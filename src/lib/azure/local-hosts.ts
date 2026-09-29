import { isAllowedEgressHost } from "./egress-proxy";

/**
 * The host names `az` may reach. The
 * endpoint override, the policy's URL rule and the egress guard share one check, the
 * guard's own, so they always agree (it also canonicalises case, a trailing dot,
 * brackets and IP spellings such as `127.1`). LocalStack's public DNS answers
 * 127.0.0.1 for the `localhost.localstack.cloud` names, and the guard maps them itself
 * without DNS. The apex matters: the emulator's long-running-operation `Location`
 * headers use it.
 */
export function isLocalHost(host: string): boolean {
  return isAllowedEgressHost(host);
}

/**
 * The ports `az` may reach on those hosts: the emulator's gateway port, 443 (its other default
 * listener, which port-less endpoint URLs use) and its external service range, which Service
 * Bus and Event Hubs endpoints, Cosmos DB's document endpoint and the AKS API server use. The
 * range is EXTERNAL_SERVICE_PORTS_START..END when set, else 4510-4560 as this server publishes
 * it. The policy's URL rule and the egress guard share it.
 */
export function emulatorPorts(
  gatewayPorts: readonly number[],
  env: NodeJS.ProcessEnv = process.env
): ReadonlySet<number> {
  const read = (...names: string[]) => Number(names.map((n) => env[n]?.trim()).find(Boolean));
  const start =
    read("EXTERNAL_SERVICE_PORTS_START", "LOCALSTACK_EXTERNAL_SERVICE_PORTS_START") || 4510;
  const end = read("EXTERNAL_SERVICE_PORTS_END", "LOCALSTACK_EXTERNAL_SERVICE_PORTS_END");
  const last = Math.min(end >= start ? end : start + 50, start + 1000);
  const ports = new Set<number>([...gatewayPorts, 443]);
  for (let port = start; port <= last; port++) ports.add(port);
  return ports;
}

/** The same list as a pattern, for messages and documentation. */
export const LOCAL_HOST =
  /(^|\.)localhost\.localstack\.cloud$|^localhost$|^127\.0\.0\.1$|^\[?::1\]?$/i;
