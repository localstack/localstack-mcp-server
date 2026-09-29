import { mkdirSync, readFileSync, statSync } from "fs";
import os from "os";
import path from "path";
import { azureProtectedDirs, canonicalPath, getAzureConfig } from "../../core/config";
import {
  BootstrapError,
  ensureAzureCliConfigured,
  runWithSelfHeal,
  versionsFromAzVersionJson,
  versionsFromLocalVersionsJson,
  type BootstrapDeps,
  type BootstrapTarget,
} from "./bootstrap";
import { buildAzChildEnv, ensurePrivateDirs } from "./child-env";
import { startEgressProxy } from "./egress-proxy";
import {
  interpreterFlags,
  listInstalledExtensions,
  nodeResolveFs,
  probeArgs,
  resolveAz,
  resolveBicep,
  type AzProbeOutcome,
  type BicepResolution,
  type InstalledExtension,
  type LocatedAz,
} from "./resolve-az";
import { listInstalledExtensions as listExtensionNames } from "./extension-map";
import { parseDenylistFile } from "./policy";
import { HostRunner } from "./runner";
import { WorkerRunner } from "./worker-runner";
import type {
  AzExecutable,
  AzRunner,
  AzRunOptions,
  AzRunResult,
  AzureConfig,
  EgressProxy,
  PolicyOptions,
} from "./types";

/**
 * Process-wide state of the Azure client tool: the configuration, the resolved `az`
 * and Bicep, the egress guard and the runner. Each is created once, on first use, so
 * a server that never runs an Azure command never starts any of them.
 */

let configCache: AzureConfig | undefined;
let azPromise: Promise<AzExecutable> | undefined;
let bicepPromise: Promise<BicepResolution | undefined> | undefined;
let guardPromise: Promise<EgressProxy | undefined> | undefined;
let lastSessionId: string | undefined;
let workerRunner: WorkerRunner | undefined;

/** Drop every cached service (tests). */
export async function resetAzureServices(): Promise<void> {
  await workerRunner?.close();
  workerRunner = undefined;
  const guard = guardPromise ? await guardPromise.catch(() => undefined) : undefined;
  await guard?.close();
  configCache = undefined;
  policyCache = undefined;
  denylistCache = undefined;
  azPromise = undefined;
  bicepPromise = undefined;
  guardPromise = undefined;
  lastSessionId = undefined;
}

export function azureConfig(): AzureConfig {
  configCache ??= getAzureConfig(process.env);
  return configCache;
}

/** The directories the file rule protects even inside the workdir. */
export function protectedDirs(): string[] {
  return azureProtectedDirs(azureConfig(), process.env);
}

let denylistCache: string[][] | undefined;
let policyCache: PolicyOptions | undefined;

/** The policy's inputs: workdir, private home, protected dirs and the user's denylist. */
export function policyOptions(): PolicyOptions {
  if (policyCache) return policyCache;
  const config = azureConfig();
  if (!denylistCache) {
    let text = "";
    try {
      text = config.denylistFile ? readFileSync(config.denylistFile, "utf8") : "";
    } catch {
      text = ""; // reported by requireAzureConfig at start (the file must exist)
    }
    denylistCache = parseDenylistFile(text);
  }
  policyCache = {
    workdir: config.workdir,
    homeDir: config.homeDir,
    extraDenied: denylistCache,
    protectedDirs: protectedDirs(),
    platform: process.platform,
  };
  return policyCache;
}

/** Names of the installed extensions, for the missing-extension hint. */
export function installedExtensionNames(): Set<string> {
  return listExtensionNames(azureConfig().extensionDir);
}

/** Containment layer 4; undefined only with LOCALSTACK_AZ_EGRESS_GUARD=0. */
export function egressGuard(): Promise<EgressProxy | undefined> {
  const config = azureConfig();
  if (!config.egressGuard) return Promise.resolve(undefined);
  guardPromise ??= startEgressProxy({
    // stderr only: stdout carries the MCP server's JSON-RPC.
    log: (line) => process.stderr.write(`[localstack-azure-client] ${line}\n`),
  });
  return guardPromise;
}

/** The emulator session last seen by requireAzureEmulatorRunning(); the bootstrap keys on it. */
export function recordEmulatorSession(sessionId: string | undefined): void {
  lastSessionId = sessionId;
}

/** The session recorded above (the test envelope shows it). */
export function emulatorSessionId(): string | undefined {
  return lastSessionId;
}

function childEnvFor(az: Pick<AzExecutable, "installer" | "azInstaller">, bicepDir?: string) {
  const config = azureConfig();
  ensurePrivateDirs({ platform: process.platform, config });
  return buildAzChildEnv(process.env, { platform: process.platform, config, az, bicepDir });
}

async function runOnce(exe: AzExecutable, argv: string[], timeoutMs: number): Promise<AzRunResult> {
  const config = azureConfig();
  const runner = new HostRunner({ exe, env: childEnvFor(exe), proxy: await egressGuard() });
  // Probes run in the private temp dir: nothing the agent wrote can shadow them.
  return runner.run(argv, { timeoutMs, cwd: config.tmpDir });
}

function lastJsonLine(text: string): unknown {
  const line = text.trim().split(/\r?\n/).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The probe resolveAz() calls: an import of azure.cli.core, or `az version` for a launcher as-is. */
async function probeAz(exe: LocatedAz, safePathFallback: boolean): Promise<AzProbeOutcome> {
  if (exe.installer === "launcher-as-is") {
    const result = await runOnce({ ...exe }, ["version", "-o", "json"], 120_000);
    if (result.exitCode !== 0)
      return { ok: false, error: result.stderr.trim().slice(0, 300) || result.spawnError };
    try {
      const core = versionsFromAzVersionJson(result.stdout).core;
      return { ok: Boolean(core), core };
    } catch {
      return { ok: false, error: "`az version -o json` did not print JSON" };
    }
  }
  const result = await runOnce(
    { file: exe.file, prefixArgs: probeArgs(safePathFallback), installer: exe.installer },
    [],
    60_000
  );
  const parsed = lastJsonLine(result.stdout) as
    { python?: string; core?: string; error?: string } | undefined;
  if (!parsed) {
    return {
      ok: false,
      error: result.spawnError ?? (result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`),
    };
  }
  return {
    ok: Boolean(parsed.core),
    python: parsed.python,
    core: parsed.core,
    error: parsed.error,
  };
}

function readProcVersion(): string | undefined {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The bytecode cache dir (LOCALSTACK_AZ_PYCACHE_DIR, set by the image), created
 * owner-only. A writable bytecode cache can be poisoned, so a directory that others can
 * write, or that another user owns, is not used.
 */
export function safePycacheDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      const stat = statSync(dir);
      const foreign = typeof process.getuid === "function" && stat.uid !== process.getuid();
      if (foreign || (stat.mode & 0o022) !== 0) {
        process.stderr.write(
          `[localstack-azure-client] LOCALSTACK_AZ_PYCACHE_DIR ${dir} is writable by others or owned by another user; not used\n`
        );
        return undefined;
      }
    }
    return dir;
  } catch {
    return undefined;
  }
}

/** Resolve and probe `az` once per process (throws AzResolveError). A failure is retried next call. */
export function azCli(): Promise<AzExecutable> {
  const config = azureConfig();
  azPromise ??= resolveAz(
    {
      env: config.azPath ? { ...process.env, LOCALSTACK_AZ_PATH: config.azPath } : process.env,
      platform: process.platform,
      homedir: os.homedir(),
      fs: nodeResolveFs,
      procVersion: process.platform === "win32" ? undefined : readProcVersion(),
      pycacheDir: safePycacheDir(config.pycacheDir),
    },
    probeAz
  ).catch((error) => {
    azPromise = undefined;
    throw error;
  });
  return azPromise;
}

/**
 * Resolve Bicep once per process when found (throws BicepPathError for a bad explicit path). A
 * miss is looked up again on the next call, so a Bicep installed meanwhile (install-azure-addons)
 * needs no restart, as the Snowflake tool checks for `snow` on each call.
 */
export function bicep(): Promise<BicepResolution | undefined> {
  const config = azureConfig();
  bicepPromise ??= (async () => {
    const az = await azCli();
    const home = os.homedir();
    const platform = process.platform;
    return resolveBicep(
      {
        env: process.env,
        platform,
        homedir: home,
        fs: nodeResolveFs,
        canonical: (p) => canonicalPath(p, platform),
        excludeDirs: [
          `${home}/.azure`,
          ...(process.env.AZURE_CONFIG_DIR ? [process.env.AZURE_CONFIG_DIR] : []),
        ],
      },
      async (bicepPath) => {
        const result = await runOnce(
          { file: bicepPath, prefixArgs: [], installer: az.installer },
          ["--version"],
          120_000
        );
        return result.exitCode === 0 ? result.stdout : undefined;
      }
    );
  })()
    .then((resolved) => {
      if (!resolved) bicepPromise = undefined;
      return resolved;
    })
    .catch((error) => {
      bicepPromise = undefined;
      throw error;
    });
  return bicepPromise;
}

export function installedExtensions(): InstalledExtension[] {
  return listInstalledExtensions(azureConfig().extensionDir, nodeResolveFs, process.platform);
}

const LOCAL_VERSIONS_CODE =
  "import json\nfrom azure.cli.core.util import _get_local_versions as v\nprint(json.dumps(v()))\n";

/** The update-check seed's versions (exported for the spawn smoke). */
export async function readLocalVersions(az: AzExecutable): Promise<Record<string, string>> {
  if (az.installer === "launcher-as-is") {
    const result = await runOnce(az, ["version", "-o", "json"], 120_000);
    return result.exitCode === 0 ? versionsFromAzVersionJson(result.stdout) : {};
  }
  const result = await runOnce(
    {
      file: az.file,
      prefixArgs: [...interpreterFlags(az.prefixArgs), "-c", LOCAL_VERSIONS_CODE],
      installer: az.installer,
    },
    [],
    60_000
  );
  // An empty answer is fine: the seed falls back to the probed core version.
  try {
    return versionsFromLocalVersionsJson(result.stdout.trim().split(/\r?\n/).pop() ?? "{}");
  } catch {
    return {};
  }
}

/** The runner for agent commands; Bicep's directory goes first on PATH when there is one. */
export async function azRunner(): Promise<HostRunner> {
  const az = await azCli();
  let bicepDir: string | undefined;
  try {
    bicepDir = (await bicep())?.dir;
  } catch {
    bicepDir = undefined; // a bad LOCALSTACK_AZ_BICEP_PATH is reported by the Bicep step
  }
  return new HostRunner({ exe: az, env: childEnvFor(az, bicepDir), proxy: await egressGuard() });
}

/**
 * The runner for the agent's commands: the warm worker with LOCALSTACK_AZ_RUNNER=worker
 *, else the subprocess runner. A launcher run as-is names no Python to
 * run the worker with, and a Python that cannot start it falls back to subprocesses.
 */
async function commandRunner(host: HostRunner): Promise<AzRunner> {
  const config = azureConfig();
  if (config.runner !== "worker") return host;
  const az = await azCli();
  if (az.installer === "launcher-as-is") return host;
  if (!workerRunner) {
    let bicepDir: string | undefined;
    try {
      bicepDir = (await bicep())?.dir;
    } catch {
      bicepDir = undefined; // reported by the Bicep step
    }
    workerRunner = new WorkerRunner({
      exe: az,
      env: childEnvFor(az, bicepDir),
      proxy: await egressGuard(),
      // A bootstrap or self-heal rewrites these: a worker started before holds stale config.
      stateFiles: ["config", "clouds.config", "azureProfile.json"].map((f) =>
        path.join(config.configDir, f)
      ),
      fallback: host,
      log: (line) => process.stderr.write(`[localstack-azure-client] ${line}\n`),
    });
  }
  return workerRunner;
}

export async function bootstrapTarget(): Promise<BootstrapTarget> {
  const config = azureConfig();
  const az = await azCli();
  return {
    configDir: config.configDir,
    endpoint: config.endpoint,
    sessionId: lastSessionId,
    azVersion: az.version,
    cwd: config.workdir,
    timeoutMs: config.timeoutMs,
  };
}

async function bootstrapDeps(): Promise<BootstrapDeps> {
  const az = await azCli();
  const runner = await azRunner();
  return {
    runner,
    commandRunner: await commandRunner(runner),
    readLocalVersions: () => readLocalVersions(az),
  };
}

export async function ensureProfile(): Promise<void> {
  await ensureAzureCliConfigured(await bootstrapTarget(), await bootstrapDeps());
}

export async function runAzCommand(
  argv: string[],
  opts: Omit<AzRunOptions, "cwd" | "timeoutMs">
): Promise<AzRunResult> {
  const config = azureConfig();
  return runWithSelfHeal(await bootstrapTarget(), await bootstrapDeps(), argv, {
    ...opts,
    timeoutMs: config.timeoutMs,
    cwd: config.workdir,
  });
}

export { BootstrapError, interpreterFlags };
