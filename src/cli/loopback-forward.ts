/**
 * In the Docker image LocalStack runs in a sibling container, but its
 * *.localhost.localstack.cloud names resolve to 127.0.0.1 — this container.
 * Names that `--add-host` cannot cover, such as the per-account Azure storage
 * hosts (<account>.blob.core.azure.localhost.localstack.cloud), would reach
 * nothing. Forwarding the container's loopback gateway port to
 * LOCALSTACK_HOSTNAME sends every such name to LocalStack; TLS passes through
 * untouched, so certificates still match the requested host.
 */
import * as fs from "fs";
import * as net from "net";

export interface ForwardTarget {
  host: string;
  port: number;
}

/** Where to forward, or undefined outside a container or when LocalStack is already local. */
export function loopbackForwardTarget(
  env: NodeJS.ProcessEnv = process.env,
  inContainer: boolean = fs.existsSync("/.dockerenv")
): ForwardTarget | undefined {
  const host = env.LOCALSTACK_HOSTNAME?.trim();
  if (!inContainer || !host || host === "localhost" || host === "127.0.0.1") return undefined;
  const port = Number(env.LOCALSTACK_PORT?.trim() || 4566);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

export function startLoopbackForwarder(
  target: ForwardTarget,
  listenPort: number = target.port
): net.Server {
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.pipe(upstream).pipe(client);
  });
  // Best effort: a taken port (e.g. `--network host`) only means no forwarding.
  server.on("error", () => server.close());
  server.listen(listenPort, "127.0.0.1");
  // The client's stdio decides when the process exits, not this listener.
  server.unref();
  return server;
}

export function forwardLoopbackGateway(): void {
  const target = loopbackForwardTarget();
  if (target) startLoopbackForwarder(target);
}
