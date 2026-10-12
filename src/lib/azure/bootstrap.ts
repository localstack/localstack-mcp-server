import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import type { AzRunOptions, AzRunResult } from "./runner";

/**
 * The tool's own Azure CLI profile. Four `az` calls point its config dir at the emulator:
 * `cloud register` (or `update`), `cloud set`, `config set` and a dummy `login`. The bootstrap is
 * their only caller; the policy refuses them to the agent. A marker records the endpoint, emulator
 * session and az version the profile was made for; when one changes (a restarted emulator has
 * lost the dummy login), the bootstrap runs again. Concurrent calls in one server share one run.
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

const inFlight = new Map<string, Promise<void>>();

/**
 * Sets the profile up for this target, unless its marker says it already is. Concurrent calls
 * share one run, which stops when the call that started it is cancelled; the others start again.
 */
export async function ensureProfile(
  target: BootstrapTarget,
  run: RunAz,
  signal?: AbortSignal
): Promise<void> {
  mkdirSync(target.configDir, { recursive: true, mode: 0o700 });
  const marker = markerFor(target);
  const key = `${target.configDir}\n${marker}`;
  for (;;) {
    if (readMarker(target.configDir) === marker) return;
    let job = inFlight.get(key);
    if (!job) {
      job = runBootstrap(target, run, marker, signal).finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    try {
      return await job;
    } catch (error) {
      const cancelled = error instanceof BootstrapError && error.result.aborted;
      if (!cancelled || signal?.aborted) throw error;
    }
  }
}

async function runBootstrap(
  target: BootstrapTarget,
  run: RunAz,
  marker: string,
  signal?: AbortSignal
): Promise<void> {
  const opts: AzRunOptions = { timeoutMs: target.timeoutMs, cwd: target.cwd, signal };
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
