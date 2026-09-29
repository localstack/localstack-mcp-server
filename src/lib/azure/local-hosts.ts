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

/** The same list as a pattern, for messages and documentation. */
export const LOCAL_HOST =
  /(^|\.)localhost\.localstack\.cloud$|^localhost$|^127\.0\.0\.1$|^\[?::1\]?$/i;
