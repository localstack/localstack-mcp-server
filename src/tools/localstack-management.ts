import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  detectLifecycleCli,
  type LifecycleCli,
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
  startRuntime,
} from "../lib/localstack/localstack.utils";
import {
  DockerApiClient,
  isLocalStackContainerNotFoundError,
  type ContainerMetadata,
} from "../lib/docker/docker.client";
import { runPreflights, requireProFeature, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";
import { withToolAnalytics } from "../core/analytics";

type ToolResponse = ReturnType<typeof ResponseBuilder.error>;
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
    // No CLI preflight: stop/restart/status drive LocalStack via the Docker API +
    // gateway, and start detects whichever lifecycle CLI is present (localstack or
    // lstk) itself — so an lstk-only host is no longer blocked here.
    const checks: Array<ToolResponse | null | Promise<ToolResponse | null>> = [requireAuthToken()];

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

// Handle start action
async function handleStart({
  envVars,
  service,
  cli,
}: {
  envVars?: Record<string, string>;
  service: "aws" | "snowflake";
  cli?: LifecycleCli;
}) {
  if (service === "snowflake") {
    return await handleSnowflakeStart({ envVars });
  }

  const status = await getLocalStackStatus({ includeCliStatus: false });
  if (status.isReady || status.isRunning) {
    return ResponseBuilder.markdown(AWS_ALREADY_RUNNING_MESSAGE);
  }

  const lifecycleCli = cli || (await detectLifecycleCli());
  if (!lifecycleCli) return noLifecycleCliFoundResponse("Starting");

  return await startRuntime({
    cli: lifecycleCli,
    // lstk would otherwise prompt; force non-interactive when spawned headless.
    startArgs: lifecycleCli === "lstk" ? ["start", "--non-interactive"] : ["start"],
    getStatus: () => getLocalStackStatus({ includeCliStatus: false }),
    processLabel: "LocalStack",
    alreadyRunningMessage: AWS_ALREADY_RUNNING_MESSAGE,
    successTitle: "🚀 LocalStack started successfully!",
    statusHeading: "Status",
    timeoutMessage:
      "❌ LocalStack start timed out after 120 seconds. It may still be starting in the background.",
    envVars,
  });
}

async function handleSnowflakeStart({ envVars }: { envVars?: Record<string, string> }) {
  const status = await getSnowflakeEmulatorStatus();
  if (status.isReady || status.isRunning) {
    return ResponseBuilder.markdown(SNOWFLAKE_ALREADY_RUNNING_MESSAGE);
  }

  // The Snowflake stack is localstack-only (`--stack snowflake` has no lstk equivalent).
  if ((await detectLifecycleCli(["localstack"])) !== "localstack") {
    return ResponseBuilder.error(
      "localstack CLI required",
      "Starting the Snowflake stack requires the Python `localstack` CLI (the `--stack snowflake` flag is localstack-only). Install it with `pip install localstack`."
    );
  }

  return await startRuntime({
    cli: "localstack",
    startArgs: ["start", "--stack", "snowflake"],
    getStatus: getSnowflakeEmulatorStatus,
    processLabel: "Snowflake emulator",
    alreadyRunningMessage: SNOWFLAKE_ALREADY_RUNNING_MESSAGE,
    successTitle: "🚀 Snowflake emulator started successfully!",
    statusHeading: "Health check",
    timeoutMessage:
      '❌ Snowflake emulator start timed out after 120 seconds. Health check endpoint did not return {"success": true}.',
    envVars,
    onReady: async () => await requireProFeature(ProFeature.SNOWFLAKE),
  });
}

// Handle stop action — stop the detected container via the Docker API (no CLI needed,
// works regardless of which CLI started it).
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
    const status = await getLocalStackStatus({ includeCliStatus: false });
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

// Handle restart action — stop the running container (Docker API), then start fresh
// (applies any new envVars). Falls through to start if nothing is running.
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
    const status = await getLocalStackStatus({ includeCliStatus: false });
    if (status.isRunning) {
      return ResponseBuilder.error(
        "LocalStack container not found",
        "The LocalStack gateway is reachable, but no matching Docker container could be identified for restart. " +
          "Set MAIN_CONTAINER_NAME to the LocalStack container name, or restart the runtime outside the MCP server."
      );
    }
    return await handleStart({ envVars, service });
  }

  const cli = await detectCliForRestart(dockerClient, containerId, service);
  if (!cli) {
    return service === "snowflake"
      ? ResponseBuilder.error(
          "localstack CLI required",
          "Restarting the Snowflake stack requires the Python `localstack` CLI on PATH."
        )
      : noLifecycleCliFoundResponse("Restarting");
  }

  try {
    await dockerClient.stopContainer(containerId);
  } catch (error) {
    return ResponseBuilder.error(
      "Failed to stop LocalStack",
      `Restart aborted because the running LocalStack container could not be stopped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  return await handleStart({ envVars, service, cli });
}

function noLifecycleCliFoundResponse(action: "Starting" | "Restarting") {
  return ResponseBuilder.error(
    "No LocalStack CLI found",
    `${action} LocalStack needs the \`localstack\` or \`lstk\` CLI on PATH, but neither was found. ` +
      "Install one (`pip install localstack`, or the `lstk` CLI), or start LocalStack yourself (e.g. `lstk start`) — " +
      "the other tools drive it via the Docker API and gateway."
  );
}

async function detectCliForRestart(
  dockerClient: DockerApiClient,
  containerId: string,
  service: "aws" | "snowflake"
): Promise<LifecycleCli | null> {
  if (service === "snowflake") return await detectLifecycleCli(["localstack"]);

  let metadata: ContainerMetadata | undefined;
  try {
    metadata = await dockerClient.inspectContainer(containerId);
  } catch {
    metadata = undefined;
  }

  return await detectLifecycleCli(preferredCliOrder(metadata));
}

function preferredCliOrder(metadata?: ContainerMetadata): LifecycleCli[] {
  const name = metadata?.name || "";
  const mainContainerName = (metadata?.env || [])
    .find((entry) => entry.startsWith("MAIN_CONTAINER_NAME="))
    ?.slice("MAIN_CONTAINER_NAME=".length);

  if (name === "localstack-aws" || mainContainerName === "localstack-aws") {
    return ["lstk", "localstack"];
  }

  return ["localstack", "lstk"];
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
