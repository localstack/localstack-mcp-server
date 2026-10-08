import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertNotInProfile,
  defaultExtensionDir,
  extensionAddArgs,
  ExtensionInstallError,
  installExtensions,
  installerEnv,
  type RunAz,
} from "./extension-install";
import { AZURE_EXTENSION_PINS } from "./extension-pins";

// The shared extension installer. Nothing here runs az: the runner is
// injected, and every directory is a temporary one.

describe("extensionAddArgs", () => {
  test("pinned, fail-fast, converging on the pin; --allow-preview only for preview builds", () => {
    expect(extensionAddArgs({ name: "fleet", version: "1.11.1", preview: false })).toEqual([
      "extension",
      "add",
      "--name",
      "fleet",
      "--version",
      "1.11.1",
      "--upgrade",
      "--yes",
      "--only-show-errors",
    ]);
    expect(extensionAddArgs({ name: "cdn", version: "1.0.0b3", preview: true })).toContain(
      "--allow-preview"
    );
  });
});

describe("the target directory", () => {
  test("defaults to ~/.localstack/azure/mcp-extensions, or LOCALSTACK_AZ_EXTENSION_DIR", () => {
    const home = path.join(os.tmpdir(), "home-x");
    expect(defaultExtensionDir({}, home)).toBe(
      path.resolve(home, ".localstack", "azure", "mcp-extensions")
    );
    expect(defaultExtensionDir({ LOCALSTACK_AZ_EXTENSION_DIR: path.join(home, "ext") }, home)).toBe(
      path.resolve(home, "ext")
    );
  });

  test("never inside ~/.azure or the user's AZURE_CONFIG_DIR", () => {
    const home = path.join(os.tmpdir(), "home-y");
    const ctx = { homedir: home, env: { AZURE_CONFIG_DIR: path.join(home, "other-profile") } };
    expect(() => assertNotInProfile(path.join(home, ".azure", "cliextensions"), ctx)).toThrow(
      /refusing to install into/
    );
    expect(() => assertNotInProfile(path.join(home, ".azure"), ctx)).toThrow(/refusing/);
    expect(() => assertNotInProfile(path.join(home, "other-profile", "ext"), ctx)).toThrow(
      /refusing/
    );
    expect(() =>
      assertNotInProfile(path.join(home, ".localstack", "azure", "mcp-extensions"), ctx)
    ).not.toThrow();
  });

  test("a symlink into the profile is refused too (WSL's ~/.azure can link to Windows)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-ext-link-"));
    try {
      const home = path.join(root, "home");
      const profile = path.join(home, ".azure");
      fs.mkdirSync(profile, { recursive: true });
      const link = path.join(root, "innocent-looking");
      fs.symlinkSync(profile, link, process.platform === "win32" ? "junction" : "dir");
      expect(() =>
        assertNotInProfile(path.join(link, "cliextensions"), { homedir: home, env: {} })
      ).toThrow(/refusing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installerEnv", () => {
  test("forces the extension dir and a throwaway config dir; the parent's are dropped", () => {
    const env = installerEnv(
      { PATH: "/bin", AZURE_CONFIG_DIR: "/real/profile", azure_extension_dir: "/real/ext" },
      "/target",
      "/tmp/cfg"
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      AZURE_EXTENSION_DIR: "/target",
      AZURE_CONFIG_DIR: "/tmp/cfg",
      AZURE_CORE_COLLECT_TELEMETRY: "no",
    });
    expect(Object.values(env)).not.toContain("/real/profile");
    expect(Object.values(env)).not.toContain("/real/ext");
  });
});

describe("installExtensions", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-ext-install-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function recorder(failOn?: string) {
    const calls: Array<{
      file: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      configExisted: boolean;
    }> = [];
    const run: RunAz = async (file, args, env) => {
      calls.push({ file, args, env, configExisted: fs.existsSync(env.AZURE_CONFIG_DIR!) });
      return failOn && args.includes(failOn)
        ? { status: 1, output: "line 1\nERROR: the index could not be read" }
        : { status: 0 };
    };
    return { calls, run };
  }

  test("every pin in order, through the given az, with a fresh config dir removed afterwards", async () => {
    const { calls, run } = recorder();
    const dir = path.join(root, "ext");
    const result = await installExtensions({
      pins: AZURE_EXTENSION_PINS,
      dir,
      az: { file: "/opt/az/bin/python3", prefix: ["-X", "utf8", "-IBm", "azure.cli"] },
      run,
      env: { PATH: "/bin", AZURE_CONFIG_DIR: "/real/profile" },
      tmpdir: root,
    });
    expect(result).toEqual({ installed: 26, dir });
    expect(fs.existsSync(dir)).toBe(true);
    expect(calls.map((c) => c.args[c.args.indexOf("--name") + 1])).toEqual(
      AZURE_EXTENSION_PINS.map((p) => p.name)
    );
    expect(calls.every((c) => c.file === "/opt/az/bin/python3")).toBe(true);
    expect(calls[0].args.slice(0, 4)).toEqual(["-X", "utf8", "-IBm", "azure.cli"]);
    const configDir = calls[0].env.AZURE_CONFIG_DIR!;
    expect(configDir).not.toBe("/real/profile");
    expect(calls.every((c) => c.env.AZURE_CONFIG_DIR === configDir && c.configExisted)).toBe(true);
    expect(calls.every((c) => c.env.AZURE_EXTENSION_DIR === dir)).toBe(true);
    expect(fs.existsSync(configDir)).toBe(false);
  });

  test("the first failure stops the run, names the extension, and still removes the config dir", async () => {
    const { calls, run } = recorder("dns-resolver");
    const error = await installExtensions({
      pins: AZURE_EXTENSION_PINS,
      dir: path.join(root, "ext"),
      az: { file: "az", prefix: [] },
      run,
      tmpdir: root,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtensionInstallError);
    expect((error as ExtensionInstallError).pin.name).toBe("dns-resolver");
    expect((error as Error).message).toMatch(
      /dns-resolver 1\.2\.0 \(exit 1\):\n[\s\S]*index could not/
    );
    expect(calls).toHaveLength(
      AZURE_EXTENSION_PINS.findIndex((p) => p.name === "dns-resolver") + 1
    );
    expect(fs.existsSync(calls[0].env.AZURE_CONFIG_DIR!)).toBe(false);
  });

  test("a spawn error is reported as such", async () => {
    const run: RunAz = async () => ({ status: null, error: new Error("spawn az ENOENT") });
    await expect(
      installExtensions({
        pins: AZURE_EXTENSION_PINS.slice(0, 1),
        dir: path.join(root, "ext"),
        az: { file: "az", prefix: [] },
        run,
        tmpdir: root,
      })
    ).rejects.toThrow(/could not run az: spawn az ENOENT/);
  });
});
