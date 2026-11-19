import { runCommand, type CommandResult } from "../../core/command-runner";
import { buildIacCliEnv } from "../../core/localstack-env";
import { LSTK_INSTALL_MESSAGE } from "../deployment/deployment-utils";
import { assertTargetsLocalStack } from "./aws-cli-sanitizer";

const AWS_CLI_INSTALL_MESSAGE = `❌ The AWS CLI is not installed or not available in PATH.

lstk runs your own AWS CLI (v2). Please install it by following the official documentation:
https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

After installation, make sure the 'aws' command is available in your PATH.`;

// lstk prints this to stdout whenever ~/.aws has no `localstack` profile, which is always the
// case in the Docker image. lstk supplies the credentials itself then, so the note is noise
// in front of the AWS CLI's output.
const NO_PROFILE_NOTE = /^> Note: No AWS profile found, run 'lstk setup aws'\r?\n/;

/** Returns an install hint when lstk or the AWS CLI is missing, otherwise null. */
export async function checkLstkAwsDependencies(): Promise<string | null> {
  const [lstk, aws] = await Promise.all([
    runCommand("lstk", ["--version"], { timeout: 10000 }),
    runCommand("aws", ["--version"], { timeout: 10000 }),
  ]);
  if (lstk.error) return LSTK_INSTALL_MESSAGE;
  if (aws.error) return AWS_CLI_INSTALL_MESSAGE;
  return null;
}

/**
 * Runs `lstk aws <args>`: the official AWS CLI, with endpoint, credentials and region set by
 * lstk. The endpoint comes from AWS_ENDPOINT_URL (see buildIacCliEnv), and the pager is off
 * because the output goes to the MCP client, not a terminal.
 */
export async function runLstkAws(args: string[]): Promise<CommandResult> {
  assertTargetsLocalStack(args);
  // No stdin: lstk hands it on to aws, and a command reading it (`s3 cp - …`) would otherwise
  // wait for input that never comes until the timeout.
  const result = await runCommand("lstk", ["aws", ...args], {
    env: buildIacCliEnv({ AWS_PAGER: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ...result, stdout: result.stdout.replace(NO_PROFILE_NOTE, "") };
}

/** The error text of a failed `lstk aws` run; lstk reports its own failures on stdout. */
export function lstkAwsErrorText(result: CommandResult): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    `lstk aws exited with code ${result.exitCode}`
  );
}
