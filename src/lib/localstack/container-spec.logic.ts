/**
 * Pure builder for the LocalStack container spec (dockerode `createContainer` options).
 *
 * Replicates what `localstack start` used to assemble via the Python CLI so the MCP
 * server can create the runtime with no CLI installed. Behavioral anchors (verified
 * against the 2026.x `localstack_cli` wheel source):
 *   - image `localstack/localstack-pro:latest` (pro unconditional), `--stack snowflake`
 *     ⇒ `localstack/snowflake:latest`
 *   - container name `localstack-main`, also injected as `MAIN_CONTAINER_NAME` env
 *   - ports 4566, 443 (only when GATEWAY_LISTEN is unset) and the external service
 *     range 4510–4560 inclusive; bind host 127.0.0.1 on a host, 0.0.0.0 in Docker
 *   - volume dir → /var/lib/localstack, docker socket → /var/run/docker.sock
 *   - GATEWAY_LISTEN forwarded host-stripped (`:4566,:443`) — the host part belongs
 *     only in the port bindings, never inside the container
 */

export const DEFAULT_CONTAINER_NAME = "localstack-main";
export const DEFAULT_AWS_IMAGE = "localstack/localstack-pro:latest";
export const DEFAULT_SNOWFLAKE_IMAGE = "localstack/snowflake:latest";
export const DEFAULT_GATEWAY_CONTAINER_PORT = 4566;
export const DEFAULT_HTTPS_GATEWAY_PORT = 443;
export const DEFAULT_SERVICE_PORT_START = 4510;
export const DEFAULT_SERVICE_PORT_END = 4560; // inclusive — 51 ports, CLI parity
export const NAMED_VOLUME_NAME = "localstack-mcp";
const VOLUME_CONTAINER_PATH = "/var/lib/localstack";
const DOCKER_SOCKET_CONTAINER_PATH = "/var/run/docker.sock";

/**
 * Env vars that configure how MCP clients/tools reach LocalStack. They must never
 * leak into the runtime container, where they would corrupt its own URL generation.
 */
const CLIENT_ONLY_ENV_KEYS = new Set([
  "HOSTNAME",
  "LOCALSTACK_HOSTNAME",
  "LOCALSTACK_PORT",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "S3_ENDPOINT",
  "AWS_S3_FORCE_PATH_STYLE",
  "LOCALSTACK_AUTH_TOKEN", // re-added deliberately as a reserved key
  "LOCALSTACK_API_KEY",
  "LOCALSTACK_IMAGE_NAME", // selects the image; not runtime config
  "LOCALSTACK_VOLUME_DIR", // host-side path; meaningless inside the container
]);

/**
 * Unprefixed LocalStack config vars commonly set on hosts that the builder forwards.
 * The CLI forwarded ~250 documented names; anything not listed here still reaches the
 * container via `LOCALSTACK_<NAME>` prefixing, which the runtime aliases natively.
 */
const FORWARDED_CONFIG_ENV_NAMES = new Set([
  "DEBUG",
  "LS_LOG",
  "SERVICES",
  "PERSISTENCE",
  "EAGER_SERVICE_LOADING",
  "ENFORCE_IAM",
  "IAM_SOFT_MODE",
  "EXTENSION_AUTO_INSTALL",
  "APP_INSPECTOR",
  "DNS_ADDRESS",
  "MAIN_DOCKER_NETWORK",
]);
const FORWARDED_CONFIG_ENV_PREFIXES = ["LAMBDA_", "CFN_", "SNOWFLAKE_", "SF_"];

/** Same detector list the localstack CLI uses to tag agent-driven starts. */
const AI_AGENT_DETECTORS: Array<[string, string[]]> = [
  ["cursor", ["CURSOR_TRACE_ID"]],
  ["cursor-cli", ["CURSOR_AGENT"]],
  ["gemini", ["GEMINI_CLI"]],
  ["codex", ["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"]],
  ["cowork", ["CLAUDE_CODE_IS_COWORK"]],
  ["claude-code", ["CLAUDECODE", "CLAUDE_CODE"]],
  ["github-copilot", ["COPILOT_MODEL", "COPILOT_ALLOW_ALL", "COPILOT_GITHUB_TOKEN"]],
  ["goose", ["GOOSE_PROVIDER"]],
  ["augment", ["AUGMENT_AGENT"]],
  ["opencode", ["OPENCODE", "OPENCODE_CALLER", "OPENCODE_CLIENT"]],
  ["antigravity", ["ANTIGRAVITY_AGENT"]],
  ["devin", ["__COG_BASHRC_SOURCED", "__COG_SHELL_INTEGRATION_SCRIPT", "__COG_SKIP_PYENV"]],
  ["replit", ["REPL_ID"]],
];

export type LocalStackStack = "aws" | "snowflake";

export type VolumeResolution =
  | { type: "bind"; source: string }
  | { type: "volume"; name: string };

export interface GatewayListenEntry {
  host: string;
  port: number;
}

export interface ContainerSpecInput {
  stack: LocalStackStack;
  /** Tool-level env overrides (`envVars` argument of localstack-management start). */
  envVars?: Record<string, string>;
  hostEnv: Record<string, string | undefined>;
  authToken: string;
  /** Whether the MCP server itself runs inside a container (changes bind IP + volume). */
  isInDocker: boolean;
  volume: VolumeResolution;
  serverVersion: string;
  /** Overrides for restart-in-place recreation: reuse the original container's identity. */
  imageOverride?: string;
  containerNameOverride?: string;
}

export interface PortBindingEntry {
  containerPort: number;
  hostIp: string;
  hostPort: number;
}

export interface LocalStackContainerSpec {
  name: string;
  Image: string;
  Env: string[];
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: {
    AutoRemove: boolean;
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    Mounts: Array<{ Type: "bind" | "volume"; Source: string; Target: string }>;
    NetworkMode?: string;
  };
}

export function resolveImage(
  stack: LocalStackStack,
  hostEnv: Record<string, string | undefined>
): string {
  if (stack === "snowflake") return DEFAULT_SNOWFLAKE_IMAGE;
  const override = hostEnv.LOCALSTACK_IMAGE_NAME?.trim() || hostEnv.IMAGE_NAME?.trim();
  return override || DEFAULT_AWS_IMAGE;
}

export function resolveContainerName(hostEnv: Record<string, string | undefined>): string {
  return (
    hostEnv.MAIN_CONTAINER_NAME?.trim() ||
    hostEnv.LOCALSTACK_MAIN_CONTAINER_NAME?.trim() ||
    DEFAULT_CONTAINER_NAME
  );
}

/**
 * Parse a GATEWAY_LISTEN value ("[host]:port" entries, comma-separated). Entries
 * without a host get the platform default bind IP.
 */
export function parseGatewayListen(value: string, defaultIp: string): GatewayListenEntry[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      const host = separator > 0 ? entry.slice(0, separator) : "";
      const portText = separator >= 0 ? entry.slice(separator + 1) : entry;
      const port = Number(portText);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid GATEWAY_LISTEN entry "${entry}": port must be 1-65535.`);
      }
      return { host: host || defaultIp, port };
    });
}

export function detectAiAgent(
  hostEnv: Record<string, string | undefined>
): string | undefined {
  for (const [agent, markers] of AI_AGENT_DETECTORS) {
    if (markers.some((marker) => hostEnv[marker])) return agent;
  }
  return undefined;
}

export interface VolumeResolutionInput {
  hostEnv: Record<string, string | undefined>;
  isInDocker: boolean;
  platform: NodeJS.Platform;
  homedir: string;
}

/**
 * Where LocalStack state lives. Host runs default to the exact per-OS directory the
 * localstack CLI used, so existing users' state carries over. Inside Docker the
 * source path must be meaningful to the HOST daemon: an explicit LOCALSTACK_VOLUME_DIR
 * wins; a legacy XDG_CACHE_HOME (identical-path mount from the pre-migration setup)
 * keeps old DooD state; otherwise a named volume avoids host paths entirely.
 */
export function resolveVolume({
  hostEnv,
  isInDocker,
  platform,
  homedir,
}: VolumeResolutionInput): VolumeResolution {
  const explicit = hostEnv.LOCALSTACK_VOLUME_DIR?.trim();
  if (explicit) return { type: "bind", source: normalizeBindPath(explicit) };

  if (isInDocker) {
    const legacyCache = hostEnv.XDG_CACHE_HOME?.trim();
    if (legacyCache) {
      return { type: "bind", source: joinPosix(legacyCache, "localstack", "volume") };
    }
    return { type: "volume", name: NAMED_VOLUME_NAME };
  }

  if (platform === "darwin") {
    return { type: "bind", source: joinPosix(homedir, "Library", "Caches", "localstack", "volume") };
  }
  if (platform === "win32") {
    const localAppData = hostEnv.LOCALAPPDATA?.trim() || `${homedir}\\AppData\\Local`;
    return {
      type: "bind",
      source: normalizeBindPath(`${localAppData}\\cache\\localstack\\volume`),
    };
  }
  const cacheHome = hostEnv.XDG_CACHE_HOME?.trim();
  const cacheBase = cacheHome && cacheHome.startsWith("/") ? cacheHome : joinPosix(homedir, ".cache");
  return { type: "bind", source: joinPosix(cacheBase, "localstack", "volume") };
}

function joinPosix(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** Docker Desktop accepts drive-letter paths with forward slashes; avoids `\` escaping woes. */
function normalizeBindPath(p: string): string {
  return p.replace(/\\/g, "/");
}

interface ResolvedPorts {
  bindings: PortBindingEntry[];
  containerGatewayListen: string;
  servicePortStart: number;
  servicePortEnd: number;
}

function firstDefined(
  keys: string[],
  ...sources: Array<Record<string, string | undefined>>
): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

function resolvePorts(input: ContainerSpecInput): ResolvedPorts {
  const { hostEnv, envVars = {} } = input;
  const defaultIp = input.isInDocker ? "0.0.0.0" : "127.0.0.1";

  const startRaw = firstDefined(
    ["EXTERNAL_SERVICE_PORTS_START", "LOCALSTACK_EXTERNAL_SERVICE_PORTS_START"],
    envVars,
    hostEnv
  );
  const servicePortStart = startRaw ? Number(startRaw) : DEFAULT_SERVICE_PORT_START;
  const endRaw = firstDefined(
    ["EXTERNAL_SERVICE_PORTS_END", "LOCALSTACK_EXTERNAL_SERVICE_PORTS_END"],
    envVars,
    hostEnv
  );
  const servicePortEnd = endRaw ? Number(endRaw) : servicePortStart + 50;
  if (
    !Number.isInteger(servicePortStart) ||
    !Number.isInteger(servicePortEnd) ||
    servicePortEnd < servicePortStart
  ) {
    throw new Error(
      `Invalid EXTERNAL_SERVICE_PORTS range: ${servicePortStart}-${servicePortEnd}.`
    );
  }

  const bindings: PortBindingEntry[] = [];
  let containerGatewayListen: string;

  const gatewayListenRaw = firstDefined(
    ["GATEWAY_LISTEN", "LOCALSTACK_GATEWAY_LISTEN"],
    envVars,
    hostEnv
  );
  if (gatewayListenRaw) {
    // CLI parity: each entry publishes port:port; the container-side env strips
    // hosts equal to the default bind IP (`:4566`) and keeps explicit others.
    const entries = parseGatewayListen(gatewayListenRaw, defaultIp);
    for (const entry of entries) {
      bindings.push({ containerPort: entry.port, hostIp: entry.host, hostPort: entry.port });
    }
    containerGatewayListen = entries
      .map((entry) => `${entry.host === defaultIp ? "" : entry.host}:${entry.port}`)
      .join(",");
  } else {
    // Default: gateway on <LOCALSTACK_PORT||4566> host-side (container always 4566),
    // plus the HTTPS gateway on 443 — the pro CLI adds it only when GATEWAY_LISTEN
    // is unset, and so do we.
    const hostGatewayPort = Number(hostEnv.LOCALSTACK_PORT || DEFAULT_GATEWAY_CONTAINER_PORT);
    bindings.push({
      containerPort: DEFAULT_GATEWAY_CONTAINER_PORT,
      hostIp: defaultIp,
      hostPort: hostGatewayPort,
    });
    bindings.push({
      containerPort: DEFAULT_HTTPS_GATEWAY_PORT,
      hostIp: defaultIp,
      hostPort: DEFAULT_HTTPS_GATEWAY_PORT,
    });
    containerGatewayListen = `:${DEFAULT_GATEWAY_CONTAINER_PORT},:${DEFAULT_HTTPS_GATEWAY_PORT}`;
  }

  // The Engine API has no range syntax — enumerate every service port.
  for (let port = servicePortStart; port <= servicePortEnd; port++) {
    bindings.push({ containerPort: port, hostIp: defaultIp, hostPort: port });
  }

  return { bindings, containerGatewayListen, servicePortStart, servicePortEnd };
}

function buildEnv(input: ContainerSpecInput, ports: ResolvedPorts, name: string): string[] {
  const { hostEnv, envVars = {} } = input;
  const env = new Map<string, string>();

  // (a) curated unprefixed config vars set on the host
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    const forwarded =
      FORWARDED_CONFIG_ENV_NAMES.has(key) ||
      FORWARDED_CONFIG_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (forwarded) env.set(key, value);
  }

  // (b) all LOCALSTACK_* / PROVIDER_OVERRIDE_* host vars minus client-only keys
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined || CLIENT_ONLY_ENV_KEYS.has(key)) continue;
    if (key.startsWith("LOCALSTACK_") || key.startsWith("PROVIDER_OVERRIDE_")) {
      env.set(key, value);
    }
  }

  // (c) explicit tool envVars win over anything host-derived
  for (const [key, value] of Object.entries(envVars)) {
    if (CLIENT_ONLY_ENV_KEYS.has(key) && key !== "LOCALSTACK_AUTH_TOKEN") continue;
    env.set(key, value);
  }

  // (d) reserved keys the launcher owns — always last, always consistent with the
  // published ports and mounts.
  env.set("MAIN_CONTAINER_NAME", name);
  env.set("GATEWAY_LISTEN", ports.containerGatewayListen);
  env.set("EXTERNAL_SERVICE_PORTS_START", String(ports.servicePortStart));
  env.set("EXTERNAL_SERVICE_PORTS_END", String(ports.servicePortEnd));
  env.set("DOCKER_HOST", `unix://${DOCKER_SOCKET_CONTAINER_PATH}`);
  env.set("LOCALSTACK_AUTH_TOKEN", input.authToken);
  env.set("LOCALSTACK_CLIENT_NAME", "localstack-mcp-server");
  env.set("LOCALSTACK_CLIENT_VERSION", input.serverVersion);
  const aiAgent = detectAiAgent(hostEnv);
  if (aiAgent) env.set("AI_AGENT", aiAgent);

  return Array.from(env.entries()).map(([key, value]) => `${key}=${value}`);
}

export function buildLocalStackContainerSpec(input: ContainerSpecInput): LocalStackContainerSpec {
  const name = input.containerNameOverride?.trim() || resolveContainerName(input.hostEnv);
  const image = input.imageOverride?.trim() || resolveImage(input.stack, input.hostEnv);
  const ports = resolvePorts(input);

  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const binding of ports.bindings) {
    const key = `${binding.containerPort}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = portBindings[key] || [];
    portBindings[key].push({ HostIp: binding.hostIp, HostPort: String(binding.hostPort) });
  }

  const mounts: LocalStackContainerSpec["HostConfig"]["Mounts"] = [
    input.volume.type === "bind"
      ? { Type: "bind", Source: input.volume.source, Target: VOLUME_CONTAINER_PATH }
      : { Type: "volume", Source: input.volume.name, Target: VOLUME_CONTAINER_PATH },
    {
      Type: "bind",
      Source: input.hostEnv.DOCKER_SOCK?.trim() || DOCKER_SOCKET_CONTAINER_PATH,
      Target: DOCKER_SOCKET_CONTAINER_PATH,
    },
  ];

  const networkMode =
    input.envVars?.MAIN_DOCKER_NETWORK?.trim() ||
    input.hostEnv.MAIN_DOCKER_NETWORK?.trim() ||
    input.hostEnv.LOCALSTACK_MAIN_DOCKER_NETWORK?.trim();

  return {
    name,
    Image: image,
    Env: buildEnv(input, ports, name),
    ExposedPorts: exposedPorts,
    HostConfig: {
      AutoRemove: true,
      PortBindings: portBindings,
      Mounts: mounts,
      ...(networkMode ? { NetworkMode: networkMode } : {}),
    },
  };
}
