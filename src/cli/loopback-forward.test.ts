import * as net from "net";

import { loopbackForwardTarget, startLoopbackForwarder } from "./loopback-forward";

describe("loopbackForwardTarget", () => {
  it("forwards to the host gateway inside a container", () => {
    expect(loopbackForwardTarget({ LOCALSTACK_HOSTNAME: "host.docker.internal" }, true)).toEqual({
      host: "host.docker.internal",
      port: 4566,
    });
  });

  it("uses LOCALSTACK_PORT", () => {
    expect(
      loopbackForwardTarget(
        { LOCALSTACK_HOSTNAME: "host.docker.internal", LOCALSTACK_PORT: "4567" },
        true
      )
    ).toEqual({ host: "host.docker.internal", port: 4567 });
  });

  it("does nothing outside a container", () => {
    expect(loopbackForwardTarget({ LOCALSTACK_HOSTNAME: "host.docker.internal" }, false)).toBe(
      undefined
    );
  });

  it.each([undefined, "localhost", "127.0.0.1"])(
    "does nothing when LocalStack is local (%s)",
    (host) => {
      expect(loopbackForwardTarget({ LOCALSTACK_HOSTNAME: host }, true)).toBe(undefined);
    }
  );

  it("does nothing for an invalid port", () => {
    expect(
      loopbackForwardTarget(
        { LOCALSTACK_HOSTNAME: "host.docker.internal", LOCALSTACK_PORT: "nope" },
        true
      )
    ).toBe(undefined);
  });
});

describe("startLoopbackForwarder", () => {
  const listening = (server: net.Server) =>
    new Promise<number>((resolve) =>
      server.listening
        ? resolve((server.address() as net.AddressInfo).port)
        : server.once("listening", () => resolve((server.address() as net.AddressInfo).port))
    );

  it("pipes loopback connections to the target and back", async () => {
    const upstream = net.createServer((socket) => socket.pipe(socket));
    upstream.listen(0, "127.0.0.1");
    const upstreamPort = await listening(upstream);

    const forwarder = startLoopbackForwarder({ host: "127.0.0.1", port: upstreamPort }, 0);
    const forwarderPort = await listening(forwarder);

    const reply = await new Promise<string>((resolve, reject) => {
      const client = net.connect(forwarderPort, "127.0.0.1", () => client.write("ping"));
      client.once("data", (data) => {
        resolve(data.toString());
        client.destroy();
      });
      client.once("error", reject);
    });

    expect(reply).toBe("ping");
    forwarder.close();
    upstream.close();
  });

  it("gives up quietly when the port is taken", async () => {
    const taken = net.createServer();
    taken.listen(0, "127.0.0.1");
    const port = await listening(taken);

    const forwarder = startLoopbackForwarder({ host: "127.0.0.1", port: 1 }, port);
    await new Promise<void>((resolve) => forwarder.once("close", () => resolve()));

    expect(forwarder.listening).toBe(false);
    taken.close();
  });
});
