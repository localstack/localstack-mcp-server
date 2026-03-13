import { runCommand } from "../../core/command-runner";
import fs from "fs";
import path from "path";

export interface DependencyCheckResult {
  isAvailable: boolean;
  tool: string;
  version?: string;
  errorMessage?: string;
}

export type ProjectType =
  | "cdk"
  | "terraform"
  | "sam"
  | "cloudformation"
  | "ambiguous"
  | "unknown";

/**
 * Check if the required deployment tool (cdklocal or tflocal) is available in the system PATH
 * @param projectType The type of project requiring either 'cdk' or 'terraform' tooling
 * @returns Promise with availability status and tool information
 */
export async function checkDependencies(
  projectType: "cdk" | "terraform" | "sam"
): Promise<DependencyCheckResult> {
  const tool =
    projectType === "cdk" ? "cdklocal" : projectType === "terraform" ? "tflocal" : "samlocal";

  try {
    const { stdout, error } = await runCommand(tool, ["--version"], { timeout: 10000 });
    if (error) throw error;

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
        : projectType === "terraform"
          ? `❌ tflocal is not installed or not available in PATH.

Please install terraform-local by following the official documentation:
https://github.com/localstack/terraform-local

Installation:
pip install terraform-local

After installation, make sure the 'tflocal' command is available in your PATH.`
          : `❌ samlocal is not installed or not available in PATH.

Please install aws-sam-cli-local by following the official documentation:
https://github.com/localstack/aws-sam-cli-local

Installation:
pip install aws-sam-cli-local

After installation, make sure the 'samlocal' command is available in your PATH.`;

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

    const hasTemplateYaml = files.includes("template.yaml") || files.includes("template.yml");
    const hasSamConfig = files.includes("samconfig.toml");

    let hasServerlessResources = false;
    if (hasTemplateYaml) {
      const samTemplateFile = files.includes("template.yaml") ? "template.yaml" : "template.yml";
      try {
        const templateContent = await fs.promises.readFile(path.join(directory, samTemplateFile), "utf-8");
        hasServerlessResources = /AWS::Serverless::[A-Za-z]+/.test(templateContent);
      } catch {
        hasServerlessResources = false;
      }
    }

    const hasCloudFormationTemplates = files.some((file) => file.endsWith(".yaml") || file.endsWith(".yml"));

    const isCdk = hasCdkJson || hasCdkFiles;
    const isTerraform = hasTerraformFiles;
    const isSam = hasSamConfig || hasServerlessResources;
    const isCloudFormation = hasCloudFormationTemplates && !isSam;

    if (
      [isCdk, isTerraform, isSam, isCloudFormation].filter(Boolean).length > 1
    ) {
      return "ambiguous";
    } else if (isCdk) {
      return "cdk";
    } else if (isTerraform) {
      return "terraform";
    } else if (isSam) {
      return "sam";
    } else if (isCloudFormation) {
      return "cloudformation";
    } else {
      return "unknown";
    }
  } catch (error) {
    return "unknown";
  }
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

export type DeploymentEventType = "header" | "command" | "output" | "error" | "success" | "warning";

export interface DeploymentEvent {
  type: DeploymentEventType;
  title?: string;
  content: string;
}
