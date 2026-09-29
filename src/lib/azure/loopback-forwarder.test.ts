import net from "net";
import {
  DEFAULT_SERVICE_PORTS,
  ensureLoopbackForwarder,
  planMirrors,
  resetLoopbackForwarder,
  startForwarder,
  totalForwarderConnections,
  type Forwarder,
  type ForwarderDeps,
} from "./loopback-forwarder";

// Ephemeral ports only: binding 127.0.0.1:4566 or 4510-4560 on a developer
// machine would collide with a running emulator's published ports.

async function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) =>
      socket.write(Buffer.concat([Buffer.from("echo:"), chunk]))
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (d) => {
      received += d.toString();
      if (received.length >= payload.length + 5) {
        socket.end();
        resolve(received);
      }
    });
    socket.on("error", reject);
    socket.write(payload);
  });
}

describe("startForwarder", () => {
  test("pipes bytes both ways, for several concurrent connections, and counts them", async () => {
    const upstream = await echoServer();
    const listen = await freePort();
    const forwarder = await startForwarder("127.0.0.1", [{ listen, target: upstream.port }]);
    try {
      const answers = await Promise.all(
        ["a", "bb", "ccc", "dddd", "✓✓"].map((p) => roundTrip(listen, p))
      );
      expect(answers).toEqual(["echo:a", "echo:bb", "echo:ccc", "echo:dddd", "echo:✓✓"]);
      expect(forwarder.connections()).toBe(5);
      expect(forwarder.failures()).toBe(0);
    } finally {
      await forwarder.close();
      await upstream.close();
    }
  });

  test("closes cleanly: the port is free again and new connections are refused", async () => {
    const upstream = await echoServer();
    const listen = await freePort();
    const forwarder = await startForwarder("127.0.0.1", [{ listen, target: upstream.port }]);
    await roundTrip(listen, "x");
    await forwarder.close();
    await expect(roundTrip(listen, "x")).rejects.toThrow();
    await upstream.close();
  });

  test("an unreachable target counts a failure and closes the client", async () => {
    const dead = await freePort();
    const listen = await freePort();
    const forwarder = await startForwarder("127.0.0.1", [{ listen, target: dead }]);
    try {
      await new Promise<void>((resolve) => {
        const socket = net.connect(listen, "127.0.0.1");
        socket.on("close", () => resolve());
        socket.on("error", () => undefined);
      });
      expect(forwarder.failures()).toBe(1);
    } finally {
      await forwarder.close();
    }
  });

  test("a busy service port is skipped; a busy gateway port is an error", async () => {
    const upstream = await echoServer();
    const gateway = await freePort();
    // The upstream's own port is taken on 127.0.0.1: listening there must fail.
    const forwarder = await startForwarder("127.0.0.1", [
      { listen: gateway, target: upstream.port },
      { listen: upstream.port, target: upstream.port },
    ]);
    expect(forwarder.ports).toEqual([{ listen: gateway, target: upstream.port }]);
    await forwarder.close();
    await expect(
      startForwarder("127.0.0.1", [{ listen: upstream.port, target: 1 }])
    ).rejects.toThrow(/could not listen/);
    await upstream.close();
  });
});

describe("planMirrors", () => {
  const lstk = {
    ipAddresses: ["172.18.0.5"],
    bindings: [
      { containerPort: 4566, hostPort: 4566 },
      { containerPort: 4510, hostPort: 4510 },
      { containerPort: 4559, hostPort: 4559 },
    ],
  };

  test("the port list comes from PortBindings", () => {
    expect(planMirrors(4566, lstk, "host")).toEqual([
      { listen: 4566, target: 4566 },
      { listen: 4510, target: 4510 },
      { listen: 4559, target: 4559 },
    ]);
  });

  test("a port-shifted emulator: host targets use host ports, the container IP its container ports", () => {
    const shifted = {
      ipAddresses: ["172.18.0.9"],
      bindings: [
        { containerPort: 4566, hostPort: 4666 },
        { containerPort: 4510, hostPort: 4610 },
      ],
    };
    expect(planMirrors(4666, shifted, "host")).toEqual([
      { listen: 4666, target: 4666 },
      { listen: 4610, target: 4610 },
    ]);
    expect(planMirrors(4666, shifted, "container")).toEqual([
      { listen: 4666, target: 4566 },
      { listen: 4610, target: 4510 },
    ]);
  });

  test("without a container, the default range 4510-4560", () => {
    const mirrors = planMirrors(4566, undefined, "host");
    expect(mirrors[0]).toEqual({ listen: 4566, target: 4566 });
    expect(mirrors.slice(1).map((m) => m.listen)).toEqual(DEFAULT_SERVICE_PORTS);
    expect(DEFAULT_SERVICE_PORTS[0]).toBe(4510);
    expect(DEFAULT_SERVICE_PORTS[DEFAULT_SERVICE_PORTS.length - 1]).toBe(4560);
  });
});

describe("ensureLoopbackForwarder (mocked Docker socket, no real listener)", () => {
  afterEach(() => resetLoopbackForwarder());

  const fakeForwarder = (target: string): Forwarder => ({
    target,
    ports: [],
    connections: () => 0,
    failures: () => 0,
    close: async () => undefined,
  });

  function deps(over: Partial<ForwarderDeps> = {}) {
    const start = jest.fn(async (target: string) => fakeForwarder(target));
    const d: ForwarderDeps = {
      inDocker: true,
      port: 4566,
      canConnect: jest.fn(async () => false),
      findEmulator: jest.fn(async () => ({
        ipAddresses: ["172.18.0.5"],
        bindings: [{ containerPort: 4566, hostPort: 4566 }],
      })),
      log: jest.fn(),
      start: start as unknown as ForwarderDeps["start"],
      ...over,
    };
    return { d, start };
  }

  test("never listens outside Docker", async () => {
    const { d, start } = deps({ inDocker: false });
    expect(await ensureLoopbackForwarder(d)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(d.canConnect).not.toHaveBeenCalled();
  });

  test("is skipped when 127.0.0.1:<port> already answers (--network host)", async () => {
    const { d, start } = deps({
      canConnect: jest.fn(async (host: string) => host === "127.0.0.1"),
    });
    expect(await ensureLoopbackForwarder(d)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  test("LOCALSTACK_AZURE_FORWARD_TARGET comes first, and is used without a probe", async () => {
    const { d, start } = deps({ forwardTarget: "10.1.2.3" });
    const forwarder = await ensureLoopbackForwarder(d);
    expect(forwarder?.target).toBe("10.1.2.3");
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("then LOCALSTACK_HOSTNAME, when it names the emulator's host and answers", async () => {
    const { d } = deps({
      hostname: "localstack-main",
      canConnect: jest.fn(
        async (host: string) => host === "localstack-main" || host === "host.docker.internal"
      ),
    });
    expect((await ensureLoopbackForwarder(d))?.target).toBe("localstack-main");
  });

  test("an unreachable LOCALSTACK_HOSTNAME falls through to the other targets", async () => {
    const { d } = deps({
      hostname: "nowhere",
      canConnect: jest.fn(async (host: string) => host === "172.18.0.5"),
    });
    expect((await ensureLoopbackForwarder(d))?.target).toBe("172.18.0.5");
  });

  test("then host.docker.internal when it answers", async () => {
    const { d } = deps({
      canConnect: jest.fn(async (host: string) => host === "host.docker.internal"),
    });
    expect((await ensureLoopbackForwarder(d))?.target).toBe("host.docker.internal");
  });

  test("then the emulator container's IP, with its container ports", async () => {
    const { d, start } = deps({
      canConnect: jest.fn(async (host: string) => host === "172.18.0.5"),
    });
    expect((await ensureLoopbackForwarder(d))?.target).toBe("172.18.0.5");
    expect(start.mock.calls[0][0]).toBe("172.18.0.5");
  });

  test("no target answering: nothing listens, and the next call tries again", async () => {
    const { d, start } = deps();
    expect(await ensureLoopbackForwarder(d)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    (d.canConnect as jest.Mock).mockImplementation(
      async (host: string) => host === "host.docker.internal"
    );
    expect((await ensureLoopbackForwarder(d))?.target).toBe("host.docker.internal");
  });

  test("a started forwarder is reused", async () => {
    const { d, start } = deps({ forwardTarget: "10.1.2.3" });
    await ensureLoopbackForwarder(d);
    await ensureLoopbackForwarder(d);
    expect(start).toHaveBeenCalledTimes(1);
  });

  // A forwarder with a real gateway mirror, so the per-call target check has a port to probe.
  function trackedDeps(ip: { current: string }) {
    const closed: string[] = [];
    let connections = 0;
    const start = jest.fn(
      async (target: string, mirrors: Array<{ listen: number; target: number }>) =>
        ({
          target,
          ports: mirrors.slice(0, 1),
          connections: () => (connections += 3),
          failures: () => 0,
          close: async () => {
            closed.push(target);
          },
        }) as Forwarder
    );
    // An empty IP means the emulator is stopped: nothing answers and no container is found.
    const canConnect = jest.fn(async (host: string) => ip.current !== "" && host === ip.current);
    const d: ForwarderDeps = {
      inDocker: true,
      port: 4566,
      canConnect,
      findEmulator: jest.fn(async () => ({
        ipAddresses: ip.current ? [ip.current] : [],
        bindings: [{ containerPort: 4566, hostPort: 4566 }],
      })),
      log: jest.fn(),
      start: start as unknown as ForwarderDeps["start"],
    };
    return { d, start, closed, canConnect };
  }

  test("a restarted emulator on a new container IP: the old target is closed and the new one used", async () => {
    const ip = { current: "172.18.0.5" };
    const { d, start, closed } = trackedDeps(ip);
    expect((await ensureLoopbackForwarder(d))?.target).toBe("172.18.0.5");
    ip.current = "172.18.0.9"; // the restart moved the container
    expect((await ensureLoopbackForwarder(d))?.target).toBe("172.18.0.9");
    expect(closed).toEqual(["172.18.0.5"]);
    expect(start).toHaveBeenCalledTimes(2);
    expect((d.log as jest.Mock).mock.calls.flat().join("\n")).toMatch(/stopped answering/);
  });

  test("a live forwarder is not mistaken for an emulator on 127.0.0.1 (it answers there itself)", async () => {
    const ip = { current: "172.18.0.5" };
    const { d, start, canConnect } = trackedDeps(ip);
    await ensureLoopbackForwarder(d);
    canConnect.mockClear();
    canConnect.mockImplementation(
      async (host: string) => host === "127.0.0.1" || host === ip.current
    );
    expect((await ensureLoopbackForwarder(d))?.target).toBe("172.18.0.5");
    expect(start).toHaveBeenCalledTimes(1);
    expect(canConnect.mock.calls.map((c) => c[0])).toEqual(["172.18.0.5"]);
  });

  test("the emulator stopped: nothing listens until it answers again", async () => {
    const ip = { current: "172.18.0.5" };
    const { d, start, closed } = trackedDeps(ip);
    await ensureLoopbackForwarder(d);
    ip.current = "";
    expect(await ensureLoopbackForwarder(d)).toBeUndefined();
    expect(closed).toEqual(["172.18.0.5"]);
    ip.current = "172.18.0.5";
    expect((await ensureLoopbackForwarder(d))?.target).toBe("172.18.0.5");
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("concurrent calls start one forwarder", async () => {
    const ip = { current: "172.18.0.5" };
    const { d, start } = trackedDeps(ip);
    await Promise.all([
      ensureLoopbackForwarder(d),
      ensureLoopbackForwarder(d),
      ensureLoopbackForwarder(d),
    ]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("the connection total keeps the counts of replaced forwarders", async () => {
    const ip = { current: "172.18.0.5" };
    const { d } = trackedDeps(ip);
    await ensureLoopbackForwarder(d);
    ip.current = "172.18.0.9";
    await ensureLoopbackForwarder(d); // retires the first (its counter reads 3)
    // the retired 3, plus the live one's next reading (6: the fake counts up by 3 per read)
    expect(await totalForwarderConnections()).toBe(9);
  });
});
