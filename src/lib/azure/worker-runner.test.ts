import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startEgressProxy } from "./egress-proxy";
import type { AzRunner, AzRunOptions, AzRunResult } from "./types";
import { WorkerRunner, writesCliState, type WorkerRunnerOptions } from "./worker-runner";

// The runner's cases against the warm worker, plus its own: state isolation,
// SystemExit, the fd 2 capture. The REAL worker code (worker-script.ts) runs under a real
// Python, with a stand-in azure.cli.core (tests/fixtures/azure/fake-worker), so no
// azure-cli is needed. Skipped when no Python is on PATH.

function findPython(): string | undefined {
  const names =
    process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    // The Microsoft Store's python.exe aliases exist but open the Store instead.
    if (!dir || /WindowsApps/i.test(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const PYTHON = findPython();
const STUB = path.join(__dirname, "../../../tests/fixtures/azure/fake-worker");
const describeIfPython = PYTHON ? describe : describe.skip;

describe("writesCliState", () => {
  test("state writers are matched by command prefix, readers are not", () => {
    expect(writesCliState(["account", "show"])).toBe(false);
    expect(writesCliState(["account", "list"])).toBe(false);
    expect(writesCliState(["account", "set", "--subscription", "x"])).toBe(true);
    expect(writesCliState(["config", "get"])).toBe(true);
    expect(writesCliState(["extension", "list"])).toBe(true);
    expect(writesCliState(["bicep", "build", "--file", "x"])).toBe(false);
    expect(writesCliState(["bicep", "install"])).toBe(true);
    expect(writesCliState(["group", "list"])).toBe(false);
  });
});

describeIfPython("WorkerRunner, with the real worker code and a stand-in azure.cli.core", () => {
  let root: string;
  let configDir: string;
  const runners: WorkerRunner[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-worker-"));
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir);
  });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runner(over: Partial<WorkerRunnerOptions> = {}): WorkerRunner {
    const r = new WorkerRunner({
      // `-m azure.cli` becomes `-c <worker>`; no -I here, so PYTHONPATH finds the stand-in.
      exe: { file: PYTHON!, prefixArgs: ["-X", "utf8", "-m", "azure.cli"], installer: "explicit" },
      env: {
        ...(process.env as Record<string, string>),
        PYTHONPATH: STUB,
        PYTHONDONTWRITEBYTECODE: "1",
        AZURE_CONFIG_DIR: configDir,
      },
      ...over,
    });
    runners.push(r);
    return r;
  }
  const opts = (over: Partial<AzRunOptions> = {}): AzRunOptions => ({
    timeoutMs: 60_000,
    cwd: root,
    ...over,
  });
  const out = (r: AzRunResult) => r.stdout.trim();

  test("one warm process: its state survives from one command to the next", async () => {
    const r = runner();
    const first = await r.run(["count"], opts());
    const second = await r.run(["count"], opts());
    expect([out(first), out(second)]).toEqual(["1", "2"]);
    expect(out(await r.run(["pid"], opts()))).toBe(out(await r.run(["pid"], opts())));
    expect(first.exitCode).toBe(0);
    expect(r.workerCount).toBe(1);
  });

  test("each command gets a fresh CLI context: no change to it leaks into the next", async () => {
    // `az rest` unregisters az's global result transforms on its CLI context. With one context
    // for the worker's life, every later command in that worker answered resourceGroup: null.
    const r = runner();
    await r.run(["unregister-transforms"], opts());
    expect(out(await r.run(["transforms"], opts()))).toBe("on");
    expect(r.workerCount).toBe(1); // still the same warm process
  });

  test("stderr: both a log handler bound at import and raw fd 2 writes are captured", async () => {
    const r = runner();
    const logged = await r.run(["log", "a", "warning"], opts());
    expect(logged.stderr).toContain("a warning");
    expect(logged.stdout).toBe("");
    const raw = await r.run(["stderr", "raw-err"], opts());
    expect(raw.stderr).toBe("raw-err");
  });

  test("bytes written straight to fd 1 land in stdout, never in the protocol stream", async () => {
    const r = runner();
    const raw = await r.run(["rawfd", "raw-out"], opts());
    expect(raw.stdout).toContain("raw-out");
    expect(out(await r.run(["echo", "still", "fine"], opts()))).toBe('["still", "fine"]');
  });

  test("SystemExit gives its code; an exception is exit 1 with its message; the worker lives on", async () => {
    const r = runner();
    const pid = out(await r.run(["pid"], opts()));
    expect((await r.run(["exit", "3"], opts())).exitCode).toBe(3);
    const raised = await r.run(["raise"], opts());
    expect(raised.exitCode).toBe(1);
    expect(raised.stderr).toContain("RuntimeError: boom");
    expect(out(await r.run(["pid"], opts()))).toBe(pid);
  });

  test("a prompt sees no tty and an empty stdin, as in a subprocess", async () => {
    const r = runner();
    expect(out(await r.run(["prompt"], opts()))).toBe("no tty\n''");
  });

  test("each command runs in its own cwd, with its own call tag in the proxy variables", async () => {
    const proxy = await startEgressProxy();
    try {
      const r = runner({ proxy });
      const sub = path.join(root, "sub");
      fs.mkdirSync(sub);
      expect(fs.realpathSync(out(await r.run(["cwd"], opts({ cwd: sub }))))).toBe(
        fs.realpathSync(sub)
      );
      const a = out(await r.run(["env", "HTTPS_PROXY"], opts()));
      const b = out(await r.run(["env", "HTTPS_PROXY"], opts()));
      expect(a).toMatch(/^http:\/\/[0-9a-f-]{36}:x@127\.0\.0\.1:\d+$/);
      expect(b).not.toBe(a);
    } finally {
      await proxy.close();
    }
  });

  test("a command that writes CLI state replaces the worker", async () => {
    const r = runner();
    expect(out(await r.run(["count"], opts()))).toBe("1");
    await r.run(["config", "set", "core.x=y"], opts());
    expect(out(await r.run(["count"], opts()))).toBe("1");
  });

  test("a changed profile file (the bootstrap, a self-heal) replaces the worker", async () => {
    const profile = path.join(configDir, "config");
    fs.writeFileSync(profile, "[core]\n");
    const r = runner({ stateFiles: [profile] });
    expect(out(await r.run(["count"], opts()))).toBe("1");
    expect(out(await r.run(["count"], opts()))).toBe("2");
    fs.writeFileSync(profile, "[core]\noutput = json\n");
    expect(out(await r.run(["count"], opts()))).toBe("1");
  });

  test("recycled after the command limit", async () => {
    const r = runner({ maxCommandsPerWorker: 2 });
    const counts = [];
    for (let i = 0; i < 3; i++) counts.push(out(await r.run(["count"], opts())));
    expect(counts).toEqual(["1", "2", "1"]);
  });

  test("a timeout kills the worker's tree; the next command gets a fresh worker", async () => {
    const r = runner();
    const pid = out(await r.run(["pid"], opts()));
    const started = Date.now();
    const slow = await r.run(["sleep", "30"], opts({ timeoutMs: 1500 }));
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out(await r.run(["pid"], opts()))).not.toBe(pid);
  });

  test("a cancelled call kills the worker too", async () => {
    const r = runner();
    await r.run(["pid"], opts());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await r.run(["sleep", "30"], opts({ signal: controller.signal }));
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test("a cancel during the worker's cold start aborts the call, and the command never runs", async () => {
    const r = runner({
      env: {
        ...(process.env as Record<string, string>),
        PYTHONPATH: STUB,
        PYTHONDONTWRITEBYTECODE: "1",
        AZURE_CONFIG_DIR: configDir,
        FAKE_AZ_IMPORT_DELAY: "2",
      },
    });
    const marker = path.join(root, "ran.txt");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await r.run(["touch", marker], opts({ signal: controller.signal }));
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500); // not held until the worker is up
    // Well after the worker would have come up: the command still never ran.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("each command gets its own log level: a first --debug does not stick", async () => {
    const r = runner();
    const first = await r.run(["debuglog", "--debug"], opts());
    expect(first.stderr).toContain("DEBUG: a debug line");
    const pid = out(await r.run(["pid"], opts()));
    const second = await r.run(["debuglog"], opts());
    expect(out(await r.run(["pid"], opts()))).toBe(pid); // the same warm worker
    expect(second.stderr).not.toContain("DEBUG: a debug line");
    expect((await r.run(["debuglog", "--debug"], opts())).stderr).toContain("DEBUG: a debug line");
  });

  test("fail-fast: a refused CONNECT through the real guard ends the call and names the host", async () => {
    const proxy = await startEgressProxy();
    try {
      const r = runner({ proxy });
      const started = Date.now();
      const result = await r.run(["connect", "api.loganalytics.io:443"], opts());
      expect(result.failFast).toBe("refused");
      expect(result.egress.refused).toEqual(["api.loganalytics.io"]);
      expect(Date.now() - started).toBeLessThan(10_000);
      // The next command runs in a fresh worker.
      expect(out(await r.run(["count"], opts()))).toBe("1");
    } finally {
      await proxy.close();
    }
  });

  test("a crash mid-command is a failure, and the next command starts a new worker", async () => {
    const r = runner();
    const crashed = await r.run(["crash"], opts());
    expect(crashed.exitCode).toBeNull();
    expect(crashed.timedOut || crashed.aborted || crashed.failFast).toBeFalsy();
    expect(crashed.stderr).toMatch(/worker exited/);
    expect(out(await r.run(["count"], opts()))).toBe("1");
  });

  test("output over the cap is truncated, and that worker is replaced", async () => {
    const r = runner({ maxStreamBytes: 1000 });
    expect(out(await r.run(["count"], opts()))).toBe("1");
    const big = await r.run(["big", "5000"], opts());
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(1000);
    expect(out(await r.run(["count"], opts()))).toBe("1");
  });

  test("a Python that cannot run the worker: this and every later call go to the fallback", async () => {
    const calls: string[][] = [];
    const fallback: AzRunner = {
      run: async (argv) => {
        calls.push(argv);
        return {
          exitCode: 0,
          stdout: "from the subprocess runner",
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
          egress: { refused: [], upstream: [], housekeeping: [], allowed: 0 },
        };
      },
    };
    const logs: string[] = [];
    const r = runner({
      workerArgs: ["-c", "import sys; sys.stderr.write('no azure.cli here'); sys.exit(3)"],
      fallback,
      log: (line) => logs.push(line),
    });
    expect((await r.run(["group", "list"], opts())).stdout).toBe("from the subprocess runner");
    expect((await r.run(["group", "show"], opts())).stdout).toBe("from the subprocess runner");
    expect(calls).toEqual([
      ["group", "list"],
      ["group", "show"],
    ]);
    expect(logs.join("\n")).toMatch(/no azure\.cli here[\s\S]*subprocess/);
  });

  test("never without an isolated AZURE_CONFIG_DIR", async () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    env.PYTHONPATH = STUB;
    delete env.AZURE_CONFIG_DIR;
    const r = runner({ env });
    await expect(r.run(["count"], opts())).rejects.toThrow(/isolated AZURE_CONFIG_DIR/);
  });

  test("parallel commands run in separate workers at once; close() stops them all", async () => {
    const r = runner();
    const started = Date.now();
    const results = await Promise.all([1, 2, 3].map(() => r.run(["sleep", "1.5"], opts())));
    expect(results.every((x) => x.exitCode === 0)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4500 + 3000); // not 3 x 1.5 s in a row, plus starts
    expect(r.workerCount).toBe(3);
    await r.close();
    expect(r.workerCount).toBe(0);
  });

  test("close() resolves only once every worker process has exited", async () => {
    // Under load on Windows, close() used to resolve when taskkill returned, before the worker's
    // exit: the afterEach's rmSync of the worker's directory then failed with EPERM.
    const r = runner();
    const pids = (await Promise.all([1, 2].map(() => r.run(["pid"], opts())))).map((x) =>
      Number(x.stdout.trim())
    );
    expect(pids.every((pid) => pid > 0)).toBe(true);
    await r.close();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(pids.filter(alive)).toEqual([]);
  });
});
