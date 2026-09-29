import { promises as dns } from "dns";
import http from "http";
import https from "https";
import net from "net";
import type { AzureConfig } from "./types";

/**
 * Is the LocalStack Azure emulator usable? Health and info are read
 * over plain HTTP on 127.0.0.1, never `localhost`: on Windows `localhost` tries ::1
 * first and costs about 2 s per call when the emulator listens on IPv4 only. The ARM
 * endpoint's HTTPS readiness is checked by connecting to the loopback address with
 * the ARM host as SNI, so no DNS is needed (the egress guard maps those names too).
 * The node `http` modules are used instead of fetch so that no proxy setting of the
 * server's environment can reroute these checks.
 */

export type EmulatorProblem =
  | "not-running"
  | "not-responding"
  | "wrong-edition"
  | "license"
  | "https-not-ready"
  | "dns"
  | "dns-not-loopback";

export interface AzureEmulatorStatus {
  ok: boolean;
  problem?: EmulatorProblem;
  /** The user-facing explanation when `ok` is false. */
  message?: string;
  edition?: string;
  license?: boolean;
  version?: string;
  /** Changes whenever the emulator restarts; the bootstrap re-runs on a change. */
  sessionId?: string;
}

export interface EmulatorDeps {
  /** GET a JSON document over plain HTTP; undefined when nothing answers. */
  getJson(url: string, timeoutMs: number): Promise<unknown | undefined>;
  /** True when an HTTPS server answers at ip:port for `servername`. */
  httpsReady(ip: string, port: number, servername: string, timeoutMs: number): Promise<boolean>;
  /** True when something accepts a TCP connection at host:port. */
  tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean>;
  lookup(host: string): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

type StatusConfig = Pick<
  AzureConfig,
  "port" | "healthBaseUrl" | "endpoint" | "endpointHost" | "egressGuard"
>;

const HEALTH_TIMEOUT_MS = 3000;
/** The second, longer health probe: a busy emulator can miss the first. */
const BUSY_HEALTH_TIMEOUT_MS = 10_000;
const HTTPS_READY_WAIT_MS = 10_000;
const HTTPS_RETRY_MS = 500;

const START_ADVICE =
  "Start it with `localstack-management` (action: start, service: azure), or `lstk start --type azure`, then retry.";

function getJson(url: string, timeoutMs: number): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (c: Buffer) => chunks.push(c));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve({});
        }
      });
      response.on("error", () => resolve(undefined));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(undefined));
  });
}

function httpsReady(
  ip: string,
  port: number,
  servername: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: ip,
        port,
        servername,
        path: "/_localstack/health",
        method: "GET",
        headers: { Host: `${servername}:${port}` },
        agent: false,
        timeout: timeoutMs,
        // Only readiness is checked here and nothing is sent; az verifies the
        // certificate itself on every real call.
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        resolve(true);
      }
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export const defaultEmulatorDeps: EmulatorDeps = {
  getJson,
  httpsReady,
  tcpOpen,
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export function isLoopbackAddress(address: string): boolean {
  return /^127\./.test(address) || address === "::1" || /^::ffff:127\./i.test(address);
}

/** The endpoint's port and the loopback address its host maps to (as the guard does). */
function endpointTarget(config: StatusConfig) {
  const url = new URL(config.endpoint);
  const port = url.port ? Number(url.port) : 443;
  const ip = /^\[?::1\]?$/.test(url.hostname) ? "::1" : "127.0.0.1";
  return { ip, port, servername: config.endpointHost.replace(/^\[|\]$/g, "") };
}

let verifiedSession: string | undefined;

/** Forget which emulator session passed the HTTPS check (tests). */
export function resetEmulatorStatusCache(): void {
  verifiedSession = undefined;
}

export async function getAzureEmulatorStatus(
  config: StatusConfig,
  deps: EmulatorDeps = defaultEmulatorDeps,
  /** `localstack-management` polls on its own, so it asks for a single HTTPS probe. */
  opts: { httpsWaitMs?: number } = {}
): Promise<AzureEmulatorStatus> {
  const httpsWaitMs = opts.httpsWaitMs ?? HTTPS_READY_WAIT_MS;
  const healthUrl = `${config.healthBaseUrl}/_localstack/health`;
  type Health = { edition?: unknown; license?: unknown } | undefined;
  let health = (await deps.getJson(healthUrl, HEALTH_TIMEOUT_MS)) as Health;
  if (!health) {
    // A busy emulator (starting side-cars under load) can miss the short probe: once more,
    // longer. Then an open port that does not answer is busy, not stopped: "not
    // running, start it" sent agents to `start`, which answers "already running".
    health = (await deps.getJson(healthUrl, BUSY_HEALTH_TIMEOUT_MS)) as Health;
  }
  if (!health) {
    const url = new URL(config.healthBaseUrl);
    if (await deps.tcpOpen(url.hostname, Number(url.port || 80), HEALTH_TIMEOUT_MS)) {
      return {
        ok: false,
        problem: "not-responding",
        message: `The LocalStack Azure emulator at ${config.healthBaseUrl} accepts connections but did not answer its health check within ${Math.round((HEALTH_TIMEOUT_MS + BUSY_HEALTH_TIMEOUT_MS) / 1000)} s: it is probably busy (for example starting side-car containers) or still starting. Retry in a few seconds. If it stays like this, check its logs (\`localstack-logs-analysis\`, analysisType: logs) or restart it (\`localstack-management\`, action: restart, service: azure).`,
      };
    }
    return {
      ok: false,
      problem: "not-running",
      message: `The LocalStack Azure emulator is not running at ${config.healthBaseUrl}. ${START_ADVICE} If it runs on another port, set LOCALSTACK_AZURE_PORT.`,
    };
  }
  const edition = typeof health.edition === "string" ? health.edition : undefined;
  const license = typeof health.license === "boolean" ? health.license : undefined;
  if (!edition || !/azure/i.test(edition)) {
    return {
      ok: false,
      problem: "wrong-edition",
      edition,
      message: `The emulator at ${config.healthBaseUrl} is not the LocalStack Azure emulator (edition: ${edition ?? "unknown"}). ${START_ADVICE} If the Azure emulator runs on another port, set LOCALSTACK_AZURE_PORT.`,
    };
  }
  if (license === false) {
    return {
      ok: false,
      problem: "license",
      edition,
      license,
      message: `The LocalStack Azure emulator at ${config.healthBaseUrl} reports no active license (health: license false). Start it with a LOCALSTACK_AUTH_TOKEN whose license includes LocalStack for Azure.`,
    };
  }

  const info = (await deps.getJson(
    `${config.healthBaseUrl}/_localstack/info`,
    HEALTH_TIMEOUT_MS
  )) as { session_id?: unknown; version?: unknown } | undefined;
  const sessionId = typeof info?.session_id === "string" ? info.session_id : undefined;
  const version = typeof info?.version === "string" ? info.version : undefined;

  // HTTPS comes up seconds after plain HTTP, so a fresh emulator gets
  // up to 10 s. A session that passed once is not probed again.
  if (!sessionId || sessionId !== verifiedSession) {
    const target = endpointTarget(config);
    const deadline = deps.now() + httpsWaitMs;
    let ready = await deps.httpsReady(target.ip, target.port, target.servername, HEALTH_TIMEOUT_MS);
    while (!ready && deps.now() < deadline) {
      await deps.sleep(HTTPS_RETRY_MS);
      ready = await deps.httpsReady(target.ip, target.port, target.servername, HEALTH_TIMEOUT_MS);
    }
    if (!ready) {
      return {
        ok: false,
        problem: "https-not-ready",
        edition,
        license,
        sessionId,
        version,
        message: `The LocalStack Azure emulator answers on ${config.healthBaseUrl}, but its HTTPS endpoint ${config.endpoint} did not become ready within ${Math.round(httpsWaitMs / 1000)} s. It may still be starting; retry in a few seconds.`,
      };
    }
    if (sessionId) verifiedSession = sessionId;
  }

  // With the guard on, the guard maps the names itself; only with it off does az
  // depend on public DNS answering 127.0.0.1.
  if (!config.egressGuard) {
    let addresses: string[];
    try {
      addresses = await deps.lookup(config.endpointHost);
    } catch {
      return {
        ok: false,
        problem: "dns",
        edition,
        license,
        sessionId,
        version,
        message: `${config.endpointHost} did not resolve. It is a public DNS name for 127.0.0.1, and some routers and corporate resolvers block such answers (DNS-rebinding protection). Turn the egress guard back on (unset LOCALSTACK_AZ_EGRESS_GUARD; it needs no DNS), allow localhost.localstack.cloud, or add \`127.0.0.1 ${config.endpointHost}\` to your hosts file.`,
      };
    }
    if (!addresses.length || !addresses.every(isLoopbackAddress)) {
      return {
        ok: false,
        problem: "dns-not-loopback",
        edition,
        license,
        sessionId,
        version,
        message: `${config.endpointHost} resolved to ${addresses.join(", ") || "nothing"}, not to 127.0.0.1. With the egress guard off, az would send its requests there. Turn the guard back on (unset LOCALSTACK_AZ_EGRESS_GUARD), or fix the name in your hosts file.`,
      };
    }
  }

  return { ok: true, edition, license, sessionId, version };
}
