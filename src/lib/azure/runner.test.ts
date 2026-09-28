// The raw module object: the namespace that `import * as` builds has fixed properties,
// which jest.spyOn cannot replace.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess: typeof import("child_process") = require("child_process");
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  activeRuns,
  HostRunner,
  killAllLiveTreesSync,
  liveChildCount,
  progressSender,
  quoteWindowsArg,
  Semaphore,
  taskkillPath,
  windowsCommandLineLength,
  type KillStep,
} from "./runner";
import { pythonPrefix } from "./resolve-az";
import type { AzExecutable, EgressEvent, EgressProxy, EgressRecords } from "./types";

// U10 (plan task 2.4; the 13 cases of check C03 plus the plan's extras). The fake
// `az` is a Node script; the cases that need a real interpreter use Python.

jest.setTimeout(60_000);

const FIXTURES = path.resolve(__dirname, "../../../tests/fixtures/azure/fake-az");
const FAKE_AZ = path.join(FIXTURES, "fake-az.mjs");
const isWin = process.platform === "win32";
const fakeExe: AzExecutable = {
  file: process.execPath,
  prefixArgs: [FAKE_AZ],
  installer: "explicit",
};

let root: string;
let workdir: string;
let baseEnv: Record<string, string>;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "lsaz-runner-"));
  workdir = path.join(root, "work");
  mkdirSync(workdir);
  baseEnv = {
    AZURE_CONFIG_DIR: path.join(root, "cfg"),
    PATH: process.env.PATH ?? "",
    ...(isWin ? { SYSTEMROOT: process.env.SystemRoot ?? "C:\\Windows" } : {}),
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const runner = (over: Partial<ConstructorParameters<typeof HostRunner>[0]> = {}) =>
  new HostRunner({ exe: fakeExe, env: baseEnv, ...over });

const run = (
  argv: string[],
  over: Partial<ConstructorParameters<typeof HostRunner>[0]> = {},
  timeoutMs = 20_000
) => runner(over).run(argv, { timeoutMs, cwd: workdir });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

/** A Python for the real-interpreter cases: PYTHON, else python3, python or py -3. */
function findPython(): string | undefined {
  const candidates: Array<[string, string[]]> = [
    ...(process.env.PYTHON ? [[process.env.PYTHON, []] as [string, string[]]] : []),
    ["python3", []],
    ["python", []],
    ...(isWin ? [["py", ["-3"]] as [string, string[]]] : []),
  ];
  for (const [file, pre] of candidates) {
    const probe = childProcess.spawnSync(
      file,
      [...pre, "-c", "import sys; print(sys.executable)"],
      {
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      }
    );
    const exe = probe.status === 0 ? probe.stdout.trim() : "";
    if (exe && existsSync(exe)) return exe;
  }
  return undefined;
}
const PYTHON = findPython();
const withPython = PYTHON ? test : test.skip;
if (!PYTHON)
  console.warn("runner.test: no Python found (set PYTHON); the real-interpreter cases are skipped");

describe("spawn options and stdin (C03 case 1)", () => {
  test("shell:false, windowsHide, three pipes, the workdir as cwd, and stdin ended at once", async () => {
    const spy = jest.spyOn(childProcess, "spawn");
    try {
      const result = await run(["echo"]);
      const call = spy.mock.calls.find((c) => c[0] === process.execPath);
      expect(call?.[2]).toMatchObject({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workdir,
        detached: !isWin,
      });
      const echoed = JSON.parse(result.stdout);
      expect(echoed.stdinIsTTY).toBe(false);
      expect(echoed.stdinEnded).toBe(true);
      expect(path.resolve(echoed.cwd).toLowerCase()).toBe(path.resolve(workdir).toLowerCase());
      expect(result.exitCode).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("argv fidelity (case 2)", () => {
  // The 15 required values and C03's extras; none may be expanded or re-split.
  const values = [
    "[?name=='a'].id | [0]",
    '{"a":"b c","d":[1,2]}',
    "C:\\dir with space\\",
    "ends\\\\",
    'he said "hi"',
    "a;b&c|d<e>f",
    "$(whoami)",
    "%PATH%",
    "^caret",
    "!bang!",
    "",
    "unicode ✓ ü é",
    "a\tb",
    "--set",
    "properties.x='{\"a\":1}'",
    '"',
    '\\"',
    'a\\\\"b',
    "\\server\\share\\",
    "trailing ",
    " leading",
    "a b\\\\",
    "line1\nline2",
    "*",
    "?",
    "~",
    "%%",
    "%C03VAR%",
    "!C03VAR!",
    "${C03VAR}",
    "`whoami`",
    "\u00a0nbsp",
    "emoji 😀",
  ];

  test("through the Node fake", async () => {
    const result = await run(["echo", ...values], { env: { ...baseEnv, C03VAR: "EXPANDED" } });
    expect(JSON.parse(result.stdout).argv).toEqual(values);
  });

  withPython("through a real Python", async () => {
    const exe: AzExecutable = {
      file: PYTHON!,
      prefixArgs: ["-X", "utf8", "-IB", path.join(FIXTURES, "echo_argv.py")],
      installer: "explicit",
    };
    const result = await run(values, { exe, env: { ...baseEnv, C03VAR: "EXPANDED" } });
    expect(result.exitCode).toBe(0);
    const received: string[] = JSON.parse(result.stdout);
    expect(received).toEqual(values);
    expect(received.join("")).not.toContain("EXPANDED");
  });
});

describe("spawn failures (cases 3 and 4)", () => {
  test("a synchronous throw becomes a spawn error, not an exception", async () => {
    const result = await run([], {
      exe: { file: "bad\0file", prefixArgs: [], installer: "explicit" },
    });
    expect(result.spawnError).toMatch(/ERR_INVALID_ARG_VALUE|null bytes/);
    expect(liveChildCount()).toBe(0);
  });

  (isWin ? test : test.skip)("a .cmd file throws EINVAL synchronously on Windows", async () => {
    const cmd = path.join(root, "az.cmd");
    writeFileSync(cmd, "@echo off\r\n");
    const result = await run([], { exe: { file: cmd, prefixArgs: [], installer: "explicit" } });
    expect(result.spawnError).toMatch(/EINVAL/);
  });

  test("an async ENOENT gives a clean error and no hang", async () => {
    const started = Date.now();
    const result = await run([], {
      exe: { file: path.join(root, "no-such-az"), prefixArgs: [], installer: "explicit" },
    });
    expect(result.spawnError).toMatch(/ENOENT/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  (isWin ? test : test.skip)(
    "an extensionless script gives ENOENT on Windows although it exists",
    async () => {
      const script = path.join(root, "az");
      writeFileSync(script, "#!/usr/bin/env bash\necho hi\n");
      const result = await run([], {
        exe: { file: script, prefixArgs: [], installer: "explicit" },
      });
      expect(result.spawnError).toMatch(/ENOENT/);
    }
  );

  test("a Windows command line over the limit is refused before spawning, with tooLong", async () => {
    const spy = jest.spyOn(childProcess, "spawn");
    try {
      const result = await run(["x".repeat(33_000)], { platform: "win32" });
      expect(result.tooLong).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("quoteWindowsArg follows libuv's quoting", () => {
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(quoteWindowsArg("a b\\")).toBe('"a b\\\\"');
    expect(quoteWindowsArg("C:\\x\\y")).toBe("C:\\x\\y");
    expect(windowsCommandLineLength("C:\\p.exe", ["a b", "c"])).toBe('C:\\p.exe "a b" c'.length);
  });
});

describe("UTF-8 (case 5)", () => {
  test("non-ASCII output comes back exact on both streams", async () => {
    const result = await run(["utf8"]);
    expect(result.stdout.replace(/\r\n/g, "\n")).toBe("ü✓é\n");
    expect(result.stderr).toContain("WARNING: ü✓é");
  });

  test("a ✓ straddling byte 65,536 comes back exact", async () => {
    const result = await run(["utf8-boundary"]);
    expect(result.stdout).toBe(
      "a".repeat(65535) + "✓".repeat(5) + "b".repeat(70000) + "✓".repeat(5)
    );
    expect(result.stdout).not.toContain("\ufffd");
  });
});

describe("the planted azure/cli/__main__.py (case 6)", () => {
  withPython(
    "is NOT executed with the -IBm prefix, and IS with plain -m (the positive control)",
    async () => {
      const plant = path.join(root, "plant");
      mkdirSync(path.join(plant, "azure", "cli"), { recursive: true });
      writeFileSync(
        path.join(plant, "azure", "cli", "__main__.py"),
        'open("MARKER", "w").write("shadowed")\n'
      );
      // A dead proxy keeps a real azure-cli, if installed, from reaching the internet.
      const env = {
        ...baseEnv,
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
      };
      const guarded = new HostRunner({
        exe: { file: PYTHON!, prefixArgs: pythonPrefix({}), installer: "pip" },
        env,
      });
      await guarded.run(["--version"], { timeoutMs: 50_000, cwd: plant });
      expect(existsSync(path.join(plant, "MARKER"))).toBe(false);

      const unguarded = new HostRunner({
        exe: { file: PYTHON!, prefixArgs: ["-Bm", "azure.cli"], installer: "pip" },
        env,
      });
      await unguarded.run(["--version"], { timeoutMs: 50_000, cwd: plant });
      expect(existsSync(path.join(plant, "MARKER"))).toBe(true);
    }
  );
});

describe("timeouts and tree kills (cases 7-9)", () => {
  test("a timeout sets timedOut and resolves within timeout + grace", async () => {
    const started = Date.now();
    const result = await run(["sleep", "20000"], {}, 700);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(700 + 5000);
    if (isWin) expect(result.exitCode).toBe(1); // after taskkill: code=1, signal=null (C03 §6)
  });

  test("a grandchild holding the pipe is killed, and the promise resolves", async () => {
    const pids = path.join(root, "tree.json");
    const started = Date.now();
    // 4 s, not 1.5 s: under a loaded full-suite run on Linux the helper had not written its
    // pids yet when the timeout fired (WSL). The grandchild sleeps 15 s, so it still times out.
    const result = await run(["grandchild", pids, "15000"], {}, 4000);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000 + 6000);
    const { root: rootPid, grandchild } = JSON.parse(readFileSync(pids, "utf8"));
    expect(await waitUntil(() => !isAlive(rootPid) && !isAlive(grandchild), 5000)).toBe(true);
  });

  test("a root that exits while a grandchild holds the pipe resolves after the drain grace, not on 'close'", async () => {
    const pids = path.join(root, "orphan.json");
    const started = Date.now();
    const result = await run(["orphan", pids, "4000"], { timings: { drainGraceMs: 300 } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("root done");
    expect(Date.now() - started).toBeLessThan(3500); // the sleeper lives 4 s; it ends on its own
  });

  (isWin ? test : test.skip)("Windows: taskkill runs first, on the live root only", async () => {
    const steps: Array<[KillStep, number | undefined]> = [];
    const spy = jest.spyOn(childProcess, "spawn");
    try {
      const pids = path.join(root, "order.json");
      await run(
        ["grandchild", pids, "15000"],
        { onKillStep: (s, status) => steps.push([s, status]) },
        1000
      );
      const { root: rootPid } = JSON.parse(readFileSync(pids, "utf8"));
      const taskkillCalls = spy.mock.calls.filter((c) =>
        String(c[0]).toLowerCase().endsWith("taskkill.exe")
      );
      expect(taskkillCalls).toHaveLength(1);
      expect(taskkillCalls[0][1]).toEqual(["/PID", String(rootPid), "/T", "/F"]);
      // The tree can be gone (and the run resolved) before taskkill's own exit arrives.
      await waitUntil(() => steps.length > 0, 5000);
      expect(steps).toEqual([["taskkill", 0]]);
    } finally {
      spy.mockRestore();
    }
  });

  (isWin ? test : test.skip)("Windows: a failing taskkill falls back to child.kill()", async () => {
    const steps: KillStep[] = [];
    // node.exe as "taskkill": it cannot run a script named /PID and exits non-zero.
    const result = await run(
      ["sleep", "20000"],
      { taskkill: process.execPath, onKillStep: (s) => steps.push(s) },
      700
    );
    expect(result.timedOut).toBe(true);
    expect(steps).toEqual(["taskkill", "kill"]);
  });

  (isWin ? test.skip : test)(
    "POSIX: SIGTERM to the group, then SIGKILL after the grace",
    async () => {
      const steps: KillStep[] = [];
      const result = await run(
        ["sleep", "20000"],
        { onKillStep: (s) => steps.push(s), timings: { posixKillGraceMs: 200 } },
        500
      );
      expect(result.timedOut).toBe(true);
      await waitUntil(() => steps.includes("sigkill"), 2000);
      expect(steps).toEqual(["sigterm", "sigkill"]);
    }
  );

  test("taskkill's path falls back to C:\\Windows when SystemRoot is missing", () => {
    expect(taskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(taskkillPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\taskkill.exe");
  });
});

describe("prompts, environment, caps, exit codes (cases 10-13)", () => {
  test("a prompt without --yes fails fast with exit 1, and nothing on stdout", async () => {
    const started = Date.now();
    const result = await run(["prompt"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/no tty available\. Use --yes\./);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // libuv's uv_spawn on Windows copies these from the PARENT when the env block
  // lacks them (process.c, required_vars); child-env.ts therefore sets the home and
  // temp ones itself.
  const LIBUV_REQUIRED = [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ];

  test("the child gets the environment it is given, and nothing else (Windows: plus libuv's required set)", async () => {
    const given = { ...baseEnv, AZ_ONLY_THIS: "1" };
    const result = await run(["echo"], { env: given });
    const echoed = JSON.parse(result.stdout);
    const norm = (k: string) => (isWin ? k.toUpperCase() : k);
    const keys = (echoed.envKeys as string[]).map(norm);
    for (const [k, v] of Object.entries(given))
      expect(echoed.env[k] ?? echoed.env[norm(k)]).toBe(v);
    const extra = keys.filter((k) => !Object.keys(given).map(norm).includes(k));
    if (isWin) expect(extra.every((k) => LIBUV_REQUIRED.includes(k))).toBe(true);
    else expect(extra).toEqual([]);
  });

  (isWin ? test : test.skip)(
    "Windows: a private USERPROFILE, TEMP, HOMEDRIVE and HOMEPATH reach the child, not the parent's",
    async () => {
      const privateHome = path.join(root, "private-home");
      const env = {
        ...baseEnv,
        USERPROFILE: privateHome,
        HOME: privateHome,
        HOMEDRIVE: privateHome.slice(0, 2),
        HOMEPATH: privateHome.slice(2),
        TEMP: path.join(root, "private-tmp"),
        TMP: path.join(root, "private-tmp"),
      };
      const echoed = JSON.parse((await run(["echo"], { env })).stdout).env;
      expect(echoed.USERPROFILE).toBe(privateHome);
      expect(echoed.HOMEDRIVE + echoed.HOMEPATH).toBe(privateHome);
      expect(echoed.TEMP).toBe(path.join(root, "private-tmp"));
      expect(echoed.USERPROFILE).not.toBe(process.env.USERPROFILE);
    }
  );

  test("the runner refuses to start without AZURE_CONFIG_DIR", async () => {
    const { AZURE_CONFIG_DIR: _drop, ...noConfig } = baseEnv;
    await expect(run(["echo"], { env: noConfig })).rejects.toThrow(/isolated AZURE_CONFIG_DIR/);
  });

  test("byte caps count bytes, kill the tree and mark the output truncated", async () => {
    const result = await run(["flood"], { maxStreamBytes: 30_000 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(30_000);
    expect(result.stdout.length).toBe(10_000); // 3-byte characters, none split
    expect(result.stdout).not.toContain("\ufffd");
  });

  test.each([1, 3])("exit code %i is passed through, and CRLF is kept", async (code) => {
    const result = await run(["exit", String(code)]);
    expect(result.exitCode).toBe(code);
    expect(result.stdout).toBe("line1\r\nline2\r\n");
    expect(result.stderr).toContain("(ResourceNotFound)");
  });
});

describe("concurrency, progress and cancellation", () => {
  test("five parallel runs have at most four children at once", async () => {
    const r = runner();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        r.run(["timestamps", "1200"], { timeoutMs: 30_000, cwd: workdir })
      )
    );
    const spans = results.map((res) => JSON.parse(res.stdout) as { start: number; end: number });
    const maxOverlap = Math.max(
      ...spans.map((s) => spans.filter((o) => o.start <= s.start && s.start < o.end).length)
    );
    expect(maxOverlap).toBeLessThanOrEqual(4);
    expect(activeRuns()).toBe(0);
  });

  test("a queued run whose signal aborts never spawns", async () => {
    const slots = new Semaphore(1);
    expect(await slots.acquire()).toBe(true);
    const controller = new AbortController();
    const waiting = slots.acquire(controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    slots.release();
    expect(slots.inUse).toBe(0);
  });

  test("onProgress is called on every interval while az runs", async () => {
    const calls: number[] = [];
    await runner({ timings: { progressIntervalMs: 150 } }).run(["sleep", "700"], {
      timeoutMs: 10_000,
      cwd: workdir,
      onProgress: (ms) => calls.push(ms),
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
  });

  test("an aborted signal kills the tree and sets aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const started = Date.now();
    const result = await runner().run(["sleep", "20000"], {
      timeoutMs: 30_000,
      cwd: workdir,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  test("a signal aborted before the run never spawns", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = jest.spyOn(childProcess, "spawn");
    try {
      const result = await runner().run(["echo"], {
        timeoutMs: 5000,
        cwd: workdir,
        signal: controller.signal,
      });
      expect(result.aborted).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("progressSender sends notifications/progress with the token, and nothing without one", async () => {
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    const send = progressSender({ _meta: { progressToken: "tok-1" }, sendNotification });
    send!(20_400);
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 20, message: "az is still running (20 s)" },
    });
    expect(progressSender({ sendNotification })).toBeUndefined();
    expect(progressSender(undefined)).toBeUndefined();
  });
});

describe("the egress guard's fail-fast (with a fake guard)", () => {
  function fakeProxy() {
    const listeners: Array<(id: string, e: EgressEvent) => void> = [];
    const ids: string[] = [];
    const records: EgressRecords = {
      refused: ["api.loganalytics.io"],
      upstream: [],
      housekeeping: [],
      allowed: 0,
    };
    const proxy: EgressProxy = {
      port: 9,
      envFor: (id) => {
        ids.push(id);
        return {
          HTTPS_PROXY: `http://${id}:x@127.0.0.1:9`,
          HTTP_PROXY: `http://${id}:x@127.0.0.1:9`,
        };
      },
      takeRecords: () => records,
      onEvent: (l) => {
        listeners.push(l);
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
      close: async () => undefined,
    };
    return {
      proxy,
      ids,
      emit: (e: EgressEvent) => listeners.forEach((l) => l(ids[0], e)),
      listeners,
    };
  }

  test("a refused host kills the call after the delay; the records come back", async () => {
    const fake = fakeProxy();
    const r = runner({ proxy: fake.proxy, timings: { failFastDelayMs: 100 } });
    setTimeout(() => fake.emit({ kind: "refused", host: "api.loganalytics.io" }), 300);
    const started = Date.now();
    const result = await r.run(["sleep", "20000"], { timeoutMs: 30_000, cwd: workdir });
    expect(result.failFast).toBe("refused");
    expect(result.timedOut).toBe(false);
    expect(result.egress.refused).toEqual(["api.loganalytics.io"]);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(fake.listeners).toHaveLength(0); // unsubscribed
  });

  test("a housekeeping refusal is not a trigger", async () => {
    const fake = fakeProxy();
    const r = runner({ proxy: fake.proxy, timings: { failFastDelayMs: 50 } });
    setTimeout(
      () => fake.emit({ kind: "housekeeping", host: "azcliprod.blob.core.windows.net" }),
      100
    );
    const result = await r.run(["sleep", "600"], { timeoutMs: 30_000, cwd: workdir });
    expect(result.failFast).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  test("the child's proxy variables carry the call tag", async () => {
    const fake = fakeProxy();
    const result = await runner({ proxy: fake.proxy }).run(["echo"], {
      timeoutMs: 10_000,
      cwd: workdir,
    });
    const env = JSON.parse(result.stdout).env;
    expect(env.HTTPS_PROXY).toBe(`http://${fake.ids[0]}:x@127.0.0.1:9`);
    expect(env.NO_PROXY).toBeUndefined();
  });
});

describe("the exit hook (review F27)", () => {
  // The tree sleeps a minute, far longer than the death wait: a pass means the kill worked,
  // never that the processes ended on their own. The generous waits only absorb a loaded
  // machine (the full suite, parallel workers).
  const SLEEP_MS = "60000";
  const DEATH_WAIT_MS = 15_000;

  test("killAllLiveTreesSync kills a live tree synchronously", async () => {
    const pids = path.join(root, "hook.json");
    const pending = run(["grandchild", pids, SLEEP_MS], {}, 120_000);
    expect(await waitUntil(() => existsSync(pids), 20_000)).toBe(true);
    const { root: rootPid, grandchild } = JSON.parse(readFileSync(pids, "utf8"));
    expect(process.listeners("exit")).toContain(killAllLiveTreesSync);
    killAllLiveTreesSync();
    await pending;
    expect(await waitUntil(() => !isAlive(rootPid) && !isAlive(grandchild), DEATH_WAIT_MS)).toBe(
      true
    );
  }, 90_000);

  test("the server process exiting mid-run leaves no descendant alive", async () => {
    // Bundle the runner and drive it from a separate Node process that exits the way
    // src/cli/lifecycle.ts does (process.exit while az runs).
    const { buildSync } = require("esbuild") as typeof import("esbuild");
    const bundle = path.join(root, "runner.bundle.js");
    buildSync({
      entryPoints: [path.join(__dirname, "runner.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "silent",
    });
    const pids = path.join(root, "exit.json");
    const driver = path.join(root, "driver.js");
    writeFileSync(
      driver,
      `const fs = require("fs");
const { HostRunner } = require(${JSON.stringify(bundle)});
const runner = new HostRunner({ exe: { file: process.execPath, prefixArgs: [${JSON.stringify(FAKE_AZ)}], installer: "explicit" }, env: ${JSON.stringify(baseEnv)} });
runner.run(["grandchild", ${JSON.stringify(pids)}, ${JSON.stringify(SLEEP_MS)}], { timeoutMs: 120000, cwd: ${JSON.stringify(workdir)} });
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(pids)})) { clearInterval(t); setTimeout(() => process.exit(0), 300); } }, 50);
`
    );
    const exited = childProcess.spawnSync(process.execPath, [driver], {
      timeout: 60_000,
      windowsHide: true,
    });
    expect(exited.status).toBe(0);
    const { root: rootPid, grandchild } = JSON.parse(readFileSync(pids, "utf8"));
    expect(await waitUntil(() => !isAlive(rootPid) && !isAlive(grandchild), DEATH_WAIT_MS)).toBe(
      true
    );
  }, 120_000);
});

describe("fail-fast with the real egress guard (U9, the runner integration)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startEgressProxy } = require("./egress-proxy") as typeof import("./egress-proxy");

  async function closedPort(): Promise<number> {
    const net = await import("net");
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    return port;
  }

  test("a CONNECT to a refused host is killed within about 2 s, and the records name the host", async () => {
    const proxy = await startEgressProxy();
    try {
      const started = Date.now();
      const result = await runner({ proxy }).run(["connect", "api.loganalytics.io:443", "30000"], {
        timeoutMs: 60_000,
        cwd: workdir,
      });
      const elapsed = Date.now() - started;
      expect(result.failFast).toBe("refused");
      expect(result.egress.refused).toEqual(["api.loganalytics.io"]);
      expect(result.stderr).toContain("403");
      expect(elapsed).toBeLessThan(6000);
    } finally {
      await proxy.close();
    }
  });

  test("a CONNECT to the emulator's name on a dead port is an upstream failure, killed fast", async () => {
    const proxy = await startEgressProxy();
    try {
      const port = await closedPort();
      const started = Date.now();
      const result = await runner({ proxy }).run(
        ["connect", `azure.localhost.localstack.cloud:${port}`, "30000"],
        {
          timeoutMs: 60_000,
          cwd: workdir,
        }
      );
      expect(result.failFast).toBe("upstream");
      expect(result.egress.upstream.join(" ")).toContain("azure.localhost.localstack.cloud");
      expect(result.stderr).toContain("502");
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      await proxy.close();
    }
  });

  test("a housekeeping host is refused but never triggers the fail-fast", async () => {
    const proxy = await startEgressProxy();
    try {
      const result = await runner({ proxy }).run(
        ["connect", "azcliprod.blob.core.windows.net:443", "1500"],
        {
          timeoutMs: 60_000,
          cwd: workdir,
        }
      );
      expect(result.failFast).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.egress.housekeeping).toEqual(["azcliprod.blob.core.windows.net"]);
      expect(result.egress.refused).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
