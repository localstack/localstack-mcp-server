import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIPv6, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isLocalHost } from "./config";

/**
 * The egress guard: a proxy on 127.0.0.1, one per `az` run, that the run reaches the network
 * through (HTTPS_PROXY and HTTP_PROXY). It opens CONNECT tunnels only to the emulator, that is
 * `localhost.localstack.cloud` and every name under it, `localhost`, 127.0.0.1 and ::1, on the
 * emulator's ports, and it maps those names to loopback itself, so no DNS answer decides where
 * a request goes. Every other tunnel, and every plain-HTTP request (the emulator hands out https
 * endpoints only), gets 403, and its host is recorded for the answer.
 *
 * Why: the agent writes the commands, and a command can name any endpoint (`--blob-endpoint`,
 * a connection string), which `az` calls with the file the command reads and a key from the
 * command. The guard keeps those requests on this machine's emulator. It covers what honours
 * HTTPS_PROXY and HTTP_PROXY: `az`, the Azure SDKs and MSAL (Python requests) and Bicep (.NET).
 * It does not cover programs that open connections of their own, such as the Docker daemon
 * behind `az acr login` or a database client behind `flexible-server connect`.
 *
 * It runs inside the MCP server's process, so no socket error may escape into the event loop.
 */

export interface EgressGuard {
  /** HTTPS_PROXY and HTTP_PROXY for the `az` child. */
  env: { HTTPS_PROXY: string; HTTP_PROXY: string };
  /**
   * What it refused: `host` for a tunnel elsewhere, `host:port` for an emulator name on another
   * port, `http://host[:port]` for a plain-HTTP request.
   */
  refused(): string[];
  close(): Promise<void>;
}

export interface EgressGuardOptions {
  /** The ports an allowed host is relayed to. */
  ports: Iterable<number>;
  /** Tests: opens the connection to an allowed target; `host` is always 127.0.0.1 or ::1. */
  connect?: (port: number, host: string) => Socket;
}

/** How long a closing connection may wait for its peer to hang up or take the last bytes. */
const LINGER_MS = 2000;
/** A host name as it may appear in a CONNECT authority (IP literals are checked apart). */
const REG_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * A host in canonical form (lower case, no brackets or trailing dot, IP literals normalised,
 * so `127.1` is 127.0.0.1), or undefined for anything that is not a host.
 */
function canonicalHost(raw: string): string | undefined {
  try {
    const bracketed = raw.startsWith("[") && raw.endsWith("]");
    const inner = bracketed ? raw.slice(1, -1) : raw;
    // Older Pythons send an IPv6 CONNECT target without brackets.
    if (isIPv6(inner)) return new URL(`http://[${inner}]/`).hostname.slice(1, -1);
    if (bracketed || !REG_NAME.test(raw) || raw.includes("..")) return undefined;
    return new URL(`http://${raw}/`).hostname.replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** A CONNECT target, `host:port` or `[v6]:port`, with the port in plain digits. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const colon = authority.lastIndexOf(":");
  const portText = authority.slice(colon + 1);
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
  const host = colon > 0 ? canonicalHost(authority.slice(0, colon)) : undefined;
  return host && port >= 1 && port <= 65535 ? { host, port } : undefined;
}

/** Closes one end of a tunnel whose other end is gone: flush what is buffered, then destroy. */
function endThenDestroy(socket: Duplex): void {
  if (socket.destroyed) return;
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.once("finish", () => socket.destroy());
  if (!socket.writableEnded) socket.end();
}

const REASONS: Record<number, string> = {
  400: "Bad Request",
  500: "Internal Server Error",
  502: "Bad Gateway",
};
/** The 403 reason phrase names the host: Python puts it into az's own error. */
const blocked = (what: string) =>
  `blocked by the egress guard: ${what.replace(/[^\x21-\x7e]/g, "")}`;

/**
 * Answers a raw socket and closes it, reading (and dropping) what the client still sends for
 * at most LINGER_MS, so that the answer is not lost to the reset unread input would cause.
 */
function reply(socket: Duplex, status: number, reason = REASONS[status] ?? ""): void {
  try {
    if (!socket.writable) return void socket.destroy();
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`
    );
    socket.resume();
    const timer = setTimeout(() => socket.destroy(), LINGER_MS);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
  } catch {
    socket.destroy();
  }
}

/** Starts a guard on 127.0.0.1 and a port the OS picks; it is ready when this resolves. */
export async function startEgressGuard(options: EgressGuardOptions): Promise<EgressGuard> {
  const ports = new Set(options.ports);
  const open =
    options.connect ??
    // Half-open, so a client that shuts down its sending side still gets the whole answer.
    ((port: number, host: string) => connect({ port, host, allowHalfOpen: true, noDelay: true }));
  const refused = new Set<string>();
  const sockets = new Set<Duplex>();
  let closed = false;
  const track = (socket: Duplex) => {
    if (closed) return void socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const tunnel = (req: IncomingMessage, client: Duplex, head: Buffer) => {
    // First: Node hands the raw socket over without an 'error' listener.
    client.on("error", () => undefined);
    try {
      const target = parseAuthority(req.url ?? "");
      if (!target) return reply(client, 400);
      const { host, port } = target;
      const address = host === "::1" ? "::1" : isLocalHost(host) ? "127.0.0.1" : undefined;
      if (!address || !ports.has(port)) {
        const what = address ? `${host}:${port}` : host;
        refused.add(what);
        return reply(client, 403, blocked(what));
      }
      const upstream = open(port, address);
      track(upstream);
      let established = false;
      upstream.on("error", () => {
        if (!established && !client.destroyed) reply(client, 502);
      });
      upstream.once("connect", () => {
        if (client.destroyed) return void upstream.destroy();
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      // Half-closes travel through the pipes; these handle an end that is gone for good.
      client.once("close", () => (established ? endThenDestroy(upstream) : upstream.destroy()));
      upstream.once("close", () => established && endThenDestroy(client));
    } catch {
      reply(client, 500);
    }
  };

  /** Plain HTTP is never relayed: the emulator's endpoints are https. */
  const refusePlainHttp = (req: IncomingMessage, res: ServerResponse) => {
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    try {
      const raw = req.url ?? "";
      const url = /^http:\/\//i.test(raw) && URL.canParse(raw) ? new URL(raw) : undefined;
      const host = url ? canonicalHost(url.hostname) : undefined;
      const what = url && host ? `http://${url.port ? `${host}:${url.port}` : host}` : undefined;
      if (what) refused.add(what);
      const [status, reason] = what ? [403, blocked(what)] : [400, REASONS[400]];
      res.writeHead(status, reason, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(reason),
        Connection: "close",
      });
      res.end(reason);
    } catch {
      res.destroy();
    }
  };

  const server = createServer();
  server.on("connection", track);
  server.on("connect", tunnel);
  server.on("request", refusePlainHttp);
  server.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
    // A parse error gets an answer; after a reset or a timeout nobody is left to read one.
    if (error.code?.startsWith("HPE_") && socket.writable) reply(socket, 400);
    else socket.destroy();
  });
  // Accept failures (EMFILE, ...) arrive here; without a listener they would end the server.
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    env: { HTTPS_PROXY: url, HTTP_PROXY: url },
    refused: () => [...refused],
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
