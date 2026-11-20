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
 *
 * Commands that only build a URL or token for the caller, without calling the gateway
 * (`s3 presign`), are the exception: their output is used from the host, so they keep the
 * `LOCALSTACK_HOST` address `awslocal` picks on its own.
 */

export const DEFAULT_CONTAINER_GATEWAY_PORT = 4566;

/**
 * AWS CLI commands that sign a URL or token locally and print it, without a request to the
 * endpoint, so the endpoint they embed must be reachable by whoever uses the output.
 */
const CLIENT_URL_COMMANDS = new Set([
  "s3 presign",
  "rds generate-db-auth-token",
  "eks get-token",
  "dsql generate-db-connect-auth-token",
  "dsql generate-db-connect-admin-auth-token",
]);

/** AWS CLI global options that take a value, so the next argument is not the service. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--profile",
  "--region",
  "--output",
  "--query",
  "--endpoint-url",
  "--ca-bundle",
  "--color",
  "--cli-read-timeout",
  "--cli-connect-timeout",
  "--cli-binary-format",
]);

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
 *
 * This does not reuse `parseGatewayListen` in `container-spec.logic.ts`: that one parses the
 * value the server is given to start a container, and reads a bare entry (`4700`) as a port.
 * This one reads the value a running container already has, so it follows how LocalStack
 * parses each address (`HostAndPort.parse`), where a bare entry is a host on the default port.
 *
 * `GATEWAY_LISTEN=:0` lets LocalStack pick a free port, which the environment does not reveal;
 * it falls back to 4566.
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

/** The service and operation of an AWS CLI argument list, skipping global options. */
export function awsCliCommandName(args: string[]): string {
  const positional: string[] = [];
  for (let i = 0; i < args.length && positional.length < 2; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) i++;
      continue;
    }
    positional.push(arg.toLowerCase());
  }
  return positional.join(" ");
}

/** Whether the command builds a URL or token for the caller instead of calling the gateway. */
export function buildsClientUrl(args: string[]): boolean {
  return CLIENT_URL_COMMANDS.has(awsCliCommandName(args));
}

/**
 * The environment for `awslocal <args>` in the container whose environment is `env`: the
 * container-side gateway, except for commands that build a URL for the caller, which keep
 * `awslocal`'s own `LOCALSTACK_HOST` endpoint.
 */
export function awslocalExecEnv(env: string[] | undefined, args: string[]): string[] {
  if (buildsClientUrl(args)) return [];
  return [`AWS_ENDPOINT_URL=${containerGatewayEndpoint(env)}`];
}
