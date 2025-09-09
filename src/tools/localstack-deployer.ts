import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runCommand, stripAnsiCodes } from "../core/command-runner";
import path from "path";
import fs from "fs";
import { ensureLocalStackCli } from "../lib/localstack/localstack.utils";
import { runPreflights, requireLocalStackRunning } from "../core/preflight";
import { DockerApiClient } from "../lib/docker/docker.client";
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
    .enum(["deploy", "destroy", "create-stack", "delete-stack"])
    .describe(
      "The action to perform: 'deploy'/'destroy' for CDK/Terraform, or 'create-stack'/'delete-stack' for CloudFormation."
    ),
  projectType: z
    .enum(["cdk", "terraform", "auto"]) 
    .default("auto")
    .describe(
      "The type of project. 'auto' (default) infers from files. Specify 'cdk' or 'terraform' to override."
    ),
  directory: z
    .string()
    .optional()
    .describe(
      "The required path to the project directory containing your infrastructure-as-code files."
    ),
  variables: z
    .record(z.string())
    .optional()
    .describe(
      "Key-value pairs for parameterization. Used for Terraform variables (-var) or CDK context (-c)."
    ),
  stackName: z
    .string()
    .optional()
    .describe("The name of the CloudFormation stack. Required for 'create-stack' and 'delete-stack'."),
  templatePath: z
    .string()
    .optional()
    .describe("The local file path to the CloudFormation template. Required for 'create-stack' if not discoverable from 'directory'."),
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
  stackName,
  templatePath,
}: InferSchema<typeof schema>) {
  if (action === "deploy" || action === "destroy") {
    const cliError = await ensureLocalStackCli();
    if (cliError) return cliError;
  } else {
    const preflightError = await runPreflights([requireLocalStackRunning()]);
    if (preflightError) return preflightError;
  }

  if (action === "create-stack") {
    if (!stackName) {
      return ResponseBuilder.error(
        "Missing Parameter",
        "The parameter 'stackName' is required for action 'create-stack'."
      );
    }
    let resolvedTemplatePath = templatePath;
    if (!resolvedTemplatePath) {
      if (!directory) {
        return ResponseBuilder.error(
          "Missing Parameter",
          "Provide 'templatePath' or a 'directory' containing a single .yaml/.yml CloudFormation template."
        );
      }
      try {
        const files = await fs.promises.readdir(directory);
        const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
        if (yamlFiles.length === 0) {
          return ResponseBuilder.error(
            "Template Not Found",
            `No .yaml/.yml template found in directory '${directory}'.`
          );
        }
        if (yamlFiles.length > 1) {
          return ResponseBuilder.error(
            "Multiple Templates Found",
            `Multiple .yaml/.yml templates found in '${directory}'. Please specify 'templatePath'.\n\nFound:\n${yamlFiles
              .map((f) => `- ${f}`)
              .join("\n")}`
          );
        }
        resolvedTemplatePath = path.join(directory, yamlFiles[0]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ResponseBuilder.error(
          "Directory Read Error",
          `Failed to read directory '${directory}'. ${message}`
        );
      }
    }

    let templateBody = "";
    try {
      templateBody = await fs.promises.readFile(resolvedTemplatePath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ResponseBuilder.error(
        "Template Read Error",
        `Failed to read template file at '${resolvedTemplatePath}'. ${message}`
      );
    }

    try {
      const dockerClient = new DockerApiClient();
      const containerId = await dockerClient.findLocalStackContainer();

      const tempPath = `/tmp/ls-cfn-${Date.now()}.yaml`;
      const writeRes = await dockerClient.executeInContainer(
        containerId,
        ["/bin/sh", "-c", `cat > ${tempPath}`],
        templateBody
      );
      if (writeRes.exitCode !== 0) {
        return ResponseBuilder.error(
          "Template Upload Failed",
          writeRes.stderr || `Failed to write template to ${tempPath}`
        );
      }

      const createCmd = [
        "awslocal",
        "cloudformation",
        "create-stack",
        "--stack-name",
        stackName,
        "--template-body",
        `file://${tempPath}`,
      ];
      const createRes = await dockerClient.executeInContainer(containerId, createCmd);

      try {
        await dockerClient.executeInContainer(containerId, ["/bin/sh", "-c", `rm -f ${tempPath}`]);
      } catch {}

      if (createRes.exitCode === 0) {
        return ResponseBuilder.markdown(
          (createRes.stdout && createRes.stdout.trim())
            ? createRes.stdout
            : `Stack '${stackName}' creation initiated.\n\nTip: Use the 'localstack-aws-client' tool with 'cloudformation describe-stacks' to monitor stack status and wait for CREATE_COMPLETE.`
        );
      }
      return ResponseBuilder.error(
        "CloudFormation create-stack failed",
        createRes.stderr || "Unknown error"
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return ResponseBuilder.error(
        "CloudFormation Error",
        `An unexpected error occurred: ${errorMessage}`
      );
    }
  }

  if (action === "delete-stack") {
    if (!stackName) {
      return ResponseBuilder.error(
        "Missing Parameter",
        "The parameter 'stackName' is required for action 'delete-stack'."
      );
    }
    try {
      const dockerClient = new DockerApiClient();
      const containerId = await dockerClient.findLocalStackContainer();
      const command = [
        "awslocal",
        "cloudformation",
        "delete-stack",
        "--stack-name",
        stackName,
      ];
      const result = await dockerClient.executeInContainer(containerId, command);
      if (result.exitCode === 0) {
        return ResponseBuilder.markdown(
          (result.stdout && result.stdout.trim())
            ? result.stdout
            : `Stack '${stackName}' deletion initiated.\n\nTip: Use the 'localstack-aws-client' tool with 'cloudformation describe-stacks' to monitor deletion status until DELETE_COMPLETE.`
        );
      }
      return ResponseBuilder.error(
        "CloudFormation delete-stack failed",
        result.stderr || "Unknown error"
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return ResponseBuilder.error(
        "CloudFormation Error",
        `An unexpected error occurred: ${errorMessage}`
      );
    }
  }

  let resolvedProjectType: "cdk" | "terraform";

  try {
    if (!directory) {
      return ResponseBuilder.error(
        "Missing Parameter",
        "The parameter 'directory' is required for actions 'deploy' and 'destroy'."
      );
    }
    const nonNullDirectory = directory as string;

    // Step 1: Project Type Resolution
    if (projectType === "auto") {
      const inferredType = await inferProjectType(nonNullDirectory);

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
    return await executeDeploymentCommands(
      resolvedProjectType,
      action,
      nonNullDirectory,
      variables
    );
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
