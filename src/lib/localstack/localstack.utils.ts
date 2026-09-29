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
  isLocalStackContainerNotFoundError,
  type ContainerMetadata,
  type LogBufferHandle,
} from "../docker/docker.client";
import {
  buildLocalStackContainerSpec,
  resolveContainerName,
  resolveVolume,
  stackFromImage,
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
  /**
   * Something accepts connections on the port but the runtime does not answer (yet).
   * Before a start it counts as running, so no second runtime is launched beside a busy
   * one. After this start launched its own container it is NOT started:
   * Docker's port proxy accepts connections before the runtime listens.
   */
  unresponsive?: boolean;
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
 *
 * `baseUrl` targets another gateway than the configured one, for example the Azure
 * client's own port when AWS and Azure run side by side.
 */
export async function getGatewayHealth(baseUrl?: string): Promise<GatewayHealth> {
  try {
    const data = await httpClient.request<{
      services?: Record<string, string>;
      edition?: string;
      version?: string;
    }>("/_localstack/health", {
      method: "GET",
      timeout: GATEWAY_HEALTH_TIMEOUT,
      ...(baseUrl ? { baseUrl } : {}),
    });

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
export async function getSessionInfo(baseUrl?: string): Promise<SessionInfo | null> {
  try {
    const info = await httpClient.request<SessionInfo>("/_localstack/info", {
      method: "GET",
      timeout: SESSION_INFO_TIMEOUT,
      ...(baseUrl ? { baseUrl } : {}),
    });
    if (!info || typeof info !== "object") return null;
    return info;
  } catch {
    return null;
  }
}

function describeGatewayHealth(
  health: GatewayHealth,
  info?: SessionInfo | null,
  baseUrl: string = LOCALSTACK_BASE_URL
): string {
  const lines = [
    `LocalStack gateway is reachable at ${baseUrl} (detected via /_localstack/health).`,
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
/** The gateway's status; `baseUrl` probes another gateway than LOCALSTACK_PORT's (side by side). */
export async function getLocalStackStatus(baseUrl?: string): Promise<LocalStackStatusResult> {
  const health = await getGatewayHealth(baseUrl);

  if (!health.reachable) {
    return {
      isRunning: false,
      isReady: false,
      statusOutput: `LocalStack is not running — the gateway at ${baseUrl ?? LOCALSTACK_BASE_URL} is not reachable.`,
    };
  }

  const info = await getSessionInfo(baseUrl);
  return {
    isRunning: true,
    isReady: health.ready,
    statusOutput: describeGatewayHealth(health, info, baseUrl),
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
      let settled = false;
      const succeed = (value: { statusCode: number; body: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
      };
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
          res.on("end", () => succeed({ statusCode: res.statusCode || 0, body: data }));
          // If the peer resets the socket mid-response, `res` emits 'aborted'/'error'
          // and 'end' never fires — without these the promise would hang forever.
          res.on("aborted", () => fail(new Error("Snowflake health probe connection aborted")));
          res.on("error", fail);
        }
      );
      // Hard wall-clock deadline: the socket `timeout` event can't fire on an
      // already-destroyed socket, so it is not sufficient on its own.
      const deadline = setTimeout(() => {
        req.destroy(new Error("Snowflake health probe timed out"));
        fail(new Error("Snowflake health probe timed out"));
      }, SNOWFLAKE_PROBE_TIMEOUT);
      req.on("timeout", () => req.destroy(new Error("Snowflake health probe timed out")));
      req.on("error", fail);
      req.on("close", () =>
        fail(new Error("Snowflake health probe connection closed before a response"))
      );
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
  try {
    return await launchRuntimeInner(options);
  } catch (error) {
    // buildLocalStackContainerSpec (invalid GATEWAY_LISTEN/ports) or the initial
    // getStatus() can throw; surface it through ResponseBuilder so the tool returns a
    // ❌ result instead of a raw protocol error.
    return ResponseBuilder.error(
      `Failed to start ${options.processLabel}`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function launchRuntimeInner(
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
  // Only this server's own default folder is created: a recreated container's bind must
  // already exist (creating a WSL path on Windows made C:\home\<user>\... there).
  if (volume.type === "bind" && !inDocker && !options.volumeOverride) {
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

  // An explicitly configured docker-socket source that doesn't exist would fail at
  // container creation with an opaque daemon error — catch it here with a message
  // that names the actual problem. (Inside Docker the path is host-side and cannot
  // be checked from this process.)
  const explicitDockerSock = process.env.DOCKER_SOCK?.trim();
  if (explicitDockerSock && !inDocker && !existsSync(explicitDockerSock)) {
    return ResponseBuilder.error(
      "Invalid DOCKER_SOCK",
      `DOCKER_SOCK is set to "${explicitDockerSock}", but that path does not exist on this machine. ` +
        "The LocalStack container mounts the Docker socket from this path — fix it, or unset DOCKER_SOCK to use /var/run/docker.sock."
    );
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
  // Short timeouts: this is pre-start housekeeping — a hung daemon should surface
  // as an error in seconds, not block the start for two minutes.
  try {
    const existing = await docker.findContainerByNameAnyState(spec.name);
    if (existing) {
      if (existing.running) {
        return conflictResponse(processLabel, spec.name, existing.image);
      }
      await docker.removeContainer(existing.id, 10000);
      await docker.waitForRemoval(existing.id, 10000);
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

  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;

  return new Promise((resolve) => {
    let resolved = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const finish = (response: ReturnType<typeof ResponseBuilder.markdown>) => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      logBuffer?.destroy();
      resolve(response);
    };

    const failureDetails = () => {
      const buffered = logBuffer ? tailLines(logBuffer.getBuffered(), CRASH_LOG_TAIL_LINES) : "";
      return buffered
        ? `\n\nContainer logs (last ${CRASH_LOG_TAIL_LINES} lines):\n${buffered}`
        : "";
    };
    // LocalStack exits with code 55 when it cannot activate its licence, and the container
    // can be gone before the reason reaches the log stream (the tail ended at
    // "exit code 55. Reason:"), so name the cause and the setting to check.
    const exitHint = () =>
      /exit code 55\b/.test(logBuffer?.getBuffered() ?? "")
        ? "\n\nExit code 55: LocalStack could not activate its licence. Check that LOCALSTACK_AUTH_TOKEN in this MCP server's configuration is a valid auth token."
        : "";

    const successResponse = (status: RuntimeStatus) => {
      let resultMessage = `${successTitle}\n\n`;
      if (envVars)
        resultMessage += `✅ Custom environment variables passed to the LocalStack container: ${Object.keys(envVars).join(", ")}\n`;
      if (status.statusOutput) resultMessage += `\n**${statusHeading}:**\n${status.statusOutput}`;
      return ResponseBuilder.markdown(resultMessage);
    };

    const finishIfReady = async (): Promise<boolean> => {
      if (resolved) return true;
      const status = await getStatus();
      if (resolved) return true;
      // A runtime that does not answer yet is still starting (see RuntimeStatus.unresponsive).
      if (!(status.isReady || (status.isRunning && !status.unresponsive))) return false;

      if (onReady) {
        const preflight = await onReady();
        if (resolved) return true;
        if (preflight) {
          finish(preflight);
          return true;
        }
      }

      finish(successResponse(status));
      return true;
    };

    // Independent wall-clock deadline: it must fire even if a `getStatus()` call hangs
    // (a slow status probe must never be able to prevent the start from settling).
    deadlineTimer = setTimeout(() => {
      const details = failureDetails();
      finish(ResponseBuilder.markdown(details ? `${timeoutMessage}${details}` : timeoutMessage));
    }, maxWaitMs);

    // The follow-stream ending means the container exited (AutoRemove removes it
    // immediately, so this buffered tail is the only surviving diagnostic).
    logBuffer?.onExit(async () => {
      if (resolved) return;
      // The runtime may have become ready in the same instant (unlikely but cheap to check).
      try {
        if (await finishIfReady()) return;
      } catch {
        // fall through to the failure response
      }
      finish(
        ResponseBuilder.markdown(
          `❌ ${processLabel} container exited unexpectedly before becoming ready.${exitHint()}${failureDetails()}`
        )
      );
    });

    // Self-scheduling poll: the next tick is only armed after the current status check
    // resolves, so a slow `getStatus()` can't spawn overlapping in-flight probes (which
    // would multiply `onReady` side effects).
    const scheduleNextPoll = () => {
      if (resolved) return;
      pollTimer = setTimeout(async () => {
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
        scheduleNextPoll();
      }, pollIntervalMs);
    };
    scheduleNextPoll();
  });
}

export interface RecreateOverrides {
  imageOverride?: string;
  containerNameOverride?: string;
  volumeOverride?: VolumeResolution;
}

/**
 * Derive start overrides from a container we are about to recreate, so an
 * externally-provisioned runtime (custom name/image/volume) is not silently replaced
 * by the defaults — that would strand its state. Reuse only applies when the previous
 * image matches the requested stack (restarting with a different `service` deliberately
 * switches stacks).
 */
export function deriveRecreateOverrides(
  metadata: ContainerMetadata | undefined,
  stack: LocalStackStack
): RecreateOverrides | undefined {
  if (!metadata?.image) return undefined;
  // Pass the labels: a bare-ID Azure container is identified by its description label
  //. An image of unknown stack keeps the historical AWS default.
  if ((stackFromImage(metadata.image, metadata.labels) ?? "aws") !== stack) return undefined;

  const overrides: RecreateOverrides = {
    imageOverride: metadata.image,
    containerNameOverride: metadata.name,
  };

  const volumeMount = (metadata.mounts || []).find(
    (mount) => mount.destination === "/var/lib/localstack"
  );
  if (volumeMount?.type === "bind" && volumeMount.source) {
    overrides.volumeOverride = { type: "bind", source: volumeMount.source };
  } else if (volumeMount?.type === "volume" && volumeMount.name) {
    overrides.volumeOverride = { type: "volume", name: volumeMount.name };
  }

  return overrides;
}

const AWS_ALREADY_RUNNING = "⚠️  LocalStack is already running.";
const SNOWFLAKE_ALREADY_RUNNING = "⚠️  Snowflake emulator is already running.";

// Keys the launcher sets authoritatively for a new container (buildEnv step (d)); carrying stale
// values from the old container is pointless, and one of them is the auth token, which must never
// be echoed back. So a restart never carries these over.
/**
 * The env key a restart writes on the new container, listing the settings it carried over from an
 * externally started one. The new container carries this server's LOCALSTACK_CLIENT_NAME,
 * so without the list a SECOND restart would see a server-started container and drop them all.
 */
export const CARRIED_ENV_KEY = "MCP_CARRIED_ENV";

/** `KEY=value` entries of `containerEnv` for exactly `keys` (the settings a restart keeps carrying). */
export function pickCarriedEnv(
  containerEnv: string[] | undefined,
  keys: string[]
): Record<string, string> {
  const wanted = new Set(keys);
  const picked: Record<string, string> = {};
  for (const entry of containerEnv ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (wanted.has(key) && !RESERVED_RESTART_ENV_KEYS.has(key)) picked[key] = entry.slice(eq + 1);
  }
  return picked;
}

const RESERVED_RESTART_ENV_KEYS = new Set([
  CARRIED_ENV_KEY, // written by the restart itself, never carried as a flag
  "MAIN_CONTAINER_NAME",
  "GATEWAY_LISTEN",
  "EXTERNAL_SERVICE_PORTS_START",
  "EXTERNAL_SERVICE_PORTS_END",
  "DOCKER_HOST",
  "LOCALSTACK_AUTH_TOKEN",
  "LOCALSTACK_CLIENT_NAME",
  "LOCALSTACK_CLIENT_VERSION",
  "AI_AGENT",
]);

// A backstop for when the image's baked env cannot be read: base-image/system variables that are
// never an operator's emulator flag, so they must not be pushed as `-e` onto the new container
// (passing PATH/HOME could break it).
const SYSTEM_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "SHELL",
  "USER",
  "TZ",
  "container",
  "GPG_KEY",
  "DEBIAN_FRONTEND",
  "PYTHONPATH",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "VIRTUAL_ENV",
]);

/**
 * The environment a restart must carry from the old container to the new one: the
 * flags the operator set with `-e` (for example MSSQL_ACCEPT_EULA, DISABLE_EVENTS, LS_AZURE_PORTAL).
 * Without this a recreate keeps only this server's own settings and silently drops the rest, so a
 * shared Azure emulator loses its EULA acceptance and starts emitting telemetry again.
 *
 * `containerEnv` is the old container's full `Config.Env`; `imageEnv` is the image's baked env. A
 * pair present unchanged in the image is a default, not an operator choice, so it is dropped (this
 * is what removes PATH and the like). Launcher-owned reserved keys are dropped too — the launcher
 * sets them for the new container, and one is the auth token. A system-var backstop keeps
 * base-image variables out even when `imageEnv` could not be read.
 */
export function carriedRestartEnv(
  containerEnv: string[] | undefined,
  imageEnv: string[] | undefined
): Record<string, string> {
  const imagePairs = new Set(imageEnv ?? []);
  const carried: Record<string, string> = {};
  for (const entry of containerEnv ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue; // no key, or an empty key
    const key = entry.slice(0, eq);
    if (imagePairs.has(entry)) continue; // an image default, unchanged by the operator
    if (RESERVED_RESTART_ENV_KEYS.has(key) || SYSTEM_ENV_KEYS.has(key)) continue;
    carried[key] = entry.slice(eq + 1);
  }
  return carried;
}

/**
 * The bind source of a container about to be recreated, when this machine cannot mount it:
 * stopping the container would remove it with no way to recreate it (an lstk
 * emulator started from WSL binds ~/.cache/lstk/volume/... as a Linux path, which a Windows
 * server cannot mount). Inside Docker the path is host-side and cannot be checked.
 */
export function unmountableBindSource(
  overrides: RecreateOverrides | undefined,
  opts: { platform?: NodeJS.Platform; inDocker?: boolean } = {}
): string | undefined {
  const volume = overrides?.volumeOverride;
  if (volume?.type !== "bind" || (opts.inDocker ?? isRunningInDocker())) return undefined;
  // A Linux path seen from a Windows host belongs to WSL or another machine.
  if ((opts.platform ?? process.platform) === "win32" && volume.source.startsWith("/")) {
    return volume.source;
  }
  return existsSync(volume.source) ? undefined : volume.source;
}

/** The refusal for unmountableBindSource: nothing is stopped. */
export function cannotRecreateResponse(source: string, containerName: string) {
  return ResponseBuilder.error(
    "Cannot restart this LocalStack container from here",
    `Its state folder is bound from \`${source}\`, which this machine cannot mount: "${containerName}" was ` +
      "probably started from WSL or another host. Stopping it here would remove it with no way to " +
      "recreate it, so nothing was stopped. Restart it where it was started (for example `lstk restart` " +
      "in WSL), or stop it and start a new one with the start action."
  );
}

/**
 * Recreate the running LocalStack container: inspect it, stop + wait for removal, then
 * launch a fresh one preserving its image/name/volume. Used as the reliable fallback
 * when an in-place `POST /_localstack/health {action:restart}` does not confirm (that
 * path can leave the runtime down under heavy Lambda load — see restartRuntimeInPlace).
 */
export async function recreateRunningContainer({
  dockerClient,
  envVars,
  pollIntervalMs,
  maxWaitMs,
}: {
  dockerClient?: DockerApiClient;
  envVars?: Record<string, string>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
} = {}): Promise<ReturnType<typeof ResponseBuilder.markdown>> {
  const docker = dockerClient ?? new DockerApiClient();

  let metadata: ContainerMetadata | undefined;
  try {
    const id = await docker.findLocalStackContainer();
    metadata = await docker.inspectContainer(id);
    // Before stopping it: one this machine could not recreate stays as it is.
    const unmountable = unmountableBindSource(
      deriveRecreateOverrides(metadata, stackFromImage(metadata?.image, metadata?.labels) ?? "aws")
    );
    if (unmountable) return cannotRecreateResponse(unmountable, metadata?.name ?? id);
    await docker.stopContainer(id);
    await docker.waitForRemoval(id);
  } catch (error) {
    if (!isLocalStackContainerNotFoundError(error)) {
      return ResponseBuilder.error(
        "Recreate failed",
        `Could not stop the running LocalStack container: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    // Nothing running — fall through to a fresh AWS start.
  }

  const stack = stackFromImage(metadata?.image, metadata?.labels) ?? "aws";
  const overrides = deriveRecreateOverrides(metadata, stack);

  return launchRuntime({
    stack,
    envVars,
    dockerClient: docker,
    getStatus: stack === "snowflake" ? getSnowflakeEmulatorStatus : getLocalStackStatus,
    processLabel: stack === "snowflake" ? "Snowflake emulator" : "LocalStack",
    alreadyRunningMessage: stack === "snowflake" ? SNOWFLAKE_ALREADY_RUNNING : AWS_ALREADY_RUNNING,
    successTitle:
      stack === "snowflake"
        ? "🚀 Snowflake emulator recreated successfully!"
        : "🚀 LocalStack recreated successfully!",
    statusHeading: stack === "snowflake" ? "Health check" : "Status",
    timeoutMessage: `❌ ${stack === "snowflake" ? "Snowflake emulator" : "LocalStack"} recreate timed out after 120 seconds. It may still be starting in the background.`,
    ...(overrides ?? {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
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
  // Baseline for the session-transition check. When /_localstack/info is not
  // available the baseline stays unknown — that means the restart can only be
  // confirmed by observing gateway downtime, never assumed.
  let baseline = await getSessionInfo();

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
  let unreachableStreak = 0;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const health = await getGatewayHealth();
    if (!health.reachable) {
      // A single failed probe can be a GC pause or a 3s-timeout blip on the OLD
      // process, not a restart — require sustained downtime before trusting it.
      unreachableStreak += 1;
      if (unreachableStreak >= 2) sawTransition = true;
      continue;
    }
    unreachableStreak = 0;

    if (!sawTransition) {
      const info = await getSessionInfo();
      if (info) {
        if (!baseline) {
          // First observation after the POST. It may already be the new session,
          // but that cannot be proven — use it as the comparison point and keep
          // waiting for an explicit signal (downtime or a later session change).
          baseline = info;
        } else {
          const sessionChanged =
            (info.session_id && baseline.session_id && info.session_id !== baseline.session_id) ||
            (typeof info.uptime === "number" &&
              typeof baseline.uptime === "number" &&
              info.uptime < baseline.uptime);
          if (sessionChanged) sawTransition = true;
        }
      }
    }

    // Success requires an explicit restart signal (a session change or sustained
    // downtime) — never assume it from a single flap or from missing session info.
    if (sawTransition && health.ready) {
      return { ok: true, detail: "LocalStack runtime restarted and is ready." };
    }
  }

  return {
    ok: false,
    detail: `Could not confirm the restart within ${Math.round(maxWaitMs / 1000)}s: the gateway stayed reachable and no session change was observed. LocalStack may still be restarting in the background — check its status before relying on the change.`,
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
