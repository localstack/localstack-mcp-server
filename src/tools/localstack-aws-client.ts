import { z } from "zod";
import { type ToolMetadata, type InferSchema, type ToolExtraArguments } from "xmcp";
import { runPreflights, requireLocalStackRunning, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { sanitizeAwsCliCommand, splitAwsCliArgs } from "../lib/aws/aws-cli-sanitizer";
import {
  checkLstkAwsDependencies,
  lstkAwsErrorText,
  runLstkAws,
  type LstkAwsResult,
} from "../lib/aws/lstk-aws";
import { awsWorkdir, OutsideWorkdirError } from "../lib/aws/local-paths";
import { allowedFolders, askToAllow } from "../lib/aws/path-consent";

// How many paths outside the working directory one command may ask the user about.
const MAX_CONSENT_QUESTIONS = 5;

// Define the schema for tool parameters
export const schema = {
  command: z
    .string()
    .trim()
    .min(1, { message: "The command string cannot be empty." })
    .describe(
      "The AWS CLI command to execute (e.g., 's3 ls', 'dynamodb list-tables'). Do not include 'lstk', 'aws' or 'awslocal'."
    ),
};

// Define the metadata for the tool
export const metadata: ToolMetadata = {
  name: "localstack-aws-client",
  description:
    "Executes an AWS CLI command against the running LocalStack for AWS emulator, through the official AWS CLI v2 and 'lstk aws', which set the endpoint, credentials and region. Requests only ever reach LocalStack. Local files (s3 cp, file://, --body, an outfile) must be relative paths or inside the tool's working directory; for an absolute path outside it, the user is asked to allow it. Write such paths out in full: ~ is not the user's home directory.",
  annotations: {
    title: "LocalStack AWS Client",
  },
};

/** `text` as a code block, fenced with more backticks than it holds in a row. */
function fence(text: string): string {
  // A loop, not Math.max(...runs): a long --debug log holds more runs than a call takes arguments.
  let longest = 2;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

export default async function localstackAwsClient(
  { command }: InferSchema<typeof schema>,
  extra?: ToolExtraArguments
) {
  return withToolAnalytics("localstack-aws-client", { command }, async () => {
    const preflightError = await runPreflights([requireAuthToken(), requireLocalStackRunning()]);
    if (preflightError) return preflightError;

    try {
      const args = splitAwsCliArgs(sanitizeAwsCliCommand(command));

      const missing = await checkLstkAwsDependencies();
      if (missing) return ResponseBuilder.error("Dependency Not Available", missing);

      // A path outside the working directory: ask the user to allow it, then check again.
      const allowedPaths = allowedFolders();
      let result: LstkAwsResult | undefined;
      for (let asked = 0; !result; asked++) {
        try {
          result = await runLstkAws(args, { checkLocalPaths: true, allowedPaths });
        } catch (err) {
          if (!(err instanceof OutsideWorkdirError) || asked >= MAX_CONSENT_QUESTIONS) throw err;
          const answer = await askToAllow(err, {
            command,
            workdir: awsWorkdir().workdir,
            // The SDK's default 60 s is short for a person reading the question.
            elicit: extra && ((request) => extra.elicit(request, { timeout: 10 * 60_000 })),
          });
          if ("refusal" in answer) {
            return ResponseBuilder.error("Local Path Not Allowed", answer.refusal);
          }
          allowedPaths.push(answer.allow);
        }
      }

      if (result.exitCode === 0 && result.blocked.length === 0) {
        // Warnings (and --debug's log) go to stderr, also when the command succeeds.
        const stderr = result.stderr.trim();
        return ResponseBuilder.markdown(
          stderr
            ? `${result.stdout.trimEnd()}\n\n**stderr:**\n\n${fence(stderr)}`.trim()
            : result.stdout
        );
      }

      // Coverage / unimplemented service hints
      const stderr = lstkAwsErrorText(result);
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

      return ResponseBuilder.error("Command Failed", stderr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ResponseBuilder.error("Execution Error", message);
    }
  });
}
