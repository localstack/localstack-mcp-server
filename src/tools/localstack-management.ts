import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { spawn } from "child_process";
import { ensureLocalStackCli, getLocalStackStatus } from "../lib/localstack/localstack.utils";
import { runCommand } from "../core/command-runner";

export const schema = {
  action: z
    .enum(["start", "stop", "restart", "status"])
    .describe("The LocalStack management action to perform"),
  envVars: z
    .record(z.string())
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
  envVars,
}: InferSchema<typeof schema>) {
  const cliError = await ensureLocalStackCli();
  if (cliError) return cliError;

  switch (action) {
    case "start":
      return await handleStart({ envVars });
    case "stop":
      return await handleStop();
    case "restart":
      return await handleRestart();
    case "status":
      return await handleStatus();
    default:
      return {
        content: [
          {
            type: "text",
            text: `❌ Unknown action: ${action}. Supported actions: start, stop, restart, status`,
          },
        ],
      };
  }
}

// Handle start action
async function handleStart({ envVars }: { envVars?: Record<string, string> }) {
  // Check if LocalStack is already running
  const statusCheck = await getLocalStackStatus();
  if (statusCheck.isRunning) {
    return {
      content: [
        {
          type: "text",
          text: "⚠️  LocalStack is already running. Use the restart action if you want to restart it with new configuration.",
        },
      ],
    };
  }

  // Prepare environment variables
  const environment = { ...process.env };

  const hasAuthToken = !!process.env.LOCALSTACK_AUTH_TOKEN;

  if (hasAuthToken) {
    environment.LOCALSTACK_AUTH_TOKEN = process.env.LOCALSTACK_AUTH_TOKEN;
  }

  // Add custom environment variables
  if (envVars) {
    Object.entries(envVars).forEach(([key, value]) => {
      environment[key] = value;
    });
  }

  return new Promise((resolve) => {
    // Start LocalStack using spawn for better control
    const localstackProcess = spawn("localstack", ["start"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";

    localstackProcess.stdout?.on("data", (data) => {
      output += data.toString();
    });

    localstackProcess.stderr?.on("data", (data) => {
      errorOutput += data.toString();
    });

    // Give LocalStack some time to start and then check status
    setTimeout(async () => {
      const statusResult = await getLocalStackStatus();

      let resultMessage = "🚀 LocalStack start command executed!\n\n";
      resultMessage += "✅ LocalStack services enabled\n";

      if (envVars && Object.keys(envVars).length > 0) {
        resultMessage += `✅ Custom environment variables applied: ${Object.keys(envVars).join(", ")}\n`;
      }

      if (statusResult.statusOutput) {
        resultMessage += `\nStatus check:\n${statusResult.statusOutput}`;
      } else if (statusResult.errorMessage) {
        resultMessage += `\nStatus check failed: ${statusResult.errorMessage}`;
        resultMessage +=
          "\nLocalStack may still be starting up. You can check the status manually using the status action.";
      }

      if (output) {
        resultMessage += `\n\nOutput:\n${output}`;
      }

      resolve({
        content: [{ type: "text", text: resultMessage }],
      });
    }, 10000); // Wait 10 seconds for LocalStack to start

    localstackProcess.on("error", (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      resolve({
        content: [{ type: "text", text: `❌ Failed to start LocalStack: ${errorMessage}` }],
      });
    });
  });
}

// Handle stop action
async function handleStop() {
  const cmd = await runCommand("localstack", ["stop"]);
  let result = "🛑 LocalStack stop command executed successfully!\n";
  if (cmd.stdout.trim()) result += `\nOutput:\n${cmd.stdout}`;
  if (cmd.stderr.trim()) result += `\nMessages:\n${cmd.stderr}`;

  const statusResult = await getLocalStackStatus();
  if (!statusResult.isRunning) {
    result += "\n\n✅ LocalStack has been stopped successfully.";
  } else if (statusResult.errorMessage) {
    result += "\n\n✅ LocalStack appears to be stopped.";
  } else {
    result += "\n\n⚠️  LocalStack may still be running. Check the status manually if needed.";
  }

  if (cmd.error) {
    result = `❌ Failed to stop LocalStack: ${cmd.error.message}\n\nThis could happen if:\n- LocalStack is not currently running\n- There was an error executing the stop command\n- Permission issues\n\nYou can try checking the LocalStack status first to see if it's running.`;
  }

  return { content: [{ type: "text", text: result }] };
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
      result +=
        "\n\n✅ LocalStack has been restarted successfully and is now running with a fresh state.";
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

  return { content: [{ type: "text", text: result }] };
}

// Handle status action
async function handleStatus() {
  const statusResult = await getLocalStackStatus();

  if (statusResult.statusOutput) {
    let result = "📊 LocalStack Status:\n\n";
    result += statusResult.statusOutput;

    // Add helpful information based on the status
    if (statusResult.isRunning) {
      result += "\n\n✅ LocalStack is currently running and ready to accept requests.";
    } else {
      result += "\n\n⚠️  LocalStack is not currently running. Use the start action to start it.";
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } else {
    const result = `❌ ${statusResult.errorMessage}

This could happen if:
- LocalStack is not installed properly
- There was an error executing the status command
- LocalStack services are not accessible

Try running the CLI check first to verify your LocalStack installation.`;

    return {
      content: [{ type: "text", text: result }],
    };
  }
}
