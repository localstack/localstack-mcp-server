import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { ensureLocalStackCli } from "../lib/localstack-utils";

const execAsync = promisify(exec);

// Define the schema for tool parameters
export const schema = {
  action: z.enum(["start", "stop", "restart", "status"]).describe("The LocalStack management action to perform"),
  // Optional parameters for start action
  enablePro: z.boolean().optional().default(false).describe("Enable LocalStack Pro services (only for start action)"),
  authToken: z.string().optional().describe("LocalStack Pro auth token (only for start action)"),
  envVars: z.record(z.string()).optional().describe("Additional environment variables as key-value pairs (only for start action)"),
};

// Define tool metadata
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

// Tool implementation
export default async function localstackManagement({ action, enablePro, authToken, envVars }: InferSchema<typeof schema>) {
  // Check if LocalStack CLI is available
  const cliError = await ensureLocalStackCli();
  if (cliError) return cliError;

  switch (action) {
    case "start":
      return await handleStart({ enablePro, authToken, envVars });
    case "stop":
      return await handleStop();
    case "restart":
      return await handleRestart();
    case "status":
      return await handleStatus();
    default:
      return {
        content: [{ type: "text", text: `❌ Unknown action: ${action}. Supported actions: start, stop, restart, status` }],
      };
  }
}

// Handle start action
async function handleStart({ enablePro, authToken, envVars }: { enablePro?: boolean, authToken?: string, envVars?: Record<string, string> }) {
  try {
    // Check if LocalStack is already running
    const { stdout: statusOutput } = await execAsync("localstack status");
    if (statusOutput.includes("running")) {
      return {
        content: [{ type: "text", text: "⚠️  LocalStack is already running. Use the restart action if you want to restart it with new configuration." }],
      };
    }
  } catch (error) {
    // LocalStack is not running, which is fine for starting
  }

  // Prepare environment variables
  const environment = { ...process.env };
  
  // Handle LocalStack Pro auth token
  if (enablePro || authToken) {
    const tokenToUse = authToken || process.env.LOCALSTACK_AUTH_TOKEN;
    if (!tokenToUse) {
      return {
        content: [{ type: "text", text: "❌ LocalStack Pro was requested but no auth token provided. Please provide an auth token or set LOCALSTACK_AUTH_TOKEN environment variable." }],
      };
    }
    environment.LOCALSTACK_AUTH_TOKEN = tokenToUse;
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = "";
    let errorOutput = "";

    localstackProcess.stdout?.on('data', (data) => {
      output += data.toString();
    });

    localstackProcess.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Give LocalStack some time to start and then check status
    setTimeout(async () => {
      try {
        const { stdout: statusCheck } = await execAsync("localstack status");
        
        let resultMessage = "🚀 LocalStack start command executed!\n\n";
        
        if (enablePro || authToken) {
          resultMessage += "✅ LocalStack Pro services enabled\n";
        }
        
        if (envVars && Object.keys(envVars).length > 0) {
          resultMessage += `✅ Custom environment variables applied: ${Object.keys(envVars).join(', ')}\n`;
        }
        
        resultMessage += `\nStatus check:\n${statusCheck}`;
        
        if (output) {
          resultMessage += `\n\nOutput:\n${output}`;
        }
        
        resolve({
          content: [{ type: "text", text: resultMessage }],
        });
      } catch (error) {
        let resultMessage = "⚠️  LocalStack start command executed, but status check failed.\n\n";
        
        if (output) {
          resultMessage += `Output:\n${output}\n`;
        }
        
        if (errorOutput) {
          resultMessage += `Error output:\n${errorOutput}\n`;
        }
        
        resultMessage += "\nLocalStack may still be starting up. You can check the status manually using the status action.";
        
        resolve({
          content: [{ type: "text", text: resultMessage }],
        });
      }
    }, 5000); // Wait 5 seconds for LocalStack to start

    localstackProcess.on('error', (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      resolve({
        content: [{ type: "text", text: `❌ Failed to start LocalStack: ${errorMessage}` }],
      });
    });
  });
}

// Handle stop action
async function handleStop() {
  try {
    // Execute localstack stop command
    const { stdout, stderr } = await execAsync("localstack stop");
    
    let result = "🛑 LocalStack stop command executed successfully!\n";
    
    if (stdout.trim()) {
      result += `\nOutput:\n${stdout}`;
    }
    
    if (stderr.trim()) {
      result += `\nMessages:\n${stderr}`;
    }
    
    // Verify that LocalStack has stopped
    try {
      const { stdout: statusOutput } = await execAsync("localstack status");
      if (!statusOutput.includes("running")) {
        result += "\n\n✅ LocalStack has been stopped successfully.";
      } else {
        result += "\n\n⚠️  LocalStack may still be running. Check the status manually if needed.";
      }
    } catch (error) {
      // If status command fails, LocalStack is likely stopped
      result += "\n\n✅ LocalStack appears to be stopped.";
    }
    
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = `❌ Failed to stop LocalStack: ${errorMessage}

This could happen if:
- LocalStack is not currently running
- There was an error executing the stop command
- Permission issues

You can try checking the LocalStack status first to see if it's running.`;
    
    return {
      content: [{ type: "text", text: result }],
    };
  }
}

// Handle restart action
async function handleRestart() {
  try {
    // Execute localstack restart command
    const { stdout, stderr } = await execAsync("localstack restart", { timeout: 30000 });
    
    let result = "🔄 LocalStack restart command executed!\n\n";
    
    if (stdout.trim()) {
      result += `Output:\n${stdout}\n`;
    }
    
    if (stderr.trim()) {
      result += `Messages:\n${stderr}\n`;
    }
    
    // Wait a moment and check status
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      const { stdout: statusOutput } = await execAsync("localstack status");
      result += `\nStatus after restart:\n${statusOutput}`;
      
      if (statusOutput.includes("running")) {
        result += "\n\n✅ LocalStack has been restarted successfully and is now running with a fresh state.";
      } else {
        result += "\n\n⚠️  LocalStack restart completed but may still be starting up. Check status again in a few moments.";
      }
    } catch (error) {
      result += "\n\n⚠️  Restart completed but unable to verify status. LocalStack may still be starting up.";
    }
    
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = `❌ Failed to restart LocalStack: ${errorMessage}

This could happen if:
- LocalStack is not currently installed properly
- There was an error executing the restart command
- The restart process timed out (LocalStack can take time to restart)
- Permission issues

You can try stopping and starting LocalStack manually using separate actions if the restart action continues to fail.`;
    
    return {
      content: [{ type: "text", text: result }],
    };
  }
}

// Handle status action
async function handleStatus() {
  try {
    // Execute localstack status command
    const { stdout, stderr } = await execAsync("localstack status");
    
    let result = "📊 LocalStack Status:\n\n";
    result += stdout;
    
    if (stderr.trim()) {
      result += `\n\nMessages:\n${stderr}`;
    }
    
    // Add helpful information based on the status
    if (stdout.includes("running")) {
      result += "\n\n✅ LocalStack is currently running and ready to accept requests.";
    } else if (stdout.includes("stopped") || stdout.includes("not running")) {
      result += "\n\n⚠️  LocalStack is not currently running. Use the start action to start it.";
    }
    
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = `❌ Failed to get LocalStack status: ${errorMessage}

This could happen if:
- LocalStack is not installed properly
- There was an error executing the status command
- LocalStack services are not accessible

Try running the CLI check tool first to verify your LocalStack installation.`;
    
    return {
      content: [{ type: "text", text: result }],
    };
  }
} 