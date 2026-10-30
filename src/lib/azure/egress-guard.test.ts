import http from "http";
import net, { type AddressInfo } from "net";
import { startEgressGuard, type EgressGuard } from "./egress-guard";

// A local echo server stands in for the emulator; the guard relays to it on its port only.
let echo: net.Server;
let origin: http.Server;
let emulatorPort: number;
let httpPort: number;
let guard: EgressGuard;
const dialled: Array<[number, string]> = [];

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  );
const guardPort = () => Number(new URL(guard.env.HTTPS_PROXY).port);

/** Sends CONNECT through the guard; resolves with its status and the open socket. */
function connectThrough(authority: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(guardPort(), "127.0.0.1");
    socket.once("error", reject);
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ status: Number(head.split(" ")[1]), socket });
    };
    socket.on("data", onData);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

/** Sends a plain-HTTP proxy request (absolute URI) through the guard. */
function getThrough(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: guardPort(), path: url }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  echo = net.createServer((socket) => socket.pipe(socket));
  emulatorPort = await listen(echo);
  origin = http.createServer((req, res) => res.end(`host=${req.headers.host} path=${req.url}`));
  httpPort = await listen(origin);
});
afterAll(() => {
  echo.close();
  origin.close();
});
beforeEach(async () => {
  dialled.length = 0;
  guard = await startEgressGuard({
    ports: [emulatorPort, httpPort],
    connect: (port, host) => {
      dialled.push([port, host]);
      return net.connect({ port, host, allowHalfOpen: true });
    },
  });
});
afterEach(() => guard.close());

test("points az's HTTPS_PROXY and HTTP_PROXY at itself", () => {
  expect(guard.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(guard.env.HTTP_PROXY).toBe(guard.env.HTTPS_PROXY);
});

test("tunnels to the emulator's names on loopback, without DNS", async () => {
  for (const host of ["azure.localhost.localstack.cloud", "LOCALHOST", "127.1", "[::1]"]) {
    const { status, socket } = await connectThrough(`${host}:${emulatorPort}`);
    if (host === "[::1]") {
      // Relayed to ::1, where the echo server does not listen: the relay was attempted.
      expect([200, 502]).toContain(status);
      socket.destroy();
      continue;
    }
    expect(status).toBe(200);
    const echoed = new Promise<string>((resolve) => socket.once("data", (d) => resolve(String(d))));
    socket.write("ping");
    expect(await echoed).toBe("ping");
    socket.destroy();
  }
  expect(dialled.map(([, host]) => host)).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1", "::1"]);
  expect(guard.refused()).toEqual([]);
});

test("refuses other hosts, and emulator names on other ports, and records them", async () => {
  const refused = [
    "storage.evil.example:443",
    "10.0.0.5:" + emulatorPort,
    "localhost.localstack.cloud.evil.example:443",
    "localhost:2375",
  ];
  for (const authority of refused) {
    const { status, socket } = await connectThrough(authority);
    expect(status).toBe(403);
    socket.destroy();
  }
  expect(guard.refused()).toEqual([
    "storage.evil.example",
    "10.0.0.5",
    "localhost.localstack.cloud.evil.example",
    "localhost:2375",
  ]);
  expect(dialled).toEqual([]);
});

test("plain HTTP: forwards an absolute URI to an emulator name, refuses anything else", async () => {
  const ok = await getThrough(`http://acct.blob.localhost.localstack.cloud:${httpPort}/c/b?x=1`);
  expect(ok).toEqual({
    status: 200,
    body: `host=acct.blob.localhost.localstack.cloud:${httpPort} path=/c/b?x=1`,
  });
  expect((await getThrough("http://evil.example/upload")).status).toBe(403);
  expect((await getThrough("/not-absolute")).status).toBe(400);
  expect(guard.refused()).toEqual(["evil.example"]);
});

test("a malformed CONNECT gets 400; close() ends an open tunnel", async () => {
  expect((await connectThrough("no-port-here")).status).toBe(400);
  const { status, socket } = await connectThrough(`localhost:${emulatorPort}`);
  expect(status).toBe(200);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await guard.close();
  await closed;
});
