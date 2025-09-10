import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { DockerApiClient } from "../lib/docker/docker.client";
import { sanitizeAwsCliCommand } from "../lib/aws/aws-cli-sanitizer";

// Define the schema for tool parameters
export const schema = {
  command: z
    .string()
    .trim()
    .min(1, { message: "The command string cannot be empty." })
    .describe(
      "The AWS CLI command to execute (e.g., 's3 ls', 'dynamodb list-tables'). Do not include 'awslocal' or 'aws'."
    ),
};

// Define the metadata for the tool
export const metadata: ToolMetadata = {
  name: "localstack-aws-client",
  description:
    "Executes an AWS CLI command against the running LocalStack container using the 'awslocal' wrapper.",
  annotations: {
    title: "LocalStack AWS Client",
  },
};

export default async function localstackAwsClient({ command }: InferSchema<typeof schema>) {
  const preflightError = await runPreflights([requireLocalStackRunning()]);
  if (preflightError) return preflightError;

  try {
    const dockerClient = new DockerApiClient();
    const containerId = await dockerClient.findLocalStackContainer();

    const sanitized = sanitizeAwsCliCommand(command);

    const args = splitArgsRespectingQuotes(sanitized);
    const cmd = ["awslocal", ...args];

    const result = await dockerClient.executeInContainer(containerId, cmd);

    if (result.exitCode === 0) {
      return ResponseBuilder.markdown(result.stdout || "");
    }

    // Coverage / unimplemented service hints
    const stderr = result.stderr || "";
    const actionMatch = stderr.match(
      /The API action '([^']+)' for service '([^']+)' is either not available in your current license plan or has not yet been emulated by LocalStack/i
    );
    const serviceMatch = stderr.match(
      /The API for service '([^']+)' is either not included in your current license plan or has not yet been emulated by LocalStack/i
    );
    if (actionMatch) {
      const service = actionMatch[2];
      const link = `https://docs.localstack.cloud/references/coverage/coverage_${service}`;
      return ResponseBuilder.error(
        "Service Not Implemented in LocalStack",
        `The requested API action may not be implemented. Check coverage: ${link}\n\n${stderr}`
      );
    }
    if (serviceMatch) {
      const link = "https://docs.localstack.cloud/references/coverage";
      return ResponseBuilder.error(
        "Service Not Implemented in LocalStack",
        `The requested service may not be implemented. Check coverage: ${link}\n\n${stderr}`
      );
    }

    return ResponseBuilder.error("Command Failed", result.stderr || "Unknown error");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return ResponseBuilder.error("Execution Error", message);
  }
}

function splitArgsRespectingQuotes(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) args.push(current);
  return args;
}
