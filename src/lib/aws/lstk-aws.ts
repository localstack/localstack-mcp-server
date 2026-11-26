import fs from "fs";
import path from "path";
import { runCommand, type CommandResult } from "../../core/command-runner";
import { localstackEndpointUrl } from "../../core/localstack-env";
import { startEgressGuard } from "../azure/egress-guard";
import { LSTK_INSTALL_MESSAGE } from "../deployment/deployment-utils";
import { assertTargetsLocalStack } from "./aws-cli-sanitizer";
import { baseChildEnv, buildAwsChildEnv, privateDirs, safePath, writableDirs } from "./child-env";
import { assertLocalPathsAllowed, awsWorkdir, confineTransfers } from "./local-paths";

const AWS_CLI_INSTALL_MESSAGE = `❌ The AWS CLI is not installed or not available in PATH.

lstk runs your own AWS CLI (v2). Please install it by following the official documentation:
https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

After installation, make sure the 'aws' command is available in your PATH.`;

// lstk prints this to stdout whenever ~/.aws has no `localstack` profile, which is always the
// case in the Docker image. lstk supplies the credentials itself then, so the note is noise
// in front of the AWS CLI's output.
const NO_PROFILE_NOTE = /^> Note: No AWS profile found, run 'lstk setup aws'\r?\n/;

let dependenciesFound = false;

/**
 * The program to spawn for `name`, given the child's `env`, whose PATH holds no directory the AWS
 * client writes to (child-env.ts). On Windows, a bare name is looked up in the child's working
 * directory before PATH, where the AWS client can write lstk.exe: it gets the full path from
 * PATH, or null when there is none. Elsewhere only PATH is searched. With no PATH entry left, it
 * is null: an empty PATH means the working directory to some programs.
 */
export function programPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const dirs = safePath((key && env[key]) || "", platform)
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  if (dirs.length === 0) return null;
  if (platform !== "win32") return name;
  for (const dir of dirs) {
    for (const ext of [".exe", ".com"]) {
      const candidate = path.win32.join(dir, name + ext);
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  return null;
}

/** The first directory on the server's PATH, left out of `childPath`, that holds `name`. */
function skippedDirWith(name: string, childPath: string): string | undefined {
  const kept = new Set(childPath.split(path.delimiter));
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
  const names =
    process.platform === "win32" ? [`${name}.exe`, `${name}.com`, `${name}.cmd`] : [name];
  return ((key && process.env[key]) || "")
    .split(path.delimiter)
    .filter((dir) => dir && !kept.has(dir))
    .find((dir) =>
      names.some((n) => fs.statSync(path.join(dir, n), { throwIfNoEntry: false })?.isFile())
    );
}

/** Tests: forget that the CLIs were found. */
export function resetLstkAwsDependencyCheck(): void {
  dependenciesFound = false;
}

/** Returns an install hint when lstk or the AWS CLI is missing, otherwise null. */
export async function checkLstkAwsDependencies(): Promise<string | null> {
  if (dependenciesFound) return null;
  // The server's own directory may be the workdir: the same lookup as for `lstk aws`.
  const env = baseChildEnv(
    process.env,
    process.platform,
    writableDirs(awsWorkdir().workdir, privateDirs())
  );
  const missing = (name: string, message: string) => {
    const dir = skippedDirWith(name, env.PATH ?? "");
    return dir
      ? `❌ ${name} was found only in ${dir}, inside a directory the AWS client writes to, so it is not run: a command could replace it. Install ${name} elsewhere on the PATH (globally), or set LOCALSTACK_AWS_WORKDIR to a directory that does not contain it.`
      : message;
  };
  const lstkProgram = programPath("lstk", env);
  const awsProgram = programPath("aws", env);
  if (!lstkProgram) return missing("lstk", LSTK_INSTALL_MESSAGE);
  if (!awsProgram) return missing("aws", AWS_CLI_INSTALL_MESSAGE);
  const [lstk, aws] = await Promise.all([
    runCommand(lstkProgram, ["--version"], { timeout: 10000, env }),
    runCommand(awsProgram, ["--version"], { timeout: 10000, env }),
  ]);
  if (lstk.error) return missing("lstk", LSTK_INSTALL_MESSAGE);
  if (aws.error) return missing("aws", AWS_CLI_INSTALL_MESSAGE);
  // 2.37.7 is the first release whose downloads honor --no-follow-symlinks.
  const version = aws.stdout
    .match(/aws-cli\/(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!version || version[0] !== 2 || version[1] < 37 || (version[1] === 37 && version[2] < 7)) {
    return `❌ The AWS client needs AWS CLI v2.37.7 or newer, found: ${aws.stdout.trim() || "unknown"}.\n\n${AWS_CLI_INSTALL_MESSAGE.split("\n").slice(2).join("\n")}`;
  }
  dependenciesFound = true;
  return null;
}

const LOCAL_GATEWAY_HOST = "localhost.localstack.cloud";

/**
 * Where the AWS CLI sends its requests (and signs them for), and where the egress guard
 * connects them to. The CLI uses localhost.localstack.cloud whenever LocalStack runs on this
 * machine, so URLs it signs for the caller (s3 presign) open on the user's machine. In the
 * Docker image the gateway is reached through the Docker host (LOCALSTACK_HOSTNAME
 * host.docker.internal), where the same port is published: the guard connects there, for
 * localhost.localstack.cloud and its subdomains alike, which no DNS entry could cover.
 */
export function lstkAwsRoute(env: NodeJS.ProcessEnv = process.env): {
  endpointUrl: string;
  dial: { host: string; port: number };
} {
  const target = new URL(localstackEndpointUrl(env));
  const port = Number(target.port || 80);
  if (target.hostname === LOCAL_GATEWAY_HOST) {
    // localhost.localstack.cloud is 127.0.0.1 by definition; no DNS answer is needed for it.
    return { endpointUrl: target.origin, dial: { host: "127.0.0.1", port } };
  }
  if (target.hostname === "host.docker.internal") {
    return {
      endpointUrl: `http://${LOCAL_GATEWAY_HOST}:${port}`,
      dial: { host: target.hostname, port },
    };
  }
  return { endpointUrl: target.origin, dial: { host: target.hostname, port } };
}

export interface LstkAwsResult extends CommandResult {
  /** Hosts outside LocalStack the egress guard refused; any entry means the command failed. */
  blocked: string[];
}

/**
 * Runs `lstk aws <args>`: the official AWS CLI, with endpoint, credentials and region set by
 * lstk. It runs with the environment of child-env.ts behind an egress guard that relays plain
 * HTTP to LocalStack and refuses everything else, in the AWS client's working directory.
 * `checkLocalPaths` holds the local paths in `args` to that directory and to `allowedPaths`, the
 * paths outside it the user allowed (local-paths.ts).
 */
export async function runLstkAws(
  args: string[],
  options: { checkLocalPaths?: boolean; allowedPaths?: string[] } = {}
): Promise<LstkAwsResult> {
  assertTargetsLocalStack(args);
  const { workdir, error } = awsWorkdir();
  if (error) throw new Error(error);
  const dirs = privateDirs();
  const { endpointUrl, dial } = lstkAwsRoute();
  const childEnv = (proxyUrl: string) =>
    buildAwsChildEnv(process.env, process.platform, { ...dirs, workdir, endpointUrl, proxyUrl });
  if (options.checkLocalPaths) {
    assertLocalPathsAllowed(args, workdir, {
      cwd: dirs.tmpDir,
      privateHome: dirs.homeDir,
      allowed: options.allowedPaths,
    });
    args = confineTransfers(args, workdir ?? dirs.tmpDir);
  }

  const endpoint = new URL(endpointUrl);
  const port = Number(endpoint.port || 80);
  const guard = await startEgressGuard({
    tunnels: () => false,
    relayHttp: {
      allows: (host, p) =>
        p === port && (host === endpoint.hostname || host.endsWith(`.${endpoint.hostname}`)),
      to: dial,
    },
  });
  try {
    // No stdin: lstk hands it on to aws, and a command reading it (`s3 cp - …`) would otherwise
    // wait for input that never comes until the timeout.
    const env = childEnv(guard.env.HTTP_PROXY);
    const lstk = programPath("lstk", env);
    if (!lstk) throw new Error(LSTK_INSTALL_MESSAGE);
    const result = await runCommand(lstk, ["aws", ...args], {
      env,
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
