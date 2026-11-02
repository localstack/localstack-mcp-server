import http from "http";
import net, { type AddressInfo } from "net";
import { startEgressGuard, type EgressGuard } from "./egress-guard";

// Local servers stand in for the emulator: an echo server, one that closes at once, and one that
// counts the connections it gets.
let echo: net.Server;
let closer: net.Server;
let counter: net.Server;
let echoPort: number;
let closerPort: number;
let counterPort: number;
let connections = 0;
let guard: EgressGuard;
const dialled: Array<[number, string]> = [];

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  );
const guardPort = () => Number(new URL(guard.env.HTTPS_PROXY).port);

/** Sends CONNECT through the guard; resolves with its status line and the open socket. */
function connectThrough(authority: string): Promise<{ line: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(guardPort(), "127.0.0.1");
    socket.once("error", reject);
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ line: head.split("\r\n")[0], socket });
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

/** The guard still answers: a tunnel to the echo server opens. */
async function stillServes() {
  const { line, socket } = await connectThrough(`localhost:${echoPort}`);
  socket.destroy();
  return line;
}

beforeAll(async () => {
  echo = net.createServer((socket) => socket.pipe(socket));
  echoPort = await listen(echo);
  // Resets once the tunnel carries data, so the reset always comes after the guard's 200.
  closer = net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy()));
  closerPort = await listen(closer);
  counter = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  counterPort = await listen(counter);
});
afterAll(() => {
  echo.close();
  closer.close();
  counter.close();
});
beforeEach(async () => {
  dialled.length = 0;
  connections = 0;
  guard = await startEgressGuard({
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
  for (const host of ["azure.localhost.localstack.cloud", "LOCALHOST", "127.1"]) {
    const { line, socket } = await connectThrough(`${host}:${echoPort}`);
    expect(line).toBe("HTTP/1.1 200 Connection Established");
    const echoed = new Promise<string>((resolve) => socket.once("data", (d) => resolve(String(d))));
    socket.write("ping");
    expect(await echoed).toBe("ping");
    socket.destroy();
  }
  (await connectThrough(`[::1]:${echoPort}`)).socket.destroy();
  expect(dialled).toEqual([
    [echoPort, "127.0.0.1"],
    [echoPort, "127.0.0.1"],
    [echoPort, "127.0.0.1"],
    [echoPort, "::1"],
  ]);
  expect(guard.refused()).toEqual([]);
});

test("refuses every other host, naming it in the 403, and never dials it", async () => {
  const lines: string[] = [];
  for (const authority of [
    "storage.evil.example:443",
    `10.0.0.5:${echoPort}`,
    "localhost.localstack.cloud.evil.example:443",
    "[2001:db8::1]:443",
  ]) {
    const { line, socket } = await connectThrough(authority);
    lines.push(line);
    socket.destroy();
  }
  // Python puts the reason phrase into its error, so az's own stderr names the host too.
  expect(lines[0]).toBe("HTTP/1.1 403 blocked by the egress guard: storage.evil.example");
  expect(lines.every((line) => line.startsWith("HTTP/1.1 403 "))).toBe(true);
  expect(guard.refused()).toEqual([
    "storage.evil.example",
    "10.0.0.5",
    "localhost.localstack.cloud.evil.example",
    "[2001:db8::1]",
  ]);
  expect(dialled).toEqual([]);
});

test("a target that is not host:port is refused, and nothing is dialled", async () => {
  for (const authority of [
    `localhost:+${echoPort}`,
    `localhost:${echoPort}.0`,
    `localhost:${echoPort}e0`,
    `user@localhost:${echoPort}`,
    `localhost:${echoPort}/path`,
    "no-port-here",
  ]) {
    const { line, socket } = await connectThrough(authority);
    expect([authority, line]).toEqual([authority, "HTTP/1.1 400 Bad Request"]);
    socket.destroy();
  }
  expect(dialled).toEqual([]);
});

test("plain HTTP is never relayed, not even to the emulator: 403 naming the target", async () => {
  expect(await getThrough(`http://localhost:${counterPort}/`)).toEqual({
    status: 403,
    reason: `blocked by the egress guard: http://localhost:${counterPort}`,
  });
  expect((await getThrough("http://evil.example/upload")).status).toBe(403);
  expect((await getThrough("/not-absolute")).status).toBe(400);
  expect(guard.refused()).toEqual([`http://localhost:${counterPort}`, "http://evil.example"]);
  expect(connections).toBe(0);
  expect(dialled).toEqual([]);
});

test("a client that resets mid-tunnel takes the upstream down, and the guard keeps serving", async () => {
  const { line, socket } = await connectThrough(`localhost:${echoPort}`);
  expect(line).toBe("HTTP/1.1 200 Connection Established");
  socket.resetAndDestroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await stillServes()).toBe("HTTP/1.1 200 Connection Established");
});

test("an upstream that resets first ends the client's side of the tunnel", async () => {
  const { line, socket } = await connectThrough(`localhost:${closerPort}`);
  expect(line).toBe("HTTP/1.1 200 Connection Established");
  const ended = new Promise((resolve) => socket.once("end", resolve));
  socket.write("ping");
  await ended;
  socket.destroy();
  expect(await stillServes()).toBe("HTTP/1.1 200 Connection Established");
});

test("close() ends an open tunnel", async () => {
  const { socket } = await connectThrough(`localhost:${echoPort}`);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await guard.close();
  await closed;
});
