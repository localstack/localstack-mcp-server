import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
  launchRuntime,
  resolveContainerName,
} from "../lib/localstack/localstack.utils";
import {
  DockerApiClient,
  isLocalStackContainerNotFoundError,
  type ContainerMetadata,
} from "../lib/docker/docker.client";
import type { VolumeResolution } from "../lib/localstack/container-spec.logic";
import {
  runPreflights,
  requireProFeature,
  requireAuthToken,
  requireDockerDaemon,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";
import { withToolAnalytics } from "../core/analytics";

const AWS_ALREADY_RUNNING_MESSAGE =
  "⚠️  LocalStack is already running. Use 'restart' if you want to apply new configuration.";
const SNOWFLAKE_ALREADY_RUNNING_MESSAGE =
  "⚠️  Snowflake emulator is already running. Use 'restart' if you want to apply new configuration.";

export const schema = {
  action: z
    .enum(["start", "stop", "restart", "status"])
    .describe("The LocalStack management action to perform"),
  service: z
    .enum(["aws", "snowflake"])
    .default("aws")
    .describe(
      "The LocalStack stack/service to manage. Use 'aws' for the default AWS emulator, or 'snowflake' for the Snowflake emulator."
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
    // Lifecycle runs entirely through the Docker Engine API + the LocalStack gateway;
    // no localstack/lstk CLI is required (or used).
    const checks: Array<ReturnType<typeof requireAuthToken> | Promise<ReturnType<typeof requireAuthToken>>> = [
      requireAuthToken(),
    ];

    if (action === "start" || action === "restart" || action === "stop") {
      checks.push(requireDockerDaemon());
    }

    if (service === "snowflake") {
      // `start` can run when no LocalStack runtime is currently up; validate feature after startup.
      if (action !== "start") checks.push(requireProFeature(ProFeature.SNOWFLAKE));
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

// Handle start action
async function handleStart({
  envVars,
  service,
  overrides,
}: {
  envVars?: Record<string, string>;
  service: "aws" | "snowflake";
  overrides?: StartOverrides;
}) {
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
        return ResponseBuilder.markdown(
          `🛑 Removed stopped LocalStack container "${stale.name}".`
        );
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
  service: "aws" | "snowflake";
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

  return await handleStart({ envVars, service, overrides: recreateOverrides(metadata, service) });
}

/**
 * Derive start overrides from the container we just stopped. Reuse only applies when
 * the previous image matches the requested stack — restarting with service=snowflake
 * while the AWS stack was running deliberately switches stacks (previous behavior).
 */
function recreateOverrides(
  metadata: ContainerMetadata | undefined,
  service: "aws" | "snowflake"
): StartOverrides | undefined {
  if (!metadata?.image) return undefined;
  const previousStack = metadata.image.includes("/snowflake") ? "snowflake" : "aws";
  if (previousStack !== service) return undefined;

  const overrides: StartOverrides = {
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

// Handle status action
async function handleStatus({ service }: { service: "aws" | "snowflake" }) {
  const statusResult = await getLocalStackStatus();
  let result = "📊 LocalStack Status:\n\n";
  result += statusResult.statusOutput || "LocalStack status is unavailable.";

  if (!statusResult.isRunning) {
    result += "\n\n⚠️  LocalStack is not currently running. Use the start action to start it.";
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
