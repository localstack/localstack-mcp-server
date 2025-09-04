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
  const statusCheck = await getLocalStackStatus();
  if (statusCheck.isRunning) {
    return {
      content: [
        {
          type: "text",
          text: "⚠️  LocalStack is already running. Use 'restart' if you want to apply new configuration.",
        },
      ],
    };
  }

  const environment = { ...process.env, ...(envVars || {}) } as Record<string, string>;
  if (process.env.LOCALSTACK_AUTH_TOKEN) {
    environment.LOCALSTACK_AUTH_TOKEN = process.env.LOCALSTACK_AUTH_TOKEN;
  }

  return new Promise((resolve) => {
    const child = spawn("localstack", ["start"], { env: environment });

    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    let earlyExit = false;
    child.on("error", (err) => {
      earlyExit = true;
      resolve({
        content: [{ type: "text", text: `❌ Failed to start LocalStack process: ${err.message}` }],
      });
    });

    child.on("close", (code) => {
      if (earlyExit) return;
      if (code !== 0) {
        resolve({
          content: [
            {
              type: "text",
              text: `❌ LocalStack process exited unexpectedly with code ${code}.\n\nStderr:\n${stderr}`,
            },
          ],
        });
      }
    });

    const pollInterval = 5000;
    const maxWaitTime = 120000;
    let timeWaited = 0;

    const poll = setInterval(async () => {
      timeWaited += pollInterval;
      const status = await getLocalStackStatus();
      if (status.isReady || status.isRunning) {
        clearInterval(poll);
        let resultMessage = "🚀 LocalStack started successfully!\n\n";
        if (envVars)
          resultMessage += `✅ Custom environment variables applied: ${Object.keys(envVars).join(", ")}\n`;
        resultMessage += `\n**Status:**\n${status.statusOutput}`;
        resolve({ content: [{ type: "text", text: resultMessage }] });
      } else if (timeWaited >= maxWaitTime) {
        clearInterval(poll);
        resolve({
          content: [
            {
              type: "text",
              text: `❌ LocalStack start timed out after ${maxWaitTime / 1000} seconds. It may still be starting in the background.`,
            },
          ],
        });
      }
    }, pollInterval);
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
