import { mkdirSync, mkdtempSync } from "fs";
import os from "os";
import path from "path";

/**
 * The environment `lstk aws` and the AWS CLI run with. Like the Azure tool's, it is built from an
 * allow-list, never from a copy of the server's environment: `AWS_*` (profiles, endpoint URLs,
 * `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`, `AWS_DATA_PATH`, credentials) and `LSTK_ENDPOINT_URL`
 * would send a command elsewhere or sign it with real credentials.
 *
 * HOME is private, so neither lstk nor the CLI reads the user's ~/.aws: no profile, no
 * credential_process, no plugins, no aliases (`!` aliases run shell commands), no history. Commands
 * that write to `~` write there. The egress guard is the proxy for every request, and LocalStack
 * is deliberately not in NO_PROXY: botocore picks a client's proxy from its configured endpoint,
 * so a request its endpoint rules send elsewhere (a Multi-Region Access Point) would bypass it.
 */

const INHERITED = ["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "LANG", "PATHEXT"];

export interface AwsChildDirs {
  homeDir: string;
  tmpDir: string;
}

let dirs: AwsChildDirs | undefined;

/** One private home and temp dir per server process, owner-only. */
export function privateDirs(): AwsChildDirs {
  if (!dirs) {
    const root = mkdtempSync(path.join(os.tmpdir(), "localstack-mcp-aws-"));
    dirs = { homeDir: path.join(root, "home"), tmpDir: path.join(root, "tmp") };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

export function buildAwsChildEnv(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: AwsChildDirs & { endpointUrl: string; proxyUrl: string }
): Record<string, string> {
  const env: Record<string, string> = {};
  const win = platform === "win32";
  for (const name of INHERITED) {
    const key = win ? Object.keys(parent).find((k) => k.toUpperCase() === name) : name;
    const value = key === undefined ? undefined : parent[key];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(parent)) {
    if (/^LC_[A-Z]+$/.test(name) && value !== undefined) env[name] = value;
  }

  env.HOME = options.homeDir;
  env.USERPROFILE = options.homeDir;
  env.TEMP = options.tmpDir;
  env.TMP = options.tmpDir;
  if (win) {
    env.HOMEDRIVE = path.win32.parse(options.homeDir).root.replace(/[\\/]$/, "");
    env.HOMEPATH = options.homeDir.slice(env.HOMEDRIVE.length) || "\\";
    env.APPDATA = path.win32.join(options.homeDir, "AppData", "Roaming");
    env.LOCALAPPDATA = path.win32.join(options.homeDir, "AppData", "Local");
  } else {
    env.TMPDIR = options.tmpDir;
  }

  // The user's region is kept: it decides where a resource lives, never which host is called.
  const region = [parent.AWS_REGION, parent.AWS_DEFAULT_REGION].find((r) => r && REGION.test(r));
  env.AWS_REGION = region ?? "us-east-1";
  env.AWS_DEFAULT_REGION = env.AWS_REGION;
  env.AWS_ACCESS_KEY_ID = "test";
  env.AWS_SECRET_ACCESS_KEY = "test";
  env.AWS_ENDPOINT_URL = options.endpointUrl;
  env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "false";
  // Their endpoint rules ignore a custom endpoint; the guard would refuse them anyway.
  env.AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS = "true";
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_PAGER = "";
  env.AWS_CLI_AUTO_PROMPT = "off";

  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    env[name] = options.proxyUrl;
  }
  // lstk's own analytics would only meet the guard's 403.
  env.LOCALSTACK_DISABLE_EVENTS = "1";
  return env;
}
