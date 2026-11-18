import { runCommand } from "../../core/command-runner";
import fs from "fs";
import path from "path";

export interface DependencyCheckResult {
  isAvailable: boolean;
  tool: string;
  version?: string;
  errorMessage?: string;
}

export type ProjectType = "cdk" | "terraform" | "sam" | "cloudformation" | "ambiguous" | "unknown";

const LSTK_INSTALL_MESSAGE = `❌ lstk is not installed or not available in PATH.

The deployer runs Terraform, CDK, and SAM through the lstk CLI. Please install it by following the official documentation:
https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/

Installation:
npm install -g @localstack/lstk
# or: brew install localstack/tap/lstk

After installation, make sure the 'lstk' command is available in your PATH.`;

const IAC_TOOLS: Record<
  "cdk" | "terraform" | "sam",
  { binary: string; versionArgs: string[]; errorMessage: string }
> = {
  terraform: {
    binary: "terraform",
    versionArgs: ["version"],
    errorMessage: `❌ terraform is not installed or not available in PATH.

lstk runs your own Terraform CLI. Please install it by following the official documentation:
https://developer.hashicorp.com/terraform/install

After installation, make sure the 'terraform' command is available in your PATH.`,
  },
  cdk: {
    binary: "cdk",
    versionArgs: ["--version"],
    errorMessage: `❌ cdk is not installed or not available in PATH.

lstk runs your own AWS CDK CLI (2.177.0 or newer). Please install it:
npm install -g aws-cdk

After installation, make sure the 'cdk' command is available in your PATH.`,
  },
  sam: {
    binary: "sam",
    versionArgs: ["--version"],
    errorMessage: `❌ sam is not installed or not available in PATH.

lstk runs your own AWS SAM CLI (1.95.0 or newer). Please install it by following the official documentation:
https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html

After installation, make sure the 'sam' command is available in your PATH.`,
  },
};

/**
 * Check that lstk and the IaC CLI it wraps (terraform, cdk, or sam) are available in the system PATH
 * @param projectType The type of project requiring 'cdk', 'terraform', or 'sam' tooling
 * @returns Promise with availability status and tool information
 */
export async function checkDependencies(
  projectType: "cdk" | "terraform" | "sam"
): Promise<DependencyCheckResult> {
  const lstk = await runCommand("lstk", ["--version"], { timeout: 10000 });
  if (lstk.error) {
    return { isAvailable: false, tool: "lstk", errorMessage: LSTK_INSTALL_MESSAGE };
  }

  const { binary, versionArgs, errorMessage } = IAC_TOOLS[projectType];
  const wrapped = await runCommand(binary, versionArgs, { timeout: 10000 });
  if (wrapped.error) {
    return { isAvailable: false, tool: binary, errorMessage };
  }

  return {
    isAvailable: true,
    tool: `lstk ${projectType}`,
    version: `${lstk.stdout.trim()}; ${wrapped.stdout.trim().split("\n")[0]}`,
  };
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
        const templateContent = await fs.promises.readFile(
          path.join(directory, samTemplateFile),
          "utf-8"
        );
        hasServerlessResources = /AWS::Serverless::[A-Za-z]+/.test(templateContent);
      } catch {
        hasServerlessResources = false;
      }
    }

    const hasCloudFormationTemplates = files.some(
      (file) => file.endsWith(".yaml") || file.endsWith(".yml")
    );

    const isCdk = hasCdkJson || hasCdkFiles;
    const isTerraform = hasTerraformFiles;
    const isSam = hasSamConfig || hasServerlessResources;
    const isCloudFormation = hasCloudFormationTemplates && !isSam;

    if ([isCdk, isTerraform, isSam, isCloudFormation].filter(Boolean).length > 1) {
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
 * @param stdout The stdout from the lstk cdk deploy command
 * @returns Formatted markdown string of outputs
 */
export function parseCdkOutputs(stdout: string): string {
  try {
    // Split on both LF and CRLF so captured stdout from Windows child
    // processes (which can use \r\n) doesn't leave a trailing \r on each line.
    // A trailing \r would break the output matcher below, since `.` does not
    // match \r and `$` (no `m` flag) won't anchor before a \r.
    const lines = stdout.split(/\r?\n/);
    const outputLines: Array<{ name: string; value: string }> = [];
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
          outputLines.push({ name: outputMatch[1].trim(), value: outputMatch[2].trim() });
        }
      }
    }

    if (outputLines.length === 0) {
      return "No outputs defined in this CDK stack.";
    }

    let result = "## 📋 CDK Stack Outputs\n\n";
    result += "| Output | Value |\n";
    result += "|--------|-------|\n";

    for (const { name, value } of outputLines) {
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
