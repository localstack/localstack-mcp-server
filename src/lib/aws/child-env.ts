import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

/**
 * The environment `lstk aws` and the AWS CLI run with. Like the Azure tool's, it is built from an
 * allow-list, never from a copy of the server's environment: `AWS_*` (profiles, endpoint URLs,
 * `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`, `AWS_DATA_PATH`, credentials) and `LSTK_ENDPOINT_URL`
 * would send a command elsewhere or sign it with real credentials.
 *
 * HOME is private, so neither lstk nor the CLI reads the user's ~/.aws: no profile, no
 * credential_process, no plugins, no aliases (`!` aliases run shell commands), no history. The
 * AWS client's path check keeps every command out of it, so none can write an alias there. Commands
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

const PREFIX = "localstack-mcp-aws-";

/**
 * One private home and temp dir per server process, owner-only. It is removed when the process
 * exits normally; one left by a process that was killed is removed by the next server.
 */
export function privateDirs(): AwsChildDirs {
  if (!dirs) {
    removeAbandonedDirs();
    const root = mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${process.pid}-`));
    dirs = { homeDir: path.join(root, "home"), tmpDir: path.join(root, "tmp") };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `--payload '{"a":1}'` and other blobs as raw text, as awslocal (CLI v1) took them; CLI v2
    // reads them as base64 by default.
    mkdirSync(path.join(dirs.homeDir, ".aws"), { mode: 0o700 });
    writeFileSync(
      path.join(dirs.homeDir, ".aws", "config"),
      "[default]\ncli_binary_format = raw-in-base64-out\n",
      { mode: 0o600 }
    );
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  }
  return dirs;
}

/** Removes the private dirs of server processes that no longer run. */
function removeAbandonedDirs(): void {
  try {
    for (const name of readdirSync(os.tmpdir())) {
      const pid = Number(name.startsWith(PREFIX) && name.slice(PREFIX.length).split("-")[0]);
      if (!Number.isInteger(pid) || pid <= 0 || isRunning(pid)) continue;
      rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  } catch {
    // Best effort: a dir that cannot be listed or removed only costs disk space.
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The directories the AWS client may write to: its workdir and its private dirs. */
export function writableDirs(workdir: string | null, dirs: AwsChildDirs): string[] {
  return [workdir, dirs.homeDir, dirs.tmpDir].filter((d): d is string => !!d);
}

/** The real path of `p`, following symlinks in the part of it that exists. */
function realpathOfLongestExisting(p: string): string {
  const rest: string[] = [];
  let existing = path.resolve(p);
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(p);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

/**
 * The part of the environment every lstk or aws process gets, the `--version` probes included:
 * the allow-listed system variables, and PATH without entries a command could write to
 * (`writable`, see safePath).
 */
export function baseChildEnv(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  writable: string[] = []
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

  if (env.PATH !== undefined) env.PATH = safePath(env.PATH, platform, writable);
  // cmd.exe (the CLI's help pager runs `more` through it) looks in the current directory first.
  if (win) env.NoDefaultCurrentDirectoryInExePath = "1";
  return env;
}

export function buildAwsChildEnv(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: AwsChildDirs & { endpointUrl: string; proxyUrl: string; workdir?: string | null }
): Record<string, string> {
  const env = baseChildEnv(parent, platform, writableDirs(options.workdir ?? null, options));
  const win = platform === "win32";
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
  // lstk sets it when it is missing; set here, the path check knows its value.
  env.PYTHONUNBUFFERED = "1";

  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    env[name] = options.proxyUrl;
  }
  // lstk's own analytics would only meet the guard's 403.
  env.LOCALSTACK_DISABLE_EVENTS = "1";
  return env;
}

/**
 * `value` (a PATH) without the entries a command could put a program in: relative ones ("", ".",
 * "bin") resolve in the working directory, and an absolute one may lie inside a directory the
 * AWS client writes to (`writable`): npx puts <project>/node_modules/.bin first on PATH, and
 * that project is the default workdir. Windows runs a file there without an execute bit.
 */
export function safePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
  writable: string[] = []
): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (dir: string) =>
    platform === "win32" ? p.resolve(dir).toLowerCase() : p.resolve(dir);
  const inside = (dir: string, root: string) =>
    dir === root || dir.startsWith(root.endsWith(p.sep) ? root : root + p.sep);
  // Lexically, and (on this machine's own paths) after following symlinks.
  const forms = (dir: string) =>
    platform === process.platform ? [fold(dir), fold(realpathOfLongestExisting(dir))] : [fold(dir)];
  const roots = writable.flatMap(forms);
  return value
    .split(p.delimiter)
    .filter((dir) => p.isAbsolute(dir) && !(platform === "win32" && /^[\\/](?![\\/])/.test(dir)))
    .filter((dir) => !forms(dir).some((form) => roots.some((root) => inside(form, root))))
    .join(p.delimiter);
}
