import { promises as dns } from "dns";
import https from "https";
import type { AzureConfig } from "./config";

/**
 * Is the LocalStack Azure emulator usable? Its health and info are read over plain HTTP from the
 * gateway every tool uses. The ARM endpoint's HTTPS listener comes up seconds after it, and is
 * checked on the loopback address with the endpoint's name as SNI. That name must also resolve to
 * 127.0.0.1, which some routers' DNS-rebinding protection blocks.
 */

export type EmulatorProblem =
  "not-running" | "wrong-edition" | "license" | "https-not-ready" | "dns";

export interface AzureEmulatorStatus {
  ok: boolean;
  problem?: EmulatorProblem;
  /** The user-facing explanation when `ok` is false. */
  message?: string;
  edition?: string;
  version?: string;
  /** Changes whenever the emulator restarts; the profile is set up again on a change. */
  sessionId?: string;
}

export interface EmulatorDeps {
  /** GET a JSON document over plain HTTP; undefined when nothing answers. */
  getJson(url: string, timeoutMs: number): Promise<unknown | undefined>;
  /** True when an HTTPS server answers at ip:port for `servername`. */
  httpsReady(ip: string, port: number, servername: string, timeoutMs: number): Promise<boolean>;
  lookup(host: string): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const HEALTH_TIMEOUT_MS = 5000;
const HTTPS_READY_WAIT_MS = 10_000;
const HTTPS_RETRY_MS = 500;
const START_ADVICE =
  "Start it with `localstack-management` (action: start, service: azure), then retry. If it runs on another port, set LOCALSTACK_PORT.";

async function getJson(url: string, timeoutMs: number): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json().catch(() => ({}));
  } catch {
    return undefined;
  }
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
        headers: { Host: `${servername}:${port}` },
        agent: false,
        timeout: timeoutMs,
        // Only readiness is checked and nothing is sent; az verifies the certificate on every call.
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

export const defaultEmulatorDeps: EmulatorDeps = {
  getJson,
  httpsReady,
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const isLoopback = (address: string) =>
  /^127\./.test(address) || address === "::1" || /^::ffff:127\./i.test(address);

/** The emulator session whose HTTPS endpoint and DNS name were checked. */
let verifiedSession: string | undefined;

export function resetEmulatorStatusCache(): void {
  verifiedSession = undefined;
}

export async function getAzureEmulatorStatus(
  config: Pick<AzureConfig, "healthBaseUrl" | "endpoint">,
  deps: EmulatorDeps = defaultEmulatorDeps,
  /** `localstack-management` polls on its own, so it asks for a single HTTPS probe. */
  opts: { httpsWaitMs?: number } = {}
): Promise<AzureEmulatorStatus> {
  const base = config.healthBaseUrl;
  const health = (await deps.getJson(`${base}/_localstack/health`, HEALTH_TIMEOUT_MS)) as
    { edition?: unknown; license?: unknown } | undefined;
  if (!health) {
    return {
      ok: false,
      problem: "not-running",
      message: `The LocalStack Azure emulator is not running at ${base}. ${START_ADVICE}`,
    };
  }
  const edition = typeof health.edition === "string" ? health.edition : undefined;
  if (!edition || !/azure/i.test(edition)) {
    return {
      ok: false,
      problem: "wrong-edition",
      edition,
      message: `The emulator at ${base} is not the LocalStack Azure emulator (edition: ${edition ?? "unknown"}). ${START_ADVICE}`,
    };
  }
  if (health.license === false) {
    return {
      ok: false,
      problem: "license",
      edition,
      message: `The LocalStack Azure emulator at ${base} reports no active license. Start it with a LOCALSTACK_AUTH_TOKEN whose license includes LocalStack for Azure.`,
    };
  }

  const info = (await deps.getJson(`${base}/_localstack/info`, HEALTH_TIMEOUT_MS)) as
    { session_id?: unknown; version?: unknown } | undefined;
  const sessionId = typeof info?.session_id === "string" ? info.session_id : undefined;
  const version = typeof info?.version === "string" ? info.version : undefined;
  const fields = { edition, sessionId, version };

  // Once per emulator session: HTTPS comes up a few seconds after plain HTTP.
  if (sessionId && sessionId === verifiedSession) return { ok: true, ...fields };
  const url = new URL(config.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || 443;
  const ip = host === "::1" ? "::1" : "127.0.0.1";
  const waitMs = opts.httpsWaitMs ?? HTTPS_READY_WAIT_MS;
  const deadline = deps.now() + waitMs;
  let ready = await deps.httpsReady(ip, port, host, HEALTH_TIMEOUT_MS);
  while (!ready && deps.now() < deadline) {
    await deps.sleep(HTTPS_RETRY_MS);
    ready = await deps.httpsReady(ip, port, host, HEALTH_TIMEOUT_MS);
  }
  if (!ready) {
    return {
      ok: false,
      problem: "https-not-ready",
      ...fields,
      message: `The LocalStack Azure emulator answers on ${base}, but its HTTPS endpoint ${config.endpoint} did not become ready within ${Math.round(waitMs / 1000)} s. It may still be starting; retry in a few seconds.`,
    };
  }
  // az resolves the endpoint's name itself.
  const addresses = /^[\d.]+$|:/.test(host) ? [host] : await deps.lookup(host).catch(() => []);
  if (!addresses.length || !addresses.every(isLoopback)) {
    return {
      ok: false,
      problem: "dns",
      ...fields,
      message: `${host} ${addresses.length ? `resolved to ${addresses.join(", ")}` : "did not resolve"}, not to 127.0.0.1. It is a public DNS name for 127.0.0.1, which some routers and corporate resolvers block (DNS-rebinding protection): allow localhost.localstack.cloud there, or add \`127.0.0.1 ${host}\` to your hosts file.`,
    };
  }
  if (sessionId) verifiedSession = sessionId;
  return { ok: true, ...fields };
}
