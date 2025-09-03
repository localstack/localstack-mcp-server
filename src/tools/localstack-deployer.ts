import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runCommand, stripAnsiCodes } from "../core/command-runner";
import path from "path";
import { ensureLocalStackCli } from "../lib/localstack/localstack.utils";
import {
  checkDependencies,
  inferProjectType,
  validateVariables,
  parseTerraformOutputs,
  parseCdkOutputs,
  type ProjectType,
} from "../lib/deployment/deployment-utils";

// Define the schema for tool parameters
export const schema = {
  action: z
    .enum(["deploy", "destroy"])
    .describe(
      "The deployment action to perform: 'deploy' to create/update resources, or 'destroy' to remove them."
    ),
  projectType: z
    .enum(["cdk", "terraform", "auto"])
    .default("auto")
    .describe(
      "The type of project. 'auto' (default) infers from files. Specify 'cdk' or 'terraform' to override."
    ),
  directory: z
    .string()
    .describe(
      "The required path to the project directory containing your infrastructure-as-code files."
    ),
  variables: z
    .record(z.string())
    .optional()
    .describe(
      "Key-value pairs for parameterization. Used for Terraform variables (-var) or CDK context (-c)."
    ),
};

// Define tool metadata
export const metadata: ToolMetadata = {
  name: "localstack-deployer",
  description: "Deploys or destroys AWS infrastructure on LocalStack using CDK or Terraform.",
  annotations: {
    title: "LocalStack Deployer",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

// Tool implementation
export default async function localstackDeployer({
  action,
  projectType,
  directory,
  variables,
}: InferSchema<typeof schema>) {
  // Check if LocalStack CLI is available first
  const cliError = await ensureLocalStackCli();
  if (cliError) return cliError;

  let resolvedProjectType: "cdk" | "terraform";

  try {
    // Step 1: Project Type Resolution
    if (projectType === "auto") {
      const inferredType = await inferProjectType(directory);

      if (inferredType === "ambiguous") {
        return {
          content: [
            {
              type: "text",
              text: `❌ **Ambiguous Project Type**

The directory "${directory}" contains both CDK and Terraform files. Please specify the project type explicitly:

- Use \`projectType: 'cdk'\` to deploy as a CDK project
- Use \`projectType: 'terraform'\` to deploy as a Terraform project`,
            },
          ],
        };
      }

      if (inferredType === "unknown") {
        return {
          content: [
            {
              type: "text",
              text: `❌ **Unknown Project Type**

The directory "${directory}" does not appear to contain recognizable infrastructure-as-code files.

Expected files:
- **CDK**: \`cdk.json\`, \`app.py\`, \`app.js\`, or \`app.ts\`
- **Terraform**: \`*.tf\` or \`*.tf.json\` files

Please check the directory path or specify the project type explicitly.`,
            },
          ],
        };
      }

      resolvedProjectType = inferredType as "cdk" | "terraform";
    } else {
      resolvedProjectType = projectType as "cdk" | "terraform";
    }

    // Check Dependencies
    const dependencyCheck = await checkDependencies(resolvedProjectType);
    if (!dependencyCheck.isAvailable) {
      return {
        content: [{ type: "text", text: dependencyCheck.errorMessage! }],
      };
    }

    // Security Validation
    const validationErrors = validateVariables(variables);
    if (validationErrors.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `🛡️ **Security Violation Detected**

Command injection attempt prevented. The following issues were found:

${validationErrors.map((error) => `- ${error}`).join("\n")}

Please review your variables and ensure they don't contain shell metacharacters or invalid identifiers.`,
          },
        ],
      };
    }

    // Execute Commands Based on Project Type and Action
    return await executeDeploymentCommands(resolvedProjectType, action, directory, variables);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `❌ **Deployment Error**

An unexpected error occurred: ${errorMessage}

Please check the directory path and ensure all prerequisites are met.`,
        },
      ],
    };
  }
}

/**
 * Execute the deployment commands based on project type and action
 */
async function executeDeploymentCommands(
  projectType: "cdk" | "terraform",
  action: "deploy" | "destroy",
  directory: string,
  variables?: Record<string, string>
) {
  const absoluteDirectory = path.resolve(directory);
  let result = `# 🚀 LocalStack ${projectType.toUpperCase()} ${action === "deploy" ? "Deployment" : "Destruction"}\n\n`;
  result += `**Project Type:** ${projectType}\n`;
  result += `**Directory:** ${absoluteDirectory}\n`;
  result += `**Action:** ${action}\n\n`;

  try {
    if (projectType === "terraform") {
      return await executeTerraformCommands(action, absoluteDirectory, variables, result);
    } else {
      return await executeCdkCommands(action, absoluteDirectory, variables, result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result += `❌ **Command Execution Failed**\n\n${errorMessage}`;

    return {
      content: [{ type: "text", text: result }],
    };
  }
}

/**
 * Execute Terraform commands
 */
async function executeTerraformCommands(
  action: "deploy" | "destroy",
  directory: string,
  variables?: Record<string, string>,
  result: string = ""
) {
  const baseCommand = "tflocal";
  const varArgs = variables
    ? Object.entries(variables).map(([key, value]) => `-var=${key}=${value}`)
    : [];

  if (action === "deploy") {
    result += `## 📦 Initializing Terraform\n\n`;
    try {
      const initRes = await runCommand(baseCommand, ["init"], { cwd: directory });

      const cleanInitOutput = stripAnsiCodes(initRes.stdout);
      if (cleanInitOutput.trim()) {
        result += `\`\`\`\n${cleanInitOutput}\n\`\`\`\n\n`;
      }

      if (
        initRes.stderr &&
        !initRes.stderr.includes("Terraform has been successfully initialized")
      ) {
        const cleanInitError = stripAnsiCodes(initRes.stderr);
        result += `**Messages:**\n\`\`\`\n${cleanInitError}\n\`\`\`\n\n`;
      }
    } catch (error) {
      result += `❌ **Error during \`tflocal init\`**\n\n`;
      const errorOutput =
        error instanceof Error && "stderr" in error
          ? stripAnsiCodes(String((error as any).stderr))
          : String(error);
      result += `\`\`\`\n${errorOutput}\n\`\`\`\n`;

      return {
        content: [{ type: "text", text: result }],
      };
    }

    result += `## 🔨 Applying Terraform Configuration\n\n`;
    try {
      const applyRes = await runCommand(baseCommand, ["apply", "-auto-approve", ...varArgs], {
        cwd: directory,
      });

      const cleanApplyOutput = stripAnsiCodes(applyRes.stdout);
      if (cleanApplyOutput.trim()) {
        result += `\`\`\`\n${cleanApplyOutput}\n\`\`\`\n\n`;
      }

      if (applyRes.stderr) {
        const cleanApplyError = stripAnsiCodes(applyRes.stderr);
        result += `**Messages:**\n\`\`\`\n${cleanApplyError}\n\`\`\`\n\n`;
      }

      try {
        const outputRes = await runCommand(baseCommand, ["output", "-json"], { cwd: directory });

        if (outputRes.stdout.trim()) {
          const parsedOutputs = parseTerraformOutputs(outputRes.stdout);
          result += parsedOutputs + "\n\n";
        }
      } catch (outputError) {
        result += `**Note:** Outputs not retrieved (deployment successful, but output parsing skipped)\n\n`;
      }

      result += `✅ **Terraform deployment completed successfully!**\n`;
    } catch (error) {
      result += `❌ **Error during \`tflocal apply\`**\n\n`;
      const errorOutput =
        error instanceof Error && "stderr" in error
          ? stripAnsiCodes(String((error as any).stderr))
          : String(error);
      result += `\`\`\`\n${errorOutput}\n\`\`\`\n`;

      return {
        content: [{ type: "text", text: result }],
      };
    }
  } else {
    result += `## 💥 Destroying Terraform Resources\n\n`;
    try {
      const destroyRes = await runCommand(baseCommand, ["destroy", "-auto-approve", ...varArgs], {
        cwd: directory,
      });

      const cleanDestroyOutput = stripAnsiCodes(destroyRes.stdout);
      if (cleanDestroyOutput.trim()) {
        result += `\`\`\`\n${cleanDestroyOutput}\n\`\`\`\n\n`;
      }

      if (destroyRes.stderr) {
        const cleanDestroyError = stripAnsiCodes(destroyRes.stderr);
        result += `**Messages:**\n\`\`\`\n${cleanDestroyError}\n\`\`\`\n\n`;
      }

      result += `✅ **Terraform resources in ${directory} have been destroyed.**\n`;
    } catch (error) {
      result += `❌ **Error during \`tflocal destroy\`**\n\n`;
      const errorOutput =
        error instanceof Error && "stderr" in error
          ? stripAnsiCodes(String((error as any).stderr))
          : String(error);
      result += `\`\`\`\n${errorOutput}\n\`\`\`\n`;

      return {
        content: [{ type: "text", text: result }],
      };
    }
  }

  return {
    content: [{ type: "text", text: result }],
  };
}

/**
 * Execute CDK commands
 */
async function executeCdkCommands(
  action: "deploy" | "destroy",
  directory: string,
  variables?: Record<string, string>,
  result: string = ""
) {
  const baseCommand = "cdklocal";
  const contextArgs = variables
    ? Object.entries(variables).flatMap(([key, value]) => ["--context", `${key}=${value}`])
    : [];

  if (action === "deploy") {
    result += `## 🥾 Bootstrapping CDK for LocalStack\n\n`;
    try {
      const bootstrapRes = await runCommand(baseCommand, ["bootstrap"], {
        cwd: directory,
        env: { ...process.env, CI: "true" },
      });

      const cleanBootstrapOutput = stripAnsiCodes(bootstrapRes.stdout);
      if (cleanBootstrapOutput.trim()) {
        result += `\`\`\`\n${cleanBootstrapOutput}\n\`\`\`\n\n`;
      }

      if (bootstrapRes.stderr) {
        const cleanBootstrapError = stripAnsiCodes(bootstrapRes.stderr);
        result += `**Messages:**\n\`\`\`\n${cleanBootstrapError}\n\`\`\`\n\n`;
      }
    } catch (error) {
      result += `❌ **Error during \`cdklocal bootstrap\`**\n\n`;
      const errorOutput =
        error instanceof Error && "stderr" in error
          ? stripAnsiCodes(String((error as any).stderr))
          : String(error);
      result += `\`\`\`\n${errorOutput}\n\`\`\`\n`;

      return {
        content: [{ type: "text", text: result }],
      };
    }

    result += `## 🚀 Deploying CDK Stack\n\n`;
    try {
      const deployRes = await runCommand(
        baseCommand,
        ["deploy", "--require-approval", "never", "--all", ...contextArgs],
        { cwd: directory, env: { ...process.env, CI: "true" } }
      );

      const cleanDeployOutput = stripAnsiCodes(deployRes.stdout);
      if (cleanDeployOutput.trim()) {
        result += `\`\`\`\n${cleanDeployOutput}\n\`\`\`\n\n`;
      }

      if (deployRes.stderr) {
        const cleanDeployError = stripAnsiCodes(deployRes.stderr);
        result += `**Messages:**\n\`\`\`\n${cleanDeployError}\n\`\`\`\n\n`;
      }

      try {
        const parsedOutputs = parseCdkOutputs(cleanDeployOutput);
        if (parsedOutputs && !parsedOutputs.includes("No outputs defined")) {
          result += parsedOutputs + "\n\n";
        }
      } catch (outputError) {
        result += `**Note:** Outputs parsing skipped (check if the deployment is successful)\n\n`;
      }

      result += `✅ **CDK stack deployed successfully!**\n`;
    } catch (error) {
      result += `❌ **Error during \`cdklocal deploy\`**\n\n`;
      const errorOutput =
        error instanceof Error && "stderr" in error
          ? stripAnsiCodes(String((error as any).stderr))
          : String(error);
      result += `\`\`\`\n${errorOutput}\n\`\`\`\n`;

      return {
        content: [{ type: "text", text: result }],
      };
    }
  } else {
    result += `## 💥 Destroying CDK Stack\n\n`;
    try {
      const destroyRes = await runCommand(
        baseCommand,
        ["destroy", "--force", "--all", ...contextArgs],
        { cwd: directory, env: { ...process.env, CI: "true" } }
      );

      const cleanDestroyOutput = stripAnsiCodes(destroyRes.stdout);
      if (cleanDestroyOutput.trim()) {
        result += `\`\`\`\n${cleanDestroyOutput}\n\`\`\`\n\n`;
      }

      if (destroyRes.stderr) {
        const cleanDestroyError = stripAnsiCodes(destroyRes.stderr);
        result += `**Messages:**\n\`\`\`\n${cleanDestroyError}\n\`\`\`\n\n`;
      }

      result += `✅ **CDK stack in ${directory} has been destroyed.**\n`;
    } catch (error) {
      result += `❌ **Error during \`cdklocal destroy\`**\n\n`;
      const errorOutput =
        error instanceof Error && "stderr" in error
          ? stripAnsiCodes(String((error as any).stderr))
          : String(error);
      result += `\`\`\`\n${errorOutput}\n\`\`\`\n`;

      return {
        content: [{ type: "text", text: result }],
      };
    }
  }

  return {
    content: [{ type: "text", text: result }],
  };
}
