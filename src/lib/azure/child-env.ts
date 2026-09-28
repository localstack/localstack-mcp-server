import { mkdirSync } from "fs";
import path from "path";
import type { AzExecutable, AzureConfig } from "./types";

/**
 * The environment `az` runs with (plan task 2.3; checks C03 and C08). It is built
 * from an allow-list, never from a copy of the server's environment:
 * - `AZURE_*`, `ARM_*`, `MSI_ENDPOINT`, `IDENTITY_*` and the user's proxy and CA
 *   variables would point `az` at real Azure or at another profile;
 * - `KUBECONFIG`, `DOCKER_COMMAND`, `GITHUB_ACTIONS`, `TF_BUILD`, `BICEP_*`,
 *   `AZURE_EXTENSION_SYS_DIR` and `BROWSER` each change what `az` or Bicep does (C08).
 * The home, AppData and temp directories are private ones inside the tool's config
 * dir, so commands that default to `~` (`--generate-ssh-keys`, `aks get-credentials`,
 * `ad ... --create-cert`) write there instead of into the user's home (C08: 66 calls,
 * and az wrote nothing into the real ones).
 */

/** Inherited on every platform. */
const INHERITED = ["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "LANG"];
/**
 * Inherited on Windows only. az finds Bicep with `shutil.which("bicep")`, which reads
 * PATHEXT on older Pythons; the others are in the environment C08's calls ran with.
 */
const INHERITED_WINDOWS = [
  "PATHEXT",
  "USERNAME",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

export interface ChildEnvOptions {
  platform: NodeJS.Platform;
  config: Pick<
    AzureConfig,
    "configDir" | "homeDir" | "tmpDir" | "extensionDir" | "egressGuard" | "inDocker"
  > &
    Partial<Pick<AzureConfig, "bicepEnv">>;
  az: Pick<AzExecutable, "installer" | "azInstaller">;
  /** Prepended to PATH, so `bicep.use_binary_from_path=true` finds the resolved binary. */
  bicepDir?: string;
}

function lookup(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** The private directories inside the config dir (`<config dir>/home`, `<config dir>/tmp`). */
export function privateDirs(opts: Pick<ChildEnvOptions, "platform" | "config">) {
  const pathApi = opts.platform === "win32" ? path.win32 : path.posix;
  const { homeDir, tmpDir } = opts.config;
  return {
    home: homeDir,
    appData: pathApi.join(homeDir, "AppData", "Roaming"),
    localAppData: pathApi.join(homeDir, "AppData", "Local"),
    tmp: tmpDir,
  };
}

/**
 * Create the config dir and its private home and temp, owner-only. Bicep extracts
 * 13.4 MB of native libraries into the temp dir (Windows) or `$HOME/.net` (Linux),
 * so both must be writable.
 */
export function ensurePrivateDirs(opts: Pick<ChildEnvOptions, "platform" | "config">): void {
  const dirs = privateDirs(opts);
  mkdirSync(opts.config.configDir, { recursive: true, mode: 0o700 });
  for (const dir of [dirs.home, dirs.tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (opts.platform === "win32") {
    mkdirSync(dirs.appData, { recursive: true });
    mkdirSync(dirs.localAppData, { recursive: true });
  }
}

function hasUtf8Locale(env: Record<string, string>) {
  return ["LC_ALL", "LC_CTYPE", "LANG"].some((k) => /utf-?8/i.test(env[k] ?? ""));
}

/**
 * Build the child environment. The egress proxy variables are added per call by the
 * runner (task 2.8); `NO_PROXY` is never set, since bypassing the guard would skip
 * its name mapping and its per-call records (C01).
 */
export function buildAzChildEnv(
  parent: NodeJS.ProcessEnv,
  opts: ChildEnvOptions
): Record<string, string> {
  const { platform, config } = opts;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const env: Record<string, string> = {};

  const inherited = platform === "win32" ? [...INHERITED, ...INHERITED_WINDOWS] : INHERITED;
  for (const name of inherited) {
    const value = lookup(parent, name, platform);
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(parent)) {
    if (/^LC_[A-Z]+$/.test(name) && value !== undefined) env[name] = value;
  }
  if (opts.bicepDir) {
    env.PATH = [opts.bicepDir, env.PATH].filter(Boolean).join(pathApi.delimiter);
  }
  // The variables a `.bicepparam` may read with readEnvironmentVariable() (LOCALSTACK_AZ_BICEP_ENV):
  // only those the user listed; config already refused the token and anything that
  // steers az. Set before the tool's own settings below, so those always win.
  const sameName = (a: string, b: string) =>
    platform === "win32" ? a.toUpperCase() === b.toUpperCase() : a === b;
  for (const name of config.bicepEnv ?? []) {
    if (Object.keys(env).some((key) => sameName(key, name))) continue; // never replace PATH & co.
    const value =
      platform === "win32" ? lookup(parent, name.toUpperCase(), platform) : parent[name];
    if (value !== undefined) env[name] = value;
  }

  // These must always be set here. On Windows, libuv's uv_spawn copies HOMEDRIVE,
  // HOMEPATH, TEMP, USERPROFILE and the rest of its required set from the PARENT
  // whenever the env block lacks them (verified in runner.test.ts), which would
  // silently undo the private home.
  const dirs = privateDirs(opts);
  env.HOME = dirs.home;
  env.USERPROFILE = dirs.home;
  env.TEMP = dirs.tmp;
  env.TMP = dirs.tmp;
  if (platform === "win32") {
    const root = path.win32.parse(dirs.home).root; // "C:\" or "\\server\share\"
    env.HOMEDRIVE = root.replace(/[\\/]$/, "");
    env.HOMEPATH = dirs.home.slice(env.HOMEDRIVE.length) || "\\";
    env.APPDATA = dirs.appData;
    env.LOCALAPPDATA = dirs.localAppData;
  } else {
    env.TMPDIR = dirs.tmp;
  }

  env.AZURE_CONFIG_DIR = config.configDir;
  env.AZURE_EXTENSION_DIR = config.extensionDir;
  env.AZURE_CORE_COLLECT_TELEMETRY = "no";
  env.AZURE_CORE_NO_COLOR = "1";
  if (opts.az.azInstaller) env.AZ_INSTALLER = opts.az.azInstaller;
  if (config.inDocker) {
    // A bundled or mounted Linux Bicep runs without ICU; C08 saw identical output.
    env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = "1";
  }
  if (opts.az.installer === "launcher-as-is") {
    // No interpreter to give `-X utf8`: the launcher's own flags decide (C03), so
    // ask for UTF-8 through the locale and, for launchers without -I, PYTHONIOENCODING.
    if (!hasUtf8Locale(env)) env.LC_ALL = "C.UTF-8";
    env.PYTHONIOENCODING = "utf-8";
  }
  return env;
}
