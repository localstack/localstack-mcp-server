import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
  startRuntime,
} from "../lib/localstack/localstack.utils";
import { runCommand } from "../core/command-runner";
import { runPreflights, requireLocalStackCli, requireProFeature, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";

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
  const checks = [requireLocalStackCli()];

  if (service === "snowflake") {
    const authTokenError = requireAuthToken();
    if (authTokenError) return authTokenError;

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
      return await handleRestart();
    case "status":
      return await handleStatus({ service });
    default:
      return ResponseBuilder.error(
        "Unknown action",
        `❌ Unknown action: ${action}. Supported actions: start, stop, restart, status`
      );
  }
}

// Handle start action
async function handleStart({
  envVars,
  service,
}: {
  envVars?: Record<string, string>;
  service: "aws" | "snowflake";
}) {
  if (service === "snowflake") {
    return await handleSnowflakeStart({ envVars });
  }

  return await startRuntime({
    startArgs: ["start"],
    getStatus: getLocalStackStatus,
    processLabel: "LocalStack",
    alreadyRunningMessage:
      "⚠️  LocalStack is already running. Use 'restart' if you want to apply new configuration.",
    successTitle: "🚀 LocalStack started successfully!",
    statusHeading: "Status",
    timeoutMessage:
      "❌ LocalStack start timed out after 120 seconds. It may still be starting in the background.",
    envVars,
  });
}

async function handleSnowflakeStart({ envVars }: { envVars?: Record<string, string> }) {
  return await startRuntime({
    startArgs: ["start", "--stack", "snowflake"],
    getStatus: getSnowflakeEmulatorStatus,
    processLabel: "Snowflake emulator",
    alreadyRunningMessage:
      "⚠️  Snowflake emulator is already running. Use 'restart' if you want to apply new configuration.",
    successTitle: "🚀 Snowflake emulator started successfully!",
    statusHeading: "Health check",
    timeoutMessage:
      '❌ Snowflake emulator start timed out after 120 seconds. Health check endpoint did not return {"success": true}.',
    envVars,
    onReady: async () => await requireProFeature(ProFeature.SNOWFLAKE),
  });
}

// Handle stop action
async function handleStop() {
  const cmd = await runCommand("localstack", ["stop"]);
  let result = "🛑 LocalStack stop command executed successfully!\n";
  if (cmd.stdout.trim()) result += `\nOutput:\n${cmd.stdout}`;
  if (cmd.stderr.trim()) result += `\nMessages:\n${cmd.stderr}`;

  const statusResult = await getLocalStackStatus();

  if (!statusResult.isRunning || statusResult.errorMessage) {
    result += "\n\n✅ LocalStack has been stopped successfully.";
  } else {
    result += "\n\n⚠️  LocalStack may still be running. Check the status manually if needed.";
  }

  if (cmd.error) {
    result =
      `❌ Failed to stop LocalStack: ${cmd.error.message}\n\nThis could happen if:\n- LocalStack is not currently running\n- There was an error executing the stop command\n- Permission issues\n\nYou can try checking the LocalStack status first to see if it's running.`;
  }

  return ResponseBuilder.markdown(result);
}

// Handle restart action
async function handleRestart() {
  const cmd = await runCommand("localstack", ["restart"], { timeout: 30000 });
  let result = "🔄 LocalStack restart command executed!\n\n";
  if (cmd.stdout.trim()) result += `Output:\n${cmd.stdout}\n`;
  if (cmd.stderr.trim()) result += `Messages:\n${cmd.stderr}\n`;

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const statusResult = await getLocalStackStatus();
  if (statusResult.statusOutput) {
    result += `\nStatus after restart:\n${statusResult.statusOutput}`;
    if (statusResult.isRunning) {
      result += "\n\n✅ LocalStack has been restarted successfully and is now running with a fresh state.";
    } else {
      result +=
        "\n\n⚠️  LocalStack restart completed but may still be starting up. Check status again in a few moments.";
    }
  } else {
    result +=
      "\n\n⚠️  Restart completed but unable to verify status. LocalStack may still be starting up.";
  }

  if (cmd.error) {
    result = `❌ Failed to restart LocalStack: ${cmd.error.message}\n\nThis could happen if:\n- LocalStack is not currently installed properly\n- There was an error executing the restart command\n- The restart process timed out (LocalStack can take time to restart)\n- Permission issues\n\nYou can try stopping and starting LocalStack manually using separate actions if the restart action continues to fail.`;
  }

  return ResponseBuilder.markdown(result);
}

// Handle status action
async function handleStatus({ service }: { service: "aws" | "snowflake" }) {
  const statusResult = await getLocalStackStatus();

  if (statusResult.statusOutput) {
    let result = "📊 LocalStack Status:\n\n";
    result += statusResult.statusOutput;

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

    // Default aws service status check
    result += "\n\n✅ LocalStack is currently running and ready to accept requests.";
    return ResponseBuilder.markdown(result);
  } else {
    const result = `❌ ${statusResult.errorMessage}

This could happen if:
- LocalStack is not installed properly
- There was an error executing the status command
- LocalStack services are not accessible

Try running the CLI check first to verify your LocalStack installation.`;

    return ResponseBuilder.markdown(result);
  }
}
