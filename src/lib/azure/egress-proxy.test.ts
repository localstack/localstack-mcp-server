/**
 * The egress guard.
 *
 * Every server here listens on a loopback port the OS picks. Refused hosts are refused
 * before any connection is attempted, and injected connect factories only ever connect
 * to 127.0.0.1, so nothing leaves the machine.
 */
import dns from "node:dns";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import {
  HOUSEKEEPING_HOSTS,
  isAllowedEgressHost,
  startEgressProxy,
  type EgressProxyOptions,
} from "./egress-proxy";
import type { EgressEvent, EgressProxy, EgressRecords } from "./types";

const LOOPBACK = "127.0.0.1";
const NO_RECORDS: EgressRecords = { refused: [], upstream: [], housekeeping: [], allowed: 0 };

// TLS with a pre-shared key needs no certificate, so the test carries no key material.
const PSK = Buffer.alloc(32, 7);
const PSK_IDENTITY = "u9-client";
const PSK_OPTIONS = { ciphers: "PSK-AES128-GCM-SHA256", maxVersion: "TLSv1.2" as const };

interface Upstream {
  port: number;
  /** Connections accepted so far, in order. */
  accepted: net.Socket[];
  close(): Promise<void>;
}

interface TlsUpstream extends Upstream {
  /** The SNI of every handshake. */
  servernames: string[];
}

interface WebUpstream extends Upstream {
  /** Requests received so far. */
  requests: Array<{ method?: string; url?: string }>;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Bytes after the answer: tunnel data after a 200 to CONNECT. */
  rest: Buffer;
  socket: net.Socket;
}

/** Everything a test opens is closed after it, so Jest sees no open handles. */
const openSockets = new Set<net.Socket>();
const closers: Array<() => Promise<void>> = [];
let nextCall = 0;

let echo: Upstream;
let tlsEcho: TlsUpstream;
let web: WebUpstream;
let guard: EgressProxy;

beforeAll(async () => {
  echo = await startEcho();
  tlsEcho = await startTlsEcho();
  web = await startWeb();
  guard = await startEgressProxy();
});

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  for (const close of closers.splice(0).reverse()) await close();
});

afterAll(async () => {
  await guard.close();
  await Promise.all([echo.close(), tlsEcho.close(), web.close()]);
});

function newCallId(label: string): string {
  nextCall += 1;
  return `u9-${label}-${nextCall}`;
}

async function newGuard(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const created = await startEgressProxy(options);
  closers.push(() => created.close());
  return created;
}

function listen(server: net.Server, host = LOOPBACK): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(server: net.Server, sockets: Iterable<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startEcho(host = LOOPBACK): Promise<Upstream> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  const port = await listen(server, host);
  return { port, accepted, close: () => closeServer(server, accepted) };
}

async function startTlsEcho(): Promise<TlsUpstream> {
  const accepted: net.Socket[] = [];
  const servernames: string[] = [];
  const server = tls.createServer(
    {
      ...PSK_OPTIONS,
      pskCallback: (_socket, identity) => (identity === PSK_IDENTITY ? PSK : null),
    },
    (socket) => {
      servernames.push(String(socket.servername));
      socket.on("error", () => undefined);
      socket.pipe(socket);
    }
  );
  server.on("connection", (socket: net.Socket) => {
    accepted.push(socket);
    socket.on("error", () => undefined);
  });
  server.on("tlsClientError", () => undefined);
  const port = await listen(server);
  return { port, accepted, servernames, close: () => closeServer(server, accepted) };
}

/** Answers every request with a JSON description of what it received. */
async function startWeb(): Promise<WebUpstream> {
  const accepted: net.Socket[] = [];
  const requests: Array<{ method?: string; url?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const answer = JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        proxyAuthorization: req.headers["proxy-authorization"] ?? null,
        body,
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(answer),
        "X-Upstream": "u9",
      });
      res.end(answer);
    });
  });
  server.on("connection", (socket) => accepted.push(socket));
  const port = await listen(server);
  return {
    port,
    accepted,
    requests,
    close: () => {
      server.closeAllConnections();
      return closeServer(server, accepted);
    },
  };
}

/** A loopback port with nothing listening: the OS just handed it out and it was closed. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function basic(tag: string): string {
  return `Basic ${Buffer.from(`${tag}:x`).toString("base64")}`;
}

function connectRequest(authority: string, tag?: string, extraHeaders: string[] = []): string {
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (tag !== undefined) lines.push(`Proxy-Authorization: ${basic(tag)}`);
  return [...lines, ...extraHeaders, "", ""].join("\r\n");
}

/** A plain-HTTP proxy request: the absolute URI in the request line. */
function httpRequest(uri: string, tag?: string, method = "GET", body = ""): string {
  const lines = [`${method} ${uri} HTTP/1.1`, `Host: ${new URL(uri).host}`, "Connection: close"];
  if (tag !== undefined) lines.push(`Proxy-Authorization: ${basic(tag)}`);
  if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return [...lines, "", body].join("\r\n");
}

/** Send raw bytes to `port` and read one answer: its head, and a Content-Length body. */
function exchange(port: number, bytes: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, LOOPBACK);
    openSockets.add(socket);
    let received = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.on("error", fail);
    socket.on("close", () =>
      fail(new Error(`closed before an answer: ${JSON.stringify(received.toString("latin1"))}`))
    );
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      const [statusLine, ...lines] = received.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const length = Number(headers["content-length"] ?? 0);
      const after = received.subarray(end + 4);
      if (after.length < length) return;
      socket.off("data", onData);
      socket.pause();
      settled = true;
      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body: after.subarray(0, length).toString("utf8"),
        rest: after.subarray(length),
        socket,
      });
    };
    socket.on("data", onData);
    socket.write(bytes);
  });
}

/** Open a CONNECT tunnel through `port` and check that it was established. */
async function openTunnel(port: number, authority: string, tag: string): Promise<net.Socket> {
  const reply = await exchange(port, connectRequest(authority, tag));
  expect(reply.status).toBe(200);
  return reply.socket;
}

function readBytes(
  socket: Duplex,
  length: number,
  initial: Buffer = Buffer.alloc(0)
): Promise<string> {
  return new Promise((resolve, reject) => {
    let got: Buffer = initial;
    if (got.length >= length) {
      resolve(got.toString());
      return;
    }
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      if (got.length < length) return;
      socket.off("data", onData);
      socket.pause();
      resolve(got.toString());
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.resume();
  });
}

/** Write `text` into a tunnel that ends at an echo server, and read it back. */
function roundTrip(socket: Duplex, text: string): Promise<string> {
  const echoed = readBytes(socket, Buffer.byteLength(text));
  socket.write(text);
  return echoed;
}

/** Resolves when `socket` has closed, however it ended. */
function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function connectOnce(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, LOOPBACK);
    openSockets.add(socket);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A connect factory that records its arguments and connects to that port on 127.0.0.1. */
function recordingConnect(calls: Array<[number, string]>): EgressProxyOptions["connect"] {
  return (port, host) => {
    calls.push([port, host]);
    return net.connect(port, LOOPBACK);
  };
}

/**
 * Replace the resolver entry points with ones that answer `address`. The tests assert
 * that none of them runs.
 */
function spyOnResolvers(address: string): jest.SpyInstance[] {
  const answer =
    (...result: unknown[]) =>
    (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") process.nextTick(() => callback(null, ...result));
    };
  const lookup = (_host: string, ...args: unknown[]) => {
    const callback = args[args.length - 1];
    const all = args.length > 1 && (args[0] as { all?: boolean } | null)?.all === true;
    if (typeof callback !== "function") return;
    process.nextTick(() =>
      all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)
    );
  };
  return [
    jest.spyOn(dns, "lookup").mockImplementation(lookup as unknown as typeof dns.lookup),
    jest
      .spyOn(dns, "resolve")
      .mockImplementation(answer([address]) as unknown as typeof dns.resolve),
    jest
      .spyOn(dns, "resolve4")
      .mockImplementation(answer([address]) as unknown as typeof dns.resolve4),
    jest.spyOn(dns, "resolve6").mockImplementation(answer([]) as unknown as typeof dns.resolve6),
    jest.spyOn(dns.promises, "lookup").mockResolvedValue({ address, family: 4 }),
    jest.spyOn(dns.promises, "resolve4").mockResolvedValue([address]),
  ];
}

describe("isAllowedEgressHost", () => {
  test.each([
    "localhost.localstack.cloud",
    "azure.localhost.localstack.cloud",
    "acct.blob.core.azure.localhost.localstack.cloud",
    "AZURE.LocalHost.LocalStack.Cloud.",
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
  ])("allows %s", (host) => {
    expect(isAllowedEgressHost(host)).toBe(true);
  });

  test.each([
    "evillocalhost.localstack.cloud",
    "localhost.localstack.cloud.evil.example",
    "localstack.cloud",
    "management.azure.com",
    "127.0.0.2",
    "::2",
    "::ffff:127.0.0.1",
    "[localhost]",
    "host.docker.internal",
    "",
  ])("refuses %j", (host) => {
    expect(isAllowedEgressHost(host)).toBe(false);
  });
});

describe("startEgressProxy, envFor and takeRecords", () => {
  test("the guard listens before it resolves, and envFor tags both proxy variables", async () => {
    await connectOnce(guard.port);
    const id = newCallId("env");
    const url = `http://${id}:x@127.0.0.1:${guard.port}`;
    expect(guard.envFor(id)).toEqual({ HTTPS_PROXY: url, HTTP_PROXY: url });
    // The user part is what requests sends as the Basic tag.
    expect(new URL(url).username).toBe(id);
    expect(guard.envFor(id)).toEqual({ HTTPS_PROXY: url, HTTP_PROXY: url });
  });

  test("envFor refuses call ids that do not fit into a URL's userinfo", () => {
    for (const bad of ["", "a b", "a:b", "a@b", "a/b", "x".repeat(129)]) {
      expect(() => guard.envFor(bad)).toThrow(/call id/);
    }
  });

  test("takeRecords returns a call's records once, and empty records for unknown calls", async () => {
    const id = newCallId("take");
    guard.envFor(id);
    await exchange(guard.port, connectRequest("example.com:443", id));
    expect(guard.takeRecords(id)).toEqual({ ...NO_RECORDS, refused: ["example.com"] });
    expect(guard.takeRecords(id)).toEqual(NO_RECORDS);
    expect(guard.takeRecords("u9-never-registered")).toEqual(NO_RECORDS);
  });

  test("extra allowed hosts must be names", async () => {
    await expect(startEgressProxy({ extraAllowedHosts: ["10.0.0.1"] })).rejects.toThrow(/names/);
    await expect(startEgressProxy({ extraAllowedHosts: ["not a host"] })).rejects.toThrow(/names/);
  });
});

describe("CONNECT", () => {
  test("an allowed CONNECT relays bytes both ways: a TLS handshake and data, SNI intact", async () => {
    const id = newCallId("tls");
    guard.envFor(id);
    const tunnel = await openTunnel(
      guard.port,
      `azure.localhost.localstack.cloud:${tlsEcho.port}`,
      id
    );
    const secure = tls.connect({
      socket: tunnel,
      servername: "azure.localhost.localstack.cloud",
      ...PSK_OPTIONS,
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: PSK, identity: PSK_IDENTITY }),
    });
    openSockets.add(secure);
    await once(secure, "secureConnect");
    expect(await roundTrip(secure, "hello through the tunnel")).toBe("hello through the tunnel");
    expect(tlsEcho.servernames).toContain("azure.localhost.localstack.cloud");
    expect(guard.takeRecords(id)).toEqual({ ...NO_RECORDS, allowed: 1 });
  });

  test("bytes that arrive together with the CONNECT request are relayed first", async () => {
    const id = newCallId("head");
    guard.envFor(id);
    const reply = await exchange(
      guard.port,
      `${connectRequest(`localhost:${echo.port}`, id)}early`
    );
    expect(reply.status).toBe(200);
    expect(await readBytes(reply.socket, "early".length, reply.rest)).toBe("early");
  });

  test("the apex, the names under it and the other local names are relayed", async () => {
    const id = newCallId("names");
    guard.envFor(id);
    const names = [
      "localhost.localstack.cloud", // the LRO polling host
      "azure.localhost.localstack.cloud",
      "acct.blob.core.azure.localhost.localstack.cloud",
      "AZURE.LocalHost.LocalStack.Cloud.",
      "localhost",
      "127.0.0.1",
    ];
    for (const name of names) {
      const tunnel = await openTunnel(guard.port, `${name}:${echo.port}`, id);
      expect(await roundTrip(tunnel, name)).toBe(name);
      tunnel.destroy();
    }
    expect(guard.takeRecords(id)).toEqual({ ...NO_RECORDS, allowed: names.length });
  });

  test("names are mapped to 127.0.0.1 by the guard: no resolver runs, even one answering 203.0.113.5", async () => {
    const connects: Array<[number, string]> = [];
    const local = await newGuard({ connect: recordingConnect(connects) });
    // Only now: Node's listen() itself runs dns.lookup, even for the literal 127.0.0.1
    // (answered locally). What must never resolve is the name in a CONNECT.
    const resolvers = spyOnResolvers("203.0.113.5");
    try {
      const id = newCallId("no-dns");
      local.envFor(id);
      for (const name of [
        "azure.localhost.localstack.cloud",
        "localhost.localstack.cloud",
        "localhost",
      ]) {
        const tunnel = await openTunnel(local.port, `${name}:${echo.port}`, id);
        expect(await roundTrip(tunnel, name)).toBe(name);
        tunnel.destroy();
      }
      expect(connects).toEqual([
        [echo.port, "127.0.0.1"],
        [echo.port, "127.0.0.1"],
        [echo.port, "127.0.0.1"],
      ]);
      for (const resolver of resolvers) expect(resolver).not.toHaveBeenCalled();
    } finally {
      for (const resolver of resolvers) resolver.mockRestore();
    }
  });

  test("the default connection is made to the address, so it needs no lookup either", async () => {
    // Loopback answers, so that not even a regression could reach the network.
    const resolvers = spyOnResolvers(LOOPBACK);
    try {
      const id = newCallId("no-dns-default");
      guard.envFor(id);
      const tunnel = await openTunnel(
        guard.port,
        `azure.localhost.localstack.cloud:${echo.port}`,
        id
      );
      expect(await roundTrip(tunnel, "direct")).toBe("direct");
      const plain = await exchange(
        guard.port,
        httpRequest(`http://localhost.localstack.cloud:${web.port}/`, id)
      );
      expect(plain.status).toBe(200);
      for (const resolver of resolvers) expect(resolver).not.toHaveBeenCalled();
    } finally {
      for (const resolver of resolvers) resolver.mockRestore();
    }
  });

  test("a [::1]:<port> authority is parsed and sent to ::1", async () => {
    const connects: Array<[number, string]> = [];
    const local = await newGuard({ connect: recordingConnect(connects) });
    const id = newCallId("v6");
    local.envFor(id);
    // Bracketed, spelled out, and unbracketed as older Pythons send it.
    const authorities = [
      `[::1]:${echo.port}`,
      `[0:0:0:0:0:0:0:1]:${echo.port}`,
      `::1:${echo.port}`,
    ];
    for (const authority of authorities) {
      const tunnel = await openTunnel(local.port, authority, id);
      expect(await roundTrip(tunnel, authority)).toBe(authority);
      tunnel.destroy();
    }
    const plain = await exchange(local.port, httpRequest(`http://[::1]:${web.port}/v6`, id));
    expect(plain.status).toBe(200);
    expect(connects).toEqual([...authorities.map(() => [echo.port, "::1"]), [web.port, "::1"]]);
    expect(local.takeRecords(id)).toEqual({ ...NO_RECORDS, allowed: 4 });
  });

  test("a literal ::1 is relayed to ::1 for real where the machine has IPv6 loopback", async () => {
    let echo6: Upstream;
    try {
      echo6 = await startEcho("::1");
    } catch {
      // No IPv6 loopback (some CI containers): the injected-connect test covers the mapping.
      return;
    }
    closers.push(() => echo6.close());
    const id = newCallId("v6-real");
    guard.envFor(id);
    const tunnel = await openTunnel(guard.port, `[::1]:${echo6.port}`, id);
    expect(await roundTrip(tunnel, "over IPv6")).toBe("over IPv6");
    expect(echo6.accepted).toHaveLength(1);
  });

  test("a refused host gets 403 and is recorded under the call id from Proxy-Authorization", async () => {
    const a = newCallId("refused-a");
    const b = newCallId("refused-b");
    guard.envFor(a);
    guard.envFor(b);
    const reply = await exchange(guard.port, connectRequest("management.azure.com:443", a));
    expect(reply.status).toBe(403);
    expect(reply.body).toBe("blocked by egress guard: management.azure.com");
    expect(reply.headers).toMatchObject({ connection: "close", "content-type": "text/plain" });
    // Near misses and a repeat; records hold canonical names, each once.
    const more = [
      "Management.Azure.com:443",
      "evillocalhost.localstack.cloud:443",
      "localhost.localstack.cloud.evil.example:443",
      "localstack.cloud:443",
      `127.0.0.2:${echo.port}`,
      "[::2]:443",
    ];
    for (const authority of more) {
      expect((await exchange(guard.port, connectRequest(authority, a))).status).toBe(403);
    }
    expect(guard.takeRecords(a)).toEqual({
      ...NO_RECORDS,
      refused: [
        "management.azure.com",
        "evillocalhost.localstack.cloud",
        "localhost.localstack.cloud.evil.example",
        "localstack.cloud",
        "127.0.0.2",
        "::2",
      ],
    });
    expect(guard.takeRecords(b)).toEqual(NO_RECORDS);
  });

  test("housekeeping hosts are recorded as housekeeping, not refused", async () => {
    expect(HOUSEKEEPING_HOSTS).toEqual([
      "azcliprod.blob.core.windows.net",
      "app.aladdin.microsoft.com",
      "aka.ms",
      "raw.githubusercontent.com",
      "appinsights.azureedge.net",
    ]);
    const id = newCallId("housekeeping");
    guard.envFor(id);
    for (const host of HOUSEKEEPING_HOSTS) {
      const reply = await exchange(guard.port, connectRequest(`${host}:443`, id));
      expect(reply.status).toBe(403);
      expect(reply.body).toBe(`blocked by egress guard: ${host}`);
    }
    expect(guard.takeRecords(id)).toEqual({ ...NO_RECORDS, housekeeping: [...HOUSEKEEPING_HOSTS] });
  });

  test("the housekeeping list can be replaced, and extra names go to 127.0.0.1", async () => {
    const connects: Array<[number, string]> = [];
    const local = await newGuard({
      housekeepingHosts: ["Example.org"],
      extraAllowedHosts: ["emulator.test"],
      connect: recordingConnect(connects),
    });
    const id = newCallId("options");
    local.envFor(id);
    expect((await exchange(local.port, connectRequest("example.org:443", id))).status).toBe(403);
    expect((await exchange(local.port, connectRequest("aka.ms:443", id))).status).toBe(403);
    const tunnel = await openTunnel(local.port, `Emulator.Test:${echo.port}`, id);
    expect(await roundTrip(tunnel, "extra")).toBe("extra");
    expect(connects).toEqual([[echo.port, "127.0.0.1"]]);
    expect(local.takeRecords(id)).toEqual({
      refused: ["aka.ms"],
      upstream: [],
      housekeeping: ["example.org"],
      allowed: 1,
    });
  });

  test("concurrent calls get separate records", async () => {
    const a = newCallId("parallel-a");
    const b = newCallId("parallel-b");
    guard.envFor(a);
    guard.envFor(b);
    const replies = await Promise.all([
      exchange(guard.port, connectRequest("a.example.com:443", a)),
      exchange(guard.port, connectRequest("b.example.com:443", b)),
      exchange(guard.port, connectRequest(`azure.localhost.localstack.cloud:${echo.port}`, a)),
      exchange(guard.port, connectRequest(`localhost.localstack.cloud:${echo.port}`, b)),
      exchange(guard.port, connectRequest("azcliprod.blob.core.windows.net:443", b)),
      exchange(guard.port, httpRequest(`http://localhost:${web.port}/parallel`, a)),
    ]);
    expect(replies.map((reply) => reply.status)).toEqual([403, 403, 200, 200, 403, 200]);
    expect(guard.takeRecords(a)).toEqual({ ...NO_RECORDS, refused: ["a.example.com"], allowed: 2 });
    expect(guard.takeRecords(b)).toEqual({
      refused: ["b.example.com"],
      upstream: [],
      housekeeping: ["azcliprod.blob.core.windows.net"],
      allowed: 1,
    });
  });

  test("a missing or unknown call tag gets 407 and is not relayed; the retry with the tag passes", async () => {
    const connects: Array<[number, string]> = [];
    const local = await newGuard({ connect: recordingConnect(connects) });
    const id = newCallId("challenge");
    local.envFor(id);
    const taken = newCallId("taken");
    local.envFor(taken);
    local.takeRecords(taken);
    const target = `azure.localhost.localstack.cloud:${echo.port}`;
    const acceptedBefore = echo.accepted.length;
    const untagged = [
      connectRequest(target), // what .NET clients such as Bicep send first
      connectRequest(target, "u9-never-registered"),
      connectRequest(target, taken), // a straggler of a call that has resolved
      connectRequest(target, undefined, ["Proxy-Authorization: Bearer abc"]),
      connectRequest(target, undefined, ["Proxy-Authorization: Basic !!!"]),
      httpRequest(`http://localhost:${web.port}/untagged`),
    ];
    for (const request of untagged) {
      const reply = await exchange(local.port, request);
      expect(reply.status).toBe(407);
      expect(reply.headers["proxy-authenticate"]).toBe('Basic realm="localstack-azure-mcp"');
    }
    expect(connects).toEqual([]);
    expect(echo.accepted).toHaveLength(acceptedBefore);
    // The .NET pattern: the same CONNECT again, now with the tag.
    const tunnel = await openTunnel(local.port, target, id);
    expect(await roundTrip(tunnel, "after the challenge")).toBe("after the challenge");
    expect(connects).toEqual([[echo.port, "127.0.0.1"]]);
    expect(local.takeRecords(id)).toEqual({ ...NO_RECORDS, allowed: 1 });
  });

  test("malformed requests get 400 and leave no record", async () => {
    const id = newCallId("malformed");
    guard.envFor(id);
    const malformed = [
      connectRequest("azure.localhost.localstack.cloud", id), // no port
      connectRequest("localhost:0", id),
      connectRequest("localhost:70000", id),
      connectRequest(`[localhost]:${echo.port}`, id),
      connectRequest(`localhost:${echo.port}:1`, id),
      `GET /relative HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: ${basic(id)}\r\n\r\n`,
      httpRequest(`https://localhost:${web.port}/`, id), // https goes through CONNECT only
      "\u0000\u0001 not http at all\r\n\r\n",
    ];
    for (const request of malformed) {
      expect((await exchange(guard.port, request)).status).toBe(400);
    }
    expect(guard.takeRecords(id)).toEqual(NO_RECORDS);
  });

  test("an upstream port that refuses gets 502 and an upstream record", async () => {
    const dead = await closedPort();
    const id = newCallId("upstream");
    guard.envFor(id);
    const tunnel = await exchange(
      guard.port,
      connectRequest(`localhost.localstack.cloud:${dead}`, id)
    );
    expect(tunnel.status).toBe(502);
    expect(tunnel.body).toBe("upstream error: ECONNREFUSED");
    const plain = await exchange(guard.port, httpRequest(`http://localhost:${dead}/`, id));
    expect(plain.status).toBe(502);
    expect(plain.body).toBe("upstream error: ECONNREFUSED");
    expect(guard.takeRecords(id)).toEqual({
      ...NO_RECORDS,
      upstream: ["localhost.localstack.cloud", "localhost"],
    });
  }, 20000);

  test("a connect factory that throws gets 500 and leaves the guard up", async () => {
    const logs: string[] = [];
    const local = await newGuard({
      connect: () => {
        throw new Error("factory exploded");
      },
      log: (line) => logs.push(line),
    });
    const id = newCallId("throwing");
    local.envFor(id);
    expect((await exchange(local.port, connectRequest(`localhost:${echo.port}`, id))).status).toBe(
      500
    );
    expect(
      (await exchange(local.port, httpRequest(`http://localhost:${web.port}/`, id))).status
    ).toBe(500);
    expect((await exchange(local.port, connectRequest("example.com:443", id))).status).toBe(403);
    expect(logs.join("\n")).toMatch(/factory exploded/);
    expect(local.takeRecords(id)).toEqual({ ...NO_RECORDS, refused: ["example.com"] });
  });

  test("a client that resets right after the 403 does not crash the process", async () => {
    const logs: string[] = [];
    const local = await newGuard({ log: (line) => logs.push(line) });
    const id = newCallId("reset");
    local.envFor(id);
    const reply = await exchange(local.port, connectRequest("example.com:443", id));
    expect(reply.status).toBe(403);
    reply.socket.resetAndDestroy();
    // The guard's end saw the reset, so this ran the path that could crash the process ...
    await waitFor(
      () => logs.some((line) => /client socket error: (ECONNRESET|EPIPE)/.test(line)),
      "the reset to reach the guard"
    );
    // ... and the guard still serves.
    expect((await exchange(local.port, connectRequest(`localhost:${echo.port}`, id))).status).toBe(
      200
    );
    expect(local.takeRecords(id)).toEqual({ ...NO_RECORDS, refused: ["example.com"], allowed: 1 });
  });

  test("a reset before the answer is read, or inside a tunnel, is survived too", async () => {
    const local = await newGuard();
    const id = newCallId("reset-more");
    local.envFor(id);
    const early = net.connect(local.port, LOOPBACK);
    openSockets.add(early);
    early.on("error", () => undefined);
    await once(early, "connect");
    const earlyClosed = closed(early);
    early.write(connectRequest("example.com:443", id), () => early.resetAndDestroy());
    await earlyClosed;

    const acceptedBefore = echo.accepted.length;
    const tunnel = await openTunnel(local.port, `localhost:${echo.port}`, id);
    await waitFor(() => echo.accepted.length > acceptedBefore, "the relayed connection");
    const relayedClosed = closed(echo.accepted[acceptedBefore]);
    tunnel.resetAndDestroy();
    // The guard tears down the emulator side as well.
    await relayedClosed;
    expect((await exchange(local.port, connectRequest("example.com:443", id))).status).toBe(403);
  });

  test("a client that hangs up cleanly ends the relayed connection, and the tunnel closes", async () => {
    const id = newCallId("hang-up");
    guard.envFor(id);
    const acceptedBefore = echo.accepted.length;
    const tunnel = await openTunnel(guard.port, `localhost:${echo.port}`, id);
    await waitFor(() => echo.accepted.length > acceptedBefore, "the relayed connection");
    const relayedClosed = closed(echo.accepted[acceptedBefore]);
    const tunnelClosed = closed(tunnel);
    expect(await roundTrip(tunnel, "last words")).toBe("last words");
    tunnel.resume();
    tunnel.end();
    await Promise.all([relayedClosed, tunnelClosed]);
  });
});

describe("plain HTTP", () => {
  test("an absolute URI to an allowed host is relayed with its Host, without the call tag", async () => {
    const id = newCallId("http");
    guard.envFor(id);
    const before = web.requests.length;
    const get = await exchange(
      guard.port,
      httpRequest(`http://LocalHost.LocalStack.Cloud:${web.port}/echo?x=1`, id)
    );
    expect(get.status).toBe(200);
    expect(get.headers["x-upstream"]).toBe("u9");
    expect(JSON.parse(get.body)).toEqual({
      method: "GET",
      url: "/echo?x=1",
      host: `localhost.localstack.cloud:${web.port}`,
      proxyAuthorization: null,
      body: "",
    });
    const post = await exchange(
      guard.port,
      httpRequest(`http://127.0.0.1:${web.port}/upload`, id, "POST", "payload")
    );
    expect(JSON.parse(post.body)).toMatchObject({
      method: "POST",
      url: "/upload",
      body: "payload",
    });
    expect(web.requests).toHaveLength(before + 2);
    expect(guard.takeRecords(id)).toEqual({ ...NO_RECORDS, allowed: 2 });
  });

  test("an absolute URI to any other host gets 403 and a record, and is not relayed", async () => {
    const id = newCallId("http-refused");
    guard.envFor(id);
    const before = web.requests.length;
    const refused = await exchange(guard.port, httpRequest("http://example.com/x", id));
    expect(refused.status).toBe(403);
    expect(refused.body).toBe("blocked by egress guard: example.com");
    expect(refused.headers.connection).toBe("close");
    const housekeeping = await exchange(
      guard.port,
      httpRequest("http://raw.githubusercontent.com/Azure/x", id)
    );
    expect(housekeeping.status).toBe(403);
    expect(web.requests).toHaveLength(before);
    expect(guard.takeRecords(id)).toEqual({
      ...NO_RECORDS,
      refused: ["example.com"],
      housekeeping: ["raw.githubusercontent.com"],
    });
  });
});

describe("events", () => {
  test("each outcome emits one event with its call id, until unsubscribed", async () => {
    const a = newCallId("events-a");
    const b = newCallId("events-b");
    guard.envFor(a);
    guard.envFor(b);
    const events: Array<[string, EgressEvent]> = [];
    const off = guard.onEvent((callId, event) => {
      if (callId === a || callId === b) events.push([callId, { ...event }]);
    });
    const dead = await closedPort();
    await exchange(guard.port, connectRequest("example.com:443", a));
    await exchange(guard.port, connectRequest("aka.ms:443", b));
    await exchange(guard.port, connectRequest(`localhost.localstack.cloud:${dead}`, a));
    await openTunnel(guard.port, `azure.localhost.localstack.cloud:${echo.port}`, b);
    await exchange(guard.port, httpRequest(`http://localhost:${web.port}/events`, a));
    off();
    await exchange(guard.port, connectRequest("example.com:443", a));
    expect(events).toEqual([
      [a, { kind: "refused", host: "example.com" }],
      [b, { kind: "housekeeping", host: "aka.ms" }],
      [a, { kind: "upstream", host: "localhost.localstack.cloud" }],
      [b, { kind: "allowed", host: "azure.localhost.localstack.cloud" }],
      [a, { kind: "allowed", host: "localhost" }],
    ]);
  }, 20000);

  test("a listener that throws or rejects changes nothing for the guard or other listeners", async () => {
    const logs: string[] = [];
    const local = await newGuard({ log: (line) => logs.push(line) });
    local.onEvent(() => {
      throw new Error("listener threw");
    });
    local.onEvent(async () => {
      throw new Error("listener rejected");
    });
    const seen: string[] = [];
    local.onEvent((_callId, event) => seen.push(event.host));
    const id = newCallId("listeners");
    local.envFor(id);
    expect((await exchange(local.port, connectRequest("example.com:443", id))).status).toBe(403);
    // The rejection is handled (and logged), so it never becomes an unhandled one.
    await waitFor(() => logs.some((line) => /listener rejected/.test(line)), "the rejection");
    expect(logs.join("\n")).toMatch(/listener threw/);
    expect(seen).toEqual(["example.com"]);
    expect(local.takeRecords(id)).toEqual({ ...NO_RECORDS, refused: ["example.com"] });
  });
});

describe("close", () => {
  test("close() destroys open tunnels, stops listening and can be called twice", async () => {
    const local = await newGuard();
    const id = newCallId("close");
    local.envFor(id);
    const acceptedBefore = echo.accepted.length;
    const tunnel = await openTunnel(local.port, `localhost:${echo.port}`, id);
    await waitFor(() => echo.accepted.length > acceptedBefore, "the relayed connection");
    const relayedClosed = closed(echo.accepted[acceptedBefore]);
    const tunnelClosed = closed(tunnel);
    tunnel.resume();
    await local.close();
    await Promise.all([relayedClosed, tunnelClosed]);
    await expect(connectOnce(local.port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(local.close()).resolves.toBeUndefined();
    // Records outlive the guard, so a call that resolves after shutdown still gets them.
    expect(local.takeRecords(id)).toEqual({ ...NO_RECORDS, allowed: 1 });
  }, 20000);
});

describe("allowedPorts: only the emulator's ports", () => {
  test("a local host on another port gets 403 and a host:port record; the allowed ports relay", async () => {
    const other = await closedPort();
    const g = await newGuard({ allowedPorts: new Set([echo.port, web.port]) });
    const id = newCallId("ports");
    g.envFor(id);
    const tunnelRefused = await exchange(g.port, connectRequest(`localhost:${other}`, id));
    expect(tunnelRefused.status).toBe(403);
    expect(tunnelRefused.body).toBe(`blocked by egress guard: localhost:${other}`);
    const httpRefused = await exchange(g.port, httpRequest(`http://127.0.0.1:${other}/admin`, id));
    expect(httpRefused.status).toBe(403);
    // The emulator's ports still relay, over CONNECT and plain HTTP.
    const tunnel = await openTunnel(g.port, `localhost.localstack.cloud:${echo.port}`, id);
    expect(await roundTrip(tunnel, "ping")).toBe("ping");
    tunnel.destroy();
    const get = await exchange(g.port, httpRequest(`http://localhost:${web.port}/echo`, id));
    expect(get.status).toBe(200);
    expect(g.takeRecords(id)).toEqual({
      ...NO_RECORDS,
      refused: [`localhost:${other}`, `127.0.0.1:${other}`],
      allowed: 2,
    });
  });
});
