import { spawn, spawnSync, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { StringDecoder } from "string_decoder";
import type {
  AzExecutable,
  AzRunner,
  AzRunOptions,
  AzRunResult,
  EgressProxy,
  EgressRecords,
} from "./types";

/**
 * The dedicated `az` runner (plan task 2.4, Appendix B.4; check C03). The shared
 * `core/command-runner.ts` is not used: it decodes per chunk (a character split at a
 * 64 KB chunk boundary becomes U+FFFD), resolves on `'close'` (a grandchild holding
 * the pipe makes it hang past its timeout), and its SIGKILL escalation never runs.
 */

/** Byte cap per stream; a breach kills the tree and marks the result truncated. */
export const MAX_STREAM_BYTES = 10 * 1024 * 1024;
/** `spawn()` throws ENAMETOOLONG at 32,767 UTF-16 units for the whole command line (C03). */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_000;
/** At most four `az` runs at once per server process (research 09 §8, R8). */
export const MAX_CONCURRENT_RUNS = 4;

export interface RunnerTimings {
  /** After `'exit'`, how long to wait for the pipes before destroying them. */
  drainGraceMs: number;
  /** POSIX: SIGTERM to the group, then SIGKILL after this. */
  posixKillGraceMs: number;
  /** After a refused egress or a failed upstream, how long before the tree is killed. */
  failFastDelayMs: number;
  progressIntervalMs: number;
}

export const DEFAULT_TIMINGS: RunnerTimings = {
  drainGraceMs: 1000,
  posixKillGraceMs: 2000,
  failFastDelayMs: 1000,
  progressIntervalMs: 10_000,
};

export const emptyEgressRecords = (): EgressRecords => ({
  refused: [],
  upstream: [],
  housekeeping: [],
  allowed: 0,
});

/** A counting semaphore; `acquire` resolves false when the signal aborts first. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve(true);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** Shared by every runner (the worker too): at most four az runs at once. */
export const runSlots = new Semaphore(MAX_CONCURRENT_RUNS);

/** Runs in flight in this process (tests). */
export function activeRuns(): number {
  return runSlots.inUse;
}

// ---------------------------------------------------------------------------
// Killing process trees
// ---------------------------------------------------------------------------

/** Absolute, so PATH cannot substitute it; a reduced environment may lack SystemRoot. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(root, "System32", "taskkill.exe");
}

export type KillStep = "taskkill" | "kill" | "sigterm" | "sigkill";

export interface KillOptions {
  platform: NodeJS.Platform;
  taskkill?: string;
  posixKillGraceMs?: number;
  onKillStep?: (step: KillStep, status?: number) => void;
}

function runTaskkill(file: string, pid: number): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a child and everything it started (C03 §6).
 * - Windows: `taskkill /PID <pid> /T /F` FIRST, while the root is alive; once the
 *   root is gone taskkill can no longer find the tree (exit 128) and orphans keep
 *   the pipe open. It runs through an awaited asynchronous spawn, so the event loop,
 *   and the in-process egress guard with it, is not blocked for its ~0.4 s. Then
 *   `child.kill()` only if taskkill failed. The kill list is never built by walking
 *   parent PIDs, which C03 showed to be unsafe under PID reuse.
 * - POSIX: the child leads its own process group (`detached`): SIGTERM to the group,
 *   then SIGKILL after a grace period.
 */
export async function killTree(child: ChildProcess, opts: KillOptions): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (opts.platform === "win32") {
    const status = await runTaskkill(opts.taskkill ?? taskkillPath(), pid);
    opts.onKillStep?.("taskkill", status);
    if (status !== 0) {
      opts.onKillStep?.("kill");
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    return;
  }
  opts.onKillStep?.("sigterm");
  if (!signalGroup(pid, "SIGTERM")) child.kill("SIGTERM");
  setTimeout(() => {
    opts.onKillStep?.("sigkill");
    // The group id cannot be reused while any member lives, so this reaches only
    // the tree this runner started.
    signalGroup(pid, "SIGKILL");
  }, opts.posixKillGraceMs ?? DEFAULT_TIMINGS.posixKillGraceMs).unref();
}

/** The synchronous form, for `process.on("exit")`, where nothing asynchronous runs. */
export function killTreeSync(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    const result = spawnSync(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
    });
    if (result.status !== 0) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    return;
  }
  if (!signalGroup(pid, "SIGKILL")) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

// A registry of live children. The server exits 1.25 s after the client closes
// stdin (src/cli/lifecycle.ts); an interrupted `aks create` would otherwise keep
// changing the emulator (C07; review F27).
const liveChildren = new Map<ChildProcess, NodeJS.Platform>();
const TERMINATING_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
let exitHookInstalled = false;
let signalHooksInstalled = false;

/** Kill every live `az` tree now (the exit hook; exported for tests). */
export function killAllLiveTreesSync(): void {
  for (const [child, platform] of liveChildren) killTreeSync(child, platform);
  liveChildren.clear();
}

function onTerminatingSignal(signal: NodeJS.Signals) {
  killAllLiveTreesSync();
  removeSignalHooks();
  // Re-raise, so the default action (or another handler) still ends the server.
  process.kill(process.pid, signal);
}

function removeSignalHooks() {
  if (!signalHooksInstalled) return;
  signalHooksInstalled = false;
  for (const signal of TERMINATING_SIGNALS) process.removeListener(signal, onTerminatingSignal);
}

export function trackChild(child: ChildProcess, platform: NodeJS.Platform) {
  liveChildren.set(child, platform);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killAllLiveTreesSync);
  }
  // POSIX children lead their own process group, so a signal that ends the server
  // would not reach them. The hooks exist only while a child is live, because a
  // listener suppresses a signal's default action.
  if (platform !== "win32" && !signalHooksInstalled) {
    signalHooksInstalled = true;
    for (const signal of TERMINATING_SIGNALS) process.on(signal, onTerminatingSignal);
  }
}

export function untrackChild(child: ChildProcess) {
  liveChildren.delete(child);
  if (liveChildren.size === 0) removeSignalHooks();
}

/** Live children in this process (tests). */
export function liveChildCount(): number {
  return liveChildren.size;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** libuv's quoting of one argument for the Windows command line (quote_cmd_arg). */
export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\t "]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let quoted = "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `"${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function windowsCommandLineLength(file: string, args: string[]): number {
  return [file, ...args].map(quoteWindowsArg).join(" ").length;
}

function describeSpawnError(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return e?.code ? `${e.code}: ${e.message}` : String(error);
}

export interface HostRunnerOptions {
  exe: AzExecutable;
  /** The child environment from buildAzChildEnv(); must carry AZURE_CONFIG_DIR. */
  env: Record<string, string>;
  /** Containment layer 4; undefined only with LOCALSTACK_AZ_EGRESS_GUARD=0. */
  proxy?: EgressProxy;
  platform?: NodeJS.Platform;
  timings?: Partial<RunnerTimings>;
  maxStreamBytes?: number;
  /** Tests: another taskkill binary, and a hook that records the kill steps. */
  taskkill?: string;
  onKillStep?: (step: KillStep, status?: number) => void;
}

export class HostRunner implements AzRunner {
  private readonly timings: RunnerTimings;

  constructor(private readonly opts: HostRunnerOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  }

  async run(argv: string[], o: AzRunOptions): Promise<AzRunResult> {
    if (!this.opts.env.AZURE_CONFIG_DIR) {
      // Containment layer 1: never run az against the user's own profile.
      throw new Error("Refusing to run az without an isolated AZURE_CONFIG_DIR.");
    }
    const acquired = await runSlots.acquire(o.signal);
    if (!acquired) return this.result({ aborted: true });
    try {
      return await this.runOnce(argv, o);
    } finally {
      runSlots.release();
    }
  }

  private result(fields: Partial<AzRunResult>): AzRunResult {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 0,
      egress: emptyEgressRecords(),
      ...fields,
    };
  }

  private runOnce(argv: string[], o: AzRunOptions): Promise<AzRunResult> {
    const { exe, proxy } = this.opts;
    const platform = this.opts.platform ?? process.platform;
    const maxBytes = this.opts.maxStreamBytes ?? MAX_STREAM_BYTES;
    const started = Date.now();
    if (o.signal?.aborted) return Promise.resolve(this.result({ aborted: true }));

    const args = [...exe.prefixArgs, ...argv];
    if (
      platform === "win32" &&
      windowsCommandLineLength(exe.file, args) > WINDOWS_COMMAND_LINE_LIMIT
    ) {
      return Promise.resolve(this.result({ tooLong: true }));
    }

    // Not a secret: Bicep's BCP192 error prints the proxy URL, tag included (C08).
    const callId = randomUUID();
    const env = proxy ? { ...this.opts.env, ...proxy.envFor(callId) } : this.opts.env;
    const takeEgress = () => (proxy ? proxy.takeRecords(callId) : emptyEgressRecords());

    let child: ChildProcess;
    try {
      child = spawn(exe.file, args, {
        shell: false,
        windowsHide: true,
        // Not "ignore": on Windows that is NUL, which Python treats as a tty, so
        // prompts would leak into stdout (C03 §7).
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: o.cwd,
        detached: platform !== "win32",
      });
    } catch (error) {
      // EINVAL (a .cmd/.bat file) and ENAMETOOLONG are thrown synchronously.
      return Promise.resolve(
        this.result({
          spawnError: describeSpawnError(error),
          durationMs: Date.now() - started,
          egress: takeEgress(),
        })
      );
    }

    return new Promise<AzRunResult>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      let settled = false;
      let exited = false;
      let exitCode: number | null = null;
      let killing = false;
      let timedOut = false;
      let aborted = false;
      let failFast: AzRunResult["failFast"];
      let unsubscribe: (() => void) | undefined;
      const streams = {
        stdout: {
          decoder: new StringDecoder("utf8"),
          text: "",
          bytes: 0,
          ended: false,
          capped: false,
        },
        stderr: {
          decoder: new StringDecoder("utf8"),
          text: "",
          bytes: 0,
          ended: false,
          capped: false,
        },
      };

      const kill = () => {
        if (killing || exited) return;
        killing = true;
        void killTree(child, {
          platform,
          taskkill: this.opts.taskkill,
          posixKillGraceMs: this.timings.posixKillGraceMs,
          onKillStep: this.opts.onKillStep,
        });
      };

      const finish = (fields: Partial<AzRunResult> = {}) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        o.signal?.removeEventListener("abort", onAbort);
        unsubscribe?.();
        untrackChild(child);
        for (const s of Object.values(streams)) {
          // A capped stream ends mid-character: its tail is dropped, not decoded as U+FFFD.
          if (!s.capped) s.text += s.decoder.end();
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        resolve(
          this.result({
            exitCode,
            stdout: streams.stdout.text,
            stderr: streams.stderr.text,
            timedOut,
            aborted,
            truncated: streams.stdout.capped || streams.stderr.capped,
            durationMs: Date.now() - started,
            egress: takeEgress(),
            failFast,
            ...fields,
          })
        );
      };

      const maybeFinish = () => {
        if (exited && streams.stdout.ended && streams.stderr.ended) finish();
      };

      const onAbort = () => {
        aborted = true;
        kill();
      };

      trackChild(child, platform);

      child.on("error", (error) => {
        // The async form of a failed start (ENOENT for an extensionless script);
        // "file missing" is not implied (C03 §1.4).
        if (child.pid === undefined) finish({ spawnError: describeSpawnError(error) });
      });
      child.on("exit", (code) => {
        exited = true;
        exitCode = code;
        // Resolve once the pipes drain, or after the grace: a grandchild holding the
        // pipe would otherwise keep 'close' from ever firing (C03 §6).
        timers.push(setTimeout(() => finish(), this.timings.drainGraceMs));
        maybeFinish();
      });

      for (const [name, stream] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ] as const) {
        const s = streams[name];
        stream?.on("error", () => undefined);
        stream?.on("end", () => {
          s.ended = true;
          maybeFinish();
        });
        stream?.on("data", (chunk: Buffer) => {
          if (s.capped) return;
          const room = maxBytes - s.bytes;
          if (chunk.length > room) {
            s.text += s.decoder.write(chunk.subarray(0, room));
            s.bytes = maxBytes;
            s.capped = true;
            kill();
            return;
          }
          s.bytes += chunk.length;
          s.text += s.decoder.write(chunk);
        });
      }

      // The child sees a non-tty stdin already at EOF: it can neither block on a
      // prompt nor read the server's JSON-RPC stream.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end();

      timers.push(
        setTimeout(() => {
          timedOut = true;
          kill();
        }, o.timeoutMs)
      );
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.onProgress) {
        const onProgress = o.onProgress;
        timers.push(
          setInterval(() => onProgress(Date.now() - started), this.timings.progressIntervalMs)
        );
      }

      // Fail fast (review F06): after a refused host or a failed upstream, SDK paths
      // retry for about 87 s and then print an error without the host in it.
      unsubscribe = proxy?.onEvent((id, event) => {
        if (id !== callId || failFast || (event.kind !== "refused" && event.kind !== "upstream"))
          return;
        const kind = event.kind;
        timers.push(
          setTimeout(() => {
            if (exited) return;
            failFast = kind;
            kill();
          }, this.timings.failFastDelayMs)
        );
      });
    });
  }
}

/**
 * `notifications/progress` every 10 s while `az` runs, when the client asked for
 * progress (plan task 2.12). Undefined without a progress token.
 */
export function progressSender(extra?: {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: unknown) => Promise<void>;
}): ((elapsedMs: number) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return undefined;
  return (elapsedMs) => {
    const seconds = Math.round(elapsedMs / 1000);
    void send({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: seconds,
        message: `az is still running (${seconds} s)`,
      },
    }).catch(() => undefined);
  };
}
