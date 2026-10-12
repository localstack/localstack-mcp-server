import { spawn, spawnSync, type ChildProcess } from "child_process";
import path from "path";
import { StringDecoder } from "string_decoder";
import type { AzExecutable } from "./resolve-az";

/**
 * Runs one `az` process. The shared core/command-runner.ts is not used: it decodes each chunk on
 * its own (a character split at a chunk boundary becomes U+FFFD), resolves on 'close' (a
 * grandchild holding the pipe keeps it waiting past its timeout), and stops only the process it
 * started, while the Debian package's `az` is a bash script whose Python would keep running.
 */

/** Byte cap per stream; a breach stops `az` and marks the result truncated. */
export const MAX_STREAM_BYTES = 10 * 1024 * 1024;
/** After `'exit'`, how long the pipes may take to drain before they are destroyed. */
const DRAIN_GRACE_MS = 1000;

export interface AzRunOptions {
  timeoutMs: number;
  cwd: string;
  signal?: AbortSignal;
  /** Tests only. */
  maxStreamBytes?: number;
}

export interface AzRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /** The spawn itself failed (ENOENT, EINVAL, ...). */
  spawnError?: string;
}

const TASKKILL = path.win32.join(
  process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
  "System32",
  "taskkill.exe"
);

/**
 * Stops `az` and everything it started, at once (az has no cleanup to wait for). Windows:
 * `taskkill /T /F` while the root still lives, or its tree cannot be found. POSIX: SIGKILL to the
 * child's own process group (it is spawned `detached` to lead one).
 */
function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (!child.pid) return;
  try {
    if (platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
    const args = ["/PID", String(child.pid), "/T", "/F"];
    if (spawnSync(TASKKILL, args, { windowsHide: true, stdio: "ignore" }).status === 0) return;
  } catch {
    // the group is gone, or taskkill could not run: the child alone below
  }
  child.kill("SIGKILL");
}

export function runAz(
  exe: AzExecutable,
  env: Record<string, string>,
  argv: string[],
  opts: AzRunOptions,
  platform: NodeJS.Platform = process.platform
): Promise<AzRunResult> {
  // Never against the user's own Azure CLI profile.
  if (!env.AZURE_CONFIG_DIR) {
    throw new Error("Refusing to run az without the tool's own AZURE_CONFIG_DIR.");
  }
  const result = (fields: Partial<AzRunResult>): AzRunResult => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
    ...fields,
  });
  if (opts.signal?.aborted) return Promise.resolve(result({ aborted: true }));

  let child: ChildProcess;
  try {
    child = spawn(exe.file, [...exe.prefixArgs, ...argv], {
      shell: false,
      windowsHide: true,
      // Not "ignore": on Windows that is NUL, which Python treats as a tty, so prompts would leak
      // into stdout.
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: opts.cwd,
      // POSIX: its own process group, which killTree stops as a whole.
      detached: platform !== "win32",
    });
  } catch (error) {
    // EINVAL (a .cmd or .bat file) and ENAMETOOLONG are thrown synchronously.
    return Promise.resolve(result({ spawnError: (error as Error).message }));
  }

  return new Promise<AzRunResult>((resolve) => {
    const maxBytes = opts.maxStreamBytes ?? MAX_STREAM_BYTES;
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    let exited = false;
    let killing = false;
    let exitCode: number | null = null;
    let timedOut = false;
    let aborted = false;
    const stream = () => ({
      decoder: new StringDecoder("utf8"),
      text: "",
      bytes: 0,
      ended: false,
      capped: false,
    });
    const streams = { stdout: stream(), stderr: stream() };

    const kill = () => {
      if (killing || exited) return;
      killing = true;
      killTree(child, platform);
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (fields: Partial<AzRunResult> = {}) => {
      if (settled) return;
      settled = true;
      timers.forEach((timer) => clearTimeout(timer));
      opts.signal?.removeEventListener("abort", onAbort);
      // A capped stream ends mid-character: its tail is dropped rather than decoded as U+FFFD.
      for (const s of Object.values(streams)) if (!s.capped) s.text += s.decoder.end();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve(
        result({
          exitCode,
          stdout: streams.stdout.text,
          stderr: streams.stderr.text,
          timedOut,
          aborted,
          truncated: streams.stdout.capped || streams.stderr.capped,
          ...fields,
        })
      );
    };
    const maybeFinish = () => {
      if (exited && streams.stdout.ended && streams.stderr.ended) finish();
    };

    child.on("error", (error) => {
      // The asynchronous form of a failed start (ENOENT).
      if (child.pid === undefined) finish({ spawnError: (error as Error).message });
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      // A grandchild holding the pipe would otherwise keep the streams from ever ending.
      timers.push(setTimeout(() => finish(), DRAIN_GRACE_MS));
      maybeFinish();
    });
    for (const name of ["stdout", "stderr"] as const) {
      const s = streams[name];
      const pipe = child[name];
      pipe?.on("error", () => undefined);
      pipe?.on("end", () => {
        s.ended = true;
        maybeFinish();
      });
      pipe?.on("data", (chunk: Buffer) => {
        if (s.capped) return;
        const room = maxBytes - s.bytes;
        if (chunk.length > room) {
          s.text += s.decoder.write(chunk.subarray(0, room));
          s.capped = true;
          kill();
          return;
        }
        s.bytes += chunk.length;
        s.text += s.decoder.write(chunk);
      });
    }
    // A stdin already at EOF: `az` can neither block on a prompt nor read the server's JSON-RPC.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();

    timers.push(
      setTimeout(() => {
        if (exited) return; // az finished; only the pipes are still draining
        timedOut = true;
        kill();
      }, opts.timeoutMs)
    );
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
