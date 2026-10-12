import os from "os";
import { ensureProfile as ensureBootstrapped } from "./bootstrap";
import { buildAzChildEnv, ensurePrivateDirs } from "./child-env";
import { getAzureConfig, type AzureConfig } from "./config";
import {
  AzResolveError,
  locateAz,
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

/** The client cancelled the call while `az` was being checked. */
export class AzCancelledError extends Error {
  constructor() {
    super("The client cancelled the call, so `az` was stopped.");
    this.name = "AzCancelledError";
  }
}

export function azureConfig(): AzureConfig {
  configCache ??= getAzureConfig(process.env);
  return configCache;
}

/** The emulator session requireAzureEmulatorRunning() saw; the profile is keyed on it. */
export function recordEmulatorSession(sessionId: string | undefined): void {
  emulatorSession = sessionId;
}

/** Tests only: forget the configuration, the resolved `az` and the session. */
export function resetAzureServices(): void {
  configCache = undefined;
  azPromise = undefined;
  emulatorSession = undefined;
}

function runner(az: AzExecutable) {
  const config = azureConfig();
  ensurePrivateDirs(config, process.platform);
  const env = buildAzChildEnv(process.env, process.platform, config, az);
  return (argv: string[], opts: AzRunOptions) => runAz(az, env, argv, opts);
}

async function probeAz(signal?: AbortSignal): Promise<AzExecutable> {
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
    signal,
  });
  if (result.aborted) throw new AzCancelledError();
  const version = parseAzVersion(result.stdout);
  if (!version) {
    const why =
      result.spawnError ?? (result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`);
    throw new AzResolveError(`The Azure CLI at ${az.file} could not be started: ${why}`);
  }
  return { ...az, version };
}

/**
 * Finds `az` and reads its version (the profile is keyed on it), once per process; a failure is
 * retried on the next call. Concurrent calls share the check, which stops when the call that
 * started it is cancelled; the others start it again.
 */
export async function azCli(signal?: AbortSignal): Promise<AzExecutable> {
  for (;;) {
    azPromise ??= probeAz(signal).catch((error) => {
      azPromise = undefined;
      throw error;
    });
    try {
      return await azPromise;
    } catch (error) {
      if (!(error instanceof AzCancelledError) || signal?.aborted) throw error;
    }
  }
}

/** Points the tool's own profile at the emulator, unless it already is (bootstrap.ts). */
export async function ensureProfile(signal?: AbortSignal): Promise<void> {
  const config = azureConfig();
  const az = await azCli(signal);
  await ensureBootstrapped(
    {
      configDir: config.configDir,
      endpoint: config.endpoint,
      sessionId: emulatorSession,
      azVersion: az.version,
      cwd: config.tmpDir,
      timeoutMs: config.timeoutMs,
    },
    runner(az),
    signal
  );
}

export async function runAzCommand(
  argv: string[],
  opts: Pick<AzRunOptions, "signal">
): Promise<AzRunResult> {
  const config = azureConfig();
  return runner(await azCli())(argv, { ...opts, timeoutMs: config.timeoutMs, cwd: config.workdir });
}
