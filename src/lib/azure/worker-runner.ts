import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { statSync } from "fs";
import {
  DEFAULT_TIMINGS,
  emptyEgressRecords,
  killTree,
  MAX_STREAM_BYTES,
  runSlots,
  trackChild,
  untrackChild,
  type KillStep,
  type RunnerTimings,
} from "./runner";
import { interpreterFlags } from "./resolve-az";
import type { AzExecutable, AzRunner, AzRunOptions, AzRunResult, EgressProxy } from "./types";
import { WORKER_CODE } from "./worker-script";

/**
 * The warm az worker (optional; LOCALSTACK_AZ_RUNNER=worker). A long-running Python child
 * imports azure-cli once and runs each command in-process, so a call costs the command, not
 * the interpreter start and the imports.
 *
 * The containment is the subprocess runner's: the same child environment (private home,
 * the tool's own AZURE_CONFIG_DIR), one egress-guard call tag per command, the same timeout,
 * cancel and fail-fast (by killing the worker's tree), the same output caps and the same
 * limit of four runs at once. Worker state never outlives what a fresh process would read
 * from disk: a worker is replaced after 200 commands, after any command that writes CLI
 * state, and whenever a profile file changed since it started (the bootstrap, a self-heal).
 */

/**
 * Command prefixes that write the CLI's own state; a worker that ran one is replaced. The
 * policy refuses most of them anyway: this is the second line.
 */
const STATE_WRITERS = [
  "account clear",
  "account set",
  "bicep install",
  "bicep uninstall",
  "bicep upgrade",
  "cloud",
  "config",
  "configure",
  "extension",
  "init",
  "login",
  "logout",
];

export const WORKER_MAX_COMMANDS = 200;

export interface WorkerRunnerOptions {
  /** The CLI's Python and its spawn prefix; never a launcher run as-is. */
  exe: AzExecutable;
  env: Record<string, string>;
  proxy?: EgressProxy;
  platform?: NodeJS.Platform;
  timings?: Partial<RunnerTimings>;
  maxStreamBytes?: number;
  maxCommandsPerWorker?: number;
  /** Profile files whose change replaces the workers (config, clouds.config, azureProfile.json). */
  stateFiles?: string[];
  /** How long a new worker may take to import azure-cli. */
  startTimeoutMs?: number;
  /** Tests: the worker program instead of `-c WORKER_CODE`. */
  workerArgs?: string[];
  /** Used from the first worker that cannot start on: this Python cannot run the worker. */
  fallback?: AzRunner;
  taskkill?: string;
  onKillStep?: (step: KillStep, status?: number) => void;
  log?: (line: string) => void;
}

interface Reply {
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function writesCliState(argv: string[]): boolean {
  return STATE_WRITERS.some((prefix) => {
    const words = prefix.split(" ");
    return words.every((word, i) => argv[i] === word);
  });
}

/** How long kill() waits for a killed worker's exit event before it gives up waiting. */
const KILL_EXIT_WAIT_MS = 5_000;

/** `ready`, or a rejection as soon as `signal` aborts: a cancel during a cold start. */
function readyOrAborted(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return ready;
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class Worker {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  /** Settles when the process has exited (or failed to spawn). */
  readonly exited: Promise<void>;
  commands = 0;
  dead = false;
  private buffer = "";
  private stderrTail = "";
  private onReply?: (reply: Reply) => void;
  private onDeath?: (why: string) => void;

  constructor(
    readonly stamp: string,
    spawnArgs: { file: string; args: string[]; env: Record<string, string>; cwd: string },
    private readonly platform: NodeJS.Platform,
    startTimeoutMs: number
  ) {
    this.child = spawn(spawnArgs.file, spawnArgs.args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnArgs.env,
      cwd: spawnArgs.cwd,
      detached: platform !== "win32",
    });
    trackChild(this.child, platform);
    this.child.stdin?.on("error", () => undefined);
    this.child.stdout?.on("error", () => undefined);
    this.child.stderr?.on("error", () => undefined);
    this.child.stderr?.on("data", (d: Buffer) => {
      // Outside a command only the worker itself writes here (an import error, a crash).
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-2000);
    });

    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let exitedResolve: () => void;
    this.exited = new Promise<void>((resolve) => {
      exitedResolve = resolve;
    });
    // A worker that dies after starting rejects a promise nobody awaits any more.
    this.ready.catch(() => undefined);
    const startTimer = setTimeout(() => {
      readyReject(new Error(`the az worker did not start within ${startTimeoutMs} ms`));
      this.stop();
    }, startTimeoutMs);

    this.child.stdout?.on("data", (d: Buffer) => {
      this.buffer += d.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.ready === true) {
          clearTimeout(startTimer);
          readyResolve();
        } else if (typeof message.id === "string") {
          this.onReply?.(message as unknown as Reply);
        }
      }
    });
    const died = (why: string) => {
      if (this.dead) return;
      this.dead = true;
      exitedResolve();
      clearTimeout(startTimer);
      untrackChild(this.child);
      const detail = this.stderrTail.trim();
      readyReject(new Error(`the az worker exited (${why})${detail ? `: ${detail}` : ""}`));
      this.onDeath?.(why);
    };
    this.child.on("error", (error) => died(error.message));
    this.child.on("exit", (code, signal) => died(signal ? `signal ${signal}` : `exit ${code}`));
  }

  /** Sends one command; resolves with the reply, or rejects when the worker dies first. */
  send(request: { id: string; argv: string[]; cwd: string; env: Record<string, string> }) {
    return new Promise<Reply>((resolve, reject) => {
      this.onReply = (reply) => {
        if (reply.id !== request.id) return;
        this.onReply = undefined;
        this.onDeath = undefined;
        resolve(reply);
      };
      this.onDeath = (why) => reject(new Error(`the az worker exited (${why})`));
      this.child.stdin?.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * Kills the tree and waits (bounded) for the exit: on POSIX killTree only sends SIGTERM, and on
   * Windows taskkill's own exit can come first, so "closed" would otherwise not mean gone.
   */
  async kill(opts: {
    taskkill?: string;
    posixKillGraceMs: number;
    onKillStep?: WorkerRunnerOptions["onKillStep"];
  }): Promise<void> {
    if (this.dead) return;
    await killTree(this.child, { platform: this.platform, ...opts });
    let timer: NodeJS.Timeout | undefined;
    const bound = Math.max(KILL_EXIT_WAIT_MS, opts.posixKillGraceMs + 2_000);
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, bound);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  /** A clean stop: end stdin, so the command loop ends and Python exits. */
  stop() {
    if (this.dead) return;
    this.child.stdin?.end();
    const timer = setTimeout(() => {
      if (!this.dead) this.child.kill();
    }, 5000);
    timer.unref();
  }
}

export class WorkerRunner implements AzRunner {
  private readonly timings: RunnerTimings;
  private readonly idle: Worker[] = [];
  private readonly all = new Set<Worker>();
  private disabled = false;

  constructor(private readonly opts: WorkerRunnerOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  }

  /** Live workers (tests). */
  get workerCount(): number {
    return [...this.all].filter((w) => !w.dead).length;
  }

  async run(argv: string[], o: AzRunOptions): Promise<AzRunResult> {
    if (!this.opts.env.AZURE_CONFIG_DIR) {
      // Containment layer 1: never run az against the user's own profile.
      throw new Error("Refusing to run az without an isolated AZURE_CONFIG_DIR.");
    }
    if (this.disabled && this.opts.fallback) return this.opts.fallback.run(argv, o);
    const acquired = await runSlots.acquire(o.signal);
    if (!acquired) return this.result({ aborted: true });
    let result: AzRunResult | "fallback";
    try {
      result = await this.runOnce(argv, o);
    } finally {
      runSlots.release();
    }
    return result === "fallback" ? this.opts.fallback!.run(argv, o) : result;
  }

  /** Stops every worker (tests, and resetAzureServices). */
  async close(): Promise<void> {
    const workers = [...this.all];
    this.idle.length = 0;
    this.all.clear();
    await Promise.all(workers.map((w) => w.kill(this.killOpts())));
  }

  private killOpts() {
    return {
      taskkill: this.opts.taskkill,
      posixKillGraceMs: this.timings.posixKillGraceMs,
      onKillStep: this.opts.onKillStep,
    };
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

  /** Modification stamp of the profile files: a change means a worker is out of date. */
  private stateStamp(): string {
    return (this.opts.stateFiles ?? [])
      .map((file) => {
        try {
          const s = statSync(file);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return "-";
        }
      })
      .join("|");
  }

  private retire(worker: Worker) {
    this.all.delete(worker);
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    worker.stop();
  }

  private async acquireWorker(cwd: string): Promise<Worker> {
    const stamp = this.stateStamp();
    while (this.idle.length > 0) {
      const worker = this.idle.pop()!;
      if (!worker.dead && worker.stamp === stamp) return worker;
      this.retire(worker);
    }
    const platform = this.opts.platform ?? process.platform;
    const worker = new Worker(
      stamp,
      {
        file: this.opts.exe.file,
        args: this.opts.workerArgs ?? [
          ...interpreterFlags(this.opts.exe.prefixArgs),
          "-c",
          WORKER_CODE,
        ],
        env: {
          ...this.opts.env,
          LOCALSTACK_AZ_WORKER_MAX_BYTES: String(this.opts.maxStreamBytes ?? MAX_STREAM_BYTES),
        },
        cwd,
      },
      platform,
      this.opts.startTimeoutMs ?? 120_000
    );
    this.all.add(worker);
    return worker;
  }

  private async runOnce(argv: string[], o: AzRunOptions): Promise<AzRunResult | "fallback"> {
    const started = Date.now();
    if (o.signal?.aborted) return this.result({ aborted: true });
    const { proxy } = this.opts;
    const callId = randomUUID();
    const env = proxy ? proxy.envFor(callId) : {};
    const takeEgress = () => (proxy ? proxy.takeRecords(callId) : emptyEgressRecords());

    let worker: Worker | undefined;
    try {
      worker = await this.acquireWorker(o.cwd);
      // A cancel during a cold start must not leave the command to run once the worker is up.
      await readyOrAborted(worker.ready, o.signal);
      if (o.signal?.aborted) throw new Error("aborted");
    } catch (error) {
      if (o.signal?.aborted) {
        if (worker) {
          this.all.delete(worker);
          void worker.kill(this.killOpts());
        }
        return this.result({
          aborted: true,
          durationMs: Date.now() - started,
          egress: takeEgress(),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.opts.fallback) {
        // This Python cannot run the worker: every later command runs as a subprocess.
        this.disabled = true;
        this.opts.log?.(`${message}; running az as a subprocess from now on`);
        takeEgress();
        return "fallback";
      }
      return this.result({
        spawnError: message,
        durationMs: Date.now() - started,
        egress: takeEgress(),
      });
    }

    const timers: NodeJS.Timeout[] = [];
    let timedOut = false;
    let aborted = false;
    let failFast: AzRunResult["failFast"];
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      this.all.delete(worker);
      void worker.kill(this.killOpts());
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(
      setTimeout(() => {
        timedOut = true;
        kill();
      }, o.timeoutMs)
    );
    if (o.onProgress) {
      const onProgress = o.onProgress;
      timers.push(
        setInterval(() => onProgress(Date.now() - started), this.timings.progressIntervalMs)
      );
    }
    // Fail fast, as the subprocess runner does: after a refused host or a
    // failed upstream, kill the worker's tree instead of waiting out the SDK's retries.
    const unsubscribe = proxy?.onEvent((id, event) => {
      if (id !== callId || failFast || (event.kind !== "refused" && event.kind !== "upstream"))
        return;
      const kind = event.kind;
      timers.push(
        setTimeout(() => {
          failFast = kind;
          kill();
        }, this.timings.failFastDelayMs)
      );
    });

    try {
      const reply = await worker.send({ id: callId, argv, cwd: o.cwd, env });
      worker.commands++;
      const replace =
        worker.commands >= (this.opts.maxCommandsPerWorker ?? WORKER_MAX_COMMANDS) ||
        writesCliState(argv) ||
        reply.truncated;
      if (replace) this.retire(worker);
      else this.idle.push(worker);
      return this.result({
        exitCode: reply.exitCode,
        stdout: reply.stdout,
        stderr: reply.stderr,
        truncated: reply.truncated,
        durationMs: Date.now() - started,
        egress: takeEgress(),
        failFast,
      });
    } catch (error) {
      // The worker died mid-command: killed by the tool (timeout, cancel, fail-fast) or crashed.
      this.all.delete(worker);
      const stoppedByTool = timedOut || aborted || failFast !== undefined;
      return this.result({
        exitCode: null,
        stderr: stoppedByTool ? "" : error instanceof Error ? error.message : String(error),
        timedOut,
        aborted,
        failFast,
        durationMs: Date.now() - started,
        egress: takeEgress(),
      });
    } finally {
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
    }
  }
}
