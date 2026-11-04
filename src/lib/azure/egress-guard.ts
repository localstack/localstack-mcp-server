import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isLocalHost } from "./config";

/**
 * The egress guard: a proxy on 127.0.0.1, one per `az` run, set as the run's HTTPS_PROXY and
 * HTTP_PROXY. It opens CONNECT tunnels only to the emulator's names and the loopback ones, and
 * dials 127.0.0.1 (or ::1) itself, so no DNS answer decides where a request goes. Every other
 * tunnel, and every plain-HTTP request, gets a 403 naming the host, and the host is recorded.
 *
 * A command can name any endpoint (`--blob-endpoint`, a connection string), and `az` would send
 * it the file the command reads. This keeps those requests on this machine's emulator.
 * docs/AZURE.md lists what it does not cover. It runs in the MCP server's process, so no socket
 * error may reach the event loop.
 */

export interface EgressGuard {
  /** HTTPS_PROXY and HTTP_PROXY for the `az` child. */
  env: { HTTPS_PROXY: string; HTTP_PROXY: string };
  /** What it refused: the host of a tunnel, or `http://host[:port]` for a plain-HTTP request. */
  refused(): string[];
  close(): Promise<void>;
}

export interface EgressGuardOptions {
  /** Tests: opens the connection to an allowed target; `host` is always 127.0.0.1 or ::1. */
  connect?: (port: number, host: string) => Socket;
}

/** Answers a raw socket and ends it; reading on lets the answer arrive before the close. */
function reply(socket: Duplex, status: string): void {
  try {
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    socket.resume();
  } catch {
    socket.destroy();
  }
}

/** Starts a guard on 127.0.0.1 and a port the OS picks; it is ready when this resolves. */
export async function startEgressGuard(options: EgressGuardOptions = {}): Promise<EgressGuard> {
  const open =
    options.connect ??
    // Half-open, so a client that shuts down its sending side still gets the whole answer.
    ((port: number, host: string) => connect({ port, host, allowHalfOpen: true, noDelay: true }));
  const refused = new Set<string>();
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const tunnel = (req: IncomingMessage, client: Duplex, head: Buffer) => {
    // First: Node hands the raw socket over without an 'error' listener.
    client.on("error", () => undefined);
    try {
      // `host:port` only: no user, path or query, and a port that URL accepts.
      const target = req.url ?? "";
      const url = URL.canParse(`https://${target}`) ? new URL(`https://${target}`) : undefined;
      if (!url || !/:\d+$/.test(target) || url.href !== `${url.origin}/`) {
        return reply(client, "400 Bad Request");
      }
      if (!isLocalHost(url.hostname)) {
        refused.add(url.hostname);
        return reply(client, `403 blocked by the egress guard: ${url.hostname}`);
      }
      const upstream = open(
        Number(url.port || 443),
        url.hostname === "[::1]" ? "::1" : "127.0.0.1"
      );
      track(upstream);
      let established = false;
      upstream.on("error", () => {
        if (!established) reply(client, "502 Bad Gateway");
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
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.end());
    } catch {
      reply(client, "500 Internal Server Error");
    }
  };

  /** Plain HTTP is never relayed: the emulator's endpoints are https. */
  const refusePlainHttp = (req: IncomingMessage, res: ServerResponse) => {
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    try {
      const raw = req.url ?? "";
      const url = /^http:\/\//i.test(raw) && URL.canParse(raw) ? new URL(raw) : undefined;
      if (url) refused.add(`http://${url.host}`);
      const reason = url ? `blocked by the egress guard: http://${url.host}` : "Bad Request";
      res.writeHead(url ? 403 : 400, reason, { "Content-Length": 0, Connection: "close" });
      res.end();
    } catch {
      res.destroy();
    }
  };

  const server = createServer();
  server.on("connection", track);
  server.on("connect", tunnel);
  server.on("request", refusePlainHttp);
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
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
