import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  CARRIED_ENV_KEY,
  cannotRecreateResponse,
  carriedRestartEnv,
  pickCarriedEnv,
  deriveRecreateOverrides,
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
  launchRuntime,
  resolveContainerName,
  unmountableBindSource,
} from "../lib/localstack/localstack.utils";
import {
  DockerApiClient,
  isLocalStackContainerNotFoundError,
  type ContainerMetadata,
} from "../lib/docker/docker.client";
import {
  MCP_CLIENT_NAME,
  stackFromImage,
  type VolumeResolution,
} from "../lib/localstack/container-spec.logic";
import {
  runPreflights,
  requireProFeature,
  requireAuthToken,
  requireDockerDaemon,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";
import { withToolAnalytics } from "../core/analytics";
import { azureStartedCheck, getAzureRuntimeStatus } from "../lib/azure/runtime-status";
import { ensureLoopbackForwarder } from "../lib/azure/loopback-forwarder";
import { azureConfig } from "../lib/azure/services";

const AWS_ALREADY_RUNNING_MESSAGE =
  "⚠️  LocalStack is already running. Use 'restart' if you want to apply new configuration.";
const SNOWFLAKE_ALREADY_RUNNING_MESSAGE =
  "⚠️  Snowflake emulator is already running. Use 'restart' if you want to apply new configuration.";
const AZURE_ALREADY_RUNNING_MESSAGE =
  "⚠️  The LocalStack Azure emulator is already running. Use 'restart' if you want to apply new configuration.";

type Service = "aws" | "snowflake" | "azure";
const SERVICE_LABELS: Record<Service, string> = {
  aws: "AWS",
  snowflake: "Snowflake",
  azure: "Azure",
};

export const schema = {
  action: z
    .enum(["start", "stop", "restart", "status"])
    .describe("The LocalStack management action to perform"),
  service: z
    .enum(["aws", "snowflake", "azure"])
    .default("aws")
    .describe(
      "The LocalStack stack/service to manage. Use 'aws' for the default AWS emulator, 'snowflake' for the Snowflake emulator, or 'azure' for the Azure emulator."
    ),
  envVars: z
    .record(z.string(), z.string())
    .optional()
    .describe("Additional environment variables as key-value pairs (only for start action)"),
};

export const metadata: ToolMetadata = {
  name: "localstack-management",
  description: "Manage LocalStack lifecycle: start, stop, restart, or check status",
  annotations: {
    title: "LocalStack Management",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function localstackManagement({
  action,
  service,
  envVars,
}: InferSchema<typeof schema>) {
  return withToolAnalytics("localstack-management", { action, service, envVars }, async () => {
    const checks: Array<
      ReturnType<typeof requireAuthToken> | Promise<ReturnType<typeof requireAuthToken>>
    > = [requireAuthToken()];

    if (action === "start" || action === "restart" || action === "stop") {
      checks.push(requireDockerDaemon());
    }

    if (service === "snowflake" && action !== "start") {
      // The SNOWFLAKE pro-feature check reads /_localstack/licenseinfo from the
      // RUNNING container, so it is only meaningful when that container actually is
      // the Snowflake stack. Checking against the AWS stack produces a misleading
      // "license does not include snowflake" error, and `start` cannot be gated at
      // all: nothing is running yet to ask (an unlicensed boot fails fast through
      // the attached crash-log path instead).
      checks.push(requireSnowflakeProIfSnowflakeRunning());
    }

    const preflightError = await runPreflights(checks);
    if (preflightError) return preflightError;

    switch (action) {
      case "start":
        return await handleStart({ envVars, service });
      case "stop":
        return await handleStop();
      case "restart":
        return await handleRestart({ envVars, service });
      case "status":
        return await handleStatus({ service });
      default:
        return ResponseBuilder.error(
          "Unknown action",
          `❌ Unknown action: ${action}. Supported actions: start, stop, restart, status`
        );
    }
  });
}

interface StartOverrides {
  imageOverride?: string;
  containerNameOverride?: string;
  volumeOverride?: VolumeResolution;
}

/** Best-effort look at the running LocalStack container (null when none/undetectable). */
async function inspectRunningContainer(
  stack?: "azure" | "aws" | "snowflake"
): Promise<ContainerMetadata | null> {
  try {
    const dockerClient = new DockerApiClient();
    const containerId = await dockerClient.findLocalStackContainer(stack ? { stack } : {});
    return await dockerClient.inspectContainer(containerId);
  } catch {
    return null;
  }
}

/** Gate on the SNOWFLAKE pro feature only when the running container is the Snowflake stack. */
async function requireSnowflakeProIfSnowflakeRunning() {
  const metadata = await inspectRunningContainer();
  if (!metadata || stackFromImage(metadata.image, metadata.labels) !== "snowflake") {
    // Not running / different stack — the handlers report those states accurately.
    return null;
  }
  return await requireProFeature(ProFeature.SNOWFLAKE);
}

// Handle start action
async function handleStart({
  envVars,
  service,
  overrides,
}: {
  envVars?: Record<string, string>;
  service: Service;
  overrides?: StartOverrides;
}) {
  if (service === "azure") {
    // The emulator is started on LOCALSTACK_PORT, and the readiness checks read the
    // Azure tool's port: both must name the same gateway.
    const azurePort = process.env.LOCALSTACK_AZURE_PORT?.trim();
    const gatewayPort = process.env.LOCALSTACK_PORT?.trim() || "4566";
    if (azurePort && azurePort !== gatewayPort) {
      return ResponseBuilder.error(
        "Conflicting Azure port settings",
        `LOCALSTACK_AZURE_PORT (${azurePort}) differs from LOCALSTACK_PORT (${gatewayPort}), the port the start action publishes the emulator on. Set LOCALSTACK_PORT=${azurePort} for a port-shifted emulator, or unset LOCALSTACK_AZURE_PORT.`
      );
    }
    return await launchRuntime({
      stack: "azure",
      envVars,
      getStatus: getAzureRuntimeStatus,
      processLabel: "LocalStack Azure emulator",
      alreadyRunningMessage: AZURE_ALREADY_RUNNING_MESSAGE,
      successTitle: "🚀 LocalStack Azure emulator started successfully!",
      statusHeading: "Health check",
      timeoutMessage:
        "❌ LocalStack Azure emulator start timed out after 120 seconds. Its health check did not report the Azure edition. If this was the first start, the image pull may still be in progress — retry in a bit.",
      onReady: azureStartedCheck,
      ...overrides,
    });
  }

  if (service === "snowflake") {
    return await launchRuntime({
      stack: "snowflake",
      envVars,
      getStatus: getSnowflakeEmulatorStatus,
      processLabel: "Snowflake emulator",
      alreadyRunningMessage: SNOWFLAKE_ALREADY_RUNNING_MESSAGE,
      successTitle: "🚀 Snowflake emulator started successfully!",
      statusHeading: "Health check",
      timeoutMessage:
        '❌ Snowflake emulator start timed out after 120 seconds. Health check endpoint did not return {"success": true}. If this was the first start, the image pull may still be in progress — retry in a bit.',
      onReady: async () => await requireProFeature(ProFeature.SNOWFLAKE),
      ...overrides,
    });
  }

  return await launchRuntime({
    stack: "aws",
    envVars,
    getStatus: getLocalStackStatus,
    processLabel: "LocalStack",
    alreadyRunningMessage: AWS_ALREADY_RUNNING_MESSAGE,
    successTitle: "🚀 LocalStack started successfully!",
    statusHeading: "Status",
    timeoutMessage:
      "❌ LocalStack start timed out after 120 seconds. It may still be starting in the background. If this was the first start, the image pull may still be in progress — retry in a bit.",
    ...overrides,
  });
}

// Handle stop action — stop the detected container via the Docker API. Also cleans up
// stopped/stale containers occupying a LocalStack name, so start's conflict advice
// ("stop it first") always has a working recovery path.
async function handleStop() {
  const dockerClient = new DockerApiClient();
  let containerId: string;
  try {
    containerId = await dockerClient.findLocalStackContainer();
  } catch (error) {
    if (!isLocalStackContainerNotFoundError(error)) {
      return ResponseBuilder.error(
        "Docker lookup failed",
        `Could not inspect Docker containers: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // No RUNNING container found — check for a stale stopped one holding the name.
    try {
      const stale = await dockerClient.findContainerByNameAnyState(
        resolveContainerName(process.env)
      );
      if (stale && !stale.running) {
        await dockerClient.removeContainer(stale.id);
        await dockerClient.waitForRemoval(stale.id);
        return ResponseBuilder.markdown(`🛑 Removed stopped LocalStack container "${stale.name}".`);
      }
    } catch {
      // fall through to the gateway-based reporting below
    }

    const status = await getLocalStackStatus();
    if (status.isRunning) {
      return ResponseBuilder.error(
        "LocalStack container not found",
        "The LocalStack gateway is reachable, but no matching Docker container could be identified. " +
          "Set MAIN_CONTAINER_NAME to the LocalStack container name, or stop the runtime outside the MCP server."
      );
    }
    return ResponseBuilder.markdown("✅ LocalStack is not running — no container to stop.");
  }

  try {
    await dockerClient.stopContainer(containerId);
    return ResponseBuilder.markdown("🛑 LocalStack stopped successfully.");
  } catch (error) {
    return ResponseBuilder.error(
      "Failed to stop LocalStack",
      `Failed to stop the LocalStack container: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// Handle restart action — stop the running container, then start fresh (applies any
// new envVars). The recreate reuses the original container's image, name, and volume
// so an externally-provisioned runtime (lstk's localstack-aws, custom names/images)
// is not silently replaced by our defaults — that would strand its state.
async function handleRestart({
  envVars,
  service,
}: {
  envVars?: Record<string, string>;
  service: Service;
}) {
  const dockerClient = new DockerApiClient();
  let containerId: string;
  try {
    containerId = await dockerClient.findLocalStackContainer();
  } catch (error) {
    if (!isLocalStackContainerNotFoundError(error)) {
      return ResponseBuilder.error(
        "Docker lookup failed",
        `Could not inspect Docker containers before restart: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const status = await getLocalStackStatus();
    if (status.isRunning) {
      return ResponseBuilder.error(
        "LocalStack container not found",
        "The LocalStack gateway is reachable, but no matching Docker container could be identified for restart. " +
          "Set MAIN_CONTAINER_NAME to the LocalStack container name, or restart the runtime outside the MCP server."
      );
    }
    return await handleStart({ envVars, service });
  }

  let metadata: ContainerMetadata | undefined;
  try {
    metadata = await dockerClient.inspectContainer(containerId);
  } catch {
    metadata = undefined;
  }

  // Before stopping anything: a container whose state folder this machine cannot mount
  // could not be recreated, and stopping it removes it (an lstk emulator started from
  // WSL was deleted this way by a Windows server).
  const overrides = deriveRecreateOverrides(metadata, service);
  const unmountable = unmountableBindSource(overrides);
  if (unmountable) return cannotRecreateResponse(unmountable, metadata?.name ?? containerId);

  // Carry an EXTERNALLY started container's own env flags over, so a restart does not silently
  // drop settings this server never set and cannot reproduce — e.g. a shared Azure emulator's
  // MSSQL_ACCEPT_EULA, DISABLE_EVENTS and portal flag, started by lstk or `docker run`.
  // A container this server started (its launcher stamps LOCALSTACK_CLIENT_NAME) got its env from
  // this server's config, so upstream's "restart applies new configuration" holds and nothing is
  // carried: a restart can still drop a setting. The image's baked env is subtracted so only
  // operator choices are carried; the caller's own `envVars` still win. Best-effort throughout.
  const startedByThisServer = (metadata?.env ?? []).includes(
    `LOCALSTACK_CLIENT_NAME=${MCP_CLIENT_NAME}`
  );
  const image = metadata?.image;
  // Promise.resolve().then: a synchronous throw from the client becomes a caught rejection too.
  const imageEnv =
    image && !startedByThisServer
      ? await Promise.resolve()
          .then(() => dockerClient.imageConfigEnv(image))
          .catch((): string[] => [])
      : [];
  // A server-started container that an earlier restart made from an external one lists what it
  // carries (CARRIED_ENV_KEY): keep carrying exactly that, so a SECOND restart does not drop the
  // external flags. Without the list, nothing is carried (upstream semantics).
  const carriedList = (metadata?.env ?? [])
    .find((entry) => entry.startsWith(`${CARRIED_ENV_KEY}=`))
    ?.slice(CARRIED_ENV_KEY.length + 1)
    .split(",")
    .filter(Boolean);
  const carried = startedByThisServer
    ? pickCarriedEnv(metadata?.env, carriedList ?? [])
    : carriedRestartEnv(metadata?.env, imageEnv);
  const carriedKeys = Object.keys(carried).filter((key) => !(envVars && key in envVars));
  const mergedEnv: Record<string, string> = { ...carried, ...(envVars ?? {}) };
  if (Object.keys(carried).length > 0) {
    mergedEnv[CARRIED_ENV_KEY] = Object.keys(carried).sort().join(",");
  }
  const startEnv = Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;

  try {
    await dockerClient.stopContainer(containerId);
    await dockerClient.waitForRemoval(containerId);
  } catch (error) {
    return ResponseBuilder.error(
      "Failed to stop LocalStack",
      `Restart aborted because the running LocalStack container could not be stopped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const started = await handleStart({ envVars: startEnv, service, overrides });
  return carriedKeys.length > 0 ? appendCarriedEnvNote(started, carriedKeys) : started;
}

/** Add a line to a restart response naming the settings carried from the old container. */
function appendCarriedEnvNote(
  response: ReturnType<typeof ResponseBuilder.markdown>,
  carriedKeys: string[]
): ReturnType<typeof ResponseBuilder.markdown> {
  const note =
    `\n\n♻️ Carried ${carriedKeys.length} setting${carriedKeys.length === 1 ? "" : "s"} over from the ` +
    `previous container: ${carriedKeys.sort().join(", ")}.`;
  let appended = false;
  const content = response.content?.map((part: { type: string; text?: string }) => {
    if (appended || part.type !== "text" || typeof part.text !== "string") return part;
    appended = true;
    return { ...part, text: part.text + note };
  });
  return { ...response, content } as ReturnType<typeof ResponseBuilder.markdown>;
}

/** `Container: "<name>" (image <image>, gateway <HostIp>:<HostPort>)`. */
function describeContainer(running: ContainerMetadata): string {
  const bindings = running.portBindings ?? {};
  const configured = process.env.LOCALSTACK_PORT?.trim() || "4566";
  const all = Object.values(bindings).flatMap((hosts) => hosts ?? []);
  const gateway =
    all.find((b) => b.HostPort === configured) ?? (bindings["4566/tcp"] ?? [])[0] ?? undefined;
  const where = gateway
    ? `${gateway.HostIp || "0.0.0.0"}:${gateway.HostPort}`
    : "not published on the host";
  return `Container: "${running.name ?? running.id}" (image ${running.image ?? "unknown"}, gateway ${where})`;
}

// Handle status action
async function handleStatus({ service }: { service: Service }) {
  // In the Docker image the emulator is reached through the loopback forwarder, which the
  // Azure tool starts on its first call: without it here, a status asked first probed an
  // empty 127.0.0.1 and said "not running" for a running emulator.
  if (service === "azure" && azureConfig().inDocker) {
    await ensureLoopbackForwarder().catch(() => undefined);
  }
  // Side by side (LOCALSTACK_AZURE_PORT != LOCALSTACK_PORT): the Azure emulator sits on the
  // Azure tool's own port, not on the gateway the other tools use, so status service: azure
  // reads that one and its container (it used to report the AWS emulator on 4666).
  const gatewayPort = process.env.LOCALSTACK_PORT?.trim() || "4566";
  const azureSideBySide =
    service === "azure" && String(azureConfig().port ?? gatewayPort) !== gatewayPort;
  const statusResult = await getLocalStackStatus(
    azureSideBySide ? azureConfig().healthBaseUrl : undefined
  );
  let result = "📊 LocalStack Status:\n\n";
  result += statusResult.statusOutput || "LocalStack status is unavailable.";

  if (!statusResult.isRunning) {
    result += "\n\n⚠️  LocalStack is not currently running. Use the start action to start it.";
    return ResponseBuilder.markdown(result);
  }

  const running = await inspectRunningContainer(azureSideBySide ? "azure" : undefined);
  const runningStack = running ? stackFromImage(running.image, running.labels) : undefined;
  // Always name the container, so a caller can check it before a stop or restart.
  if (running) result += `\n\n${describeContainer(running)}`;

  // Another stack's container is running. A Snowflake image may report the AWS
  // stack's `pro` edition, so for service: snowflake only a clear AWS or Azure image
  // counts as foreign.
  const foreign =
    running &&
    runningStack &&
    runningStack !== service &&
    (service !== "snowflake" || runningStack !== "snowflake");
  if (running && runningStack && foreign) {
    const next =
      runningStack === "azure"
        ? "Use localstack-azure-client with it, or stop it first"
        : "Stop it first";
    result +=
      `\n\n⚠️  The running LocalStack container ("${running.name}", image: ${running.image}) is the ${SERVICE_LABELS[runningStack]} stack — ` +
      `the ${SERVICE_LABELS[service]} emulator is not running. ${next}, then start with service: ${service}.`;
    return ResponseBuilder.markdown(result);
  }

  if (service === "azure") {
    const azure = await getAzureRuntimeStatus();
    if (azure.isReady) {
      result += "\n\n✅ LocalStack is running and the Azure emulator health check passed.";
    } else {
      const diagnostics = [azure.statusOutput, azure.status.message].filter(Boolean).join(" | ");
      result +=
        "\n\n⚠️  LocalStack is running, but the Azure emulator health check did not pass." +
        (diagnostics ? ` (${diagnostics})` : "");
    }
    return ResponseBuilder.markdown(result);
  }

  if (service === "snowflake") {
    const snowflakeStatus = await getSnowflakeEmulatorStatus();

    if (snowflakeStatus.isReady || snowflakeStatus.isRunning) {
      result += "\n\n✅ LocalStack is running and Snowflake emulator health check passed.";
    } else {
      const diagnostics = [snowflakeStatus.statusOutput, snowflakeStatus.errorMessage]
        .filter(Boolean)
        .join(" | ");
      result +=
        "\n\n⚠️  LocalStack is running, but Snowflake emulator health check did not pass." +
        (diagnostics ? ` (${diagnostics})` : "");
    }
    return ResponseBuilder.markdown(result);
  }

  if (statusResult.isReady) {
    result += "\n\n✅ LocalStack is currently running and ready to accept requests.";
  } else {
    result += "\n\n⚠️  LocalStack is reachable, but service readiness has not been reported yet.";
  }
  return ResponseBuilder.markdown(result);
}
