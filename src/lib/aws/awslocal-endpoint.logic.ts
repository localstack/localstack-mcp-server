/**
 * Where `awslocal` must send requests when it runs inside the LocalStack container.
 *
 * `awslocal` builds its endpoint from `LOCALSTACK_HOST` unless `AWS_ENDPOINT_URL` is set.
 * `LOCALSTACK_HOST` names the gateway as the host sees it (for example
 * `localhost.localstack.cloud:4700` when the gateway is published on host port 4700), and
 * that port is not open inside the container. The gateway listens inside the container on
 * the first `GATEWAY_LISTEN` address, port 4566 by default, so `awslocal` gets that address
 * as `AWS_ENDPOINT_URL` for its own process only. The container's `LOCALSTACK_HOST` stays as
 * it is, so the URLs LocalStack returns (SQS queue URLs) still name the host-side address.
 */

export const DEFAULT_CONTAINER_GATEWAY_PORT = 4566;

/** The value of `key` in a container's `KEY=value` environment list, or undefined. */
export function containerEnvValue(env: string[] | undefined, key: string): string | undefined {
  const prefix = `${key}=`;
  const entry = (env ?? []).find((item) => item.startsWith(prefix));
  return entry === undefined ? undefined : entry.slice(prefix.length);
}

/**
 * The port of the first `GATEWAY_LISTEN` entry, read the way LocalStack reads it: `[ipv6]:port`,
 * `host:port`, `:port`, or a host alone, which keeps the default port. The container entrypoint
 * exports `LOCALSTACK_GATEWAY_LISTEN` as `GATEWAY_LISTEN`, so the prefixed name wins. An unset,
 * empty or unreadable value means the default port.
 */
export function containerGatewayPort(env: string[] | undefined): number {
  const raw =
    containerEnvValue(env, "LOCALSTACK_GATEWAY_LISTEN") ?? containerEnvValue(env, "GATEWAY_LISTEN");
  const first = raw?.split(",")[0]?.trim();
  if (!first) return DEFAULT_CONTAINER_GATEWAY_PORT;

  let portText: string | undefined;
  if (first.startsWith("[")) {
    portText = /^\[[^\]]+\](?::(\d+))?$/.exec(first)?.[1];
  } else if (first.includes(":")) {
    portText = first.slice(first.indexOf(":") + 1);
  }
  if (portText === undefined) return DEFAULT_CONTAINER_GATEWAY_PORT;

  const port = Number(portText);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONTAINER_GATEWAY_PORT;
}

/** The gateway as a process inside the container reaches it. */
export function containerGatewayEndpoint(env: string[] | undefined): string {
  return `http://localhost:${containerGatewayPort(env)}`;
}

/** The environment for an `awslocal` exec in the container whose environment is `env`. */
export function awslocalExecEnv(env: string[] | undefined): string[] {
  return [`AWS_ENDPOINT_URL=${containerGatewayEndpoint(env)}`];
}
