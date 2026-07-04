import {
  getGatewayHealth,
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
  launchRuntime,
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
};

describe("localstack.utils", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
    mockedHttpRequest.mockReset();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
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
      expect(client.removeContainer).toHaveBeenCalledWith("stale-1");
      expect(client.waitForRemoval).toHaveBeenCalledWith("stale-1");
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

    test("treats a gateway-down window as the restart transition", async () => {
      let healthGets = 0;
      mockedRequest.mockImplementation(async (endpoint: any, options: any) => {
        const url = String(endpoint);
        if (url.includes("/_localstack/info")) return { session_id: "old", uptime: 500 } as any;
        if (url.includes("/_localstack/health") && options?.method === "POST") return {} as any;
        healthGets += 1;
        if (healthGets <= 2) throw new Error("ECONNREFUSED");
        return { services: { s3: "available" } } as any;
      });

      const result = await restartRuntimeInPlace({ pollIntervalMs: 5, maxWaitMs: 500 });
      expect(result.ok).toBe(true);
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
  });
});
