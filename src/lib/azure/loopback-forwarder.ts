import net from "net";
import { DockerApiClient } from "../docker/docker.client";

/**
 * The loopback forwarder. Inside the Docker
 * image the emulator is not on the server's 127.0.0.1, yet everything else assumes it
 * is: the health checks, the egress guard (which maps the emulator's names to
 * 127.0.0.1 without DNS) and az's ARM endpoint. So, in Docker only, the server listens
 * on 127.0.0.1 on the emulator's ports and pipes each connection to the real emulator.
 * TLS stays end to end: bytes are relayed, never terminated.
 */

/** The emulator's external service ports when its bindings cannot be read (the server's own spec). */
export const DEFAULT_SERVICE_PORTS = Array.from({ length: 51 }, (_, i) => 4510 + i);

export interface PortMirror {
  /** The port on the server's 127.0.0.1. */
  listen: number;
  /** The port on the target. */
  target: number;
}

export interface Forwarder {
  readonly target: string;
  readonly ports: PortMirror[];
  /** Connections relayed so far; L5 reads it to prove traffic went through. */
  connections(): number;
  failures(): number;
  close(): Promise<void>;
}

/** Relay every connection on 127.0.0.1:<listen> to <target>:<target port>. */
export async function startForwarder(
  target: string,
  mirrors: PortMirror[],
  opts: { listenHost?: string; log?: (line: string) => void } = {}
): Promise<Forwarder> {
  const listenHost = opts.listenHost ?? "127.0.0.1";
  let connections = 0;
  let failures = 0;
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  const listening: PortMirror[] = [];

  for (const mirror of mirrors) {
    const server = net.createServer((client) => {
      connections++;
      sockets.add(client);
      const upstream = net.connect(mirror.target, target);
      sockets.add(upstream);
      const done = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", done);
      client.on("close", done);
      upstream.on("error", () => {
        failures++;
        done();
      });
      upstream.on("close", done);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on("error", (error) =>
      opts.log?.(`forwarder: ${listenHost}:${mirror.listen}: ${error.message}`)
    );
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(mirror.listen, listenHost, () => resolve(true));
    });
    if (ok) {
      servers.push(server);
      listening.push(mirror);
    } else if (mirror === mirrors[0]) {
      // The gateway port is the one that matters; a busy service port is only skipped.
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      throw new Error(`the loopback forwarder could not listen on ${listenHost}:${mirror.listen}`);
    }
  }

  return {
    target,
    ports: listening,
    connections: () => connections,
    failures: () => failures,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    },
  };
}

/** What the forwarder needs to know about the emulator container, from the Docker socket. */
export interface EmulatorContainer {
  /** The container's IPs (a shared network makes one reachable). */
  ipAddresses: string[];
  /** Container port → host port, for the gateway and the service ports. */
  bindings: Array<{ containerPort: number; hostPort: number }>;
}

export interface ForwarderDeps {
  inDocker: boolean;
  /** LOCALSTACK_AZURE_PORT: the port az's endpoint names. */
  port: number;
  /** LOCALSTACK_AZURE_FORWARD_TARGET. */
  forwardTarget?: string;
  /** LOCALSTACK_HOSTNAME: where the documented configuration says the emulator lives. */
  hostname?: string;
  canConnect(host: string, port: number, timeoutMs: number): Promise<boolean>;
  findEmulator(): Promise<EmulatorContainer | undefined>;
  log(line: string): void;
  /** Tests: replaces the real listener, so no fixed port is ever bound. */
  start?: typeof startForwarder;
}

export function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The emulator container through the mounted Docker socket, when there is one. */
async function findEmulatorViaDocker(): Promise<EmulatorContainer | undefined> {
  try {
    const docker = new DockerApiClient();
    const metadata = await docker.inspectContainer(
      await docker.findLocalStackContainer({ stack: "azure" })
    );
    const bindings: EmulatorContainer["bindings"] = [];
    for (const [key, hosts] of Object.entries(metadata.portBindings ?? {})) {
      const containerPort = parseInt(key, 10);
      for (const host of hosts ?? []) {
        const hostPort = parseInt(host.HostPort ?? "", 10);
        if (containerPort && hostPort) bindings.push({ containerPort, hostPort });
      }
    }
    return { ipAddresses: metadata.ipAddresses ?? [], bindings };
  } catch {
    return undefined;
  }
}

export function defaultForwarderDeps(config: {
  inDocker: boolean;
  port: number;
  forwardTarget?: string;
}): ForwarderDeps {
  return {
    inDocker: config.inDocker,
    port: config.port,
    forwardTarget: config.forwardTarget,
    hostname: process.env.LOCALSTACK_HOSTNAME?.trim() || undefined,
    canConnect,
    findEmulator: findEmulatorViaDocker,
    log: (line) => process.stderr.write(`[localstack-azure-client] ${line}\n`),
  };
}

/**
 * The mirrors for one target. For `host.docker.internal` (or an explicit target) the
 * host ports are the targets; for the container's own IP the container ports are.
 */
export function planMirrors(
  port: number,
  emulator: EmulatorContainer | undefined,
  kind: "host" | "container"
): PortMirror[] {
  const gateway = emulator?.bindings.find((b) => b.hostPort === port);
  const mirrors: PortMirror[] = [
    { listen: port, target: kind === "container" ? (gateway?.containerPort ?? 4566) : port },
  ];
  const services = emulator?.bindings.filter(
    (b) => b.containerPort >= 4510 && b.containerPort <= 4560
  );
  const servicePairs = services?.length
    ? services.map((b) => ({
        listen: b.hostPort,
        target: kind === "container" ? b.containerPort : b.hostPort,
      }))
    : DEFAULT_SERVICE_PORTS.map((p) => ({ listen: p, target: p }));
  for (const pair of servicePairs) {
    if (!mirrors.some((m) => m.listen === pair.listen)) mirrors.push(pair);
  }
  return mirrors;
}

let active: Promise<Forwarder | undefined> | undefined;
/** Connections of forwarders already replaced, so the exit line counts every one. */
let retiredConnections = 0;
/** The last forwarder started, read by the synchronous exit hook. */
let latestForwarder: Forwarder | undefined;
let exitHook = false;

/** The running forwarder, if any (tests and the test envelope). */
export async function activeForwarder(): Promise<Forwarder | undefined> {
  return active ? active.catch(() => undefined) : undefined;
}

/** Connections relayed by every forwarder this process started (the exit line). */
export async function totalForwarderConnections(): Promise<number> {
  return retiredConnections + ((await activeForwarder())?.connections() ?? 0);
}

export async function resetLoopbackForwarder(): Promise<void> {
  const forwarder = await activeForwarder();
  await forwarder?.close();
  active = undefined;
  latestForwarder = undefined;
  retiredConnections = 0;
}

/**
 * Start the forwarder in Docker only, and only when 127.0.0.1:<port> does not already
 * answer (for example under `--network host`). Target order:
 * LOCALSTACK_AZURE_FORWARD_TARGET, then host.docker.internal, then the emulator
 * container's IP through the Docker socket (this needs a shared network). When no
 * target answers, nothing listens and the health check reports the emulator as down.
 *
 * Every call checks that a running forwarder's target still answers: a restarted
 * emulator container can come back on another IP, and the old target would then fail
 * every call. A target that stopped answering is closed and looked up again.
 */
export function ensureLoopbackForwarder(deps?: ForwarderDeps): Promise<Forwarder | undefined> {
  if (!deps) {
    // Imported lazily so that a server that never runs an Azure command reads no config.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { azureConfig } = require("./services") as typeof import("./services");
    deps = defaultForwarderDeps(azureConfig());
  }
  const d = deps;
  if (!d.inDocker) return Promise.resolve(undefined);
  // Chained, so concurrent calls check and replace the forwarder one at a time.
  const previous = active;
  active = (async () => {
    const current = previous ? await previous.catch(() => undefined) : undefined;
    if (current) {
      const gateway = current.ports[0];
      if (!gateway || (await d.canConnect(current.target, gateway.target, 1000))) return current;
      d.log(
        `forwarder: ${current.target}:${gateway.target} stopped answering; looking for the emulator again`
      );
      retiredConnections += current.connections();
      if (latestForwarder === current) latestForwarder = undefined;
      await current.close();
    } else if (await d.canConnect("127.0.0.1", d.port, 500)) {
      // Checked only without a forwarder of our own, which would answer here itself.
      return undefined;
    }
    // Undefined when no target answers yet (the emulator may not be up): the next call tries again.
    return startFirstReachable(d);
  })();
  return active;
}

async function startFirstReachable(d: ForwarderDeps): Promise<Forwarder | undefined> {
  const emulator = await d.findEmulator();
  const candidates: Array<{ host: string; kind: "host" | "container"; explicit?: boolean }> = [];
  if (d.forwardTarget) candidates.push({ host: d.forwardTarget, kind: "host", explicit: true });
  // LOCALSTACK_HOSTNAME names where the emulator lives (a container on a shared network):
  // checked like the others, so host.docker.internal keeps its fallback to the container IP.
  if (
    d.hostname &&
    !/^(localhost|127\.0\.0\.1|::1|\[::1\]|host\.docker\.internal)$/i.test(d.hostname)
  ) {
    candidates.push({ host: d.hostname, kind: "host" });
  }
  candidates.push({ host: "host.docker.internal", kind: "host" });
  for (const ip of emulator?.ipAddresses ?? []) candidates.push({ host: ip, kind: "container" });
  for (const candidate of candidates) {
    const mirrors = planMirrors(d.port, emulator, candidate.kind);
    if (!candidate.explicit && !(await d.canConnect(candidate.host, mirrors[0].target, 2000)))
      continue;
    const forwarder = await (d.start ?? startForwarder)(candidate.host, mirrors, { log: d.log });
    d.log(
      `forwarder: 127.0.0.1:${d.port} -> ${candidate.host}:${mirrors[0].target} (${forwarder.ports.length} ports)`
    );
    if (!exitHook) {
      exitHook = true;
      process.on("exit", () => {
        try {
          // Synchronous here: the active forwarder, if any, is the one just started or a replacement.
          const live = latestForwarder?.connections() ?? 0;
          process.stderr.write(`forwarder connections=${retiredConnections + live}\n`);
        } catch {
          // stderr already gone
        }
      });
    }
    latestForwarder = forwarder;
    return forwarder;
  }
  d.log(
    `forwarder: no target answered on port ${d.port} (tried ${candidates.map((c) => c.host).join(", ")})`
  );
  return undefined;
}
