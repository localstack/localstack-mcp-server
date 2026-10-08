import { randomUUID } from "crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import type { AzRunner, AzRunOptions, AzRunResult } from "./types";

/**
 * The isolated CLI profile. Exactly five `az` calls
 * point the config dir at the emulator: `cloud list`, `cloud register|update`,
 * `cloud set`, `config set` and a dummy `login`. The bootstrap is the only caller of
 * those commands; the policy refuses them for the agent.
 */

export const LOCALSTACK_CLOUD = "LocalStack";

/** The CLI config values, set in one call. */
export const CLI_CONFIG = [
  "core.instance_discovery=false",
  "core.collect_telemetry=false",
  "output.show_survey_link=no",
  "extension.use_dynamic_install=no",
  // az 2.85 sends failed command names, with their parameter names, to
  // app.aladdin.microsoft.com.
  "core.error_recommendation=off",
  "core.output=json",
  // Removes `vm create`'s region cost notice.
  "core.display_region_identified=false",
  // Bicep from the child's PATH, and no aka.ms version lookups.
  "bicep.use_binary_from_path=true",
  "bicep.check_version=false",
  // Never spawn `az upgrade` (read from the source).
  "auto-upgrade.enable=no",
];

export const DUMMY_LOGIN = [
  "login",
  "--service-principal",
  "-u",
  "any-app",
  "-p",
  "any-pass",
  "--tenant",
  "anytenant",
  "--only-show-errors",
];

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
export const LOCK_DIR = "localstack-mcp-bootstrap.lock";
export const LEASE_DIR = "localstack-mcp-leases";
export const VERSION_CHECK_FILE = "versionCheck.json";
/** A server killed mid-bootstrap leaves its lock behind; one this old is broken. */
export const STALE_LOCK_MS = 5 * 60_000;
/** Another server's lease younger than this means it is using the config dir. */
export const FRESH_LEASE_MS = 15 * 60_000;
const LEASE_REFRESH_MS = 60_000;
const LOCK_POLL_MS = 250;

/**
 * Failures that mean the profile is not (or no longer) pointed at the emulator: one
 * re-bootstrap and one retry. A
 * genuine error, such as a missing resource, never matches.
 */
export const SELF_HEAL_PATTERNS = [
  /^ERROR: Please run ['"]?az login['"]? to setup account\./im,
  /please run ['"]?az login/i,
  /no subscriptions? found for/i,
  /cloud ['"]?[^'"\n]*['"]? (is )?not (registered|found)/i,
];

export function needsRebootstrap(result: AzRunResult): boolean {
  if (result.exitCode === 0 || result.timedOut || result.aborted) return false;
  return SELF_HEAL_PATTERNS.some((p) => p.test(result.stderr));
}

export interface BootstrapMarker {
  endpoint: string;
  azVersion?: string;
  sessionId?: string;
  createdAt: string;
}

export interface BootstrapTarget {
  configDir: string;
  endpoint: string;
  sessionId?: string;
  azVersion?: string;
  /** The runner's cwd: always the workdir. */
  cwd: string;
  timeoutMs: number;
}

export interface BootstrapDeps {
  /** Runs the bootstrap's own steps (always a subprocess: each writes CLI state). */
  runner: AzRunner;
  /** Runs the agent's command; the warm worker with LOCALSTACK_AZ_RUNNER=worker. Default: runner. */
  commandRunner?: AzRunner;
  /**
   * The local versions for the update-check seed: one interpreter call of
   * `_get_local_versions()`, or `az version -o json` for a launcher spawned as-is.
   * Keys as az uses them: `azure-cli`, `core`, `telemetry`.
   */
  readLocalVersions(): Promise<Record<string, string>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hostname?: string;
}

/** A bootstrap step failed; `result` carries az's output for the error hints. */
export class BootstrapError extends Error {
  constructor(
    readonly step: string,
    readonly result: AzRunResult
  ) {
    super(`The Azure CLI profile bootstrap failed at \`az ${step}\` (exit ${result.exitCode}).`);
    this.name = "BootstrapError";
  }
}

/** Another server is using this config dir with another endpoint. */
export class ConfigDirInUseError extends Error {
  constructor(configDir: string, endpoint: string) {
    super(
      `The Azure CLI config dir ${configDir} is in use by another LocalStack MCP server for ${endpoint}. ` +
        `Re-pointing it would move that server's commands to this emulator. Give each server its own ` +
        `LOCALSTACK_AZ_CONFIG_DIR (the default is one per port: ~/.localstack/azure/mcp-config-<port>).`
    );
    this.name = "ConfigDirInUseError";
  }
}

// ---------------------------------------------------------------------------
// Locks: commands are readers, the bootstrap is the writer
// ---------------------------------------------------------------------------

/** A writer-preferring readers-writer lock, so a re-bootstrap never starves. */
export class ReadWriteLock {
  private readers = 0;
  private writer = false;
  private waitingWriters = 0;
  private readonly waiters: Array<() => void> = [];

  private pump() {
    const pending = this.waiters.splice(0);
    for (const w of pending) w();
  }

  private async acquireRead() {
    while (this.writer || this.waitingWriters > 0) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.readers++;
  }

  private async acquireWrite() {
    this.waitingWriters++;
    try {
      while (this.writer || this.readers > 0) {
        await new Promise<void>((r) => this.waiters.push(r));
      }
    } finally {
      this.waitingWriters--;
    }
    this.writer = true;
  }

  async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.readers--;
      this.pump();
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.writer = false;
      this.pump();
    }
  }

  get state() {
    return { readers: this.readers, writer: this.writer, waitingWriters: this.waitingWriters };
  }
}

const locks = new Map<string, ReadWriteLock>();

export function profileLock(configDir: string): ReadWriteLock {
  const key = path.resolve(configDir).toLowerCase();
  let lock = locks.get(key);
  if (!lock) {
    lock = new ReadWriteLock();
    locks.set(key, lock);
  }
  return lock;
}

/** Forget the in-process locks and this process's lease id (tests). */
export function resetBootstrapState(): void {
  locks.clear();
  leaseWrittenAt.clear();
  processLeaseId = randomUUID();
}

// ---------------------------------------------------------------------------
// Files: the marker, the seed, the lock dir and the leases
// ---------------------------------------------------------------------------

function writeAtomic(file: string, text: string) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch {
    // Windows refuses to replace a file another process has open (EPERM). Readers
    // of these files tolerate a torn read (the marker re-bootstraps under the lock).
    rmSync(temp, { force: true });
    writeFileSync(file, text, { mode: 0o600 });
  }
}

export function readMarker(configDir: string): BootstrapMarker | undefined {
  try {
    const marker = JSON.parse(readFileSync(path.join(configDir, MARKER_FILE), "utf8"));
    return typeof marker?.endpoint === "string" ? marker : undefined;
  } catch {
    return undefined;
  }
}

export function markerMatches(
  marker: BootstrapMarker | undefined,
  target: BootstrapTarget
): boolean {
  return (
    Boolean(marker) &&
    marker!.endpoint === target.endpoint &&
    marker!.sessionId === target.sessionId &&
    marker!.azVersion === target.azVersion
  );
}

/**
 * The update-check seed. az reads `versions.core.local` on every
 * command and logs any failure as a WARNING, `versions['azure-cli']` for `az
 * version`, and parses both times with `%Y-%m-%d %H:%M:%S.%f`, adding 1 or 7 days
 * (so the year 9999 would overflow). With these values az never checks for
 * updates, which would reach azcliprod.blob.core.windows.net.
 */
export function versionCheckSeed(localVersions: Record<string, string>, azVersion?: string) {
  const versions: Record<string, string> = { ...localVersions };
  if (azVersion) {
    versions.core ??= azVersion;
    versions["azure-cli"] ??= azVersion;
  }
  if (!versions.core) throw new Error("the update-check seed needs the azure-cli-core version");
  return {
    versions: Object.fromEntries(
      Object.entries(versions).map(([k, v]) => [k, { local: v, pypi: v }])
    ),
    update_time: "2999-01-01 00:00:00.000000",
    check_time: "2999-01-01 00:00:00.000000",
  };
}

/** `az version -o json` → the seed's keys (for a launcher spawned as-is). */
export function versionsFromAzVersionJson(text: string): Record<string, string> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const out: Record<string, string> = {};
  const map: Record<string, string> = {
    "azure-cli": "azure-cli",
    "azure-cli-core": "core",
    "azure-cli-telemetry": "telemetry",
  };
  for (const [from, to] of Object.entries(map)) {
    if (typeof parsed[from] === "string") out[to] = parsed[from] as string;
  }
  return out;
}

/** `_get_local_versions()` output ({"core": {"local": "2.87.0"}, ...}) → flat versions. */
export function versionsFromLocalVersionsJson(text: string): Record<string, string> {
  const parsed = JSON.parse(text) as Record<string, { local?: unknown }>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v?.local === "string") out[k] = v.local;
  }
  return out;
}

interface LockOwner {
  createdAt: number;
  hostname: string;
}

/** The lock's creation time: its owner file, else (not yet written, or a crash) the dir's age. */
function lockCreatedAt(lockDir: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8")) as LockOwner)
      .createdAt;
  } catch {
    try {
      return statSync(lockDir).mtimeMs;
    } catch {
      return undefined;
    }
  }
}

/**
 * The cross-process lock: a directory created with mkdir, holding {createdAt,
 * hostname}. A lock older than 5 minutes is broken; a lock is never judged by
 * checking or killing a PID.
 */
async function withLockDir<T>(
  configDir: string,
  deps: Required<Pick<BootstrapDeps, "now" | "sleep" | "hostname">>,
  fn: () => Promise<T>
): Promise<T> {
  const lockDir = path.join(configDir, LOCK_DIR);
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ createdAt: deps.now(), hostname: deps.hostname } satisfies LockOwner)
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const createdAt = lockCreatedAt(lockDir);
      if (createdAt === undefined) continue; // released meanwhile
      if (deps.now() - createdAt > STALE_LOCK_MS) {
        // Break it by renaming: of two waiters that judged the same lock stale, only
        // one rename succeeds, and a lock re-taken meanwhile is seen by the re-read.
        try {
          if (lockCreatedAt(lockDir) === createdAt) {
            const broken = `${lockDir}.stale-${randomUUID()}`;
            renameSync(lockDir, broken);
            rmSync(broken, { recursive: true, force: true });
          }
        } catch {
          // another waiter broke it first
        }
        continue;
      }
      await deps.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

let processLeaseId = randomUUID();
const leaseWrittenAt = new Map<string, number>();
let leaseExitHook = false;

interface Lease {
  endpoint: string;
  hostname: string;
  updatedAt: number;
}

/** Record that this process uses the config dir for its endpoint (refreshed each minute). */
export function touchLease(
  configDir: string,
  endpoint: string,
  now: number,
  hostname: string
): void {
  const key = `${configDir}\n${endpoint}`;
  if (now - (leaseWrittenAt.get(key) ?? -Infinity) < LEASE_REFRESH_MS) return;
  const dir = path.join(configDir, LEASE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${processLeaseId}.json`);
  writeAtomic(file, JSON.stringify({ endpoint, hostname, updatedAt: now } satisfies Lease));
  leaseWrittenAt.set(key, now);
  if (!leaseExitHook) {
    leaseExitHook = true;
    process.on("exit", () => {
      for (const k of leaseWrittenAt.keys()) {
        try {
          unlinkSync(path.join(k.split("\n")[0], LEASE_DIR, `${processLeaseId}.json`));
        } catch {
          // already gone
        }
      }
    });
  }
}

/** Another process's fresh lease for `endpoint`. */
export function freshLeaseFor(configDir: string, endpoint: string, now: number): boolean {
  const dir = path.join(configDir, LEASE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (name === `${processLeaseId}.json` || !name.endsWith(".json")) return false;
    try {
      const lease = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Lease;
      return lease.endpoint === endpoint && now - lease.updatedAt < FRESH_LEASE_MS;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// The bootstrap
// ---------------------------------------------------------------------------

function withDefaults(deps: BootstrapDeps) {
  return {
    ...deps,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    hostname: deps.hostname ?? os.hostname(),
  };
}

async function mustSucceed(step: string, pending: Promise<AzRunResult>): Promise<AzRunResult> {
  const result = await pending;
  if (result.exitCode !== 0) throw new BootstrapError(step, result);
  return result;
}

async function runBootstrap(
  target: BootstrapTarget,
  deps: ReturnType<typeof withDefaults>
): Promise<void> {
  const opts: AzRunOptions = { timeoutMs: target.timeoutMs, cwd: target.cwd };
  // A marker is written last, so a partial bootstrap leaves none (the next call retries).
  rmSync(path.join(target.configDir, MARKER_FILE), { force: true });
  // The seed comes BEFORE the first az call: a fresh config dir checks for updates
  // on its very first command.
  const seed = versionCheckSeed(await deps.readLocalVersions(), target.azVersion);
  writeAtomic(path.join(target.configDir, VERSION_CHECK_FILE), JSON.stringify(seed));

  const listed = await deps.runner.run(
    ["cloud", "list", "--query", `[?name=='${LOCALSTACK_CLOUD}'].name`, "-o", "tsv"],
    opts
  );
  // The stdout, not the result object, says whether the cloud exists.
  const exists = listed.exitCode === 0 && listed.stdout.trim() === LOCALSTACK_CLOUD;
  const verb = exists ? "update" : "register";
  await mustSucceed(
    `cloud ${verb}`,
    deps.runner.run(
      [
        "cloud",
        verb,
        "--name",
        LOCALSTACK_CLOUD,
        "--cloud-config",
        cloudConfigJson(target.endpoint),
        "--only-show-errors",
      ],
      opts
    )
  );
  await mustSucceed(
    "cloud set",
    deps.runner.run(["cloud", "set", "--name", LOCALSTACK_CLOUD, "--only-show-errors"], opts)
  );
  await mustSucceed(
    "config set",
    deps.runner.run(["config", "set", ...CLI_CONFIG, "--only-show-errors"], opts)
  );
  await mustSucceed("login", deps.runner.run(DUMMY_LOGIN, opts));

  const marker: BootstrapMarker = {
    endpoint: target.endpoint,
    azVersion: target.azVersion,
    sessionId: target.sessionId,
    createdAt: new Date(deps.now()).toISOString(),
  };
  writeAtomic(path.join(target.configDir, MARKER_FILE), JSON.stringify(marker));
}

/**
 * Make sure the config dir is bootstrapped for this endpoint, emulator session and
 * az version. Re-bootstraps when any of them changed; `force` re-bootstraps anyway
 * (the self-heal). Waits for in-flight commands first (the write lock), and for a
 * bootstrap in another server process (the lock dir).
 */
export async function ensureAzureCliConfigured(
  target: BootstrapTarget,
  rawDeps: BootstrapDeps,
  opts: { force?: boolean } = {}
): Promise<void> {
  const deps = withDefaults(rawDeps);
  mkdirSync(target.configDir, { recursive: true, mode: 0o700 });
  touchLease(target.configDir, target.endpoint, deps.now(), deps.hostname);
  if (!opts.force && markerMatches(readMarker(target.configDir), target)) return;

  const stale = opts.force ? readMarker(target.configDir) : undefined;
  await profileLock(target.configDir).write(() =>
    withLockDir(target.configDir, deps, async () => {
      const marker = readMarker(target.configDir);
      // Another caller finished the job while this one waited.
      if (markerMatches(marker, target) && (!opts.force || marker?.createdAt !== stale?.createdAt))
        return;
      if (
        marker &&
        marker.endpoint !== target.endpoint &&
        freshLeaseFor(target.configDir, marker.endpoint, deps.now())
      ) {
        throw new ConfigDirInUseError(target.configDir, marker.endpoint);
      }
      await runBootstrap(target, deps);
    })
  );
}

/** Run one command under the profile's read lock. */
export function runInProfile(
  target: BootstrapTarget,
  runner: AzRunner,
  argv: string[],
  opts: AzRunOptions
): Promise<AzRunResult> {
  return profileLock(target.configDir).read(() => runner.run(argv, opts));
}

/**
 * Run a command; if it fails because the profile is not logged in to the emulator,
 * re-bootstrap once and retry once. A second failure is returned
 * as it is, and the output layer gives the row-1 hint.
 */
export async function runWithSelfHeal(
  target: BootstrapTarget,
  deps: BootstrapDeps,
  argv: string[],
  opts: AzRunOptions
): Promise<AzRunResult> {
  const runner = deps.commandRunner ?? deps.runner;
  const first = await runInProfile(target, runner, argv, opts);
  if (!needsRebootstrap(first) || opts.signal?.aborted) return first;
  await ensureAzureCliConfigured(target, deps, { force: true });
  return runInProfile(target, runner, argv, opts);
}
