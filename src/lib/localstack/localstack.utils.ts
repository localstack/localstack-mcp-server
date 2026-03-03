import { spawn } from "child_process";
import { runCommand } from "../../core/command-runner";
import { ResponseBuilder } from "../../core/response-builder";

export interface LocalStackCliCheckResult {
  isAvailable: boolean;
  version?: string;
  errorMessage?: string;
}

/**
 * Check if LocalStack CLI is installed and available in the system PATH
 * @returns Promise with availability status, version (if available), and error message (if not available)
 */
export async function checkLocalStackCli(): Promise<LocalStackCliCheckResult> {
  try {
    await runCommand("localstack", ["--help"]);
    const { stdout: version } = await runCommand("localstack", ["--version"]);

    return {
      isAvailable: true,
      version: version.trim(),
    };
  } catch (error) {
    return {
      isAvailable: false,
      errorMessage: `❌ LocalStack CLI is not installed or not available in PATH.

Please install LocalStack by following the official documentation:
https://docs.localstack.cloud/aws/getting-started/installation/

Installation options:
- Using pip: pip install localstack
- Using Docker: Use the LocalStack Docker image
- Using Homebrew (macOS): brew install localstack/tap/localstack-cli

After installation, make sure the 'localstack' command is available in your PATH.`,
    };
  }
}

export interface LocalStackStatusResult {
  isRunning: boolean;
  statusOutput?: string;
  errorMessage?: string;
  isReady?: boolean;
}

export interface SnowflakeStatusResult {
  isRunning: boolean;
  statusOutput?: string;
  errorMessage?: string;
  isReady?: boolean;
}

export interface RuntimeStatus {
  isRunning: boolean;
  isReady?: boolean;
  statusOutput?: string;
}

/**
 * Get LocalStack status information
 * @returns Promise with status details including running state and raw output
 */
export async function getLocalStackStatus(): Promise<LocalStackStatusResult> {
  try {
    const { stdout } = await runCommand("localstack", ["status"]);

    const isRunning = stdout.includes("running");
    const isReady = stdout.includes("Ready") || stdout.includes("ready");

    return {
      isRunning,
      isReady,
      statusOutput: stdout.trim(),
    };
  } catch (error) {
    return {
      isRunning: false,
      errorMessage: `Failed to get LocalStack status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get Snowflake emulator status information by checking the Snowflake session endpoint
 * @returns Promise with status details including running state and raw output
 */
export async function getSnowflakeEmulatorStatus(): Promise<SnowflakeStatusResult> {
  try {
    const { stdout, stderr, error, exitCode } = await runCommand("curl", [
      "-sS",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      "{}",
      "snowflake.localhost.localstack.cloud:4566/session",
    ]);

    const output = (stdout || "").trim();
    const isSuccess = /"success"\s*:\s*true/.test(output);

    return {
      isRunning: exitCode === 0 && isSuccess,
      isReady: exitCode === 0 && isSuccess,
      statusOutput: output || stderr.trim(),
      ...(error
        ? {
            errorMessage: `Failed to reach Snowflake emulator endpoint: ${error.message}`,
          }
        : {}),
    };
  } catch (error) {
    return {
      isRunning: false,
      errorMessage: `Failed to get Snowflake emulator status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Start a LocalStack runtime flavor and poll until it becomes available.
 * Supports custom startup args (e.g. default stack vs Snowflake stack), optional
 * environment overrides, and optional post-start validation hooks.
 */
export async function startRuntime({
  startArgs,
  getStatus,
  processLabel,
  alreadyRunningMessage,
  successTitle,
  statusHeading,
  timeoutMessage,
  envVars,
  onReady,
}: {
  startArgs: string[];
  getStatus: () => Promise<RuntimeStatus>;
  processLabel: string;
  alreadyRunningMessage: string;
  successTitle: string;
  statusHeading: string;
  timeoutMessage: string;
  envVars?: Record<string, string>;
  onReady?: () => Promise<ReturnType<typeof ResponseBuilder.error> | null>;
}) {
  const statusCheck = await getStatus();
  if (statusCheck.isReady || statusCheck.isRunning) {
    return ResponseBuilder.markdown(alreadyRunningMessage);
  }

  const environment = { ...process.env, ...(envVars || {}) } as Record<string, string>;
  if (process.env.LOCALSTACK_AUTH_TOKEN) {
    environment.LOCALSTACK_AUTH_TOKEN = process.env.LOCALSTACK_AUTH_TOKEN;
  }

  return new Promise((resolve) => {
    const child = spawn("localstack", startArgs, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    let earlyExit = false;
    let poll: NodeJS.Timeout;
    child.on("error", (err) => {
      earlyExit = true;
      if (poll) clearInterval(poll);
      resolve(ResponseBuilder.markdown(`❌ Failed to start ${processLabel} process: ${err.message}`));
    });

    child.on("close", (code) => {
      if (earlyExit) return;
      if (poll) clearInterval(poll);
      if (code !== 0) {
        resolve(
          ResponseBuilder.markdown(
            `❌ ${processLabel} process exited unexpectedly with code ${code}.\n\nStderr:\n${stderr}`
          )
        );
      }
    });

    const pollInterval = 5000;
    const maxWaitTime = 120000;
    let timeWaited = 0;

    poll = setInterval(async () => {
      timeWaited += pollInterval;
      const status = await getStatus();
      if (status.isReady || status.isRunning) {
        if (onReady) {
          const preflight = await onReady();
          if (preflight) {
            clearInterval(poll);
            resolve(preflight);
            return;
          }
        }

        clearInterval(poll);
        let resultMessage = `${successTitle}\n\n`;
        if (envVars)
          resultMessage += `✅ Custom environment variables applied: ${Object.keys(envVars).join(", ")}\n`;
        if (status.statusOutput) resultMessage += `\n**${statusHeading}:**\n${status.statusOutput}`;
        resolve(ResponseBuilder.markdown(resultMessage));
      } else if (timeWaited >= maxWaitTime) {
        clearInterval(poll);
        resolve(ResponseBuilder.markdown(timeoutMessage));
      }
    }, pollInterval);
  });
}

/**
 * Validate LocalStack CLI availability and return early if not available
 * This is a helper function for tools that require LocalStack CLI
 */
export async function ensureLocalStackCli() {
  const cliCheck = await checkLocalStackCli();

  if (!cliCheck.isAvailable) {
    return {
      content: [{ type: "text", text: cliCheck.errorMessage! }],
    };
  }

  return null; // CLI is available, continue with tool execution
}
