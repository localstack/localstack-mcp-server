import { statSync } from "fs";
import os from "os";
import path from "path";

/** The Azure client tool's settings, read from the server's environment. */
export interface AzureConfig {
  /** The emulator's gateway, built like LOCALSTACK_BASE_URL: LOCALSTACK_HOSTNAME and LOCALSTACK_PORT. */
  healthBaseUrl: string;
  port: number;
  /** The ARM endpoint `az` talks to: https://azure.localhost.localstack.cloud:<port>. */
  endpoint: string;
  /** The ports the egress guard relays to: the gateway's, 443 and the external-service range. */
  emulatorPorts: number[];
  /** The tool's own Azure CLI config dir; `az` never sees the user's ~/.azure. */
  configDir: string;
  /** The child's private home and temp dir, inside the config dir. */
  homeDir: string;
  tmpDir: string;
  /** The user's own extension dir: AZURE_EXTENSION_DIR, else <AZURE_CONFIG_DIR or ~/.azure>/cliextensions. */
  extensionDir: string;
  /** An explicit `az` launcher or the CLI's Python (LOCALSTACK_AZ_PATH). */
  azPath?: string;
  timeoutMs: number;
  /** The working directory `az` runs in (LOCALSTACK_AZ_WORKDIR, default the server's). */
  workdir: string;
  /** Settings the tool refuses to run with, until they are fixed. */
  errors: string[];
}

export interface AzureConfigDeps {
  homedir?: () => string;
  cwd?: () => string;
  platform?: NodeJS.Platform;
  isDirectory?: (p: string) => boolean;
}

/**
 * The hosts an absolute `rest` URL may name, and the egress guard relays to: LocalStack's
 * public DNS names for 127.0.0.1 (localhost.localstack.cloud and its subdomains) and the
 * loopback names and addresses.
 */
export function isLocalHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  return (
    ["localhost", "127.0.0.1", "::1", "localhost.localstack.cloud"].includes(h) ||
    h.endsWith(".localhost.localstack.cloud")
  );
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function getAzureConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: AzureConfigDeps = {}
): AzureConfig {
  const platform = deps.platform ?? process.platform;
  const P = platform === "win32" ? path.win32 : path.posix;
  const home = (deps.homedir ?? os.homedir)();
  const cwd = (deps.cwd ?? process.cwd)();
  const errors: string[] = [];
  const setting = (name: string) => env[name]?.trim() || undefined;
  // MCP client configs pass values without a shell, so a leading `~` is expanded here.
  const userPath = (value: string) =>
    P.resolve(cwd, value === "~" || /^~[\\/]/.test(value) ? P.join(home, value.slice(1)) : value);
  const wholeNumber = (name: string, fallback: string, min: number, max: number) => {
    const text = setting(name) ?? fallback;
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!(value >= min && value <= max)) {
      errors.push(`${name} must be a whole number from ${min} to ${max}; got "${text}".`);
    }
    return value;
  };
  const fold = (p: string) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const inside = (child: string, parent: string) => {
    const rel = P.relative(fold(parent), fold(child));
    return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
  };

  const port = wholeNumber("LOCALSTACK_PORT", "4566", 1, 65535);
  // The external-service range as the start action publishes it (an invalid one is reported there).
  const rangeSetting = (name: string) =>
    Number(setting(name) ?? setting(`LOCALSTACK_${name}`) ?? NaN);
  let first = rangeSetting("EXTERNAL_SERVICE_PORTS_START");
  first = Number.isInteger(first) ? first : 4510;
  let last = rangeSetting("EXTERNAL_SERVICE_PORTS_END");
  last = Number.isInteger(last) ? last : first + 50;
  if (first < 1 || last > 65535 || last < first || last - first >= 1000)
    [first, last] = [4510, 4560];
  const emulatorPorts = [
    port,
    443,
    ...Array.from({ length: last - first + 1 }, (_, i) => first + i),
  ];

  const userProfile = userPath(setting("AZURE_CONFIG_DIR") ?? P.join(home, ".azure"));
  const configSetting = setting("LOCALSTACK_AZ_CONFIG_DIR");
  const configDir = configSetting
    ? userPath(configSetting)
    : P.join(home, ".localstack", "azure", `mcp-config-${port}`);
  // The bootstrap rewrites the config dir's cloud, settings and login: it must never be (or hold)
  // the user's own Azure CLI profile.
  for (const profile of new Set([P.join(home, ".azure"), userProfile])) {
    if (inside(configDir, profile) || inside(profile, configDir)) {
      errors.push(
        `LOCALSTACK_AZ_CONFIG_DIR (${configDir}) overlaps your Azure CLI profile (${profile}). The tool keeps its own profile so it never changes your Azure CLI login; choose another directory.`
      );
    }
  }

  const workdir = userPath(setting("LOCALSTACK_AZ_WORKDIR") ?? cwd);
  if (!(deps.isDirectory ?? isDirectory)(workdir)) {
    errors.push(
      `LOCALSTACK_AZ_WORKDIR (${workdir}) is not an existing directory: set it to the directory that holds your templates and files.`
    );
  }

  return {
    healthBaseUrl: `http://${setting("LOCALSTACK_HOSTNAME") ?? "localhost"}:${port}`,
    port,
    endpoint: `https://azure.localhost.localstack.cloud:${port}`,
    emulatorPorts: [...new Set(emulatorPorts)],
    configDir,
    homeDir: P.join(configDir, "home"),
    tmpDir: P.join(configDir, "tmp"),
    extensionDir: userPath(setting("AZURE_EXTENSION_DIR") ?? P.join(userProfile, "cliextensions")),
    azPath: setting("LOCALSTACK_AZ_PATH"),
    timeoutMs: (wholeNumber("LOCALSTACK_AZ_TIMEOUT_SECONDS", "300", 5, 3600) || 300) * 1000,
    workdir,
    errors,
  };
}
