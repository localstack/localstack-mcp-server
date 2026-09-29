import https from "https";
import net from "net";
import type { TLSSocket } from "tls";
import { makeTestCertificate } from "./testing/tls";
import {
  defaultEmulatorDeps,
  getAzureEmulatorStatus,
  isLoopbackAddress,
  resetEmulatorStatusCache,
  type EmulatorDeps,
} from "./emulator";

// The emulator status. The network is mocked, apart from one real
// HTTPS readiness case on a local TLS server.

const CONFIG = {
  port: 4566,
  healthBaseUrl: "http://127.0.0.1:4566",
  endpoint: "https://azure.localhost.localstack.cloud:4566",
  endpointHost: "azure.localhost.localstack.cloud",
  egressGuard: true,
};

const AZURE_HEALTH = { edition: "azure-alpha", license: true };
const INFO = { version: "2026.9.0.dev336:1ee0fa539", edition: "azure-alpha", session_id: "s-1" };

function deps(over: Partial<EmulatorDeps> & { health?: unknown; info?: unknown } = {}) {
  let clock = 0;
  // `in`, not a destructuring default: an explicit `health: undefined` means "unreachable".
  const { health: _h, info: _i, ...rest } = over;
  const health = "health" in over ? over.health : AZURE_HEALTH;
  const info = "info" in over ? over.info : INFO;
  const d: EmulatorDeps = {
    getJson: jest.fn(async (url: string) => (url.endsWith("/health") ? health : info)),
    httpsReady: jest.fn(async () => true),
    // Closed by default: no health answer then means nothing listens (not running).
    tcpOpen: jest.fn(async () => false),
    lookup: jest.fn(async () => {
      throw new Error("DNS must not be used");
    }),
    sleep: jest.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    ...rest,
  };
  return d;
}

beforeEach(() => resetEmulatorStatusCache());

describe("getAzureEmulatorStatus", () => {
  test("a healthy Azure emulator", async () => {
    const d = deps();
    expect(await getAzureEmulatorStatus(CONFIG, d)).toEqual({
      ok: true,
      edition: "azure-alpha",
      license: true,
      sessionId: "s-1",
      version: "2026.9.0.dev336:1ee0fa539",
    });
    expect(d.getJson).toHaveBeenCalledWith(
      "http://127.0.0.1:4566/_localstack/health",
      expect.any(Number)
    );
  });

  test("unreachable: the start advice and the port variable", async () => {
    const status = await getAzureEmulatorStatus(CONFIG, deps({ health: undefined }));
    expect(status).toMatchObject({ ok: false, problem: "not-running" });
    expect(status.message).toMatch(/not running at http:\/\/127\.0\.0\.1:4566/);
    expect(status.message).toMatch(/service: azure/);
    expect(status.message).toMatch(/LOCALSTACK_AZURE_PORT/);
  });

  test("busy: an open port that answers no health check is not-responding, not not-running", async () => {
    const d = deps({ health: undefined, tcpOpen: jest.fn(async () => true) });
    const status = await getAzureEmulatorStatus(CONFIG, d);
    expect(status).toMatchObject({ ok: false, problem: "not-responding" });
    expect(status.message).toMatch(/accepts connections but did not answer its health check/);
    expect(status.message).toMatch(/Retry in a few seconds/);
    expect(status.message).not.toMatch(/Start it with/);
    // The short probe, then the longer one, then the port.
    expect(d.getJson).toHaveBeenCalledTimes(2);
    expect((d.getJson as jest.Mock).mock.calls[1][1]).toBeGreaterThan(
      (d.getJson as jest.Mock).mock.calls[0][1]
    );
    expect(d.tcpOpen).toHaveBeenCalledWith("127.0.0.1", 4566, expect.any(Number));
  });

  test("a slow first health probe is rescued by the longer second one", async () => {
    let calls = 0;
    const d = deps({
      getJson: jest.fn(async (url: string) =>
        url.endsWith("/health") ? (++calls === 1 ? undefined : AZURE_HEALTH) : INFO
      ),
    });
    const status = await getAzureEmulatorStatus(CONFIG, d);
    expect(status.ok).toBe(true);
    expect(d.tcpOpen).not.toHaveBeenCalled();
  });

  test.each(["pro", "bigdata-pro", "snowflake", undefined])(
    "wrong edition: %s",
    async (edition) => {
      const status = await getAzureEmulatorStatus(
        CONFIG,
        deps({ health: { edition, license: true } })
      );
      expect(status).toMatchObject({ ok: false, problem: "wrong-edition" });
      expect(status.message).toContain(`edition: ${edition ?? "unknown"}`);
    }
  );

  test("license: false", async () => {
    const status = await getAzureEmulatorStatus(
      CONFIG,
      deps({ health: { edition: "azure-alpha", license: false } })
    );
    expect(status).toMatchObject({ ok: false, problem: "license" });
  });

  test("HTTPS not ready yet: retries for up to 10 s, then fails with the readiness message", async () => {
    const httpsReady = jest.fn(async () => false);
    const d = deps({ httpsReady });
    const status = await getAzureEmulatorStatus(CONFIG, d);
    expect(status).toMatchObject({ ok: false, problem: "https-not-ready", sessionId: "s-1" });
    expect(status.message).toMatch(/did not become ready within 10 s/);
    expect(httpsReady.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(httpsReady).toHaveBeenCalledWith(
      "127.0.0.1",
      4566,
      "azure.localhost.localstack.cloud",
      expect.any(Number)
    );
  });

  test("HTTPS that comes up after a few retries passes", async () => {
    let calls = 0;
    const status = await getAzureEmulatorStatus(
      CONFIG,
      deps({ httpsReady: async () => ++calls >= 3 })
    );
    expect(status.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("the HTTPS check needs no DNS: a resolver that throws is never called", async () => {
    const d = deps();
    await getAzureEmulatorStatus(CONFIG, d);
    expect(d.lookup).not.toHaveBeenCalled();
  });

  test("a session that passed the HTTPS check once is not probed again; a new session is", async () => {
    const d = deps();
    await getAzureEmulatorStatus(CONFIG, d);
    await getAzureEmulatorStatus(CONFIG, d);
    expect(d.httpsReady).toHaveBeenCalledTimes(1);
    const restarted = deps({ info: { ...INFO, session_id: "s-2" } });
    const status = await getAzureEmulatorStatus(CONFIG, restarted);
    expect(status.sessionId).toBe("s-2");
    expect(restarted.httpsReady).toHaveBeenCalledTimes(1);
  });

  test("an IPv6 endpoint connects to ::1", async () => {
    const d = deps();
    await getAzureEmulatorStatus(
      { ...CONFIG, endpoint: "https://[::1]:4566", endpointHost: "[::1]" },
      d
    );
    expect(d.httpsReady).toHaveBeenCalledWith("::1", 4566, "::1", expect.any(Number));
  });

  describe("with the guard off, DNS must answer loopback", () => {
    const off = { ...CONFIG, egressGuard: false };

    test("loopback answers pass", async () => {
      const status = await getAzureEmulatorStatus(off, deps({ lookup: async () => ["127.0.0.1"] }));
      expect(status.ok).toBe(true);
    });

    test("a non-loopback answer is refused", async () => {
      const status = await getAzureEmulatorStatus(
        off,
        deps({ lookup: async () => ["203.0.113.5"] })
      );
      expect(status).toMatchObject({ ok: false, problem: "dns-not-loopback" });
      expect(status.message).toContain("203.0.113.5");
    });

    test("a failed lookup gives the DNS-rebinding hint", async () => {
      const status = await getAzureEmulatorStatus(
        off,
        deps({
          lookup: async () => {
            throw new Error("ENOTFOUND");
          },
        })
      );
      expect(status).toMatchObject({ ok: false, problem: "dns" });
      expect(status.message).toMatch(/DNS-rebinding protection/);
    });
  });

  test("isLoopbackAddress", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });
});

describe("the default deps against real local servers", () => {
  test("httpsReady answers through SNI on 127.0.0.1", async () => {
    const pems = makeTestCertificate();
    if (!pems) return; // no openssl here: the mocked cases cover the logic
    let sni: string | undefined;
    const server = https.createServer(pems, (req, res) => {
      sni = (req.socket as TLSSocket).servername || undefined;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(
        await defaultEmulatorDeps.httpsReady(
          "127.0.0.1",
          port,
          "azure.localhost.localstack.cloud",
          3000
        )
      ).toBe(true);
      expect(sni).toBe("azure.localhost.localstack.cloud");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("getJson returns undefined for a closed port", async () => {
    const server = https.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new Promise((r) => server.close(r));
    expect(
      await defaultEmulatorDeps.getJson(`http://127.0.0.1:${port}/_localstack/health`, 2000)
    ).toBeUndefined();
    expect(
      await defaultEmulatorDeps.httpsReady("127.0.0.1", port, "x.localhost.localstack.cloud", 2000)
    ).toBe(false);
    expect(await defaultEmulatorDeps.tcpOpen("127.0.0.1", port, 2000)).toBe(false);
  });

  test("tcpOpen: a listening port that never answers HTTP is open (the busy case)", async () => {
    // Accepts the connection and says nothing, like a stalled emulator. Its sockets are
    // destroyed at the end: a socket nobody reads never sees the client leave.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => void sockets.add(socket));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await defaultEmulatorDeps.tcpOpen("127.0.0.1", port, 2000)).toBe(true);
      expect(
        await defaultEmulatorDeps.getJson(`http://127.0.0.1:${port}/_localstack/health`, 500)
      ).toBeUndefined();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});
