import { mkdirSync } from "fs";
import path from "path";
import type { AzureConfig } from "./config";
import type { AzExecutable } from "./resolve-az";

/**
 * The environment `az` runs with. It is built from an allow-list, never from a copy of the
 * server's environment: `AZURE_*`, `ARM_*`, `MSI_*` and the proxy and CA variables would point
 * `az` at real Azure or at another profile. Its home and temp directories are private ones inside
 * the tool's config dir, so commands that write to `~` (`--generate-ssh-keys`,
 * `aks get-credentials`) write there instead of into the user's home.
 */

type ChildConfig = Pick<AzureConfig, "configDir" | "homeDir" | "tmpDir" | "extensionDir">;

const INHERITED = ["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "LANG"];
const INHERITED_WINDOWS = [
  "PATHEXT",
  "USERNAME",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

const appData = (homeDir: string) => ({
  roaming: path.win32.join(homeDir, "AppData", "Roaming"),
  local: path.win32.join(homeDir, "AppData", "Local"),
});

/** The config dir and the private home and temp in it, owner-only. */
export function ensurePrivateDirs(config: ChildConfig, platform: NodeJS.Platform): void {
  const dirs = [config.configDir, config.homeDir, config.tmpDir];
  if (platform === "win32") dirs.push(...Object.values(appData(config.homeDir)));
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function buildAzChildEnv(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  config: ChildConfig,
  az: Pick<AzExecutable, "prefixArgs" | "azInstaller">
): Record<string, string> {
  const env: Record<string, string> = {};
  const win = platform === "win32";
  for (const name of win ? [...INHERITED, ...INHERITED_WINDOWS] : INHERITED) {
    const key = win ? Object.keys(parent).find((k) => k.toUpperCase() === name) : name;
    const value = key === undefined ? undefined : parent[key];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(parent)) {
    if (/^LC_[A-Z]+$/.test(name) && value !== undefined) env[name] = value;
  }

  // Always set: on Windows libuv copies HOMEDRIVE, HOMEPATH, TEMP, USERPROFILE and the rest of
  // its required set from the parent when the block lacks them, which would undo the private home.
  env.HOME = config.homeDir;
  env.USERPROFILE = config.homeDir;
  env.TEMP = config.tmpDir;
  env.TMP = config.tmpDir;
  if (win) {
    env.HOMEDRIVE = path.win32.parse(config.homeDir).root.replace(/[\\/]$/, "");
    env.HOMEPATH = config.homeDir.slice(env.HOMEDRIVE.length) || "\\";
    env.APPDATA = appData(config.homeDir).roaming;
    env.LOCALAPPDATA = appData(config.homeDir).local;
  } else {
    env.TMPDIR = config.tmpDir;
  }

  env.AZURE_CONFIG_DIR = config.configDir;
  env.AZURE_EXTENSION_DIR = config.extensionDir;
  env.AZURE_CORE_COLLECT_TELEMETRY = "no";
  env.AZURE_CORE_NO_COLOR = "1";
  if (az.azInstaller) env.AZ_INSTALLER = az.azInstaller;
  // A launcher run as it is gets no `-X utf8`: ask for UTF-8 through the locale instead.
  if (
    az.prefixArgs.length === 0 &&
    !["LC_ALL", "LC_CTYPE", "LANG"].some((k) => /utf-?8/i.test(env[k] ?? ""))
  ) {
    env.LC_ALL = "C.UTF-8";
  }
  return env;
}
