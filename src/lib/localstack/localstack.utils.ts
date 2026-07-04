import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { request as httpRequest } from "http";
import { LOCALSTACK_BASE_URL, LOCALSTACK_HOSTNAME, LOCALSTACK_PORT } from "../../core/config";
import { runCommand } from "../../core/command-runner";
import { httpClient } from "../../core/http-client";
import { ResponseBuilder } from "../../core/response-builder";
import {
  DockerApiClient,
  LocalStackContainerConflictError,
  type LogBufferHandle,
} from "../docker/docker.client";
import {
  buildLocalStackContainerSpec,
  resolveContainerName,
  resolveVolume,
  type LocalStackStack,
  type VolumeResolution,
} from "./container-spec.logic";

export interface SnowflakeCliCheckResult {
  isAvailable: boolean;
  version?: string;
  errorMessage?: string;
}

const SNOWFLAKE_CLI_CHECK_TIMEOUT = 30000;

/** Version baked in at build time; used to tag containers we launch. */
let SERVER_VERSION = "unknown";
try {
  // Statically inlined by the bundler.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SERVER_VERSION = require("../../../package.json").version || "unknown";
} catch {
  // keep "unknown"
}

/** Whether the MCP server itself runs inside a container (changes bind IP + volume default). */
export function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv");
}

/**
 * Check if Snowflake CLI is installed and available in the system PATH
 * @returns Promise with availability status, version (if available), and error message (if not available)
 */
export async function checkSnowflakeCli(): Promise<SnowflakeCliCheckResult> {
  try {
    const { stdout, error, exitCode, stderr } = await runCommand("snow", ["--version"], {
      timeout: SNOWFLAKE_CLI_CHECK_TIMEOUT,
      shell: process.platform === "win32",
    });
    if (error || exitCode !== 0) {
      throw error || new Error(stderr || `snow --version exited with code ${exitCode}`);
    }

    return {
      isAvailable: true,
      version: stdout.trim(),
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      isAvailable: false,
      errorMessage: `❌ Snowflake CLI (snow) is not installed or not available in PATH.

Please install the Snowflake CLI by following the official documentation:
https://docs.localstack.cloud/snowflake/integrations/snow-cli/

Installation options:
- Using pip: pip install snowflake-cli-labs
- Using Homebrew (macOS): brew install snowflake-cli

After installation, make sure the 'snow' command is available in your PATH.${
        details.trim() ? `\n\nDetails: ${details.trim()}` : ""
      }`,
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

export interface SessionInfo {
  version?: string;
  edition?: string;
  is_license_activated?: boolean;
  session_id?: string;
  uptime?: number;
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
const SNOWFLAKE_PROBE_TIMEOUT = 10000;

function getLocalStackEndpointHost() {
  return process.env.LOCALSTACK_HOSTNAME?.trim() || LOCALSTACK_HOSTNAME;
}

function getLocalStackEndpointPort() {
  return String(process.env.LOCALSTACK_PORT || LOCALSTACK_PORT);
}

const GATEWAY_HEALTH_TIMEOUT = 3000;
const SESSION_INFO_TIMEOUT = 3000;
const READY_SERVICE_STATES = new Set(["available", "running"]);

/**
 * Provenance-agnostic LocalStack detection.
 *
 * Probes the LocalStack gateway health endpoint (`/_localstack/health`) directly over
 * HTTP. Any container exposing the gateway on :4566 answers this — regardless of who
 * started it (this server, `lstk`, docker-compose, raw `docker run`) or what the
 * container is named.
 *
 * This is the source of truth for "is LocalStack running?".
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

/** Best-effort read of `/_localstack/info` for status enrichment and restart detection. */
export async function getSessionInfo(): Promise<SessionInfo | null> {
  try {
    const info = await httpClient.request<SessionInfo>("/_localstack/info", {
      method: "GET",
      timeout: SESSION_INFO_TIMEOUT,
    });
    if (!info || typeof info !== "object") return null;
    return info;
  } catch {
    return null;
  }
}

function describeGatewayHealth(health: GatewayHealth, info?: SessionInfo | null): string {
  const lines = [
    `LocalStack gateway is reachable at ${LOCALSTACK_BASE_URL} (detected via /_localstack/health).`,
  ];
  const edition = info?.edition || health.edition;
  const version = info?.version || health.version;
  if (edition) lines.push(`Edition: ${edition}`);
  if (version) lines.push(`Version: ${version}`);
  if (health.services) {
    const total = Object.keys(health.services).length;
    const initialized = Object.values(health.services).filter((state) =>
      READY_SERVICE_STATES.has(state)
    ).length;
    lines.push(`Services initialized: ${initialized}/${total}`);
  }
  if (info?.is_license_activated !== undefined) {
    lines.push(`License activated: ${info.is_license_activated ? "yes" : "no"}`);
  }
  if (typeof info?.uptime === "number") {
    lines.push(`Uptime: ${info.uptime}s`);
  }
  return lines.join("\n");
}

/**
 * Get LocalStack status information. Running state is decided by the gateway probe;
 * display detail is enriched from `/_localstack/info` when available.
 */
export async function getLocalStackStatus(): Promise<LocalStackStatusResult> {
  const health = await getGatewayHealth();

  if (!health.reachable) {
    return {
      isRunning: false,
      isReady: false,
      statusOutput: `LocalStack is not running — the gateway at ${LOCALSTACK_BASE_URL} is not reachable.`,
    };
  }

  const info = await getSessionInfo();
  return {
    isRunning: true,
    isReady: health.ready,
    statusOutput: describeGatewayHealth(health, info),
  };
}

/**
 * Get Snowflake emulator status by POSTing to its session endpoint. Uses node:http
 * directly because the probe needs an explicit Host header
 * (`snowflake.localhost.localstack.cloud`) — fetch/undici silently drops Host as a
 * forbidden header.
 */
export async function getSnowflakeEmulatorStatus(): Promise<SnowflakeStatusResult> {
  const host = getLocalStackEndpointHost();
  const port = Number(getLocalStackEndpointPort());
  const body = "{}";

  try {
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host,
          port,
          path: "/session",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: `${SNOWFLAKE_ROUTING_HOST}:${port}`,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: SNOWFLAKE_PROBE_TIMEOUT,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
          });
          res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: data }));
        }
      );
      req.on("timeout", () => req.destroy(new Error("Snowflake health probe timed out")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    const output = response.body.trim();
    const isSuccess = /"success"\s*:\s*true/.test(output);

    return {
      isRunning: isSuccess,
      isReady: isSuccess,
      statusOutput: output,
    };
  } catch (error) {
    return {
      isRunning: false,
      isReady: false,
      errorMessage: `Failed to reach Snowflake emulator endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface LaunchRuntimeOptions {
  stack: LocalStackStack;
  envVars?: Record<string, string>;
  getStatus: () => Promise<RuntimeStatus>;
  processLabel: string;
  alreadyRunningMessage: string;
  successTitle: string;
  statusHeading: string;
  timeoutMessage: string;
  onReady?: () => Promise<ReturnType<typeof ResponseBuilder.error> | null>;
  /** Restart-in-place recreation: pin the original container's identity. */
  imageOverride?: string;
  containerNameOverride?: string;
  volumeOverride?: VolumeResolution;
  /** Injectable for tests. */
  dockerClient?: DockerApiClient;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 120000;
const CRASH_LOG_TAIL_LINES = 50;

function tailLines(text: string, lines: number): string {
  const allLines = text.split(/\r?\n/).filter((line) => line.trim());
  return allLines.slice(-lines).join("\n");
}

function conflictResponse(processLabel: string, containerName: string, image?: string) {
  const otherStack = image?.includes("/snowflake")
    ? "the Snowflake emulator"
    : "another LocalStack stack (likely the AWS emulator)";
  return ResponseBuilder.error(
    "LocalStack container already running",
    `Starting ${processLabel} failed because a LocalStack container named "${containerName}"${
      image ? ` (image: ${image})` : ""
    } is already running — it belongs to ${otherStack}. ` +
      `Stop it first with the localstack-management tool (action: stop), then retry this start.`
  );
}

/**
 * Start a LocalStack runtime flavor directly through the Docker Engine API (no
 * localstack/lstk CLI involved) and poll until it becomes available.
 */
export async function launchRuntime(
  options: LaunchRuntimeOptions
): Promise<ReturnType<typeof ResponseBuilder.markdown>> {
  const {
    stack,
    envVars,
    getStatus,
    processLabel,
    alreadyRunningMessage,
    successTitle,
    statusHeading,
    timeoutMessage,
    onReady,
  } = options;

  const statusCheck = await getStatus();
  if (statusCheck.isReady || statusCheck.isRunning) {
    return ResponseBuilder.markdown(alreadyRunningMessage);
  }

  const authToken = process.env.LOCALSTACK_AUTH_TOKEN?.trim();
  if (!authToken) {
    return ResponseBuilder.error(
      "Auth Token Required",
      "LOCALSTACK_AUTH_TOKEN is required to start LocalStack."
    );
  }

  const docker = options.dockerClient ?? new DockerApiClient();
  try {
    await docker.ping();
  } catch (error) {
    return ResponseBuilder.error(
      "Docker Not Available",
      error instanceof Error ? error.message : String(error)
    );
  }

  const inDocker = isRunningInDocker();
  const volume =
    options.volumeOverride ??
    resolveVolume({
      hostEnv: process.env,
      isInDocker: inDocker,
      platform: process.platform,
      homedir: homedir(),
    });
  if (volume.type === "bind" && !inDocker) {
    try {
      await mkdir(volume.source, { recursive: true });
    } catch (error) {
      return ResponseBuilder.error(
        "Volume Directory Error",
        `Could not create the LocalStack volume directory at ${volume.source}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const spec = buildLocalStackContainerSpec({
    stack,
    envVars,
    hostEnv: process.env,
    authToken,
    isInDocker: inDocker,
    volume,
    serverVersion: SERVER_VERSION,
    imageOverride: options.imageOverride,
    containerNameOverride: options.containerNameOverride,
  });

  // Fail fast (or clean up) when the container name is taken. A running container is
  // an actionable conflict; a stopped one is a stale leftover we remove ourselves.
  try {
    const existing = await docker.findContainerByNameAnyState(spec.name);
    if (existing) {
      if (existing.running) {
        return conflictResponse(processLabel, spec.name, existing.image);
      }
      await docker.removeContainer(existing.id);
      await docker.waitForRemoval(existing.id);
    }
  } catch (error) {
    return ResponseBuilder.error(
      "Docker lookup failed",
      `Could not check for existing LocalStack containers: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    if (spec.HostConfig.NetworkMode) {
      await docker.ensureNetwork(spec.HostConfig.NetworkMode);
    }
    if (!(await docker.imageExists(spec.Image))) {
      await docker.pullImage(spec.Image);
    }
  } catch (error) {
    return ResponseBuilder.error(
      "Failed to prepare LocalStack start",
      error instanceof Error ? error.message : String(error)
    );
  }

  let containerId: string;
  try {
    containerId = await docker.createAndStartContainer(spec);
  } catch (error) {
    if (error instanceof LocalStackContainerConflictError) {
      return conflictResponse(processLabel, spec.name);
    }
    return ResponseBuilder.error(
      `Failed to start ${processLabel}`,
      error instanceof Error ? error.message : String(error)
    );
  }

  let logBuffer: LogBufferHandle | undefined;
  try {
    logBuffer = await docker.attachLogBuffer(containerId);
  } catch {
    // Diagnostics-only: readiness polling still works without the log stream.
  }

  return new Promise((resolve) => {
    let poll: NodeJS.Timeout;
    let resolved = false;
    const finish = (response: ReturnType<typeof ResponseBuilder.markdown>) => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      logBuffer?.destroy();
      resolve(response);
    };

    const failureDetails = () => {
      const buffered = logBuffer ? tailLines(logBuffer.getBuffered(), CRASH_LOG_TAIL_LINES) : "";
      return buffered
        ? `\n\nContainer logs (last ${CRASH_LOG_TAIL_LINES} lines):\n${buffered}`
        : "";
    };

    const successResponse = (status: RuntimeStatus) => {
      let resultMessage = `${successTitle}\n\n`;
      if (envVars)
        resultMessage += `✅ Custom environment variables passed to the LocalStack container: ${Object.keys(envVars).join(", ")}\n`;
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

    // The follow-stream ending means the container exited (AutoRemove removes it
    // immediately, so this buffered tail is the only surviving diagnostic).
    logBuffer?.onExit(async () => {
      // The runtime may have become ready in the same instant (unlikely but cheap to check).
      try {
        if (await finishIfReady()) return;
      } catch {
        // fall through to the failure response
      }
      finish(
        ResponseBuilder.markdown(
          `❌ ${processLabel} container exited unexpectedly before becoming ready.${failureDetails()}`
        )
      );
    });

    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    let timeWaited = 0;
    poll = setInterval(async () => {
      timeWaited += pollIntervalMs;
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

      if (timeWaited >= maxWaitMs) {
        const details = failureDetails();
        finish(ResponseBuilder.markdown(details ? `${timeoutMessage}${details}` : timeoutMessage));
      }
    }, pollIntervalMs);
  });
}

export interface InPlaceRestartResult {
  ok: boolean;
  detail: string;
}

/**
 * Restart the LocalStack runtime in place (`POST /_localstack/health {"action":
 * "restart"}`) and wait for the NEW process to become ready. The POST returns
 * immediately while the old process keeps answering health checks for a moment, so
 * readiness is detected via the session transition (session_id change / uptime
 * reset), not via the first successful health poll.
 */
export async function restartRuntimeInPlace({
  pollIntervalMs = 2000,
  maxWaitMs = 120000,
}: { pollIntervalMs?: number; maxWaitMs?: number } = {}): Promise<InPlaceRestartResult> {
  const before = await getSessionInfo();

  try {
    await httpClient.request("/_localstack/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restart" }),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `Restart request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let sawTransition = false;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const health = await getGatewayHealth();
    if (!health.reachable) {
      // Gateway went down — the restart is in progress.
      sawTransition = true;
      continue;
    }

    if (!sawTransition && before) {
      const info = await getSessionInfo();
      if (info) {
        const sessionChanged =
          (info.session_id && before.session_id && info.session_id !== before.session_id) ||
          (typeof info.uptime === "number" &&
            typeof before.uptime === "number" &&
            info.uptime < before.uptime);
        if (sessionChanged) sawTransition = true;
      }
    }

    const restarted = sawTransition || !before;
    if (restarted && health.ready) {
      return { ok: true, detail: "LocalStack runtime restarted and is ready." };
    }
  }

  return {
    ok: false,
    detail: `LocalStack did not report ready within ${Math.round(maxWaitMs / 1000)}s after the restart request. It may still be restarting in the background.`,
  };
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

export { resolveContainerName };
