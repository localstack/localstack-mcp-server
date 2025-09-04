import { spawn, SpawnOptions } from "child_process";
import { DEFAULT_COMMAND_TIMEOUT, DEFAULT_COMMAND_MAX_BUFFER } from "./config";

export interface CommandResult {
  stdout: string;
  stderr: string;
  error?: Error;
  exitCode: number | null;
}

export interface CommandOptions extends SpawnOptions {
  timeout?: number;
  maxBuffer?: number;
  onData?: (chunk: string, type: "stdout" | "stderr") => void;
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const {
      timeout = DEFAULT_COMMAND_TIMEOUT,
      maxBuffer = DEFAULT_COMMAND_MAX_BUFFER,
      onData,
      ...spawnOptions
    } = options;

    const child = spawn(command, args, { ...spawnOptions });

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let bufferExceeded = false;
    let error: Error | undefined;

    const killProcess = (reason: string) => {
      if (child.killed) return;
      error = new Error(reason);
      child.kill(spawnOptions.killSignal ?? "SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(`Command timed out after ${timeout}ms`);
    }, timeout);

    const onChunk = (isStdout: boolean) => (chunk: Buffer) => {
      if (timedOut || bufferExceeded) return;
      const len = chunk.length;
      if (isStdout) {
        outBytes += len;
        const data = chunk.toString();
        stdout += data;
        if (onData) onData(data, "stdout");
        if (outBytes > maxBuffer) {
          bufferExceeded = true;
          killProcess(`stdout exceeded maxBuffer size of ${maxBuffer} bytes`);
        }
      } else {
        errBytes += len;
        const data = chunk.toString();
        stderr += data;
        if (onData) onData(data, "stderr");
        if (errBytes > maxBuffer) {
          bufferExceeded = true;
          killProcess(`stderr exceeded maxBuffer size of ${maxBuffer} bytes`);
        }
      }
    };

    child.stdout?.on("data", onChunk(true));
    child.stderr?.on("data", onChunk(false));

    child.on("error", (err) => {
      error = err;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!timedOut && !bufferExceeded && code !== 0 && !error) {
        error = new Error(`Command failed with exit code ${code}: ${stderr.trim()}`);
      }
      resolve({ stdout, stderr, error, exitCode: code });
    });
  });
}

export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
