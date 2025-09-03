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
}

/**
 * Executes a command securely using spawn.
 * @param command The command to execute (e.g., 'tflocal').
 * @param args An array of string arguments.
 * @param options Spawn options including cwd, env, timeout, etc.
 * @returns A promise that resolves with the command result.
 */
export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const {
      timeout = DEFAULT_COMMAND_TIMEOUT,
      maxBuffer = DEFAULT_COMMAND_MAX_BUFFER,
      ...spawnOptions
    } = options;

    const child = spawn(command, args, {
      ...spawnOptions,
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      resolve({ stdout, stderr, error, exitCode: child.exitCode });
    });

    child.on("close", (code) => {
      let error: Error | undefined;
      if (code !== 0) {
        error = new Error(`Command failed with exit code ${code}: ${stderr.trim()}`);
      }
      resolve({ stdout, stderr, error, exitCode: code });
    });
  });
}

/**
 * Strip ANSI escape codes from command output for clean display.
 * This is the exact same function from the original deployment-utils.ts, now centralized.
 * @param text The text containing ANSI escape codes.
 * @returns Cleaned text without ANSI codes.
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
