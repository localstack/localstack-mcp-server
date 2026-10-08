import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import type { AzRunOptions, AzRunResult } from "./runner";

/**
 * The tool's own Azure CLI profile. Four `az` calls point its config dir at the emulator:
 * `cloud register` (or `update`), `cloud set`, `config set` and a dummy `login`. The bootstrap is
 * their only caller; the policy refuses them to the agent. A marker records the endpoint, emulator
 * session and az version the profile was made for; when one changes (a restarted emulator has
 * lost the dummy login), the bootstrap runs again. Servers that share the config dir may run it at
 * the same moment, so every step tolerates another server having done it already.
 */

export const LOCALSTACK_CLOUD = "LocalStack";

/** The CLI settings, set in one call. */
export const CLI_CONFIG = [
  "core.instance_discovery=false",
  "core.collect_telemetry=false",
  "output.show_survey_link=no",
  // A command from an extension that is not installed fails instead of installing it.
  "extension.use_dynamic_install=no",
  // az sends failed command names, with their parameter names, to app.aladdin.microsoft.com.
  "core.error_recommendation=off",
  "core.output=json",
  // Removes `vm create`'s region cost notice.
  "core.display_region_identified=false",
  // Bicep from PATH, and no aka.ms version lookups or downloads.
  "bicep.use_binary_from_path=true",
  "bicep.check_version=false",
  "auto-upgrade.enable=no",
];

export const DUMMY_LOGIN =
  "login --service-principal -u any-app -p any-pass --tenant anytenant --only-show-errors".split(
    " "
  );

export function cloudConfigJson(endpoint: string): string {
  return JSON.stringify({
    endpoints: {
      activeDirectory: endpoint,
      activeDirectoryResourceId: endpoint,
      activeDirectoryGraphResourceId: endpoint,
      management: `${endpoint}/`,
      microsoftGraphResourceId: `${endpoint}/`,
      resourceManager: `${endpoint}/`,
      logAnalyticsResourceId: endpoint,
    },
  });
}

export const MARKER_FILE = "localstack-mcp-bootstrap.json";

export interface BootstrapTarget {
  configDir: string;
  endpoint: string;
  sessionId?: string;
  azVersion?: string;
  cwd: string;
  timeoutMs: number;
}

export type RunAz = (argv: string[], opts: AzRunOptions) => Promise<AzRunResult>;

/** A bootstrap step failed; `result` carries az's output. */
export class BootstrapError extends Error {
  constructor(
    readonly step: string,
    readonly result: AzRunResult
  ) {
    super(
      `Setting up the tool's Azure CLI profile failed at \`az ${step}\` (exit ${result.exitCode}).`
    );
    this.name = "BootstrapError";
  }
}

const markerFor = (target: BootstrapTarget) =>
  JSON.stringify({
    endpoint: target.endpoint,
    sessionId: target.sessionId ?? null,
    azVersion: target.azVersion ?? null,
  });

function readMarker(configDir: string): string | undefined {
  try {
    return readFileSync(path.join(configDir, MARKER_FILE), "utf8");
  } catch {
    return undefined;
  }
}

export const LOCK_DIR = "localstack-mcp-bootstrap.lock";
/** A server killed mid-bootstrap leaves its lock behind; one older than this is broken. */
const STALE_LOCK_MS = 120_000;

/**
 * Servers sharing the config dir set it up one at a time: `az cloud` and `az config` rewrite the
 * same config file, and concurrent writers lose each other's settings.
 */
async function withLock(configDir: string, fn: () => Promise<void>): Promise<void> {
  const lock = path.join(configDir, LOCK_DIR);
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true });
      } catch {
        // released meanwhile
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const inFlight = new Map<string, Promise<void>>();

/** Sets the profile up for this target, unless its marker says it already is; concurrent calls share one run. */
export function ensureProfile(target: BootstrapTarget, run: RunAz): Promise<void> {
  mkdirSync(target.configDir, { recursive: true, mode: 0o700 });
  const marker = markerFor(target);
  if (readMarker(target.configDir) === marker) return Promise.resolve();
  const key = `${target.configDir}\n${marker}`;
  let job = inFlight.get(key);
  if (!job) {
    // Under the lock, the marker again: another server may have just done it.
    job = withLock(target.configDir, async () => {
      if (readMarker(target.configDir) !== marker) await runBootstrap(target, run, marker);
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

async function runBootstrap(target: BootstrapTarget, run: RunAz, marker: string): Promise<void> {
  const opts: AzRunOptions = { timeoutMs: target.timeoutMs, cwd: target.cwd };
  // The marker is written last, so a partial bootstrap leaves none and the next call starts over.
  rmSync(path.join(target.configDir, MARKER_FILE), { force: true });
  const step = async (name: string, argv: string[]) => {
    const result = await run(argv, opts);
    if (result.exitCode !== 0) throw new BootstrapError(name, result);
  };
  // The cloud exists after an earlier bootstrap, or when another server registered it a moment ago.
  const cloud = ["--name", LOCALSTACK_CLOUD, "--cloud-config", cloudConfigJson(target.endpoint)];
  const registered = await run(["cloud", "register", ...cloud, "--only-show-errors"], opts);
  if (registered.exitCode !== 0) {
    if (!/is already registered/.test(registered.stderr)) {
      throw new BootstrapError("cloud register", registered);
    }
    await step("cloud update", ["cloud", "update", ...cloud, "--only-show-errors"]);
  }
  await step("cloud set", ["cloud", "set", "--name", LOCALSTACK_CLOUD, "--only-show-errors"]);
  await step("config set", ["config", "set", ...CLI_CONFIG, "--only-show-errors"]);
  await step("login", DUMMY_LOGIN);
  writeFileSync(path.join(target.configDir, MARKER_FILE), marker, { mode: 0o600 });
}
