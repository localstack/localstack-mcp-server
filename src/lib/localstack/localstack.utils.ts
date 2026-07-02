import { spawn } from "child_process";
import { LOCALSTACK_BASE_URL, LOCALSTACK_HOSTNAME, LOCALSTACK_PORT } from "../../core/config";
import { runCommand } from "../../core/command-runner";
import { httpClient } from "../../core/http-client";
import { ResponseBuilder } from "../../core/response-builder";

export interface LocalStackCliCheckResult {
  isAvailable: boolean;
  version?: string;
  errorMessage?: string;
}

export interface SnowflakeCliCheckResult {
  isAvailable: boolean;
  version?: string;
  errorMessage?: string;
}

const CLI_CHECK_TIMEOUT = 5000;

function cliSpawnOptions() {
  return {
    timeout: CLI_CHECK_TIMEOUT,
    shell: process.platform === "win32",
  };
}

function localStackCliUnavailable(details?: string): LocalStackCliCheckResult {
  const suffix = details?.trim() ? `\n\nDetails: ${details.trim()}` : "";
  return {
    isAvailable: false,
    errorMessage: `❌ LocalStack CLI is not installed or not available in PATH.

Please install LocalStack by following the official documentation:
https://docs.localstack.cloud/aws/getting-started/installation/

Installation options:
- Using pip: pip install localstack
- Using Docker: Use the LocalStack Docker image
- Using Homebrew (macOS): brew install localstack/tap/localstack-cli

After installation, make sure the 'localstack' command is available in your PATH.${suffix}`,
  };
}

/**
 * Check if LocalStack CLI is installed and available in the system PATH
 * @returns Promise with availability status, version (if available), and error message (if not available)
 */
export async function checkLocalStackCli(): Promise<LocalStackCliCheckResult> {
  try {
    const help = await runCommand("localstack", ["--help"], cliSpawnOptions());
    if (help.error || help.exitCode !== 0) {
      return localStackCliUnavailable(help.error?.message || help.stderr);
    }

    const versionResult = await runCommand("localstack", ["--version"], cliSpawnOptions());
    if (versionResult.error || versionResult.exitCode !== 0) {
      return localStackCliUnavailable(versionResult.error?.message || versionResult.stderr);
    }

    return {
      isAvailable: true,
      version: versionResult.stdout.trim(),
    };
  } catch (error) {
    return localStackCliUnavailable(error instanceof Error ? error.message : String(error));
  }
}

export type LifecycleCli = "localstack" | "lstk";

/**
 * Whether a CLI is usable. `runCommand` resolves (rather than throws) on a missing
 * binary, so we inspect the actual exit code / error — this returns false when the
 * binary isn't on PATH.
 */
async function cliAvailable(bin: string): Promise<boolean> {
  const { error, exitCode } = await runCommand(bin, ["--version"], cliSpawnOptions());
  return !error && exitCode === 0;
}

/**
 * Pick a CLI capable of starting LocalStack. Prefers the Python `localstack` CLI for
 * backward compatibility, falling back to `lstk` (the newer Go CLI, which also forwards
 * `LOCALSTACK_*` env). Returns null when neither is installed: a running container can
 * still be detected and driven via the gateway + Docker API, but *creating* one needs a
 * CLI.
 */
export async function detectLifecycleCli(
  preferredOrder: LifecycleCli[] = ["localstack", "lstk"]
): Promise<LifecycleCli | null> {
  for (const cli of preferredOrder) {
    if (await cliAvailable(cli)) return cli;
  }
  return null;
}

/**
 * Check if Snowflake CLI is installed and available in the system PATH
 * @returns Promise with availability status, version (if available), and error message (if not available)
 */
export async function checkSnowflakeCli(): Promise<SnowflakeCliCheckResult> {
  try {
    const help = await runCommand("snow", ["--help"], cliSpawnOptions());
    if (help.error || help.exitCode !== 0) {
      throw help.error || new Error(help.stderr || `snow --help exited with code ${help.exitCode}`);
    }
    const {
      stdout: version,
      error,
      exitCode,
      stderr,
    } = await runCommand("snow", ["--version"], cliSpawnOptions());
    if (error || exitCode !== 0) {
      throw error || new Error(stderr || `snow --version exited with code ${exitCode}`);
    }

    return {
      isAvailable: true,
      version: version.trim(),
    };
  } catch (error) {
    return {
      isAvailable: false,
      errorMessage: `❌ Snowflake CLI (snow) is not installed or not available in PATH.

Please install the Snowflake CLI by following the official documentation:
https://docs.localstack.cloud/snowflake/integrations/snow-cli/

Installation options:
- Using pip: pip install snowflake-cli-labs
- Using Homebrew (macOS): brew install snowflake-cli

After installation, make sure the 'snow' command is available in your PATH.`,
    };
  }
}

export interface LocalStackStatusResult {
  isRunning: boolean;
  statusOutput?: string;
  errorMessage?: string;
  isReady?: boolean;
}

export interface GatewayHealth {
  /** The LocalStack gateway answered on :4566 — the runtime is up. */
  reachable: boolean;
  /** The gateway is serving and at least one service has left the boot state. */
  ready: boolean;
  /** Per-service states reported by `/_localstack/health` (e.g. `running`, `available`). */
  services?: Record<string, string>;
  edition?: string;
  version?: string;
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

const SNOWFLAKE_ROUTING_HOST = "snowflake.localhost.localstack.cloud";
const CLIENT_ONLY_ENV_KEYS = [
  "HOSTNAME",
  "LOCALSTACK_HOSTNAME",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "S3_ENDPOINT",
  "AWS_S3_FORCE_PATH_STYLE",
];

function getLocalStackEndpointHost() {
  return process.env.LOCALSTACK_HOSTNAME?.trim() || LOCALSTACK_HOSTNAME;
}

function getLocalStackEndpointPort() {
  return String(process.env.LOCALSTACK_PORT || LOCALSTACK_PORT);
}

const GATEWAY_HEALTH_TIMEOUT = 3000;
const CLI_STATUS_TIMEOUT = 5000;
const READY_SERVICE_STATES = new Set(["available", "running"]);

/**
 * Provenance-agnostic LocalStack detection.
 *
 * Probes the LocalStack gateway health endpoint (`/_localstack/health`) directly over
 * HTTP. Any container exposing the gateway on :4566 answers this — regardless of who
 * started it (`localstack` CLI, `lstk`, docker-compose, raw `docker run`), what the
 * container is named, or whether a host-side CLI is installed.
 *
 * This is the source of truth for "is LocalStack running?". A name + CLI check misses
 * runtimes started by `lstk` (container `localstack-aws`) or any external tool, even
 * though their gateway is healthy and reachable.
 */
export async function getGatewayHealth(): Promise<GatewayHealth> {
  try {
    const data = await httpClient.request<{
      services?: Record<string, string>;
      edition?: string;
      version?: string;
    }>("/_localstack/health", { method: "GET", timeout: GATEWAY_HEALTH_TIMEOUT });

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { reachable: false, ready: false };
    }

    const services = data.services ? data.services : undefined;

    const ready = Object.values(services || {}).some((state) => READY_SERVICE_STATES.has(state));

    return {
      reachable: true,
      ready,
      services,
      edition: data?.edition,
      version: data?.version,
    };
  } catch {
    // ECONNREFUSED / timeout / non-2xx → gateway not reachable (not running, or not
    // yet listening). Detection stays provenance-agnostic: no container name, no CLI.
    return { reachable: false, ready: false };
  }
}

function describeGatewayHealth(health: GatewayHealth): string {
  const lines = [
    `LocalStack gateway is reachable at ${LOCALSTACK_BASE_URL} (detected via /_localstack/health).`,
  ];
  if (health.edition) lines.push(`Edition: ${health.edition}`);
  if (health.version) lines.push(`Version: ${health.version}`);
  if (health.services) {
    const total = Object.keys(health.services).length;
    const initialized = Object.values(health.services).filter((state) =>
      READY_SERVICE_STATES.has(state)
    ).length;
    lines.push(`Services initialized: ${initialized}/${total}`);
  }
  return lines.join("\n");
}

interface CliStatus {
  output?: string;
  running: boolean;
  ready: boolean;
}

/**
 * Best-effort read of `localstack status` for human-readable output only.
 *
 * Crucially, a non-zero exit is NOT treated as "CLI unavailable": `localstack status`
 * exits non-zero when LocalStack isn't running (the exit code even differs by host —
 * 0 on Windows, non-zero on Linux) yet still prints a useful "stopped" table to
 * stdout. We use whatever stdout it produced and only report "unavailable" when there
 * is genuinely nothing to show.
 */
async function tryCliStatus(timeoutMs = CLI_STATUS_TIMEOUT): Promise<CliStatus> {
  const unavailable: CliStatus = { running: false, ready: false };
  try {
    const result = await runCommand("localstack", ["status"], { timeout: timeoutMs });
    if (!result.stdout?.trim()) return unavailable;

    const stdout = result.stdout;
    return {
      output: stdout.trim(),
      running: stdout.includes("running"),
      ready: stdout.includes("Ready") || stdout.includes("ready"),
    };
  } catch {
    return unavailable;
  }
}

interface LocalStackStatusOptions {
  includeCliStatus?: boolean;
}

/**
 * Get LocalStack status information.
 *
 * Running state is decided by the gateway probe. The Python CLI's `status`
 * output is layered on as display-only detail when requested.
 *
 * @returns Promise with status details including running state and raw output
 */
export async function getLocalStackStatus({
  includeCliStatus = true,
}: LocalStackStatusOptions = {}): Promise<LocalStackStatusResult> {
  const [health, cli] = await Promise.all([
    getGatewayHealth(),
    includeCliStatus ? tryCliStatus() : Promise.resolve<CliStatus | undefined>(undefined),
  ]);

  const isRunning = health.reachable;
  const isReady = health.ready;

  if (!isRunning) {
    const statusOutput =
      cli?.output ||
      `LocalStack is not running — the gateway at ${LOCALSTACK_BASE_URL} is not reachable.`;
    return { isRunning: false, isReady: false, statusOutput };
  }

  return {
    isRunning,
    isReady,
    statusOutput: cli?.running && cli.output ? cli.output : describeGatewayHealth(health),
  };
}

/**
 * Get Snowflake emulator status information by checking the Snowflake session endpoint
 * @returns Promise with status details including running state and raw output
 */
export async function getSnowflakeEmulatorStatus(): Promise<SnowflakeStatusResult> {
  try {
    const host = getLocalStackEndpointHost();
    const port = getLocalStackEndpointPort();
    const { stdout, stderr, error, exitCode } = await runCommand("curl", [
      "-sS",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-H",
      `Host: ${SNOWFLAKE_ROUTING_HOST}:${port}`,
      "-d",
      "{}",
      `http://${host}:${port}/session`,
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
  cli = "localstack",
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
  /** Lifecycle CLI binary to spawn — `localstack` (default) or `lstk`. */
  cli?: LifecycleCli;
  startArgs: string[];
  getStatus: () => Promise<RuntimeStatus>;
  processLabel: string;
  alreadyRunningMessage: string;
  successTitle: string;
  statusHeading: string;
  timeoutMessage: string;
  envVars?: Record<string, string>;
  onReady?: () => Promise<ReturnType<typeof ResponseBuilder.error> | null>;
}): Promise<ReturnType<typeof ResponseBuilder.markdown>> {
  const statusCheck = await getStatus();
  if (statusCheck.isReady || statusCheck.isRunning) {
    return ResponseBuilder.markdown(alreadyRunningMessage);
  }

  const environment = { ...process.env } as Record<string, string>;
  for (const key of CLIENT_ONLY_ENV_KEYS) {
    delete environment[key];
  }
  Object.assign(environment, envVars || {});
  if (process.env.LOCALSTACK_AUTH_TOKEN) {
    environment.LOCALSTACK_AUTH_TOKEN = process.env.LOCALSTACK_AUTH_TOKEN;
  }
  // Force UTF-8 for the spawned Python `localstack` CLI so its emoji output doesn't
  // throw UnicodeEncodeError under the Windows cp1252 code page.
  if (cli === "localstack") {
    if (!environment.PYTHONIOENCODING) environment.PYTHONIOENCODING = "utf-8";
    if (!environment.PYTHONUTF8) environment.PYTHONUTF8 = "1";
  }

  return new Promise((resolve) => {
    const child = spawn(cli, startArgs, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    let earlyExit = false;
    let poll: NodeJS.Timeout;
    let resolved = false;
    const finish = (response: ReturnType<typeof ResponseBuilder.markdown>) => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      resolve(response);
    };
    const failureDetails = () => {
      const details: string[] = [];
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      if (trimmedStdout) details.push(`Stdout:\n${trimmedStdout}`);
      if (trimmedStderr) details.push(`Stderr:\n${trimmedStderr}`);
      return details.length ? `\n\n${details.join("\n\n")}` : "";
    };
    const successResponse = (status: RuntimeStatus) => {
      let resultMessage = `${successTitle}\n\n`;
      if (envVars)
        resultMessage += `✅ Custom environment variables passed to lifecycle CLI: ${Object.keys(envVars).join(", ")}\n`;
      if (status.statusOutput) resultMessage += `\n**${statusHeading}:**\n${status.statusOutput}`;
      return ResponseBuilder.markdown(resultMessage);
    };
    const finishIfReady = async (): Promise<boolean> => {
      const status = await getStatus();
      if (!(status.isReady || status.isRunning)) return false;

      if (onReady) {
        const preflight = await onReady();
        if (preflight) {
          finish(preflight);
          return true;
        }
      }

      finish(successResponse(status));
      return true;
    };

    child.on("error", (err) => {
      earlyExit = true;
      finish(
        ResponseBuilder.markdown(`❌ Failed to start ${processLabel} process: ${err.message}`)
      );
    });

    child.on("close", async (code) => {
      if (earlyExit) return;
      // A non-zero exit is a real failure: stop polling and report it.
      // A zero exit is expected in non-interactive environments (e.g. inside a
      // container, where `localstack start` launches the runtime and returns
      // instead of staying attached to stream logs). In that case we must keep
      // polling so readiness is still detected and the promise resolves — clearing
      // the interval here would leave the start call hanging forever.
      if (code !== 0) {
        finish(
          ResponseBuilder.markdown(
            `❌ ${processLabel} process exited unexpectedly with code ${code}.${failureDetails()}`
          )
        );
        return;
      }

      if (cli === "lstk") {
        try {
          if (await finishIfReady()) return;
        } catch (error) {
          finish(
            ResponseBuilder.markdown(
              `❌ ${processLabel} process exited before it became ready. Failed to verify status: ${
                error instanceof Error ? error.message : String(error)
              }${failureDetails()}`
            )
          );
          return;
        }

        finish(
          ResponseBuilder.markdown(
            `❌ ${processLabel} process exited before it became ready.${failureDetails()}`
          )
        );
      }
    });

    const pollInterval = 5000;
    const maxWaitTime = 120000;
    let timeWaited = 0;

    poll = setInterval(async () => {
      timeWaited += pollInterval;
      try {
        if (await finishIfReady()) return;
      } catch (error) {
        finish(
          ResponseBuilder.markdown(
            `❌ Failed to check ${processLabel} status: ${
              error instanceof Error ? error.message : String(error)
            }${failureDetails()}`
          )
        );
        return;
      }

      if (timeWaited >= maxWaitTime) {
        const details = failureDetails();
        finish(ResponseBuilder.markdown(details ? `${timeoutMessage}${details}` : timeoutMessage));
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

/**
 * Validate Snowflake CLI availability and return early if not available
 * This is a helper function for tools that require Snowflake CLI
 */
export async function ensureSnowflakeCli() {
  const cliCheck = await checkSnowflakeCli();

  if (!cliCheck.isAvailable) {
    return {
      content: [{ type: "text", text: cliCheck.errorMessage! }],
    };
  }

  return null; // CLI is available, continue with tool execution
}
