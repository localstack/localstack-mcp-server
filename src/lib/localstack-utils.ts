import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface LocalStackCliCheckResult {
  isAvailable: boolean;
  version?: string;
  errorMessage?: string;
}

/**
 * Check if LocalStack CLI is installed and available in the system PATH
 * @returns Promise with availability status, version (if available), and error message (if not available)
 */
export async function checkLocalStackCli(): Promise<LocalStackCliCheckResult> {
  try {
    // Try to execute 'localstack --help' to check if CLI is available
    await execAsync("localstack --help");
    
    // Get version information
    const { stdout: version } = await execAsync("localstack --version");
    
    return {
      isAvailable: true,
      version: version.trim(),
    };
  } catch (error) {
    return {
      isAvailable: false,
      errorMessage: `❌ LocalStack CLI is not installed or not available in PATH.

Please install LocalStack by following the official documentation:
https://docs.localstack.cloud/aws/getting-started/installation/

Installation options:
- Using pip: pip install localstack
- Using Docker: Use the LocalStack Docker image
- Using Homebrew (macOS): brew install localstack/tap/localstack-cli

After installation, make sure the 'localstack' command is available in your PATH.`,
    };
  }
}

export interface LocalStackStatusResult {
  isRunning: boolean;
  statusOutput?: string;
  errorMessage?: string;
  isReady?: boolean;
}

/**
 * Get LocalStack status information
 * @returns Promise with status details including running state and raw output
 */
export async function getLocalStackStatus(): Promise<LocalStackStatusResult> {
  try {
    const { stdout } = await execAsync("localstack status");
    
    const isRunning = stdout.includes("running");
    const isReady = stdout.includes("Ready") || stdout.includes("ready");
    
    return {
      isRunning,
      isReady,
      statusOutput: stdout.trim(),
    };
  } catch (error) {
    return {
      isRunning: false,
      errorMessage: `Failed to get LocalStack status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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