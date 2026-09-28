import { existsSync, realpathSync, statSync } from "fs";
import os from "os";
import path from "path";
import type { AzureConfig } from "../lib/azure/types";
import { isLocalHost } from "../lib/azure/local-hosts";

export const LOCALSTACK_HOSTNAME = process.env.LOCALSTACK_HOSTNAME || "localhost";
export const LOCALSTACK_PORT = process.env.LOCALSTACK_PORT || 4566;
export const LOCALSTACK_BASE_URL = `http://${LOCALSTACK_HOSTNAME}:${LOCALSTACK_PORT}`;

// Default timeout for network requests in milliseconds
export const DEFAULT_FETCH_TIMEOUT = 15000;

// Default timeouts and buffer sizes for command execution
export const DEFAULT_COMMAND_TIMEOUT = 300000; // 5 minutes
export const DEFAULT_COMMAND_MAX_BUFFER = 1024 * 1024 * 10; // 10 MB
export const IAM_CONFIG_ENDPOINT = "/_aws/iam/config";

// ---------------------------------------------------------------------------
// The Azure client (plan task 2.1, Appendix D). Unlike the constants above, this is a
// function of the environment, so tests can build any configuration without
// re-importing the module.
// ---------------------------------------------------------------------------

const DEFAULT_AZURE_PORT = 4566;
const DEFAULT_AZ_TIMEOUT_SECONDS = 300;
const DEFAULT_AZ_MAX_CHARS = 30000;
/** The runner caps each stream at 10 MB, so a larger text cap would never apply. */
const MAX_AZ_OUTPUT_CHARS = 10_000_000;

export interface AzureConfigDeps {
  homedir?: () => string;
  cwd?: () => string;
  platform?: NodeJS.Platform;
  inDocker?: boolean;
  /** The realpath of an existing path; undefined when it does not exist. */
  realpath?: (p: string) => string | undefined;
  isDirectory?: (p: string) => boolean;
  isFile?: (p: string) => boolean;
}

function defaultRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

function statIs(p: string, kind: "dir" | "file"): boolean {
  try {
    const stat = statSync(p);
    return kind === "dir" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

/**
 * A comparable form of a path: resolved, with its longest existing prefix put
 * through realpath (a symlinked parent cannot hide `~/.azure`), and lower-cased on
 * the case-insensitive platforms.
 */
export function canonicalPath(
  p: string,
  platform: NodeJS.Platform,
  realpath: (p: string) => string | undefined = defaultRealpath
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let head = pathApi.resolve(p);
  const tail: string[] = [];
  for (;;) {
    const real = realpath(head);
    if (real !== undefined) {
      head = real;
      break;
    }
    const parent = pathApi.dirname(head);
    if (parent === head) break;
    tail.unshift(pathApi.basename(head));
    head = parent;
  }
  const joined = tail.length ? pathApi.join(head, ...tail) : head;
  return platform === "win32" || platform === "darwin" ? joined.toLowerCase() : joined;
}

/** `child` equals `parent` or lies inside it; both canonical. */
export function isInsideOrEqual(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const rel = pathApi.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

/** Expand a leading `~` (MCP client configs pass values without a shell), then resolve. */
function resolveUserPath(value: string, home: string, cwd: string, platform: NodeJS.Platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const expanded =
    value === "~" ? home : /^~[\\/]/.test(value) ? pathApi.join(home, value.slice(2)) : value;
  return pathApi.resolve(cwd, expanded);
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[]
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    warnings.push(`${name}=${raw} is not a whole number from ${min} to ${max}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

function readFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean, warnings: string[]) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  warnings.push(`${name}=${env[name]} is not 0 or 1; using ${fallback ? 1 : 0}.`);
  return fallback;
}

// LOCALSTACK_AZ_BICEP_ENV may never pass these, even when listed: the auth token, and the
// variables that steer az, Bicep, Python, .NET or the network, the same families the child
// environment keeps out (child-env.ts).
const BICEP_ENV_DENIED_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "KUBECONFIG",
  "DOCKER_COMMAND",
  "DOCKER_HOST",
  "GITHUB_ACTIONS",
  "TF_BUILD",
  "BROWSER",
  "MSI_ENDPOINT",
  "MSI_SECRET",
]);
const BICEP_ENV_DENIED_PREFIXES = [
  "LOCALSTACK_", // the auth token and this tool's own settings
  "AZURE_",
  "ARM_",
  "IDENTITY_",
  "BICEP_",
  "DOTNET_",
  "PYTHON",
];

/**
 * LOCALSTACK_AZ_BICEP_ENV: the server variables a `.bicepparam` may read with
 * `readEnvironmentVariable()`. az runs with an allow-list environment, so a variable reaches Bicep
 * only when it is listed here: a planted parameter file can read nothing the user did not choose.
 */
function readBicepEnv(env: NodeJS.ProcessEnv, warnings: string[]): string[] {
  const raw = env.LOCALSTACK_AZ_BICEP_ENV?.trim();
  if (!raw) return [];
  const names: string[] = [];
  const invalid: string[] = [];
  const denied: string[] = [];
  for (const name of raw.split(/[\s,]+/).filter(Boolean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      invalid.push(name);
      continue;
    }
    const upper = name.toUpperCase();
    if (
      BICEP_ENV_DENIED_NAMES.has(upper) ||
      BICEP_ENV_DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      denied.push(name);
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  if (invalid.length > 0) {
    warnings.push(
      `LOCALSTACK_AZ_BICEP_ENV: ${invalid.join(", ")} ${invalid.length === 1 ? "is not a variable name" : "are not variable names"}; ignored.`
    );
  }
  if (denied.length > 0) {
    warnings.push(
      `LOCALSTACK_AZ_BICEP_ENV: ${denied.join(", ")} ${denied.length === 1 ? "is" : "are"} never passed to Bicep (the auth token and the variables that steer az, Bicep, Python, .NET or the network stay out); ignored.`
    );
  }
  return names;
}

/**
 * The Azure client's settings (plan task 2.1, Appendix D). Invalid numbers fall back
 * to their defaults with a warning; values that would weaken containment (a remote
 * endpoint, a config dir inside the user's real Azure CLI profile) are hard errors,
 * and the tool refuses to run while any is present.
 */
export function getAzureConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: AzureConfigDeps = {}
): AzureConfig {
  const platform = deps.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = (deps.homedir ?? os.homedir)();
  const cwd = (deps.cwd ?? process.cwd)();
  const realpath = deps.realpath ?? defaultRealpath;
  const isDirectory = deps.isDirectory ?? ((p: string) => statIs(p, "dir"));
  const isFile = deps.isFile ?? ((p: string) => statIs(p, "file"));
  const canon = (p: string) => canonicalPath(p, platform, realpath);
  const inside = (child: string, parent: string) =>
    isInsideOrEqual(canon(child), canon(parent), platform);
  const warnings: string[] = [];
  const errors: string[] = [];

  const sharedPort = readInt(env, "LOCALSTACK_PORT", DEFAULT_AZURE_PORT, 1, 65535, warnings);
  const port = readInt(env, "LOCALSTACK_AZURE_PORT", sharedPort, 1, 65535, warnings);

  let endpoint = `https://azure.localhost.localstack.cloud:${port}`;
  const endpointOverride = env.LOCALSTACK_AZURE_ENDPOINT?.trim();
  if (endpointOverride) {
    let url: URL | undefined;
    try {
      url = new URL(endpointOverride);
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password) {
      errors.push(
        `LOCALSTACK_AZURE_ENDPOINT must be an https URL such as https://azure.localhost.localstack.cloud:${port}; got "${endpointOverride}".`
      );
    } else if (!isLocalHost(url.hostname)) {
      errors.push(
        `LOCALSTACK_AZURE_ENDPOINT must point at a local emulator (localhost.localstack.cloud or a subdomain, localhost, 127.0.0.1 or ::1); "${url.hostname}" is not local. The tool never talks to remote endpoints.`
      );
    } else if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      errors.push(
        `LOCALSTACK_AZURE_ENDPOINT must be a bare origin without a path, query or fragment; got "${endpointOverride}".`
      );
    } else {
      endpoint = `https://${url.host}`;
    }
  }
  const endpointHost = new URL(endpoint).hostname.toLowerCase();

  const realAzureDir = pathApi.join(home, ".azure");
  const parentAzureConfigDir = env.AZURE_CONFIG_DIR?.trim()
    ? resolveUserPath(env.AZURE_CONFIG_DIR.trim(), home, cwd, platform)
    : undefined;

  const configDirSetting = env.LOCALSTACK_AZ_CONFIG_DIR?.trim();
  const configDir = configDirSetting
    ? resolveUserPath(configDirSetting, home, cwd, platform)
    : pathApi.join(home, ".localstack", "azure", `mcp-config-${port}`);
  // N4: the bootstrap rewrites the config dir's cloud, config and login, so it must
  // never be (or contain) the user's real Azure CLI profile.
  const configDirProblem =
    pathApi.basename(configDir).toLowerCase() === ".azure"
      ? "has the basename .azure"
      : inside(configDir, realAzureDir)
        ? `lies inside your Azure CLI profile (${realAzureDir})`
        : parentAzureConfigDir && inside(configDir, parentAzureConfigDir)
          ? `lies inside AZURE_CONFIG_DIR (${parentAzureConfigDir})`
          : inside(realAzureDir, configDir)
            ? `contains your Azure CLI profile (${realAzureDir})`
            : undefined;
  if (configDirProblem) {
    errors.push(
      `The Azure tool's CLI config dir ${configDir} ${configDirProblem}. The tool keeps its own isolated profile so it never changes your Azure CLI login; set LOCALSTACK_AZ_CONFIG_DIR to another directory (the default is ~/.localstack/azure/mcp-config-<port>).`
    );
  }

  const extensionSetting = env.LOCALSTACK_AZ_EXTENSION_DIR?.trim();
  const extensionDir = extensionSetting
    ? resolveUserPath(extensionSetting, home, cwd, platform)
    : pathApi.join(home, ".localstack", "azure", "mcp-extensions");

  const workdirSetting = env.LOCALSTACK_AZ_WORKDIR?.trim();
  const workdir = workdirSetting ? resolveUserPath(workdirSetting, home, cwd, platform) : cwd;
  if (!isDirectory(workdir)) {
    errors.push(
      `The Azure tool's working directory ${workdir} is not an existing directory. Set LOCALSTACK_AZ_WORKDIR to the directory that holds your templates and files.`
    );
  } else if (
    inside(workdir, realAzureDir) ||
    (parentAzureConfigDir && inside(workdir, parentAzureConfigDir)) ||
    inside(workdir, configDir)
  ) {
    errors.push(
      `The Azure tool's working directory ${workdir} lies inside an Azure CLI profile. Set LOCALSTACK_AZ_WORKDIR to a project directory.`
    );
  } else if (inside(home, workdir)) {
    // Not an error: a client may start servers in the home directory. The file
    // rule's protected directories still keep ~/.azure, ~/.ssh, ~/.kube and ~/.docker out.
    warnings.push(
      `The Azure tool's working directory is ${workdir}, which contains your home directory; commands can read and write files anywhere under it. Set LOCALSTACK_AZ_WORKDIR to a project directory.`
    );
  }

  const optionalPath = (name: string) => {
    const value = env[name]?.trim();
    return value ? resolveUserPath(value, home, cwd, platform) : undefined;
  };
  const azPath = env.LOCALSTACK_AZ_PATH?.trim() || undefined;
  const bicepPath = env.LOCALSTACK_AZ_BICEP_PATH?.trim() || undefined;

  const denylistFile = optionalPath("LOCALSTACK_AZ_DENYLIST_FILE");
  if (denylistFile && !isFile(denylistFile)) {
    // A missing denylist must not silently weaken the user's own policy.
    errors.push(`LOCALSTACK_AZ_DENYLIST_FILE ${denylistFile} does not exist or is not a file.`);
  }

  // `worker` (plan task 7.1) is opt-in: one warm az process per concurrent call.
  const runnerSetting = env.LOCALSTACK_AZ_RUNNER?.trim().toLowerCase();
  let runner: AzureConfig["runner"] = "host";
  if (runnerSetting === "worker") {
    runner = "worker";
  } else if (runnerSetting && runnerSetting !== "host") {
    warnings.push(
      `LOCALSTACK_AZ_RUNNER=${env.LOCALSTACK_AZ_RUNNER} is not a runner; use host or worker. Using host.`
    );
  }

  const inDocker = deps.inDocker ?? existsSync("/.dockerenv");

  return {
    port,
    healthBaseUrl: `http://127.0.0.1:${port}`,
    endpoint,
    endpointHost,
    configDir,
    homeDir: pathApi.join(configDir, "home"),
    tmpDir: pathApi.join(configDir, "tmp"),
    extensionDir,
    azPath,
    bicepPath,
    bicepEnv: readBicepEnv(env, warnings),
    timeoutMs:
      readInt(env, "LOCALSTACK_AZ_TIMEOUT_SECONDS", DEFAULT_AZ_TIMEOUT_SECONDS, 5, 3600, warnings) *
      1000,
    maxOutputChars: readInt(
      env,
      "LOCALSTACK_AZ_MAX_OUTPUT_CHARS",
      DEFAULT_AZ_MAX_CHARS,
      1000,
      MAX_AZ_OUTPUT_CHARS,
      warnings
    ),
    maxHelpChars: readInt(
      env,
      "LOCALSTACK_AZ_MAX_HELP_CHARS",
      DEFAULT_AZ_MAX_CHARS,
      1000,
      MAX_AZ_OUTPUT_CHARS,
      warnings
    ),
    workdir,
    egressGuard: readFlag(env, "LOCALSTACK_AZ_EGRESS_GUARD", true, warnings),
    denylistFile,
    runner,
    pycacheDir: optionalPath("LOCALSTACK_AZ_PYCACHE_DIR"),
    forwardTarget: env.LOCALSTACK_AZURE_FORWARD_TARGET?.trim() || undefined,
    testEnvelope: env.LOCALSTACK_AZ_TEST_ENVELOPE?.trim() === "1",
    inDocker,
    warnings,
    errors,
  };
}

/**
 * The directories the file rule refuses even inside the workdir (see
 * `PolicyOptions.protectedDirs`).
 */
export function azureProtectedDirs(
  config: AzureConfig,
  env: NodeJS.ProcessEnv = process.env,
  deps: Pick<AzureConfigDeps, "homedir" | "platform" | "cwd"> = {}
): string[] {
  const platform = deps.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = (deps.homedir ?? os.homedir)();
  const cwd = (deps.cwd ?? process.cwd)();
  const dirs = [".azure", ".ssh", ".kube", ".docker"].map((d) => pathApi.join(home, d));
  const parent = env.AZURE_CONFIG_DIR?.trim();
  if (parent) dirs.push(resolveUserPath(parent, home, cwd, platform));
  dirs.push(config.configDir);
  return dirs;
}
