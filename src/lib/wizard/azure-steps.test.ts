import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RunAz } from "../azure/extension-install";
import { AZURE_EXTENSION_PINS } from "../azure/extension-pins";
import { installAzureExtensionsStep, installBicepStep, type AzureStepDeps } from "./azure-steps";

// U12 (plan task 5.3): the wizard's Azure steps, with az and the download injected and a
// temporary home, so the real ~/.localstack and ~/.azure are never touched.

describe("the wizard's Azure steps", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-wizard-azure-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function deps(over: Partial<AzureStepDeps> = {}) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const run: RunAz = async (file, args) => {
      calls.push({ file, args });
      return { status: 0 };
    };
    const d: AzureStepDeps = {
      platform: process.platform,
      arch: process.arch,
      homedir: home,
      env: {},
      locate: () => ({
        file: "/usr/bin/python3",
        prefixArgs: ["-X", "utf8", "-IBm", "azure.cli"],
        installer: "pip",
      }),
      run,
      pins: AZURE_EXTENSION_PINS,
      musl: false,
      installBicep: jest.fn(async () => ({ path: "/x/bicep", asset: "bicep-linux-x64" })),
      ...over,
    };
    return { d, calls };
  }

  test("extensions: the 26 pins into ~/.localstack/azure/mcp-extensions, through the located az", async () => {
    const { d, calls } = deps();
    const result = await installAzureExtensionsStep(d);
    expect(result).toMatchObject({ step: "extensions", status: "installed" });
    const dir = path.join(home, ".localstack", "azure", "mcp-extensions");
    expect(result.detail).toContain(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(calls).toHaveLength(26);
    expect(calls.every((c) => c.file === "/usr/bin/python3")).toBe(true);
  });

  test("extensions: a no-op when az is missing", async () => {
    const { d, calls } = deps({
      locate: () => {
        throw new Error("no az");
      },
    });
    const result = await installAzureExtensionsStep(d);
    expect(result).toMatchObject({ step: "extensions", status: "skipped" });
    expect(result.detail).toMatch(/no Azure CLI found/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test("extensions: an extension dir inside ~/.azure is refused before az runs", async () => {
    const { d, calls } = deps({
      env: { LOCALSTACK_AZ_EXTENSION_DIR: path.join(home, ".azure", "cliextensions") },
    });
    const result = await installAzureExtensionsStep(d);
    expect(result).toMatchObject({ step: "extensions", status: "failed" });
    expect(result.detail).toMatch(/refusing to install into/);
    expect(calls).toHaveLength(0);
  });

  test("extensions: a Windows .cmd launcher run as-is is skipped with the way out", async () => {
    const { d, calls } = deps({
      platform: "win32",
      locate: () => ({ file: "C:\\tools\\az.cmd", prefixArgs: [], installer: "launcher-as-is" }),
    });
    const result = await installAzureExtensionsStep(d);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.detail).toMatch(/LOCALSTACK_AZ_PATH/);
    expect(calls).toHaveLength(0);
  });

  test("bicep: installed, or failed with the installer's message", async () => {
    const ok = deps();
    expect(await installBicepStep(ok.d)).toMatchObject({ step: "bicep", status: "installed" });
    expect(ok.d.installBicep).toHaveBeenCalledWith(
      expect.objectContaining({ homedir: home, platform: process.platform, musl: false })
    );
    const failing = deps({
      installBicep: jest.fn(async () => {
        throw new Error("the downloaded bicep has sha256 abc, not the pinned def");
      }),
    });
    expect(await installBicepStep(failing.d)).toEqual({
      step: "bicep",
      status: "failed",
      detail: "the downloaded bicep has sha256 abc, not the pinned def",
    });
  });
});
