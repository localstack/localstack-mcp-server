import http from "http";
import net, { type AddressInfo } from "net";
import { startEgressGuard, type EgressGuard } from "./egress-guard";

// A local echo server stands in for the emulator; the guard relays to it on its port only.
let echo: net.Server;
// Answers any HTTP request with a status below 100, which once crashed the plain-HTTP relay.
let weird: net.Server;
let emulatorPort: number;
let weirdPort: number;
let guard: EgressGuard;
const dialled: Array<[number, string]> = [];

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  );
const guardPort = () => Number(new URL(guard.env.HTTPS_PROXY).port);

/** Sends CONNECT through the guard; resolves with its status line and the open socket. */
function connectThrough(
  authority: string
): Promise<{ status: number; line: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(guardPort(), "127.0.0.1");
    socket.once("error", reject);
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const line = head.split("\r\n")[0];
      resolve({ status: Number(line.split(" ")[1]), line, socket });
    };
    socket.on("data", onData);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

/** Sends a plain-HTTP proxy request (absolute URI) through the guard. */
function getThrough(url: string): Promise<{ status: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: guardPort(), path: url }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, reason: res.statusMessage ?? "" })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  echo = net.createServer((socket) => socket.pipe(socket));
  emulatorPort = await listen(echo);
  weird = net.createServer((socket) =>
    socket.once("data", () => socket.end("HTTP/1.1 099 Weird\r\nContent-Length: 0\r\n\r\n"))
  );
  weirdPort = await listen(weird);
});
afterAll(() => {
  echo.close();
  weird.close();
});
beforeEach(async () => {
  dialled.length = 0;
  guard = await startEgressGuard({
    ports: [emulatorPort, weirdPort],
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

test("refuses other hosts, and emulator names on other ports, naming them in the 403", async () => {
  const refused = [
    "storage.evil.example:443",
    "10.0.0.5:" + emulatorPort,
    "localhost.localstack.cloud.evil.example:443",
    "localhost:2375",
  ];
  const lines: string[] = [];
  for (const authority of refused) {
    const { status, line, socket } = await connectThrough(authority);
    expect(status).toBe(403);
    lines.push(line);
    socket.destroy();
  }
  expect(guard.refused()).toEqual([
    "storage.evil.example",
    "10.0.0.5",
    "localhost.localstack.cloud.evil.example",
    "localhost:2375",
  ]);
  // Python puts the reason phrase into its error, so az's own stderr names the host too.
  expect(lines[0]).toBe("HTTP/1.1 403 blocked by the egress guard: storage.evil.example");
  expect(lines[3]).toBe("HTTP/1.1 403 blocked by the egress guard: localhost:2375");
  expect(dialled).toEqual([]);
});

test("odd port spellings and empty labels are not hosts: 400, nothing dialled", async () => {
  for (const authority of [
    `localhost:+${emulatorPort}`,
    `localhost:${emulatorPort}.0`,
    `localhost:${emulatorPort}e0`,
    `localhost..:${emulatorPort}`,
    "no-port-here",
  ]) {
    const { status, socket } = await connectThrough(authority);
    expect([authority, status]).toEqual([authority, 400]);
    socket.destroy();
  }
  expect(dialled).toEqual([]);
});

test("plain HTTP is never relayed, not even to the emulator: 403 naming the target", async () => {
  // The upstream on this allowed port answers 099; relaying it once took the whole server down.
  const local = await getThrough(`http://localhost:${weirdPort}/`);
  expect(local).toEqual({
    status: 403,
    reason: `blocked by the egress guard: http://localhost:${weirdPort}`,
  });
  expect((await getThrough("http://evil.example/upload")).status).toBe(403);
  expect((await getThrough("/not-absolute")).status).toBe(400);
  expect(guard.refused()).toEqual([`http://localhost:${weirdPort}`, "http://evil.example"]);
  expect(dialled).toEqual([]);
  // The guard still serves tunnels afterwards.
  const { status, socket } = await connectThrough(`localhost:${emulatorPort}`);
  expect(status).toBe(200);
  socket.destroy();
});

test("close() ends an open tunnel", async () => {
  const { status, socket } = await connectThrough(`localhost:${emulatorPort}`);
  expect(status).toBe(200);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await guard.close();
  await closed;
});
