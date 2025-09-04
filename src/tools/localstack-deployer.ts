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
import { type DeploymentEvent } from "../lib/deployment/deployment-utils";
import { formatDeploymentReport } from "../lib/deployment/deployment-reporter";
import { ResponseBuilder } from "../core/response-builder";

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
        return ResponseBuilder.error(
          "Ambiguous Project Type",
          `The directory "${directory}" contains both CDK and Terraform files. Please specify the project type explicitly:

- Use \`projectType: 'cdk'\` to deploy as a CDK project
- Use \`projectType: 'terraform'\` to deploy as a Terraform project`
        );
      }

      if (inferredType === "unknown") {
        return ResponseBuilder.error(
          "Unknown Project Type",
          `The directory "${directory}" does not appear to contain recognizable infrastructure-as-code files.

Expected files:
- **CDK**: \`cdk.json\`, \`app.py\`, \`app.js\`, or \`app.ts\`
- **Terraform**: \`*.tf\` or \`*.tf.json\` files

Please check the directory path or specify the project type explicitly.`
        );
      }

      resolvedProjectType = inferredType as "cdk" | "terraform";
    } else {
      resolvedProjectType = projectType as "cdk" | "terraform";
    }

    // Check Dependencies
    const dependencyCheck = await checkDependencies(resolvedProjectType);
    if (!dependencyCheck.isAvailable) {
      return ResponseBuilder.error("Dependency Not Available", dependencyCheck.errorMessage!);
    }

    // Security Validation
    const validationErrors = validateVariables(variables);
    if (validationErrors.length > 0) {
      return ResponseBuilder.error(
        "Security Violation Detected",
        `🛡️ **Security Violation Detected**

Command injection attempt prevented. The following issues were found:

${validationErrors.map((error) => `- ${error}`).join("\n")}

Please review your variables and ensure they don't contain shell metacharacters or invalid identifiers.`
      );
    }

    // Execute Commands Based on Project Type and Action
    return await executeDeploymentCommands(resolvedProjectType, action, directory, variables);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.error(
      "Deployment Error",
      `An unexpected error occurred: ${errorMessage}

Please check the directory path and ensure all prerequisites are met.`
    );
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
  const baseTitle = `🚀 LocalStack ${projectType.toUpperCase()} ${action === "deploy" ? "Deployment" : "Destruction"}`;
  const events =
    projectType === "terraform"
      ? await executeTerraformCommands(action, absoluteDirectory, variables)
      : await executeCdkCommands(action, absoluteDirectory, variables);
  const report = formatDeploymentReport(baseTitle, events);
  return ResponseBuilder.markdown(report);
}

/**
 * Execute Terraform commands
 */
async function executeTerraformCommands(
  action: "deploy" | "destroy",
  directory: string,
  variables?: Record<string, string>
): Promise<DeploymentEvent[]> {
  const events: DeploymentEvent[] = [];
  const baseCommand = "tflocal";
  const varArgs = variables
    ? Object.entries(variables).flatMap(([k, v]) => ["-var", `${k}=${v}`])
    : [];

  if (action === "deploy") {
    events.push({ type: "header", title: "📦 Initializing Terraform", content: "" });
    const initRes = await runCommand(baseCommand, ["init"], { cwd: directory });
    events.push({ type: "output", content: stripAnsiCodes(initRes.stdout) });
    if (initRes.stderr) events.push({ type: "warning", content: stripAnsiCodes(initRes.stderr) });
    if (initRes.error) {
      events.push({
        type: "error",
        title: "Error during `tflocal init`",
        content: initRes.error.message,
      });
      return events;
    }

    events.push({ type: "header", title: "🔨 Applying Terraform Configuration", content: "" });
    const applyArgs = ["apply", "-auto-approve", ...varArgs];
    const applyRes = await runCommand(baseCommand, applyArgs, { cwd: directory });
    events.push({ type: "output", content: stripAnsiCodes(applyRes.stdout) });
    if (applyRes.stderr) events.push({ type: "warning", content: stripAnsiCodes(applyRes.stderr) });
    if (applyRes.error) {
      events.push({
        type: "error",
        title: "Error during `tflocal apply`",
        content: applyRes.error.message,
      });
      return events;
    }

    const outputRes = await runCommand(baseCommand, ["output", "-json"], { cwd: directory });
    if (outputRes.stdout.trim()) {
      const parsed = parseTerraformOutputs(outputRes.stdout);
      events.push({ type: "output", content: parsed });
    }
    events.push({ type: "success", content: "Terraform deployment completed successfully!" });
  } else {
    events.push({ type: "header", title: "💥 Destroying Terraform Resources", content: "" });
    const destroyArgs = ["destroy", "-auto-approve", ...varArgs];
    const destroyRes = await runCommand(baseCommand, destroyArgs, { cwd: directory });
    events.push({ type: "output", content: stripAnsiCodes(destroyRes.stdout) });
    if (destroyRes.stderr)
      events.push({ type: "warning", content: stripAnsiCodes(destroyRes.stderr) });
    if (destroyRes.error) {
      events.push({
        type: "error",
        title: "Error during `tflocal destroy`",
        content: destroyRes.error.message,
      });
      return events;
    }
    events.push({
      type: "success",
      content: `Terraform resources in ${directory} have been destroyed.`,
    });
  }
  return events;
}

/**
 * Execute CDK commands
 */
async function executeCdkCommands(
  action: "deploy" | "destroy",
  directory: string,
  variables?: Record<string, string>
): Promise<DeploymentEvent[]> {
  const events: DeploymentEvent[] = [];
  const baseCommand = "cdklocal";
  const contextArgs = variables
    ? Object.entries(variables).flatMap(([key, value]) => ["--context", `${key}=${value}`])
    : [];

  if (action === "deploy") {
    events.push({ type: "header", title: "🥾 Bootstrapping CDK for LocalStack", content: "" });
    const bootstrapRes = await runCommand(baseCommand, ["bootstrap"], {
      cwd: directory,
      env: { ...process.env, CI: "true" },
    });
    events.push({ type: "output", content: stripAnsiCodes(bootstrapRes.stdout) });
    if (bootstrapRes.stderr)
      events.push({ type: "warning", content: stripAnsiCodes(bootstrapRes.stderr) });
    if (bootstrapRes.error) {
      events.push({
        type: "error",
        title: "Error during `cdklocal bootstrap`",
        content: bootstrapRes.error.message,
      });
      return events;
    }

    events.push({ type: "header", title: "🚀 Deploying CDK Stack", content: "" });
    const deployRes = await runCommand(
      baseCommand,
      ["deploy", "--require-approval", "never", "--all", ...contextArgs],
      { cwd: directory, env: { ...process.env, CI: "true" } }
    );
    const cleanDeployOutput = stripAnsiCodes(deployRes.stdout);
    events.push({ type: "output", content: cleanDeployOutput });
    if (deployRes.stderr)
      events.push({ type: "warning", content: stripAnsiCodes(deployRes.stderr) });
    try {
      const parsedOutputs = parseCdkOutputs(cleanDeployOutput);
      if (parsedOutputs && !parsedOutputs.includes("No outputs defined")) {
        events.push({ type: "output", content: parsedOutputs });
      }
    } catch {}
    if (deployRes.error) {
      events.push({
        type: "error",
        title: "Error during `cdklocal deploy`",
        content: deployRes.error.message,
      });
      return events;
    }
    events.push({ type: "success", content: "CDK stack deployed successfully!" });
  } else {
    events.push({ type: "header", title: "💥 Destroying CDK Stack", content: "" });
    const destroyRes = await runCommand(
      baseCommand,
      ["destroy", "--force", "--all", ...contextArgs],
      { cwd: directory, env: { ...process.env, CI: "true" } }
    );
    events.push({ type: "output", content: stripAnsiCodes(destroyRes.stdout) });
    if (destroyRes.stderr)
      events.push({ type: "warning", content: stripAnsiCodes(destroyRes.stderr) });
    if (destroyRes.error) {
      events.push({
        type: "error",
        title: "Error during `cdklocal destroy`",
        content: destroyRes.error.message,
      });
      return events;
    }
    events.push({ type: "success", content: `CDK stack in ${directory} has been destroyed.` });
  }
  return events;
}
