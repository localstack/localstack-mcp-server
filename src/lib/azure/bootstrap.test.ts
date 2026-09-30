import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  CLI_CONFIG,
  ConfigDirInUseError,
  BootstrapError,
  DUMMY_LOGIN,
  ensureAzureCliConfigured,
  freshLeaseFor,
  LEASE_DIR,
  LOCK_DIR,
  MARKER_FILE,
  needsRebootstrap,
  readMarker,
  ReadWriteLock,
  resetBootstrapState,
  runInProfile,
  runWithSelfHeal,
  STALE_LOCK_MS,
  versionCheckSeed,
  versionsFromAzVersionJson,
  versionsFromLocalVersionsJson,
  VERSION_CHECK_FILE,
  type BootstrapDeps,
  type BootstrapTarget,
} from "./bootstrap";
import type { AzRunner, AzRunOptions, AzRunResult } from "./types";

// With a fake runner that records argv sequences.

const ENDPOINT = "https://azure.localhost.localstack.cloud:4566";
const ok = (stdout = ""): AzRunResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 1,
  egress: { refused: [], upstream: [], housekeeping: [], allowed: 0 },
});
const fail = (stderr: string, exitCode = 1): AzRunResult => ({ ...ok(), exitCode, stderr });

type Responder = (argv: string[], call: number) => AzRunResult | Promise<AzRunResult>;

function fakeRunner(
  respond: Responder = (argv) => (argv[0] === "cloud" && argv[1] === "list" ? ok("") : ok())
) {
  const calls: string[][] = [];
  const runner: AzRunner = {
    run: jest.fn(async (argv: string[], _opts: AzRunOptions) => {
      calls.push(argv);
      return respond(argv, calls.length);
    }),
  };
  return { runner, calls };
}

let root: string;
let configDir: string;
let target: BootstrapTarget;

beforeEach(() => {
  resetBootstrapState();
  root = mkdtempSync(path.join(os.tmpdir(), "lsaz-boot-"));
  configDir = path.join(root, "mcp-config-4566");
  target = {
    configDir,
    endpoint: ENDPOINT,
    sessionId: "s-1",
    azVersion: "2.87.0",
    cwd: root,
    timeoutMs: 60_000,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const LOCAL_VERSIONS = { "azure-cli": "2.87.0", core: "2.87.0", telemetry: "1.1.0" };
const deps = (runner: AzRunner, over: Partial<BootstrapDeps> = {}): BootstrapDeps => ({
  runner,
  readLocalVersions: async () => LOCAL_VERSIONS,
  hostname: "test-host",
  ...over,
});

describe("the five calls", () => {
  test("exactly five calls, with the cloud JSON as one element and the CLI config values", async () => {
    const { runner, calls } = fakeRunner();
    await ensureAzureCliConfigured(target, deps(runner));
    expect(calls).toEqual([
      ["cloud", "list", "--query", "[?name=='LocalStack'].name", "-o", "tsv"],
      [
        "cloud",
        "register",
        "--name",
        "LocalStack",
        "--cloud-config",
        expect.any(String),
        "--only-show-errors",
      ],
      ["cloud", "set", "--name", "LocalStack", "--only-show-errors"],
      ["config", "set", ...CLI_CONFIG, "--only-show-errors"],
      DUMMY_LOGIN,
    ]);
    expect(JSON.parse(calls[1][5])).toEqual({
      endpoints: {
        activeDirectory: ENDPOINT,
        activeDirectoryResourceId: ENDPOINT,
        activeDirectoryGraphResourceId: ENDPOINT,
        management: `${ENDPOINT}/`,
        microsoftGraphResourceId: `${ENDPOINT}/`,
        resourceManager: `${ENDPOINT}/`,
        logAnalyticsResourceId: ENDPOINT,
      },
    });
    expect(CLI_CONFIG).toEqual([
      "core.instance_discovery=false",
      "core.collect_telemetry=false",
      "output.show_survey_link=no",
      "extension.use_dynamic_install=no",
      "core.error_recommendation=off",
      "core.output=json",
      "core.display_region_identified=false",
      "bicep.use_binary_from_path=true",
      "bicep.check_version=false",
      "auto-upgrade.enable=no",
    ]);
  });

  test("an existing LocalStack cloud (cloud list's stdout) is updated, not registered", async () => {
    const { runner, calls } = fakeRunner((argv) =>
      argv[1] === "list" ? ok("LocalStack\r\n") : ok()
    );
    await ensureAzureCliConfigured(target, deps(runner));
    expect(calls[1].slice(0, 2)).toEqual(["cloud", "update"]);
  });

  test("a failed cloud list means register", async () => {
    const { runner, calls } = fakeRunner((argv) =>
      argv[1] === "list" ? fail("ERROR: boom") : ok()
    );
    await ensureAzureCliConfigured(target, deps(runner));
    expect(calls[1].slice(0, 2)).toEqual(["cloud", "register"]);
  });

  test("a matching marker skips the bootstrap entirely", async () => {
    const first = fakeRunner();
    await ensureAzureCliConfigured(target, deps(first.runner));
    const second = fakeRunner();
    await ensureAzureCliConfigured(target, deps(second.runner));
    expect(second.calls).toEqual([]);
  });

  test.each([
    ["the endpoint", { endpoint: "https://localhost.localstack.cloud:4566" }],
    ["the emulator session", { sessionId: "s-2" }],
    ["the az version", { azVersion: "2.90.0" }],
  ])("a change of %s re-bootstraps", async (_label, change) => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    const again = fakeRunner();
    await ensureAzureCliConfigured({ ...target, ...change }, deps(again.runner));
    expect(again.calls).toHaveLength(5);
  });
});

describe("the versionCheck.json seed", () => {
  test("written BEFORE the first az call, with the exact keys and times", async () => {
    let seenAtFirstCall: unknown;
    const { runner } = fakeRunner((argv, n) => {
      if (n === 1)
        seenAtFirstCall = JSON.parse(
          readFileSync(path.join(configDir, VERSION_CHECK_FILE), "utf8")
        );
      return argv[1] === "list" ? ok("") : ok();
    });
    await ensureAzureCliConfigured(target, deps(runner));
    expect(seenAtFirstCall).toEqual({
      versions: {
        "azure-cli": { local: "2.87.0", pypi: "2.87.0" },
        core: { local: "2.87.0", pypi: "2.87.0" },
        telemetry: { local: "1.1.0", pypi: "1.1.0" },
      },
      update_time: "2999-01-01 00:00:00.000000",
      check_time: "2999-01-01 00:00:00.000000",
    });
  });

  test("re-seeded when the az version changes", async () => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    const newer = { "azure-cli": "2.90.0", core: "2.90.0", telemetry: "1.1.0" };
    await ensureAzureCliConfigured(
      { ...target, azVersion: "2.90.0" },
      deps(fakeRunner().runner, { readLocalVersions: async () => newer })
    );
    const seed = JSON.parse(readFileSync(path.join(configDir, VERSION_CHECK_FILE), "utf8"));
    expect(seed.versions.core.local).toBe("2.90.0");
  });

  test("the seed always has core, falling back to the probed version", () => {
    expect(versionCheckSeed({}, "2.85.0").versions).toEqual({
      core: { local: "2.85.0", pypi: "2.85.0" },
      "azure-cli": { local: "2.85.0", pypi: "2.85.0" },
    });
    expect(() => versionCheckSeed({})).toThrow(/core/);
  });

  test("the launcher-as-is seed comes from az version -o json", () => {
    const azVersion = JSON.stringify({
      "azure-cli": "2.90.0",
      "azure-cli-core": "2.90.0",
      "azure-cli-telemetry": "1.1.0",
      extensions: { "resource-graph": "2.1.1" },
    });
    expect(versionsFromAzVersionJson(azVersion)).toEqual({
      "azure-cli": "2.90.0",
      core: "2.90.0",
      telemetry: "1.1.0",
    });
  });

  test("the interpreter probe's _get_local_versions() output is flattened", () => {
    const text = JSON.stringify({
      "azure-cli": { local: "2.87.0" },
      core: { local: "2.87.0" },
      telemetry: { local: "1.1.0" },
    });
    expect(versionsFromLocalVersionsJson(text)).toEqual(LOCAL_VERSIONS);
  });
});

describe("the marker", () => {
  test("written only after success, with the endpoint, session and az version", async () => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    expect(readMarker(configDir)).toMatchObject({
      endpoint: ENDPOINT,
      sessionId: "s-1",
      azVersion: "2.87.0",
    });
  });

  test("a partial failure leaves no marker, and the error names the step with az's output", async () => {
    const { runner } = fakeRunner((argv) =>
      argv[0] === "login"
        ? fail("ERROR: Unable to get endpoints from the cloud.", 1)
        : argv[1] === "list"
          ? ok("")
          : ok()
    );
    const error = await ensureAzureCliConfigured(target, deps(runner)).catch((e) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect((error as BootstrapError).step).toBe("login");
    expect((error as BootstrapError).result.stderr).toContain("Unable to get endpoints");
    expect(existsSync(path.join(configDir, MARKER_FILE))).toBe(false);
    expect(existsSync(path.join(configDir, LOCK_DIR))).toBe(false);
  });
});

describe("locks", () => {
  test("two concurrent calls give one bootstrap", async () => {
    const { runner, calls } = fakeRunner(async (argv) => {
      await new Promise((r) => setTimeout(r, 20));
      return argv[1] === "list" ? ok("") : ok();
    });
    await Promise.all([
      ensureAzureCliConfigured(target, deps(runner)),
      ensureAzureCliConfigured(target, deps(runner)),
    ]);
    expect(calls).toHaveLength(5);
  });

  test("another process's bootstrap (its lock dir) is waited for, and not repeated", async () => {
    mkdirSync(path.join(configDir, LOCK_DIR), { recursive: true });
    writeFileSync(
      path.join(configDir, LOCK_DIR, "owner.json"),
      JSON.stringify({ createdAt: Date.now(), hostname: "other" })
    );
    const { runner, calls } = fakeRunner();
    let slept = 0;
    const sleep = async (ms: number) => {
      slept++;
      if (slept === 3) {
        // The other process finishes: it writes the marker and releases its lock.
        writeFileSync(
          path.join(configDir, MARKER_FILE),
          JSON.stringify({
            endpoint: ENDPOINT,
            sessionId: "s-1",
            azVersion: "2.87.0",
            createdAt: "x",
          })
        );
        rmSync(path.join(configDir, LOCK_DIR), { recursive: true, force: true });
      }
      await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    };
    await ensureAzureCliConfigured(target, deps(runner, { sleep }));
    expect(slept).toBeGreaterThanOrEqual(3);
    expect(calls).toEqual([]);
  });

  test("a lock dir older than 5 minutes is broken", async () => {
    mkdirSync(path.join(configDir, LOCK_DIR), { recursive: true });
    writeFileSync(
      path.join(configDir, LOCK_DIR, "owner.json"),
      JSON.stringify({ createdAt: Date.now() - STALE_LOCK_MS - 1000, hostname: "crashed" })
    );
    const { runner, calls } = fakeRunner();
    await ensureAzureCliConfigured(target, deps(runner));
    expect(calls).toHaveLength(5);
  });

  test("a fresh lock is respected until it goes stale", async () => {
    mkdirSync(path.join(configDir, LOCK_DIR), { recursive: true });
    writeFileSync(
      path.join(configDir, LOCK_DIR, "owner.json"),
      JSON.stringify({ createdAt: 1_000_000, hostname: "busy" })
    );
    let clock = 1_000_000;
    const { runner, calls } = fakeRunner();
    const sleep = async (ms: number) => {
      clock += ms * 100; // 25 s per poll: stale after about 12 polls
    };
    await ensureAzureCliConfigured(target, deps(runner, { now: () => clock, sleep }));
    expect(clock - 1_000_000).toBeGreaterThan(STALE_LOCK_MS);
    expect(calls).toHaveLength(5);
  });

  test("a re-bootstrap waits for in-flight commands", async () => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    let release!: () => void;
    const order: string[] = [];
    const { runner } = fakeRunner(async (argv) => {
      if (argv[0] === "group") {
        order.push("command:start");
        await new Promise<void>((r) => (release = r));
        order.push("command:end");
        return ok("[]");
      }
      order.push(`bootstrap:${argv[0]} ${argv[1] ?? ""}`.trim());
      return argv[1] === "list" ? ok("") : ok();
    });
    const command = runInProfile(target, runner, ["group", "list"], { timeoutMs: 1000, cwd: root });
    await new Promise((r) => setTimeout(r, 20));
    const rebootstrap = ensureAzureCliConfigured(target, deps(runner), { force: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["command:start"]);
    release();
    await Promise.all([command, rebootstrap]);
    expect(order.slice(0, 3)).toEqual(["command:start", "command:end", "bootstrap:cloud list"]);
  });

  test("the readers-writer lock prefers a waiting writer over new readers", async () => {
    const lock = new ReadWriteLock();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const r1 = lock.read(() =>
      new Promise<void>((r) => (releaseFirst = r)).then(() => void events.push("r1"))
    );
    await new Promise((r) => setTimeout(r, 5));
    const w = lock.write(async () => void events.push("w"));
    const r2 = lock.read(async () => void events.push("r2"));
    await new Promise((r) => setTimeout(r, 5));
    expect(lock.state).toEqual({ readers: 1, writer: false, waitingWriters: 1 });
    releaseFirst();
    await Promise.all([r1, w, r2]);
    expect(events).toEqual(["r1", "w", "r2"]);
  });
});

describe("a shared config dir", () => {
  test("a marker for another endpoint with that process's fresh lease fails with a clear error", async () => {
    mkdirSync(path.join(configDir, LEASE_DIR), { recursive: true });
    const other = "https://azure.localhost.localstack.cloud:4666";
    writeFileSync(
      path.join(configDir, MARKER_FILE),
      JSON.stringify({ endpoint: other, createdAt: "x" })
    );
    writeFileSync(
      path.join(configDir, LEASE_DIR, "other-process.json"),
      JSON.stringify({ endpoint: other, hostname: "h", updatedAt: Date.now() })
    );
    const { runner, calls } = fakeRunner();
    await expect(ensureAzureCliConfigured(target, deps(runner))).rejects.toBeInstanceOf(
      ConfigDirInUseError
    );
    expect(calls).toEqual([]);
  });

  test("a stale lease of the other endpoint does not block a re-point", async () => {
    mkdirSync(path.join(configDir, LEASE_DIR), { recursive: true });
    const other = "https://azure.localhost.localstack.cloud:4666";
    writeFileSync(
      path.join(configDir, MARKER_FILE),
      JSON.stringify({ endpoint: other, createdAt: "x" })
    );
    writeFileSync(
      path.join(configDir, LEASE_DIR, "other-process.json"),
      JSON.stringify({ endpoint: other, hostname: "h", updatedAt: Date.now() - 16 * 60_000 })
    );
    const { runner, calls } = fakeRunner();
    await ensureAzureCliConfigured(target, deps(runner));
    expect(calls).toHaveLength(5);
  });

  test("this process's own lease never counts as another's", async () => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    expect(freshLeaseFor(configDir, ENDPOINT, Date.now())).toBe(false);
  });
});

describe("self-heal", () => {
  test.each([
    "ERROR: Please run 'az login' to setup account.",
    'WARNING: something first\nERROR: Please run "az login" to setup account.',
    "ERROR: No subscription found for the tenant.",
    "ERROR: Cloud 'LocalStack' is not registered.",
  ])("%j triggers exactly one re-bootstrap and one retry", async (stderr) => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    let commandRuns = 0;
    const { runner, calls } = fakeRunner((argv) => {
      if (argv[0] === "group") return ++commandRuns === 1 ? fail(stderr) : ok('[{"name":"rg1"}]');
      return argv[1] === "list" ? ok("LocalStack") : ok();
    });
    const result = await runWithSelfHeal(target, deps(runner), ["group", "list"], {
      timeoutMs: 1000,
      cwd: root,
    });
    expect(result.stdout).toContain("rg1");
    expect(commandRuns).toBe(2);
    expect(calls.filter((c) => c[0] !== "group")).toHaveLength(5);
  });

  test("a second login failure is returned as it is: no loop", async () => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    const { runner, calls } = fakeRunner((argv) =>
      argv[0] === "group"
        ? fail("ERROR: Please run 'az login' to setup account.")
        : argv[1] === "list"
          ? ok("")
          : ok()
    );
    const result = await runWithSelfHeal(target, deps(runner), ["group", "list"], {
      timeoutMs: 1000,
      cwd: root,
    });
    expect(result.exitCode).toBe(1);
    expect(calls.filter((c) => c[0] === "group")).toHaveLength(2);
  });

  test("a genuine error (resource not found) never triggers it", async () => {
    await ensureAzureCliConfigured(target, deps(fakeRunner().runner));
    const { runner, calls } = fakeRunner(() =>
      fail("ERROR: (ResourceNotFound) Resource group 'x' could not be found.", 3)
    );
    const result = await runWithSelfHeal(target, deps(runner), ["group", "show", "-n", "x"], {
      timeoutMs: 1000,
      cwd: root,
    });
    expect(result.exitCode).toBe(3);
    expect(calls).toEqual([["group", "show", "-n", "x"]]);
  });

  test("needsRebootstrap ignores successes, timeouts and cancellations", () => {
    const login = "ERROR: Please run 'az login' to setup account.";
    expect(needsRebootstrap(fail(login))).toBe(true);
    expect(needsRebootstrap({ ...ok(), stderr: login })).toBe(false);
    expect(needsRebootstrap({ ...fail(login), timedOut: true })).toBe(false);
    expect(needsRebootstrap({ ...fail(login), aborted: true })).toBe(false);
  });
});
