import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

export interface DependencyCheckResult {
  isAvailable: boolean;
  tool: string;
  version?: string;
  errorMessage?: string;
}

export type ProjectType = "cdk" | "terraform" | "ambiguous" | "unknown";

/**
 * Check if the required deployment tool (cdklocal or tflocal) is available in the system PATH
 * @param projectType The type of project requiring either 'cdk' or 'terraform' tooling
 * @returns Promise with availability status and tool information
 */
export async function checkDependencies(
  projectType: "cdk" | "terraform"
): Promise<DependencyCheckResult> {
  const tool = projectType === "cdk" ? "cdklocal" : "tflocal";

  try {
    const { stdout } = await execAsync(`${tool} --version`, { timeout: 10000 });

    return {
      isAvailable: true,
      tool,
      version: stdout.trim(),
    };
  } catch (error) {
    const errorMessage =
      projectType === "cdk"
        ? `❌ cdklocal is not installed or not available in PATH.

Please install aws-cdk-local by following the official documentation:
https://github.com/localstack/aws-cdk-local

Installation:
npm install -g aws-cdk-local aws-cdk

After installation, make sure the 'cdklocal' command is available in your PATH.`
        : `❌ tflocal is not installed or not available in PATH.

Please install terraform-local by following the official documentation:
https://github.com/localstack/terraform-local

Installation:
pip install terraform-local

After installation, make sure the 'tflocal' command is available in your PATH.`;

    return {
      isAvailable: false,
      tool,
      errorMessage,
    };
  }
}

/**
 * Infer the project type by inspecting the contents of the given directory
 * @param directory The path to the project directory
 * @returns Promise with the inferred project type
 */
export async function inferProjectType(directory: string): Promise<ProjectType> {
  try {
    const stats = await fs.promises.stat(directory);
    if (!stats.isDirectory()) {
      throw new Error(`Path ${directory} is not a directory`);
    }

    const files = await fs.promises.readdir(directory);

    const hasCdkJson = files.includes("cdk.json");
    const hasCdkFiles = files.some(
      (file) =>
        file.startsWith("cdk.") || file === "app.py" || file === "app.js" || file === "app.ts"
    );

    const hasTerraformFiles = files.some(
      (file) => file.endsWith(".tf") || file.endsWith(".tf.json")
    );

    const isCdk = hasCdkJson || hasCdkFiles;
    const isTerraform = hasTerraformFiles;

    if (isCdk && isTerraform) {
      return "ambiguous";
    } else if (isCdk) {
      return "cdk";
    } else if (isTerraform) {
      return "terraform";
    } else {
      return "unknown";
    }
  } catch (error) {
    return "unknown";
  }
}

/**
 * Strip ANSI escape codes from command output for clean display
 * @param text The text containing ANSI escape codes
 * @returns Cleaned text without ANSI codes
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Validate variables object to prevent command injection
 * @param variables The variables object to validate
 * @returns Array of validation errors, empty if valid
 */
export function validateVariables(variables?: Record<string, string>): string[] {
  if (!variables) {
    return [];
  }

  const dangerousPatterns = [
    ";", // Command separator
    "&&", // Command chaining
    "||", // Command chaining
    "$(", // Command substitution
    "`", // Command substitution (backticks)
    "|", // Pipe operator
    ">", // Output redirection
    "<", // Input redirection
    "&", // Background execution
    "\n", // Newline
    "\r", // Carriage return
  ];

  const errors: string[] = [];

  for (const [key, value] of Object.entries(variables)) {
    for (const pattern of dangerousPatterns) {
      if (key.includes(pattern)) {
        errors.push(`Variable key "${key}" contains forbidden character: ${pattern}`);
      }
      if (value.includes(pattern)) {
        errors.push(`Variable value for "${key}" contains forbidden character: ${pattern}`);
      }
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) {
      errors.push(`Variable key "${key}" is not a valid identifier`);
    }
  }

  return errors;
}

/**
 * Parse Terraform outputs from JSON format
 * @param outputJson The JSON string from terraform output -json
 * @returns Formatted markdown string of outputs
 */
export function parseTerraformOutputs(outputJson: string): string {
  try {
    const outputs = JSON.parse(outputJson);

    if (!outputs || Object.keys(outputs).length === 0) {
      return "No outputs defined in this Terraform configuration.";
    }

    let result = "## 📋 Terraform Outputs\n\n";
    result += "| Name | Value | Description |\n";
    result += "|------|-------|-------------|\n";

    for (const [name, config] of Object.entries(outputs as Record<string, any>)) {
      const value = config.value ?? "N/A";
      const description = config.description ?? "";
      const displayValue = typeof value === "string" ? value : JSON.stringify(value);
      result += `| **${name}** | \`${displayValue}\` | ${description} |\n`;
    }

    return result;
  } catch (error) {
    return `Error parsing Terraform outputs: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Parse CDK outputs from deploy command stdout
 * @param stdout The stdout from cdklocal deploy command
 * @returns Formatted markdown string of outputs
 */
export function parseCdkOutputs(stdout: string): string {
  try {
    const lines = stdout.split("\n");
    const outputLines: string[] = [];
    let inOutputsSection = false;

    for (const line of lines) {
      if (line.trim().startsWith("Outputs:")) {
        inOutputsSection = true;
        continue;
      }

      if (inOutputsSection) {
        if (line.trim() === "" || line.match(/^[A-Z].*:$/)) {
          break;
        }

        const outputMatch = line.match(/^([^=]+)\s*=\s*(.+)$/);
        if (outputMatch) {
          outputLines.push(line.trim());
        }
      }
    }

    if (outputLines.length === 0) {
      return "No outputs defined in this CDK stack.";
    }

    let result = "## 📋 CDK Stack Outputs\n\n";
    result += "| Output | Value |\n";
    result += "|--------|-------|\n";

    for (const line of outputLines) {
      const [name, value] = line.split(" = ").map((s) => s.trim());
      result += `| **${name}** | \`${value}\` |\n`;
    }

    return result;
  } catch (error) {
    return `Error parsing CDK outputs: ${error instanceof Error ? error.message : String(error)}`;
  }
}
