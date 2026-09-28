/**
 * Containment layer 4 (plan task 2.8, Appendix B.7; checks C01 and C08): the loopback
 * proxy that every `az` child reaches the network through, via HTTPS_PROXY/HTTP_PROXY.
 *
 * - It relays only to the emulator: `localhost.localstack.cloud` and every name under it
 *   (the apex too, because the emulator's LRO `Location` headers point there), plus
 *   `localhost`, `127.0.0.1` and `::1`.
 * - It maps those names to 127.0.0.1 itself (::1 for a literal ::1), which is what
 *   LocalStack's public DNS answers anyway. No DNS lookup ever happens, so a hijacked or
 *   blocked answer changes nothing (review F04, Appendix G row 3).
 * - Every other host gets 403 and is recorded under the call that asked for it, found by
 *   the tag in the proxy URL's userinfo. The runner reads those records to fail fast and
 *   to name the blocked host, which az's own error does not do on SDK paths (C01).
 * - A request without a known tag gets 407. Python's requests sends the tag up front, but
 *   .NET children such as Bicep send it only after this challenge (C08). It also keeps
 *   other local processes from using the guard as a relay.
 *
 * The guard runs inside the MCP server's process, so no socket error, throw or rejection
 * may escape into the event loop. C01's first proxy died on one reset after a 403.
 */

import {
  STATUS_CODES,
  createServer,
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, isIPv6, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { EgressEvent, EgressProxy, EgressRecords } from "./types";

/** LocalStack's public zone: every name in it resolves to 127.0.0.1 (C01). */
const EMULATOR_ZONE = "localhost.localstack.cloud";

/**
 * Hosts that az and Bicep call on their own. They are refused like any other host, but
 * they are expected blocks, never the command's failure and never a fail-fast trigger.
 */
export const HOUSEKEEPING_HOSTS: readonly string[] = [
  "azcliprod.blob.core.windows.net", // az's update check (C01)
  "app.aladdin.microsoft.com", // az 2.85's command recommender, until bootstrap turns it off (C01)
  "aka.ms", // Bicep's public-module index, fetched on every build (C08)
  "raw.githubusercontent.com", // the `vm create --image <alias>` list; az falls back to its copy (C08)
  // `functionapp create` without --workspace downloads Application Insights' region map
  // (appservice/_create_util.py get_region_mapping). az catches the failure, warns, and still
  // creates the function app; as a fail-fast trigger it killed a successful create (L4, L2).
  "appinsights.azureedge.net",
];

const PROXY_AUTHENTICATE = 'Basic realm="localstack-azure-mcp"';

/** How long a closing connection may wait for its peer to hang up or to take the last bytes. */
const LINGER_MS = 2000;

/** Tags travel in a URL's userinfo, so they are limited to unreserved URL characters. */
const CALL_ID = /^[A-Za-z0-9._~-]{1,128}$/;

/** A host name as it may appear in a CONNECT authority (IP literals are checked apart). */
const REG_NAME = /^[A-Za-z0-9._-]+$/;

/** Hop-by-hop headers (RFC 9110, section 7.6.1) are never forwarded on the plain-HTTP path. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface EgressProxyOptions {
  /**
   * Opens the TCP connection to an allowed target and returns the socket while it is
   * still connecting, as `net.connect()` does. `host` is always 127.0.0.1 or ::1, never a
   * name, which is how tests prove that no DNS is involved.
   */
  connect?: (port: number, host: string) => Socket;
  /** More names to relay, matched exactly (in any case) and sent to 127.0.0.1 without DNS. */
  extraAllowedHosts?: readonly string[];
  /** Replaces HOUSEKEEPING_HOSTS. */
  housekeepingHosts?: readonly string[];
  /**
   * Diagnostics, one line each: 400, 407 and 500 answers, upstream failures and socket
   * errors. Never wire it to stdout, where the MCP server speaks JSON-RPC.
   */
  log?: (line: string) => void;
}

interface Target {
  /** Canonical: lower case, without brackets or a trailing dot. */
  host: string;
  port: number;
}

interface HttpTarget extends Target {
  /** `host[:port]` of the absolute URI, which becomes the forwarded Host header. */
  authority: string;
  /** Path and query, as sent upstream. */
  path: string;
}

interface CallState {
  refused: Set<string>;
  upstream: Set<string>;
  housekeeping: Set<string>;
  allowed: number;
}

type Listener = (callId: string, event: EgressEvent) => void;

/**
 * The canonical spelling of a host from a CONNECT authority or an absolute URI: lower
 * case, without brackets or a trailing dot, with IP literals in standard form, so that
 * `127.1` or `[0:0:0:0:0:0:0:1]` are recognised for what they are. Undefined for anything
 * that is not a host.
 */
function canonicalHost(raw: string): string | undefined {
  try {
    const bracketed = raw.startsWith("[") && raw.endsWith("]");
    const inner = bracketed ? raw.slice(1, -1) : raw;
    // Older Pythons send an IPv6 CONNECT target without brackets.
    if (isIPv6(inner)) return new URL(`http://[${inner}]/`).hostname.slice(1, -1);
    if (bracketed || !REG_NAME.test(raw)) return undefined;
    return new URL(`http://${raw}/`).hostname.replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** The loopback address the built-in allow-list maps a canonical host to. */
function builtInTarget(host: string): "127.0.0.1" | "::1" | undefined {
  if (host === "::1") return "::1";
  if (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === EMULATOR_ZONE ||
    host.endsWith(`.${EMULATOR_ZONE}`)
  ) {
    return "127.0.0.1";
  }
  return undefined;
}

/**
 * Whether the guard relays `host` (a name or an IP literal, bracketed or not): the
 * built-in list of `localhost.localstack.cloud` and every name under it, `localhost`,
 * `127.0.0.1` and `::1`. Case and a trailing dot do not matter. The policy's URL rule and
 * the endpoint check can share it (plan tasks 2.1 and 2.7).
 */
export function isAllowedEgressHost(host: string): boolean {
  const canonical = canonicalHost(host);
  return canonical !== undefined && builtInTarget(canonical) !== undefined;
}

/** A CONNECT target, `host:port` or `[v6]:port`. */
function parseAuthority(authority: string): Target | undefined {
  const colon = authority.lastIndexOf(":");
  const portText = authority.slice(colon + 1);
  if (colon <= 0 || !/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  const host = canonicalHost(authority.slice(0, colon));
  return host !== undefined && port >= 1 && port <= 65535 ? { host, port } : undefined;
}

/** The target of a plain-HTTP proxy request, which must be an absolute `http://` URI. */
function parseAbsoluteUri(raw: string): HttpTarget | undefined {
  if (!/^http:\/\//i.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = canonicalHost(url.hostname);
  const port = url.port ? Number(url.port) : 80;
  if (host === undefined || port < 1) return undefined;
  return { host, port, authority: url.host, path: `${url.pathname}${url.search}` };
}

/** The call tag of `Proxy-Authorization: Basic base64(<callId>:x)`, when there is one. */
function callTagOf(header: string | undefined): string | undefined {
  const match = /^basic +([A-Za-z0-9+/]+={0,2}) *$/i.exec(header ?? "");
  if (!match) return undefined;
  const credentials = Buffer.from(match[1], "base64").toString("utf8");
  const colon = credentials.indexOf(":");
  return colon === -1 ? credentials : credentials.slice(0, colon);
}

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  // Headers named in `Connection` are hop-by-hop too.
  const named = (headers.connection ?? "").toLowerCase().split(",");
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !named.some((n) => n.trim() === name)) {
      kept[name] = value;
    }
  }
  return kept;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Request targets come from any local process: keep them short and on one line. */
function printable(value: string | undefined): string {
  return JSON.stringify((value ?? "").slice(0, 200));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * Close one end of a tunnel whose other end is gone: flush what is buffered, then
 * destroy. The timer bounds a peer that stops reading.
 */
function endThenDestroy(socket: Duplex): void {
  if (socket.destroyed) return;
  if (socket.writableFinished) {
    socket.destroy();
    return;
  }
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.once("finish", () => socket.destroy());
  if (!socket.writableEnded) socket.end();
}

const defaultConnect = (port: number, host: string): Socket =>
  // Half-open, so a client that shuts down its sending side still gets the whole answer.
  connect({ port, host, allowHalfOpen: true, noDelay: true });

class EgressGuard implements EgressProxy {
  private readonly server: Server;
  private readonly calls = new Map<string, CallState>();
  // Wrapped, so the same function can subscribe twice and unsubscribe once.
  private readonly listeners = new Set<{ listener: Listener }>();
  private readonly sockets = new Set<Duplex>();
  private readonly connectUpstream: (port: number, host: string) => Socket;
  private readonly extraHosts = new Set<string>();
  private readonly housekeeping: ReadonlySet<string>;
  private readonly writeLog?: (line: string) => void;
  private listeningPort = 0;
  private closing?: Promise<void>;

  constructor(options: EgressProxyOptions) {
    this.connectUpstream = options.connect ?? defaultConnect;
    this.writeLog = options.log;
    for (const name of options.extraAllowedHosts ?? []) {
      const host = canonicalHost(name);
      if (host === undefined || isIP(host) !== 0) {
        throw new TypeError(
          `egress guard: extra allowed hosts must be names, got ${printable(name)}`
        );
      }
      this.extraHosts.add(host);
    }
    this.housekeeping = new Set(
      (options.housekeepingHosts ?? HOUSEKEEPING_HOSTS).map((name) => canonicalHost(name) ?? name)
    );

    this.server = createServer();
    this.server.on("connection", (socket) => this.track(socket));
    this.server.on("connect", (req, socket, head) => this.onConnect(req, socket, head));
    this.server.on("request", (req, res) => this.onRequest(req, res));
    this.server.on("clientError", (error, socket) => this.onClientError(error, socket));
    // Accept failures (EMFILE, ...) arrive here; without a listener they would end the process.
    this.server.on("error", (error) => this.log(`server error: ${errorCode(error)}`));
  }

  get port(): number {
    return this.listeningPort;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.listeningPort = (this.server.address() as AddressInfo).port;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
  }

  envFor(callId: string): { HTTPS_PROXY: string; HTTP_PROXY: string } {
    if (!CALL_ID.test(callId)) {
      throw new TypeError(
        `egress guard: a call id must match ${CALL_ID}, got ${printable(callId)}`
      );
    }
    if (!this.calls.has(callId)) {
      this.calls.set(callId, {
        refused: new Set(),
        upstream: new Set(),
        housekeeping: new Set(),
        allowed: 0,
      });
    }
    const url = `http://${callId}:x@127.0.0.1:${this.listeningPort}`;
    return { HTTPS_PROXY: url, HTTP_PROXY: url };
  }

  takeRecords(callId: string): EgressRecords {
    const call = this.calls.get(callId);
    // Forgetting the tag means a straggler of a finished call gets 407, not a relay.
    this.calls.delete(callId);
    return {
      refused: [...(call?.refused ?? [])],
      upstream: [...(call?.upstream ?? [])],
      housekeeping: [...(call?.housekeeping ?? [])],
      allowed: call?.allowed ?? 0,
    };
  }

  onEvent(listener: Listener): () => void {
    const entry = { listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      this.listeners.clear();
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
    });
    return this.closing;
  }

  private onConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // First, before anything can throw: Node hands the raw socket over without an 'error'
    // listener, and a client that resets right after our answer (curl, requests) would
    // take the whole process down with it (C01).
    socket.on("error", (error) => this.log(`client socket error: ${errorCode(error)}`));
    try {
      const target = parseAuthority(req.url ?? "");
      if (target === undefined) {
        this.log(`400 CONNECT ${printable(req.url)}: not host:port`);
        this.reply(socket, 400);
        return;
      }
      const callId = this.callOf(req, `CONNECT ${target.host}:${target.port}`);
      if (callId === undefined) {
        this.reply(socket, 407, "", [`Proxy-Authenticate: ${PROXY_AUTHENTICATE}`]);
        return;
      }
      const address = this.targetFor(target.host);
      if (address === undefined) {
        this.refuse(callId, target.host);
        this.reply(socket, 403, `blocked by egress guard: ${target.host}`);
        return;
      }
      this.tunnel(socket, head, callId, target, address);
    } catch (error) {
      this.log(`500 CONNECT ${printable(req.url)}: ${errorMessage(error)}`);
      this.reply(socket, 500);
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    req.on("error", (error) => this.log(`request error: ${errorCode(error)}`));
    res.on("error", (error) => this.log(`response error: ${errorCode(error)}`));
    try {
      const target = parseAbsoluteUri(req.url ?? "");
      if (target === undefined) {
        this.log(`400 ${req.method} ${printable(req.url)}: not an absolute http:// URI`);
        this.respond(res, 400, "the egress guard only relays absolute http:// URIs");
        return;
      }
      const callId = this.callOf(req, `${req.method} ${target.host}:${target.port}`);
      if (callId === undefined) {
        this.respond(res, 407, "", { "Proxy-Authenticate": PROXY_AUTHENTICATE });
        return;
      }
      const address = this.targetFor(target.host);
      if (address === undefined) {
        this.refuse(callId, target.host);
        this.respond(res, 403, `blocked by egress guard: ${target.host}`);
        return;
      }
      this.forward(req, res, callId, target, address);
    } catch (error) {
      this.log(`500 ${req.method} ${printable(req.url)}: ${errorMessage(error)}`);
      this.respond(res, 500, "");
    }
  }

  private onClientError(error: Error, socket: Duplex): void {
    try {
      const code = errorCode(error);
      this.log(`client error: ${code}`);
      // A parse error gets an answer; after a reset or a timeout nobody is left to read one.
      if (code.startsWith("HPE_") && socket.writable) this.reply(socket, 400);
      else socket.destroy();
    } catch {
      socket.destroy();
    }
  }

  private tunnel(
    client: Duplex,
    head: Buffer,
    callId: string,
    target: Target,
    address: string
  ): void {
    const upstream = this.connectUpstream(target.port, address);
    this.track(upstream);
    let established = false;

    upstream.on("error", (error) => {
      try {
        if (established || client.destroyed) {
          this.log(`tunnel to ${target.host}:${target.port} ended: ${errorCode(error)}`);
          return;
        }
        // Only a failure while the client still waits is the emulator's: a client that
        // left first (the runner killed its call) must not be reported as "emulator down".
        this.log(`502 CONNECT ${target.host}:${target.port}: ${errorCode(error)}`);
        this.record(callId, "upstream", target.host);
        this.reply(client, 502, `upstream error: ${errorCode(error)}`);
      } catch (failure) {
        this.log(`tunnel error handling failed: ${errorMessage(failure)}`);
        client.destroy();
      }
    });
    upstream.once("connect", () => {
      try {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        this.record(callId, "allowed", target.host);
      } catch (error) {
        this.log(`tunnel to ${target.host}:${target.port} failed: ${errorMessage(error)}`);
        client.destroy();
        upstream.destroy();
      }
    });
    // Half-closes travel through the pipes; these handle an end that is gone for good.
    client.once("close", () => (established ? endThenDestroy(upstream) : upstream.destroy()));
    upstream.once("close", () => {
      if (established) endThenDestroy(client);
    });
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    callId: string,
    target: HttpTarget,
    address: string
  ): void {
    // Opened here, not by http.request, so that a throwing factory lands in the caller's
    // catch (a 500) instead of being reported as an upstream failure.
    const socket = this.connectUpstream(target.port, address);
    this.track(socket);
    // The request reports socket errors, but attaches its listener a tick later; this
    // covers a factory whose socket fails before that.
    socket.on("error", () => undefined);
    let answered = false;
    let clientGone = false;

    // RFC 9112, section 3.2.2: a proxy sets Host from the absolute URI.
    const headers = { ...withoutHopByHop(req.headers), host: target.authority };
    let upstream: ClientRequest;
    try {
      upstream = request(
        { method: req.method, path: target.path, headers, createConnection: () => socket },
        (response) => {
          try {
            answered = true;
            response.on("error", (error) =>
              this.log(`upstream response error: ${errorCode(error)}`)
            );
            this.record(callId, "allowed", target.host);
            const status = response.statusCode ?? 502;
            const kept = withoutHopByHop(response.headers);
            if (response.statusMessage) res.writeHead(status, response.statusMessage, kept);
            else res.writeHead(status, kept);
            response.pipe(res);
          } catch (error) {
            this.log(`relaying ${target.host}:${target.port} failed: ${errorMessage(error)}`);
            res.destroy();
          }
        }
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
    upstream.on("error", (error) => {
      try {
        if (clientGone) return;
        if (answered) {
          this.log(
            `upstream ${target.host}:${target.port} failed mid-response: ${errorCode(error)}`
          );
          res.destroy();
          return;
        }
        this.log(`502 ${req.method} ${target.host}:${target.port}: ${errorCode(error)}`);
        this.record(callId, "upstream", target.host);
        this.respond(res, 502, `upstream error: ${errorCode(error)}`);
      } catch (failure) {
        this.log(`upstream error handling failed: ${errorMessage(failure)}`);
        res.destroy();
      }
    });
    res.once("close", () => {
      if (res.writableFinished) return;
      clientGone = true;
      upstream.destroy();
    });
    req.pipe(upstream);
  }

  /** The registered call behind a request, or undefined (and logged) without a known tag. */
  private callOf(req: IncomingMessage, what: string): string | undefined {
    const tag = callTagOf(req.headers["proxy-authorization"]);
    if (tag !== undefined && this.calls.has(tag)) return tag;
    this.log(`407 ${what}: ${tag === undefined ? "no call tag" : "unknown call tag"}`);
    return undefined;
  }

  private targetFor(host: string): string | undefined {
    return builtInTarget(host) ?? (this.extraHosts.has(host) ? "127.0.0.1" : undefined);
  }

  private refuse(callId: string, host: string): void {
    this.record(callId, this.housekeeping.has(host) ? "housekeeping" : "refused", host);
  }

  private record(callId: string, kind: EgressEvent["kind"], host: string): void {
    const call = this.calls.get(callId);
    // Records already taken mean the call has resolved: a late connection counts for nobody.
    if (call === undefined) return;
    if (kind === "allowed") call.allowed += 1;
    else call[kind].add(host);
    const event: EgressEvent = Object.freeze({ kind, host });
    for (const { listener } of [...this.listeners]) {
      try {
        const result: unknown = listener(callId, event);
        if (isThenable(result)) {
          result.then(undefined, (error) =>
            this.log(`event listener failed: ${errorMessage(error)}`)
          );
        }
      } catch (error) {
        this.log(`event listener failed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Answer a raw socket and close it. It keeps reading (and discarding) until the client
   * hangs up, for at most LINGER_MS, so the answer is not lost to the reset that closing
   * with unread input sends.
   */
  private reply(socket: Duplex, status: number, body = "", headers: string[] = []): void {
    try {
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, ...headers];
      if (body) lines.push("Content-Type: text/plain");
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`, "Connection: close");
      socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
      socket.resume();
      const timer = setTimeout(() => socket.destroy(), LINGER_MS);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    } catch (error) {
      this.log(`answering ${status} failed: ${errorMessage(error)}`);
      socket.destroy();
    }
  }

  private respond(
    res: ServerResponse,
    status: number,
    body: string,
    headers: OutgoingHttpHeaders = {}
  ): void {
    try {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        ...headers,
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      });
      res.end(body);
    } catch (error) {
      this.log(`answering ${status} failed: ${errorMessage(error)}`);
      res.destroy();
    }
  }

  private track(socket: Duplex): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private log(line: string): void {
    try {
      this.writeLog?.(`egress guard: ${line}`);
    } catch {
      // A failing logger must not turn a diagnostic into a crash.
    }
  }
}

/**
 * Start the guard on 127.0.0.1 and a port the OS picks. It resolves only once the guard
 * listens: a child started earlier would spend 14 s per call on a proxy that is not there
 * (C01, Appendix G row 18).
 */
export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const guard = new EgressGuard(options);
  await guard.listen();
  return guard;
}
