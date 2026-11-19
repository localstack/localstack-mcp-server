import { runCommand, type CommandResult } from "../../core/command-runner";
import { localstackEndpointUrl } from "../../core/localstack-env";
import { startEgressGuard } from "../azure/egress-guard";
import { LSTK_INSTALL_MESSAGE } from "../deployment/deployment-utils";
import { assertTargetsLocalStack } from "./aws-cli-sanitizer";
import { buildAwsChildEnv, privateDirs } from "./child-env";
import { assertLocalPathsAllowed, awsWorkdir } from "./local-paths";

const AWS_CLI_INSTALL_MESSAGE = `❌ The AWS CLI is not installed or not available in PATH.

lstk runs your own AWS CLI (v2). Please install it by following the official documentation:
https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

After installation, make sure the 'aws' command is available in your PATH.`;

// lstk prints this to stdout whenever ~/.aws has no `localstack` profile, which is always the
// case in the Docker image. lstk supplies the credentials itself then, so the note is noise
// in front of the AWS CLI's output.
const NO_PROFILE_NOTE = /^> Note: No AWS profile found, run 'lstk setup aws'\r?\n/;

let dependenciesFound = false;

/** Tests: forget that the CLIs were found. */
export function resetLstkAwsDependencyCheck(): void {
  dependenciesFound = false;
}

/** Returns an install hint when lstk or the AWS CLI is missing, otherwise null. */
export async function checkLstkAwsDependencies(): Promise<string | null> {
  if (dependenciesFound) return null;
  const [lstk, aws] = await Promise.all([
    runCommand("lstk", ["--version"], { timeout: 10000 }),
    runCommand("aws", ["--version"], { timeout: 10000 }),
  ]);
  if (lstk.error) return LSTK_INSTALL_MESSAGE;
  if (aws.error) return AWS_CLI_INSTALL_MESSAGE;
  dependenciesFound = true;
  return null;
}

export interface LstkAwsResult extends CommandResult {
  /** Hosts outside LocalStack the egress guard refused; any entry means the command failed. */
  blocked: string[];
}

/**
 * Runs `lstk aws <args>`: the official AWS CLI, with endpoint, credentials and region set by
 * lstk. It runs with the environment of child-env.ts behind an egress guard that relays plain
 * HTTP to LocalStack and refuses everything else, in the AWS client's working directory.
 * `checkLocalPaths` holds the local paths in `args` to that directory (local-paths.ts).
 */
export async function runLstkAws(
  args: string[],
  options: { checkLocalPaths?: boolean } = {}
): Promise<LstkAwsResult> {
  assertTargetsLocalStack(args);
  const { workdir, error } = awsWorkdir();
  if (error) throw new Error(error);
  const dirs = privateDirs();
  if (options.checkLocalPaths) assertLocalPathsAllowed(args, workdir);

  const endpointUrl = localstackEndpointUrl();
  const endpoint = new URL(endpointUrl);
  const port = Number(endpoint.port || 80);
  const guard = await startEgressGuard({
    tunnels: () => false,
    relayHttp: {
      allows: (host, p) =>
        p === port && (host === endpoint.hostname || host.endsWith(`.${endpoint.hostname}`)),
      // localhost.localstack.cloud is 127.0.0.1 by definition; no DNS answer is needed for it.
      to: {
        host: endpoint.hostname === "localhost.localstack.cloud" ? "127.0.0.1" : endpoint.hostname,
        port,
      },
    },
  });
  try {
    // No stdin: lstk hands it on to aws, and a command reading it (`s3 cp - …`) would otherwise
    // wait for input that never comes until the timeout.
    const result = await runCommand("lstk", ["aws", ...args], {
      env: buildAwsChildEnv(process.env, process.platform, {
        ...dirs,
        endpointUrl,
        proxyUrl: guard.env.HTTP_PROXY,
      }),
      cwd: workdir ?? dirs.tmpDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Help pages come through man as overstrike (`N\bNA\bAM\bME\bE`); keep the letters.
    const stdout = result.stdout.replace(NO_PROFILE_NOTE, "").replace(/[^\n]\x08/g, "");
    return { ...result, stdout, blocked: guard.refused() };
  } finally {
    await guard.close();
  }
}

/** The error text of a failed `lstk aws` run; lstk reports its own failures on stdout. */
export function lstkAwsErrorText(result: LstkAwsResult): string {
  if (result.blocked.length > 0) {
    return `The command tried to reach ${result.blocked.join(", ")}, outside LocalStack, and was stopped: the AWS client only talks to LocalStack.\n\n${result.stderr.trim()}`.trim();
  }
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    `lstk aws exited with code ${result.exitCode}`
  );
}
