import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { ensureAzureCliConfigured, runWithSelfHeal } from "./bootstrap";
import { buildAzChildEnv } from "./child-env";
import { startEgressProxy } from "./egress-proxy";
import {
  listInstalledExtensions,
  probeArgs,
  resolveAz,
  resolveBicep,
  type AzProbeOutcome,
  type LocatedAz,
} from "./resolve-az";
import { HostRunner } from "./runner";
import * as services from "./services";
import type { AzExecutable, AzRunResult } from "./types";
import { WorkerRunner } from "./worker-runner";

// The composition root's wiring: what each service is built from, what is
// cached, and what a failure resets. Every process-spawning piece is a stand-in; the
// probes' parsing and the runner choice are the real code.

jest.mock("./runner", () => ({ HostRunner: jest.fn() }));
jest.mock("./worker-runner", () => ({ WorkerRunner: jest.fn() }));
jest.mock("./egress-proxy", () => ({ startEgressProxy: jest.fn() }));
jest.mock("./child-env", () => ({
  buildAzChildEnv: jest.fn((_env: unknown, opts: { bicepDir?: string }) => ({
    CHILD_ENV: "1",
    BICEP_DIR: opts.bicepDir ?? "",
  })),
  ensurePrivateDirs: jest.fn(),
}));
jest.mock("./bootstrap", () => ({
  ...jest.requireActual("./bootstrap"),
  ensureAzureCliConfigured: jest.fn(),
  runWithSelfHeal: jest.fn(),
}));
jest.mock("./resolve-az", () => ({
  ...jest.requireActual("./resolve-az"),
  resolveAz: jest.fn(),
  resolveBicep: jest.fn(),
  listInstalledExtensions: jest.fn(() => [{ name: "fleet", version: "1.4.0" }]),
}));

const mockedHost = HostRunner as unknown as jest.Mock;
const mockedWorker = WorkerRunner as unknown as jest.Mock;
const mockedGuard = startEgressProxy as jest.MockedFunction<typeof startEgressProxy>;
const mockedResolveAz = resolveAz as jest.MockedFunction<typeof resolveAz>;
const mockedResolveBicep = resolveBicep as jest.MockedFunction<typeof resolveBicep>;
const mockedChildEnv = buildAzChildEnv as unknown as jest.Mock;
const mockedEnsure = ensureAzureCliConfigured as jest.MockedFunction<
  typeof ensureAzureCliConfigured
>;
const mockedSelfHeal = runWithSelfHeal as jest.MockedFunction<typeof runWithSelfHeal>;

const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-services-"));
const workdir = path.join(root, "work");
const configDir = path.join(root, "mcp-config");
const extensionDir = path.join(root, "extensions");
mkdirSync(workdir);
mkdirSync(extensionDir);

const PY: AzExecutable = {
  file: "/opt/az/bin/python3",
  prefixArgs: ["-X", "utf8", "-IBm", "azure.cli"],
  installer: "pip",
  azInstaller: "PIP",
  version: "2.90.0",
};
const LAUNCHER: AzExecutable = {
  file: "/usr/local/bin/az",
  prefixArgs: [],
  installer: "launcher-as-is",
};

function result(over: Partial<AzRunResult> = {}): AzRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 1,
    egress: { refused: [], upstream: [], housekeeping: [], allowed: 0 },
    ...over,
  };
}

/** Every HostRunner the services built, with the calls made on it. */
let hosts: Array<{
  opts: Record<string, unknown>;
  calls: Array<{ argv: string[]; opts: unknown }>;
}>;
let respond: (argv: string[]) => AzRunResult;
const guard = { close: jest.fn().mockResolvedValue(undefined) };
const worker = { close: jest.fn().mockResolvedValue(undefined), run: jest.fn() };
const savedEnv = { ...process.env };

beforeEach(async () => {
  await services.resetAzureServices();
  jest.clearAllMocks();
  process.env = {
    ...savedEnv,
    LOCALSTACK_AZ_WORKDIR: workdir,
    LOCALSTACK_AZ_CONFIG_DIR: configDir,
    LOCALSTACK_AZ_EXTENSION_DIR: extensionDir,
  };
  for (const name of [
    "LOCALSTACK_AZ_EGRESS_GUARD",
    "LOCALSTACK_AZ_RUNNER",
    "LOCALSTACK_AZ_PATH",
    "LOCALSTACK_AZ_DENYLIST_FILE",
    "LOCALSTACK_AZ_PYCACHE_DIR",
    "LOCALSTACK_AZ_TIMEOUT_SECONDS",
    "AZURE_CONFIG_DIR",
  ]) {
    delete process.env[name];
  }
  hosts = [];
  respond = () => result();
  mockedHost.mockImplementation((opts: Record<string, unknown>) => {
    const record = { opts, calls: [] as Array<{ argv: string[]; opts: unknown }> };
    hosts.push(record);
    return {
      run: jest.fn(async (argv: string[], runOpts: unknown) => {
        record.calls.push({ argv, opts: runOpts });
        return respond(argv);
      }),
    };
  });
  mockedWorker.mockImplementation(() => worker);
  mockedGuard.mockResolvedValue(guard as never);
  mockedResolveAz.mockResolvedValue(PY);
  mockedResolveBicep.mockResolvedValue(undefined);
});

afterAll(async () => {
  await services.resetAzureServices();
  process.env = savedEnv;
});

describe("configuration and policy inputs", () => {
  test("the config is read once, and a reset reads it again", async () => {
    const first = services.azureConfig();
    expect(services.azureConfig()).toBe(first);
    process.env.LOCALSTACK_AZ_TIMEOUT_SECONDS = "77";
    expect(services.azureConfig().timeoutMs).toBe(first.timeoutMs);
    await services.resetAzureServices();
    expect(services.azureConfig().timeoutMs).toBe(77_000);
  });

  test("the policy gets the workdir, the private home, the protected dirs and the denylist", () => {
    const denylist = path.join(root, "denylist.txt");
    writeFileSync(
      denylist,
      "# the user's own rules\nwebapp deploy\n\nvm   run-command  # no remote shells\n"
    );
    process.env.LOCALSTACK_AZ_DENYLIST_FILE = denylist;
    const options = services.policyOptions();
    expect(options.extraDenied).toEqual([
      ["webapp", "deploy"],
      ["vm", "run-command"],
    ]);
    expect(options.workdir).toBe(services.azureConfig().workdir);
    expect(options.homeDir).toBe(services.azureConfig().homeDir);
    expect(options.platform).toBe(process.platform);
    expect(options.protectedDirs).toEqual(services.protectedDirs());
    expect(options.protectedDirs).toContain(path.join(os.homedir(), ".azure"));
    expect(services.policyOptions()).toBe(options);
  });

  test("a denylist file that vanished gives an empty list (the start check reports it)", () => {
    process.env.LOCALSTACK_AZ_DENYLIST_FILE = path.join(root, "no-such-denylist.txt");
    expect(services.policyOptions().extraDenied).toEqual([]);
  });

  test("the extension lists come from the tool's extension dir", () => {
    mkdirSync(path.join(extensionDir, "fleet", "fleet-1.4.0.dist-info"), { recursive: true });
    expect([...services.installedExtensionNames()]).toEqual(["fleet"]);
    expect(services.installedExtensions()).toEqual([{ name: "fleet", version: "1.4.0" }]);
    expect(listInstalledExtensions).toHaveBeenCalledWith(
      services.azureConfig().extensionDir,
      expect.anything(),
      process.platform
    );
  });

  test("the emulator session is recorded for the bootstrap", async () => {
    expect(services.emulatorSessionId()).toBeUndefined();
    services.recordEmulatorSession("session-1");
    expect(services.emulatorSessionId()).toBe("session-1");
    const config = services.azureConfig();
    await expect(services.bootstrapTarget()).resolves.toEqual({
      configDir: config.configDir,
      endpoint: config.endpoint,
      sessionId: "session-1",
      azVersion: "2.90.0",
      cwd: config.workdir,
      timeoutMs: config.timeoutMs,
    });
  });
});

describe("the egress guard", () => {
  test("starts once, on first use, and logs to stderr only", async () => {
    const first = await services.egressGuard();
    expect(await services.egressGuard()).toBe(first);
    expect(first).toBe(guard);
    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      mockedGuard.mock.calls[0][0]!.log!("refused example.com");
      expect(write).toHaveBeenCalledWith("[localstack-azure-client] refused example.com\n");
    } finally {
      write.mockRestore();
    }
  });

  test("LOCALSTACK_AZ_EGRESS_GUARD=0 starts none", async () => {
    process.env.LOCALSTACK_AZ_EGRESS_GUARD = "0";
    await expect(services.egressGuard()).resolves.toBeUndefined();
    expect(mockedGuard).not.toHaveBeenCalled();
  });

  test("a reset closes it", async () => {
    await services.egressGuard();
    await services.resetAzureServices();
    expect(guard.close).toHaveBeenCalledTimes(1);
  });
});

describe("resolving az: the probe resolveAz calls", () => {
  const located: LocatedAz = { file: "/opt/az/bin/python3", prefixArgs: [], installer: "pip" };

  async function probeWith(exe: LocatedAz, safePathFallback = false): Promise<AzProbeOutcome> {
    let outcome: AzProbeOutcome | undefined;
    mockedResolveAz.mockImplementationOnce(async (_ctx, probe) => {
      outcome = await probe(exe, safePathFallback);
      return PY;
    });
    await services.azCli();
    await services.resetAzureServices();
    return outcome!;
  }

  test("an interpreter is probed with the import code, in the private temp dir", async () => {
    respond = () => result({ stdout: 'a warning line\n{"python": "3.12.4", "core": "2.90.0"}\n' });
    await expect(probeWith(located, true)).resolves.toEqual({
      ok: true,
      python: "3.12.4",
      core: "2.90.0",
      error: undefined,
    });
    expect(hosts[0].opts.exe).toEqual({
      file: located.file,
      prefixArgs: probeArgs(true),
      installer: "pip",
    });
    expect(hosts[0].opts.proxy).toBe(guard);
    expect(hosts[0].calls[0]).toEqual({
      argv: [],
      opts: { timeoutMs: 60_000, cwd: services.azureConfig().tmpDir },
    });
  });

  test("a failed import reports the Python version and the error", async () => {
    respond = () =>
      result({ stdout: '{"python": "3.10.2", "error": "ModuleNotFoundError()"}', exitCode: 0 });
    await expect(probeWith(located)).resolves.toEqual({
      ok: false,
      python: "3.10.2",
      core: undefined,
      error: "ModuleNotFoundError()",
    });
  });

  test("no JSON: the spawn error, else stderr, else the exit code", async () => {
    respond = () => result({ exitCode: null, spawnError: "spawn ENOENT" });
    expect((await probeWith(located)).error).toBe("spawn ENOENT");
    respond = () => result({ exitCode: 1, stderr: "  Traceback: boom  " });
    expect((await probeWith(located)).error).toBe("Traceback: boom");
    respond = () => result({ exitCode: 9 });
    expect(await probeWith(located)).toEqual({ ok: false, error: "exit 9" });
  });

  test("a launcher run as-is is probed with `az version`", async () => {
    const launcher: LocatedAz = {
      file: LAUNCHER.file,
      prefixArgs: [],
      installer: "launcher-as-is",
    };
    respond = () => result({ stdout: '{"azure-cli": "2.90.0", "azure-cli-core": "2.90.0"}' });
    await expect(probeWith(launcher)).resolves.toEqual({ ok: true, core: "2.90.0" });
    expect(hosts[0].calls[0].argv).toEqual(["version", "-o", "json"]);
    expect(hosts[0].calls[0].opts).toMatchObject({ timeoutMs: 120_000 });

    respond = () => result({ exitCode: 2, stderr: "az: broken install" });
    await expect(probeWith(launcher)).resolves.toEqual({ ok: false, error: "az: broken install" });
    respond = () => result({ exitCode: 2, spawnError: "spawn EACCES" });
    await expect(probeWith(launcher)).resolves.toEqual({ ok: false, error: "spawn EACCES" });
    respond = () => result({ stdout: "not json" });
    await expect(probeWith(launcher)).resolves.toEqual({
      ok: false,
      error: "`az version -o json` did not print JSON",
    });
  });

  test("az is resolved once; LOCALSTACK_AZ_PATH and the pycache dir reach the resolver", async () => {
    process.env.LOCALSTACK_AZ_PATH = "/custom/az";
    process.env.LOCALSTACK_AZ_PYCACHE_DIR = path.join(root, "pycache-ok");
    await expect(services.azCli()).resolves.toBe(PY);
    await services.azCli();
    expect(mockedResolveAz).toHaveBeenCalledTimes(1);
    const ctx = mockedResolveAz.mock.calls[0][0];
    expect(ctx.env.LOCALSTACK_AZ_PATH).toBe("/custom/az");
    expect(ctx.platform).toBe(process.platform);
    expect(ctx.homedir).toBe(os.homedir());
    expect(ctx.pycacheDir).toBe(path.join(root, "pycache-ok"));
    // Windows has no /proc/version to read (macOS has none either, Linux does).
    if (process.platform === "win32") expect(ctx.procVersion).toBeUndefined();
  });

  test("a failed resolution is not cached", async () => {
    mockedResolveAz.mockRejectedValueOnce(new Error("az not found"));
    await expect(services.azCli()).rejects.toThrow("az not found");
    await expect(services.azCli()).resolves.toBe(PY);
    expect(mockedResolveAz).toHaveBeenCalledTimes(2);
  });
});

describe("safePycacheDir", () => {
  test("no setting, no dir", () => {
    expect(services.safePycacheDir(undefined)).toBeUndefined();
  });

  test("the dir is created and used", () => {
    const dir = path.join(root, "pycache-new");
    expect(services.safePycacheDir(dir)).toBe(dir);
  });

  test("a path that cannot be a directory is not used", () => {
    const file = path.join(root, "a-file");
    writeFileSync(file, "x");
    expect(services.safePycacheDir(path.join(file, "cache"))).toBeUndefined();
  });

  (process.platform === "win32" ? test.skip : test)(
    "a dir others can write is not used, and the log says why",
    () => {
      const dir = path.join(root, "pycache-shared");
      mkdirSync(dir, { mode: 0o777 });
      // mkdirSync's mode is masked by the umask: set the bits explicitly.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("fs").chmodSync(dir, 0o777);
      const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(services.safePycacheDir(dir)).toBeUndefined();
        expect(String(write.mock.calls[0][0])).toContain("writable by others");
      } finally {
        write.mockRestore();
      }
    }
  );
});

describe("Bicep", () => {
  test("resolved once, with the Azure profiles excluded, probed with --version", async () => {
    process.env.AZURE_CONFIG_DIR = path.join(root, "parent-azure");
    let probed: string | undefined;
    mockedResolveBicep.mockImplementationOnce(async (ctx, probe) => {
      expect(ctx.excludeDirs).toEqual([`${os.homedir()}/.azure`, path.join(root, "parent-azure")]);
      expect(typeof ctx.canonical("x")).toBe("string");
      respond = () => result({ stdout: "Bicep CLI version 0.47.16 (abc)" });
      probed = await probe("/opt/bicep/bicep");
      respond = () => result({ exitCode: 1, stdout: "ignored" });
      expect(await probe("/opt/bicep/bicep")).toBeUndefined();
      return {
        path: "/opt/bicep/bicep",
        dir: "/opt/bicep",
        source: "explicit",
        supportsBicepparam: true,
      };
    });
    await expect(services.bicep()).resolves.toMatchObject({ dir: "/opt/bicep" });
    await services.bicep();
    expect(mockedResolveBicep).toHaveBeenCalledTimes(1);
    expect(probed).toBe("Bicep CLI version 0.47.16 (abc)");
    expect(hosts[0].opts.exe).toEqual({
      file: "/opt/bicep/bicep",
      prefixArgs: [],
      installer: "pip",
    });
    expect(hosts[0].calls[0].argv).toEqual(["--version"]);
  });

  test("without AZURE_CONFIG_DIR only ~/.azure is excluded; a failure is retried", async () => {
    mockedResolveBicep.mockImplementationOnce(async (ctx) => {
      expect(ctx.excludeDirs).toEqual([`${os.homedir()}/.azure`]);
      throw new Error("LOCALSTACK_AZ_BICEP_PATH does not exist");
    });
    await expect(services.bicep()).rejects.toThrow("does not exist");
    await expect(services.bicep()).resolves.toBeUndefined();
    expect(mockedResolveBicep).toHaveBeenCalledTimes(2);
  });

  test("a miss is not cached: a Bicep installed meanwhile is found on the next call", async () => {
    // As the Snowflake tool checks for `snow` on each call: installing Bicep with
    // install-azure-addons while the server runs needs no restart.
    // A flag, not queued mockResolvedValueOnce values: beforeEach replaces this implementation,
    // so nothing leaks into the next test even if this one fails midway.
    let installed = false;
    mockedResolveBicep.mockImplementation(async () =>
      installed
        ? {
            path: "/home/u/.localstack/azure/bin/bicep",
            dir: "/home/u/.localstack/azure/bin",
            source: "tool",
            supportsBicepparam: true,
          }
        : undefined
    );
    await expect(services.bicep()).resolves.toBeUndefined();
    installed = true;
    await expect(services.bicep()).resolves.toMatchObject({ source: "tool" });
    await services.bicep();
    expect(mockedResolveBicep).toHaveBeenCalledTimes(2); // a hit is still resolved once
  });
});

describe("readLocalVersions (the update-check seed)", () => {
  test("an interpreter runs azure.cli.core's own version code", async () => {
    respond = () =>
      result({ stdout: 'noise\n{"core": {"local": "2.90.0"}, "telemetry": {"local": "1.1.0"}}\n' });
    await expect(services.readLocalVersions(PY)).resolves.toEqual({
      core: "2.90.0",
      telemetry: "1.1.0",
    });
    const exe = hosts[0].opts.exe as AzExecutable;
    expect(exe.prefixArgs.slice(-2)[0]).toBe("-c");
    expect(exe.prefixArgs.slice(-1)[0]).toContain("_get_local_versions");
    expect(exe.prefixArgs).not.toContain("azure.cli");
  });

  test("unparseable output gives no versions", async () => {
    respond = () => result({ stdout: "Traceback (most recent call last)" });
    await expect(services.readLocalVersions(PY)).resolves.toEqual({});
  });

  test("a launcher run as-is uses `az version`", async () => {
    respond = () => result({ stdout: '{"azure-cli": "2.88.0", "azure-cli-core": "2.88.0"}' });
    await expect(services.readLocalVersions(LAUNCHER)).resolves.toEqual({
      "azure-cli": "2.88.0",
      core: "2.88.0",
    });
    respond = () => result({ exitCode: 1 });
    await expect(services.readLocalVersions(LAUNCHER)).resolves.toEqual({});
  });
});

describe("the runners", () => {
  test("the host runner gets the child env with Bicep's dir, and the guard", async () => {
    mockedResolveBicep.mockResolvedValue({
      path: "/opt/bicep/bicep",
      dir: "/opt/bicep",
      source: "tool",
      supportsBicepparam: true,
    });
    await services.azRunner();
    const last = hosts[hosts.length - 1];
    expect(last.opts).toEqual({
      exe: PY,
      env: { CHILD_ENV: "1", BICEP_DIR: "/opt/bicep" },
      proxy: guard,
    });
    expect(mockedChildEnv).toHaveBeenLastCalledWith(
      process.env,
      expect.objectContaining({ platform: process.platform, az: PY, bicepDir: "/opt/bicep" })
    );
  });

  test("a bad Bicep path does not stop az commands", async () => {
    mockedResolveBicep.mockRejectedValue(new Error("bad LOCALSTACK_AZ_BICEP_PATH"));
    await services.azRunner();
    expect(hosts[hosts.length - 1].opts.env).toEqual({ CHILD_ENV: "1", BICEP_DIR: "" });
  });

  test("by default the bootstrap and commands use the host runner", async () => {
    await services.ensureProfile();
    const [target, deps] = mockedEnsure.mock.calls[0];
    expect(target.azVersion).toBe("2.90.0");
    expect(deps.commandRunner).toBe(deps.runner);
    respond = () => result({ stdout: '{"core": {"local": "2.90.0"}}' });
    await expect(deps.readLocalVersions()).resolves.toEqual({ core: "2.90.0" });
    expect(mockedWorker).not.toHaveBeenCalled();
  });

  test("LOCALSTACK_AZ_RUNNER=worker: one warm worker, falling back to the host runner", async () => {
    process.env.LOCALSTACK_AZ_RUNNER = "worker";
    mockedResolveBicep.mockRejectedValue(new Error("bad LOCALSTACK_AZ_BICEP_PATH"));
    mockedSelfHeal.mockResolvedValue(result({ stdout: "[]" }));
    await expect(services.runAzCommand(["group", "list"], {})).resolves.toMatchObject({
      stdout: "[]",
    });
    await services.runAzCommand(["group", "list"], {});
    expect(mockedWorker).toHaveBeenCalledTimes(1);
    const options = mockedWorker.mock.calls[0][0];
    const config = services.azureConfig();
    expect(options.exe).toBe(PY);
    expect(options.env).toEqual({ CHILD_ENV: "1", BICEP_DIR: "" });
    expect(options.proxy).toBe(guard);
    expect(options.stateFiles).toEqual(
      ["config", "clouds.config", "azureProfile.json"].map((f) => path.join(config.configDir, f))
    );
    expect(options.fallback).toBe(mockedSelfHeal.mock.calls[0][1].runner);
    const [, deps, argv, opts] = mockedSelfHeal.mock.calls[0];
    expect(deps.commandRunner).toBe(worker);
    expect(argv).toEqual(["group", "list"]);
    expect(opts).toEqual({ timeoutMs: config.timeoutMs, cwd: config.workdir });

    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      options.log("worker replaced");
      expect(write).toHaveBeenCalledWith("[localstack-azure-client] worker replaced\n");
    } finally {
      write.mockRestore();
    }

    await services.resetAzureServices();
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  test("the worker gets Bicep's dir when there is one", async () => {
    process.env.LOCALSTACK_AZ_RUNNER = "worker";
    mockedResolveBicep.mockResolvedValue({
      path: "/opt/bicep/bicep",
      dir: "/opt/bicep",
      source: "tool",
      supportsBicepparam: true,
    });
    await services.ensureProfile();
    expect(mockedWorker.mock.calls[0][0].env).toEqual({ CHILD_ENV: "1", BICEP_DIR: "/opt/bicep" });
  });

  test("a launcher run as-is names no Python for the worker: the host runner stays", async () => {
    process.env.LOCALSTACK_AZ_RUNNER = "worker";
    mockedResolveAz.mockResolvedValue(LAUNCHER);
    await services.ensureProfile();
    const [, deps] = mockedEnsure.mock.calls[0];
    expect(deps.commandRunner).toBe(deps.runner);
    expect(mockedWorker).not.toHaveBeenCalled();
  });
});
