/**
 * Shared contracts of the Azure client modules.
 * Every module in src/lib/azure/ builds against these types, so they can be
 * implemented and tested independently.
 */

/** Resolved settings of the Azure client tool (built by getAzureConfig). */
export interface AzureConfig {
  /** Gateway port of the Azure emulator (LOCALSTACK_AZURE_PORT, default LOCALSTACK_PORT, 4566). */
  port: number;
  /** Plain-HTTP health base, always IPv4: `http://127.0.0.1:<port>`. */
  healthBaseUrl: string;
  /** ARM endpoint: `https://azure.localhost.localstack.cloud:<port>` unless overridden. */
  endpoint: string;
  /** Host name of `endpoint`, lower-case. */
  endpointHost: string;
  /** Isolated CLI config dir (AZURE_CONFIG_DIR of the child); one per port by default. */
  configDir: string;
  /** Private home of the child: `<configDir>/home`. */
  homeDir: string;
  /** Private temp of the child: `<configDir>/tmp`. */
  tmpDir: string;
  /** Extension dir passed to the child as AZURE_EXTENSION_DIR. */
  extensionDir: string;
  /** Explicit `az` launcher or its Python (LOCALSTACK_AZ_PATH). */
  azPath?: string;
  /** Explicit Bicep binary (LOCALSTACK_AZ_BICEP_PATH). */
  bicepPath?: string;
  /**
   * The server environment variables a `.bicepparam` may read with `readEnvironmentVariable()`
   * (LOCALSTACK_AZ_BICEP_ENV). az's environment is an allow-list, so nothing else ever reaches
   * Bicep; the token and the variables that steer az are refused even when listed.
   */
  bicepEnv: string[];
  /** Per-command timeout in milliseconds (LOCALSTACK_AZ_TIMEOUT_SECONDS x 1000). */
  timeoutMs: number;
  maxOutputChars: number;
  maxHelpChars: number;
  /** Root of the file policy and the runner's cwd (LOCALSTACK_AZ_WORKDIR). */
  workdir: string;
  /** Containment layer 4 on (default) or off (LOCALSTACK_AZ_EGRESS_GUARD=0, debugging only). */
  egressGuard: boolean;
  denylistFile?: string;
  runner: "host" | "worker";
  /** Bytecode cache dir for installs without .pyc (LOCALSTACK_AZ_PYCACHE_DIR; the image sets it). */
  pycacheDir?: string;
  /** Docker only: loopback forwarder target host (LOCALSTACK_AZURE_FORWARD_TARGET). */
  forwardTarget?: string;
  /** Tests only: append the JSON result envelope (LOCALSTACK_AZ_TEST_ENVELOPE=1). */
  testEnvelope: boolean;
  /** The server runs inside a container. */
  inDocker: boolean;
  /** Invalid values that fell back to a default, with the reason. */
  warnings: string[];
  /** Hard configuration errors; the tool refuses to run while any is present. */
  errors: string[];
}

/** How to start `az`. */
export interface AzExecutable {
  /** The executable spawned: the CLI's Python, or a launcher run as-is. */
  file: string;
  /** Arguments before the az argv, e.g. ["-X","utf8","-W","ignore::SyntaxWarning","-IBm","azure.cli"]; [] for a launcher as-is. */
  prefixArgs: string[];
  /** `script`: a bash launcher whose interpreter was parsed but that names no AZ_INSTALLER. */
  installer: "msi" | "pip" | "deb" | "rpm" | "homebrew" | "script" | "launcher-as-is" | "explicit";
  /** Value for the child's AZ_INSTALLER, when known. */
  azInstaller?: "MSI" | "PIP" | "DEB" | "RPM" | "HOMEBREW";
  /** azure-cli-core version from the import probe (or `az version` for a launcher as-is). */
  version?: string;
}

/** Records the egress guard keeps per call. */
export interface EgressRecords {
  /** Non-housekeeping hosts refused. */
  refused: string[];
  /** Allowed hosts whose upstream connection failed (`conn-refused` with the guard on). */
  upstream: string[];
  /** Housekeeping hosts refused (never a failure). */
  housekeeping: string[];
  /** Number of CONNECTs relayed to the emulator for this call. */
  allowed: number;
}

export interface EgressEvent {
  kind: "refused" | "upstream" | "housekeeping" | "allowed";
  host: string;
}

/** Containment layer 4: the CONNECT allow-list proxy. */
export interface EgressProxy {
  /** The loopback port the guard listens on. */
  readonly port: number;
  /** Proxy variables for one call: `http://<callId>:x@127.0.0.1:<port>`. Registers the tag. */
  envFor(callId: string): { HTTPS_PROXY: string; HTTP_PROXY: string };
  /** Records of a call, removed on read. */
  takeRecords(callId: string): EgressRecords;
  /** Subscribe to events of all calls; returns the unsubscribe function. */
  onEvent(listener: (callId: string, event: EgressEvent) => void): () => void;
  close(): Promise<void>;
}

export interface AzRunOptions {
  timeoutMs: number;
  /** Always the workdir. */
  cwd: string;
  signal?: AbortSignal;
  /** Called about every 10 s while `az` runs. */
  onProgress?: (elapsedMs: number) => void;
}

export interface AzRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
  /** From the egress guard (empty with the guard off). */
  egress: EgressRecords;
  /** The spawn itself failed (ENOENT, EINVAL, ENAMETOOLONG, ...). */
  spawnError?: string;
  /** Refused before spawning because the Windows command line would be too long (`too-long`). */
  tooLong?: boolean;
  /** Killed early by the fail-fast rule after a refusal or an upstream failure. */
  failFast?: "refused" | "upstream";
}

export interface AzRunner {
  run(argv: string[], opts: AzRunOptions): Promise<AzRunResult>;
}

/** Outcome of the pure command policy. */
export type PolicyResult =
  | {
      ok: true;
      local?: undefined;
      /** Argv to spawn, without the leading `az`. */
      argv: string[];
      /** User-facing notes, e.g. a URL rewrite. */
      notes: string[];
      isHelp: boolean;
      needsBicep: boolean;
      /** `rewritten` when a management.azure.com URL was rewritten. */
      outcome: "ok" | "rewritten";
    }
  | {
      ok: true;
      /** Answered by the handler from the CLI probe (`version`, `--version`). */
      local: "version";
      argv: string[];
      notes: string[];
      isHelp: false;
      needsBicep: false;
      outcome: "local";
    }
  | {
      ok: false;
      title: string;
      message: string;
      /** Stable id for analytics, e.g. `denied:cloud-set`, `syntax`, `file:outside-workdir`. */
      ruleId: string;
      /** The argv, when tokenizing succeeded (for analytics fields). */
      argv?: string[];
    };

export interface PolicyOptions {
  workdir: string;
  /** The child's private home; `~` paths resolve here. */
  homeDir: string;
  /** Extra denied prefixes from LOCALSTACK_AZ_DENYLIST_FILE (already parsed). */
  extraDenied?: string[][];
  /**
   * Directories the file rule refuses even inside the workdir: the user's real
   * `~/.azure`, `~/.ssh`, `~/.kube`, `~/.docker`, the parent's AZURE_CONFIG_DIR and
   * the tool's own config dir. They matter when the workdir is the user's home or
   * one of its ancestors. A path inside `homeDir` (the private home) stays allowed.
   */
  protectedDirs?: string[];
  platform?: NodeJS.Platform;
  /**
   * The emulator's ports (its gateway, 443 and its service range): a URL for a local host on
   * any other port, such as Docker's API on localhost:2375, is refused. Unset: any port.
   */
  localPorts?: ReadonlySet<number>;
}

/** The class of a failure, as its first line names it. */
export type AzFailureClass =
  | "login"
  | "conn-refused"
  | "dns"
  | "discovery"
  | "not-implemented"
  | "provider"
  | "no-route"
  | "extension"
  | "unknown-command"
  | "argument"
  | "not-found"
  | "cli-error"
  | "emulator-error"
  | "needs-yes"
  | "egress-refused"
  | "too-long"
  | "timeout"
  | "guard-down"
  | "bicep-missing"
  | "bicep-registry"
  | "bicep-env"
  | "azcopy"
  | "cancelled"
  | "spawn-error"
  | "other";

export interface ToolTextResponse {
  content: Array<{ type: "text"; text: string }>;
}
