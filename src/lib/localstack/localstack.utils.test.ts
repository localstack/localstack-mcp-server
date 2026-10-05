import {
  deriveRecreateOverrides,
  getGatewayHealth,
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
  launchRuntime,
  recreateRunningContainer,
  restartRuntimeInPlace,
} from "./localstack.utils";
import { httpClient } from "../../core/http-client";
import { request as httpRequest } from "http";
import { EventEmitter } from "events";

jest.mock("../../core/http-client", () => ({
  httpClient: { request: jest.fn() },
  HttpError: class HttpError extends Error {},
}));

jest.mock("http", () => ({
  request: jest.fn(),
}));

const mockedRequest = httpClient.request as jest.MockedFunction<typeof httpClient.request>;
const mockedHttpRequest = httpRequest as jest.MockedFunction<typeof httpRequest>;

const gatewayUnreachable = () => mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));

/** Simulate one node:http request/response round-trip for the Snowflake probe. */
function mockHttpResponse({ statusCode = 200, body = "" }: { statusCode?: number; body?: string }) {
  mockedHttpRequest.mockImplementationOnce(((options: any, callback: any) => {
    const req = new EventEmitter() as any;
    req.write = jest.fn();
    req.end = jest.fn(() => {
      const res = new EventEmitter() as any;
      res.statusCode = statusCode;
      callback(res);
      setImmediate(() => {
        if (body) res.emit("data", Buffer.from(body));
        res.emit("end");
      });
    });
    req.destroy = jest.fn((err: Error) => req.emit("error", err));
    return req;
  }) as any);
}

function mockHttpError(message: string) {
  mockedHttpRequest.mockImplementationOnce(((_options: any, _callback: any) => {
    const req = new EventEmitter() as any;
    req.write = jest.fn();
    req.end = jest.fn(() => {
      setImmediate(() => req.emit("error", new Error(message)));
    });
    req.destroy = jest.fn();
    return req;
  }) as any);
}

/** Minimal DockerApiClient stand-in for launchRuntime. */
function mockDockerClient(overrides: Record<string, jest.Mock> = {}) {
  const logHandle = {
    getBuffered: jest.fn(() => ""),
    hasExited: jest.fn(() => false),
    onExit: jest.fn(),
    destroy: jest.fn(),
  };
  const client = {
    ping: jest.fn().mockResolvedValue(undefined),
    findContainerByNameAnyState: jest.fn().mockResolvedValue(null),
    findLocalStackContainer: jest.fn().mockResolvedValue("container-123"),
    inspectContainer: jest
      .fn()
      .mockResolvedValue({ id: "container-123", image: "localstack/localstack-pro:latest" }),
    stopContainer: jest.fn().mockResolvedValue(undefined),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    waitForRemoval: jest.fn().mockResolvedValue(undefined),
    ensureNetwork: jest.fn().mockResolvedValue(undefined),
    imageExists: jest.fn().mockResolvedValue(true),
    pullImage: jest.fn().mockResolvedValue(undefined),
    createAndStartContainer: jest.fn().mockResolvedValue("container-123"),
    attachLogBuffer: jest.fn().mockResolvedValue(logHandle),
    ...overrides,
  };
  return { client: client as any, logHandle };
}

const launchDefaults = {
  stack: "aws" as const,
  processLabel: "LocalStack",
  alreadyRunningMessage: "already running",
  successTitle: "🚀 LocalStack started successfully!",
  statusHeading: "Status",
  timeoutMessage: "❌ timed out",
  pollIntervalMs: 10,
  maxWaitMs: 100,
  // A named volume skips the host-dir mkdir side effect and keeps the spec
  // independent of LOCALSTACK_VOLUME_DIR/XDG_CACHE_HOME on the test machine.
  volumeOverride: { type: "volume", name: "test-volume" } as const,
};

describe("localstack.utils", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
    mockedHttpRequest.mockReset();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    // launchRuntime builds its container spec from process.env — a developer
    // machine with these set user-wide (e.g. the old identical-path workaround)
    // must not change what the tests assert.
    delete process.env.MAIN_CONTAINER_NAME;
    delete process.env.LOCALSTACK_MAIN_CONTAINER_NAME;
    delete process.env.LOCALSTACK_IMAGE_NAME;
    delete process.env.IMAGE_NAME;
    delete process.env.GATEWAY_LISTEN;
    delete process.env.LOCALSTACK_GATEWAY_LISTEN;
    delete process.env.MAIN_DOCKER_NETWORK;
    delete process.env.LOCALSTACK_MAIN_DOCKER_NETWORK;
    delete process.env.DOCKER_SOCK;
  });

  describe("getGatewayHealth", () => {
    test("reports reachable + ready when the gateway answers with running services", async () => {
      mockedRequest.mockResolvedValueOnce({
        services: { s3: "running", lambda: "available" },
        edition: "pro",
        version: "4.0.0",
      } as any);

      const health = await getGatewayHealth();
      expect(health.reachable).toBe(true);
      expect(health.ready).toBe(true);
      expect(health.edition).toBe("pro");
    });

    test("reports reachable but not ready until a service is available or running", async () => {
      mockedRequest.mockResolvedValueOnce({
        services: { s3: "starting", lambda: "stopped" },
      } as any);

      const health = await getGatewayHealth();
      expect(health.reachable).toBe(true);
      expect(health.ready).toBe(false);
    });

    test("reports not reachable when the gateway probe fails", async () => {
      gatewayUnreachable();

      const health = await getGatewayHealth();
      expect(health.reachable).toBe(false);
      expect(health.ready).toBe(false);
    });

    test("does not treat arbitrary text responses as a LocalStack gateway", async () => {
      mockedRequest.mockResolvedValueOnce("not localstack" as any);

      const health = await getGatewayHealth();
      expect(health.reachable).toBe(false);
      expect(health.ready).toBe(false);
    });
  });

  describe("getLocalStackStatus", () => {
    test("reports not running as informational status (never an error) when the gateway is down", async () => {
      // The Docker smoke test's pre-start `status` scenario: must come back as plain
      // status text, not an errorMessage — the management tool renders statusOutput
      // without a leading ❌, which is exactly what the harness asserts.
      gatewayUnreachable();

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(false);
      expect(result.isReady).toBe(false);
      expect(result.statusOutput).toMatch(/not running/i);
      expect(result.statusOutput?.startsWith("❌")).toBe(false);
      expect(result.errorMessage).toBeUndefined();
    });

    test("enriches running status from /_localstack/info", async () => {
      mockedRequest.mockImplementation(async (endpoint: any) => {
        if (String(endpoint).includes("/_localstack/health")) {
          return { services: { s3: "available" }, edition: "pro", version: "4.0.0" } as any;
        }
        if (String(endpoint).includes("/_localstack/info")) {
          return { is_license_activated: true, uptime: 42, session_id: "abc" } as any;
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      });

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(true);
      expect(result.isReady).toBe(true);
      expect(result.statusOutput).toContain("/_localstack/health");
      expect(result.statusOutput).toContain("License activated: yes");
      expect(result.statusOutput).toContain("Uptime: 42s");
    });

    test("still reports running when /_localstack/info is unavailable", async () => {
      mockedRequest.mockImplementation(async (endpoint: any) => {
        if (String(endpoint).includes("/_localstack/health")) {
          return { services: { s3: "available" } } as any;
        }
        throw new Error("info not available");
      });

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(true);
      expect(result.statusOutput).toContain("Services initialized: 1/1");
    });
  });

  describe("getSnowflakeEmulatorStatus", () => {
    test("marks emulator healthy on success payload", async () => {
      mockHttpResponse({ body: '{"success": true}' });

      const result = await getSnowflakeEmulatorStatus();
      expect(result.isRunning).toBe(true);
      expect(result.isReady).toBe(true);
      expect(result.statusOutput).toContain('"success": true');
      // The probe must send the Snowflake routing Host header (undici fetch drops it).
      const options = mockedHttpRequest.mock.calls[0][0] as any;
      expect(options.headers.Host).toMatch(/^snowflake\.localhost\.localstack\.cloud:/);
    });

    test("reports unhealthy response", async () => {
      mockHttpResponse({ body: '{"success": false}' });

      const result = await getSnowflakeEmulatorStatus();
      expect(result.isRunning).toBe(false);
      expect(result.isReady).toBe(false);
    });

    test("reports connection failures without throwing", async () => {
      mockHttpError("connect ECONNREFUSED");

      const result = await getSnowflakeEmulatorStatus();
      expect(result.isRunning).toBe(false);
      expect(result.errorMessage).toContain("ECONNREFUSED");
    });

    test("settles (does not hang) when the socket is aborted mid-response", async () => {
      // The peer resets the connection after the response starts: 'end' never fires,
      // so without the 'aborted'/'close' handlers the probe promise would hang forever.
      mockedHttpRequest.mockImplementationOnce(((_options: any, callback: any) => {
        const req = new EventEmitter() as any;
        req.write = jest.fn();
        req.destroy = jest.fn();
        req.end = jest.fn(() => {
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          callback(res);
          setImmediate(() => {
            res.emit("data", Buffer.from('{"succ'));
            res.emit("aborted");
          });
        });
        return req;
      }) as any);

      const result = await getSnowflakeEmulatorStatus();
      expect(result.isRunning).toBe(false);
      expect(result.errorMessage).toMatch(/aborted/i);
    });
  });

  describe("launchRuntime", () => {
    test("returns the already-running message without touching Docker", async () => {
      const { client } = mockDockerClient();
      const result = await launchRuntime({
        ...launchDefaults,
        getStatus: jest.fn().mockResolvedValue({ isRunning: true, isReady: true }),
        dockerClient: client,
      });
      expect(result.content[0].text).toBe("already running");
      expect(client.createAndStartContainer).not.toHaveBeenCalled();
    });

    test("starts the container and succeeds once the gateway becomes reachable", async () => {
      const { client } = mockDockerClient();
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ isRunning: false })
        .mockResolvedValue({ isRunning: true, isReady: true, statusOutput: "gateway reachable" });

      const result = await launchRuntime({
        ...launchDefaults,
        getStatus,
        envVars: { DEBUG: "1" },
        dockerClient: client,
      });

      const text = result.content[0].text;
      expect(text).toContain("started successfully");
      expect(text).toContain(
        "Custom environment variables passed to the LocalStack container: DEBUG"
      );
      expect(client.createAndStartContainer).toHaveBeenCalledTimes(1);
      const spec = client.createAndStartContainer.mock.calls[0][0];
      expect(spec.Image).toBe("localstack/localstack-pro:latest");
      expect(spec.name).toBe("localstack-main");
    });

    test("pulls the image when missing", async () => {
      const { client } = mockDockerClient({
        imageExists: jest.fn().mockResolvedValue(false),
      });
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ isRunning: false })
        .mockResolvedValue({ isRunning: true, isReady: true });

      await launchRuntime({ ...launchDefaults, getStatus, dockerClient: client });
      expect(client.pullImage).toHaveBeenCalledWith("localstack/localstack-pro:latest");
    });

    test("reports an actionable conflict when the container name is already running", async () => {
      const { client } = mockDockerClient({
        findContainerByNameAnyState: jest.fn().mockResolvedValue({
          id: "abc",
          name: "localstack-main",
          state: "running",
          running: true,
          image: "localstack/snowflake:latest",
        }),
      });
      const getStatus = jest.fn().mockResolvedValue({ isRunning: false });

      const result = await launchRuntime({ ...launchDefaults, getStatus, dockerClient: client });
      const text = result.content[0].text;
      expect(text).toContain("already running");
      expect(text).toContain("Snowflake");
      expect(text).toContain("action: stop");
      expect(client.createAndStartContainer).not.toHaveBeenCalled();
    });

    test("removes a stale stopped container and proceeds", async () => {
      const { client } = mockDockerClient({
        findContainerByNameAnyState: jest.fn().mockResolvedValue({
          id: "stale-1",
          name: "localstack-main",
          state: "exited",
          running: false,
        }),
      });
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ isRunning: false })
        .mockResolvedValue({ isRunning: true, isReady: true });

      const result = await launchRuntime({ ...launchDefaults, getStatus, dockerClient: client });
      // Fail-fast timeouts: pre-start housekeeping must not block for the default 60s.
      expect(client.removeContainer).toHaveBeenCalledWith("stale-1", 10000);
      expect(client.waitForRemoval).toHaveBeenCalledWith("stale-1", 10000);
      expect(result.content[0].text).toContain("started successfully");
    });

    test("fails with the buffered log tail when the container exits during startup", async () => {
      let exitCallback: (() => void) | undefined;
      const logHandle = {
        getBuffered: jest.fn(() => "boot line\nLicense activation failed\n"),
        hasExited: jest.fn(() => true),
        onExit: jest.fn((cb: () => void) => {
          exitCallback = cb;
        }),
        destroy: jest.fn(),
      };
      const { client } = mockDockerClient({
        attachLogBuffer: jest.fn().mockResolvedValue(logHandle),
      });
      const getStatus = jest.fn().mockResolvedValue({ isRunning: false });

      const resultPromise = launchRuntime({ ...launchDefaults, getStatus, dockerClient: client });
      // wait for the launch flow to attach the buffer, then simulate container exit
      await new Promise((resolve) => setTimeout(resolve, 5));
      exitCallback?.();

      const text = (await resultPromise).content[0].text;
      expect(text).toContain("exited unexpectedly");
      expect(text).toContain("License activation failed");
      expect(logHandle.destroy).toHaveBeenCalled();
    });

    test("times out with the timeout message when readiness never arrives", async () => {
      const { client } = mockDockerClient();
      const getStatus = jest.fn().mockResolvedValue({ isRunning: false });

      const result = await launchRuntime({ ...launchDefaults, getStatus, dockerClient: client });
      expect(result.content[0].text).toContain("timed out");
    });

    test("still settles at the deadline even when getStatus hangs forever", async () => {
      // The independent deadline must fire regardless of an in-flight status probe —
      // otherwise a hung getStatus (e.g. a wedged snowflake HTTP probe) leaks the start.
      const { client } = mockDockerClient();
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ isRunning: false }) // initial pre-start check
        .mockImplementation(() => new Promise(() => {})); // subsequent polls hang

      const result = await launchRuntime({
        ...launchDefaults,
        getStatus,
        dockerClient: client,
        pollIntervalMs: 5,
        maxWaitMs: 40,
      });
      expect(result.content[0].text).toContain("timed out");
    });

    test("does not re-run onReady after resolving (no overlapping/post-exit re-fire)", async () => {
      const { client, logHandle } = mockDockerClient();
      // onExit is registered; capture it so we can fire it AFTER success to prove the guard.
      let exitCb: (() => void) | undefined;
      logHandle.onExit.mockImplementation((cb: () => void) => {
        exitCb = cb;
      });
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ isRunning: false })
        .mockResolvedValue({ isRunning: true, isReady: true });
      const onReady = jest.fn().mockResolvedValue(null);

      await launchRuntime({
        ...launchDefaults,
        getStatus,
        onReady,
        dockerClient: client,
        pollIntervalMs: 5,
        maxWaitMs: 500,
      });
      const callsAtResolve = onReady.mock.calls.length;
      exitCb?.(); // simulate the destroy()-triggered stream close after resolution
      await new Promise((r) => setTimeout(r, 20));
      expect(onReady.mock.calls.length).toBe(callsAtResolve);
      expect(callsAtResolve).toBe(1);
    });

    test("runs the onReady gate before reporting success", async () => {
      const { client } = mockDockerClient();
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ isRunning: false })
        .mockResolvedValue({ isRunning: true, isReady: true });
      const onReady = jest.fn().mockResolvedValue({
        content: [{ type: "text", text: "❌ **Feature Not Available**" }],
      });

      const result = await launchRuntime({
        ...launchDefaults,
        getStatus,
        onReady,
        dockerClient: client,
      });
      expect(onReady).toHaveBeenCalled();
      expect(result.content[0].text).toContain("Feature Not Available");
    });

    test("fails cleanly when the auth token is missing", async () => {
      delete process.env.LOCALSTACK_AUTH_TOKEN;
      const { client } = mockDockerClient();
      const result = await launchRuntime({
        ...launchDefaults,
        getStatus: jest.fn().mockResolvedValue({ isRunning: false }),
        dockerClient: client,
      });
      expect(result.content[0].text).toContain("LOCALSTACK_AUTH_TOKEN");
    });

    test("rejects an explicitly configured DOCKER_SOCK that does not exist", async () => {
      process.env.DOCKER_SOCK = "/definitely/not/a/real/docker.sock";
      const { client } = mockDockerClient();
      const result = await launchRuntime({
        ...launchDefaults,
        getStatus: jest.fn().mockResolvedValue({ isRunning: false }),
        dockerClient: client,
      });
      const text = result.content[0].text;
      expect(text).toContain("DOCKER_SOCK");
      expect(text).toContain("/definitely/not/a/real/docker.sock");
      expect(client.createAndStartContainer).not.toHaveBeenCalled();
    });
  });

  describe("restartRuntimeInPlace", () => {
    test("waits for the session transition before reporting ready", async () => {
      // Old process stays "ready" for a moment after the restart POST; the helper
      // must not report success until the session changes (uptime reset).
      let infoCalls = 0;
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        const url = String(endpoint);
        if (url.includes("/_localstack/info")) {
          infoCalls += 1;
          return infoCalls <= 2
            ? ({ session_id: "old", uptime: 500 } as any)
            : ({ session_id: "new", uptime: 3 } as any);
        }
        if (url.includes("/_localstack/health") && options?.method === "POST") return {} as any;
        return { services: { s3: "available" } } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 500 });
      expect(result.ok).toBe(true);
      expect(infoCalls).toBeGreaterThanOrEqual(3);
    });

    test("treats sustained gateway downtime as the restart transition", async () => {
      let healthGets = 0;
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        const url = String(endpoint);
        if (url.includes("/_localstack/info")) return { session_id: "old", uptime: 500 } as any;
        if (url.includes("/_localstack/health") && options?.method === "POST") return {} as any;
        healthGets += 1;
        if (healthGets <= 2) throw new Error("ECONNREFUSED"); // two consecutive = sustained
        return { services: { s3: "available" } } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 500 });
      expect(result.ok).toBe(true);
    });

    test("does NOT confirm on a single health flap (session unchanged)", async () => {
      // One transient probe failure (GC pause / 3s timeout on the OLD process) must not
      // be mistaken for a restart when the session never actually changes.
      let healthGets = 0;
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        const url = String(endpoint);
        if (url.includes("/_localstack/info")) return { session_id: "old", uptime: 500 } as any;
        if (url.includes("/_localstack/health") && options?.method === "POST") return {} as any;
        healthGets += 1;
        if (healthGets === 1) throw new Error("ECONNREFUSED"); // a single blip, then healthy again
        return { services: { s3: "available" } } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 60 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/Could not confirm/i);
    });

    test("reports failure when the restart request itself fails", async () => {
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        if (String(endpoint).includes("/_localstack/info")) return { session_id: "old" } as any;
        if (options?.method === "POST") throw new Error("connection refused");
        return { services: {} } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 100 });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("Restart request failed");
    });

    test("does not assume success when session info is unavailable and no downtime is seen", async () => {
      // Missing /_localstack/info must read as "unknown", not as proof of a restart —
      // a healthy gateway alone is what the OLD process looks like too.
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        const url = String(endpoint);
        if (url.includes("/_localstack/info")) throw new Error("info endpoint unavailable");
        if (url.includes("/_localstack/health") && options?.method === "POST") return {} as any;
        return { services: { s3: "available" } } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 60 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/Could not confirm/i);
    });

    test("adopts the first post-request session as baseline and confirms on a later change", async () => {
      // /_localstack/info was unreachable before the POST; the first successful read
      // becomes the comparison point, and a subsequent session change confirms.
      let infoCalls = 0;
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        const url = String(endpoint);
        if (url.includes("/_localstack/info")) {
          infoCalls += 1;
          if (infoCalls === 1) throw new Error("info endpoint unavailable");
          return infoCalls <= 3
            ? ({ session_id: "old", uptime: 500 } as any)
            : ({ session_id: "new", uptime: 2 } as any);
        }
        if (url.includes("/_localstack/health") && options?.method === "POST") return {} as any;
        return { services: { s3: "available" } } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 500 });
      expect(result.ok).toBe(true);
    });
  });

  describe("deriveRecreateOverrides", () => {
    test("reuses image/name/volume of a matching-stack container", () => {
      expect(
        deriveRecreateOverrides(
          {
            id: "x",
            name: "localstack-aws",
            image: "localstack/localstack-pro:3.9",
            mounts: [{ type: "bind", source: "/host/vol", destination: "/var/lib/localstack" }],
          },
          "aws"
        )
      ).toEqual({
        imageOverride: "localstack/localstack-pro:3.9",
        containerNameOverride: "localstack-aws",
        volumeOverride: { type: "bind", source: "/host/vol" },
      });
    });

    test("returns undefined when the previous image is a different stack (deliberate switch)", () => {
      expect(
        deriveRecreateOverrides({ id: "x", image: "localstack/snowflake:latest" }, "aws")
      ).toBeUndefined();
    });

    test("returns undefined without image metadata", () => {
      expect(deriveRecreateOverrides(undefined, "aws")).toBeUndefined();
      expect(deriveRecreateOverrides({ id: "x" }, "aws")).toBeUndefined();
    });
  });

  describe("recreateRunningContainer", () => {
    test("stops the running container and relaunches preserving its identity", async () => {
      let started = false;
      const { client } = mockDockerClient({
        findLocalStackContainer: jest.fn().mockResolvedValue("old-id"),
        inspectContainer: jest.fn().mockResolvedValue({
          id: "old-id",
          name: "localstack-aws",
          image: "localstack/localstack-pro:latest",
          // named volume avoids a real host mkdir side effect in this integration test;
          // the bind-source preservation is covered by the deriveRecreateOverrides tests.
          mounts: [{ type: "volume", name: "localstack-mcp", destination: "/var/lib/localstack" }],
        }),
        createAndStartContainer: jest.fn().mockImplementation(async () => {
          started = true;
          return "new-id";
        }),
      });
      // Gateway is down until the fresh container starts, then reachable+ready — so the
      // launch's "already running?" pre-check correctly sees "not running".
      mockedRequest.mockImplementation(async (endpoint: any) => {
        if (String(endpoint).includes("/_localstack/health")) {
          if (!started) throw new Error("ECONNREFUSED");
          return { services: { s3: "available" } } as any;
        }
        return {} as any;
      });

      const result = await recreateRunningContainer({
        dockerClient: client,
        pollIntervalMs: 5,
        maxWaitMs: 500,
      });
      expect(client.stopContainer).toHaveBeenCalledWith("old-id");
      expect(client.waitForRemoval).toHaveBeenCalledWith("old-id");
      const spec = client.createAndStartContainer.mock.calls[0][0];
      expect(spec.name).toBe("localstack-aws");
      expect(spec.Image).toBe("localstack/localstack-pro:latest");
      expect(result.content[0].text).toContain("recreated successfully");
    });
  });
});
