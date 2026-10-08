import os from "os";
import { ensureProfile as ensureBootstrapped } from "./bootstrap";
import { buildAzChildEnv, ensurePrivateDirs } from "./child-env";
import { getAzureConfig, type AzureConfig } from "./config";
import { listInstalledExtensions } from "./extension-map";
import {
  AzResolveError,
  compareVersions,
  locateAz,
  MIN_AZ_VERSION,
  nodeResolveFs,
  parseAzVersion,
  type AzExecutable,
} from "./resolve-az";
import { runAz, type AzRunOptions, type AzRunResult } from "./runner";

/**
 * Process-wide state of the Azure client tool: the configuration and the resolved `az`, each
 * created on first use, and the emulator session the profile is checked against.
 */

let configCache: AzureConfig | undefined;
let azPromise: Promise<AzExecutable> | undefined;
let emulatorSession: string | undefined;

export function azureConfig(): AzureConfig {
  configCache ??= getAzureConfig(process.env);
  return configCache;
}

/** The emulator session requireAzureEmulatorRunning() saw; the profile is keyed on it. */
export function recordEmulatorSession(sessionId: string | undefined): void {
  emulatorSession = sessionId;
}

function runner(az: AzExecutable) {
  const config = azureConfig();
  ensurePrivateDirs(config, process.platform);
  const env = buildAzChildEnv(process.env, process.platform, config, az);
  return (argv: string[], opts: AzRunOptions) => runAz(az, env, argv, opts);
}

/** Finds `az` and checks its version, once per process; a failure is retried on the next call. */
export function azCli(): Promise<AzExecutable> {
  azPromise ??= (async () => {
    const config = azureConfig();
    const az = locateAz({
      azPath: config.azPath,
      env: process.env,
      platform: process.platform,
      homedir: os.homedir(),
      ...nodeResolveFs,
    });
    // `az version` makes no network call (`az --version` does).
    const result = await runner(az)(["version", "-o", "json"], {
      timeoutMs: 120_000,
      cwd: config.tmpDir,
    });
    const version = parseAzVersion(result.stdout);
    if (!version) {
      const why =
        result.spawnError ?? (result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`);
      throw new AzResolveError(`The Azure CLI at ${az.file} could not be started: ${why}`);
    }
    if (compareVersions(version, MIN_AZ_VERSION) < 0) {
      throw new AzResolveError(
        `The Azure CLI at ${az.file} is version ${version}; the LocalStack Azure tool needs ${MIN_AZ_VERSION} or newer. Upgrade it: https://learn.microsoft.com/cli/azure/update-azure-cli`
      );
    }
    return { ...az, version };
  })().catch((error) => {
    azPromise = undefined;
    throw error;
  });
  return azPromise;
}

/** Points the tool's own profile at the emulator, unless it already is (bootstrap.ts). */
export async function ensureProfile(): Promise<void> {
  const config = azureConfig();
  const az = await azCli();
  await ensureBootstrapped(
    {
      configDir: config.configDir,
      endpoint: config.endpoint,
      sessionId: emulatorSession,
      azVersion: az.version,
      cwd: config.tmpDir,
      timeoutMs: config.timeoutMs,
    },
    runner(az)
  );
}

export async function runAzCommand(
  argv: string[],
  opts: Pick<AzRunOptions, "signal" | "onProgress">
): Promise<AzRunResult> {
  const config = azureConfig();
  return runner(await azCli())(argv, { ...opts, timeoutMs: config.timeoutMs, cwd: config.workdir });
}

export function installedExtensionNames(): Set<string> {
  return listInstalledExtensions(azureConfig().extensionDir);
}
