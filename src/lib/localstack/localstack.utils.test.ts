import {
  getGatewayHealth,
  getLocalStackStatus,
  getSnowflakeEmulatorStatus,
} from "./localstack.utils";
import { runCommand } from "../../core/command-runner";
import { httpClient } from "../../core/http-client";

jest.mock("../../core/command-runner", () => ({
  runCommand: jest.fn(),
}));

jest.mock("../../core/http-client", () => ({
  httpClient: { request: jest.fn() },
  HttpError: class HttpError extends Error {},
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedRequest = httpClient.request as jest.MockedFunction<typeof httpClient.request>;

const cliUnavailable = () =>
  mockedRunCommand.mockResolvedValue({
    stdout: "",
    stderr: "command not found: localstack",
    error: new Error("spawn localstack ENOENT"),
    exitCode: null,
  } as any);

const gatewayUnreachable = () => mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));

describe("localstack.utils", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedRequest.mockReset();
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

    test("reports reachable but not ready while every service is still initializing", async () => {
      mockedRequest.mockResolvedValueOnce({
        services: { s3: "initializing", lambda: "starting" },
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
  });

  describe("getLocalStackStatus", () => {
    test("marks instance as running and ready from CLI output (no gateway)", async () => {
      gatewayUnreachable();
      mockedRunCommand.mockResolvedValueOnce({
        stdout: "Runtime status: running (Ready)",
        stderr: "",
        exitCode: 0,
      } as any);

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(true);
      expect(result.isReady).toBe(true);
    });

    test("detects an lstk-managed runtime via the gateway even when the CLI is absent", async () => {
      // The Python `localstack` binary is missing (lstk-only host), so the CLI yields
      // nothing — but the gateway is healthy, so detection must still report running.
      cliUnavailable();
      mockedRequest.mockResolvedValueOnce({
        services: { s3: "available" },
        edition: "pro",
      } as any);

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(true);
      expect(result.isReady).toBe(true);
      expect(result.statusOutput).toContain("/_localstack/health");
    });

    test("reports not running as informational status (never an error) when neither gateway nor CLI is available", async () => {
      // This is the Docker smoke test's pre-start `status` scenario: the gateway is
      // down and `localstack status` yields nothing usable. It must come back as plain
      // status text, not an errorMessage — the management tool renders statusOutput
      // without a leading ❌, which is exactly what the harness asserts.
      gatewayUnreachable();
      cliUnavailable();

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(false);
      expect(result.isReady).toBe(false);
      expect(result.statusOutput).toMatch(/not running/i);
      expect(result.statusOutput?.startsWith("❌")).toBe(false);
      expect(result.errorMessage).toBeUndefined();
    });

    test("keeps the CLI 'stopped' output as informational status when it exits non-zero", async () => {
      // `localstack status` exits non-zero when LocalStack isn't running (on Linux),
      // but still prints a "stopped" table. That output must surface as a normal
      // status (no error), not be discarded as "CLI unavailable" — regression guard
      // for the Docker image smoke test's pre-start `status` check.
      gatewayUnreachable();
      mockedRunCommand.mockResolvedValueOnce({
        stdout: "Runtime status: stopped",
        stderr: "",
        error: new Error("Command failed with exit code 1"),
        exitCode: 1,
      } as any);

      const result = await getLocalStackStatus();
      expect(result.isRunning).toBe(false);
      expect(result.statusOutput).toContain("stopped");
      expect(result.errorMessage).toBeUndefined();
    });
  });

  describe("getSnowflakeEmulatorStatus", () => {
    test("marks emulator healthy on success payload", async () => {
      mockedRunCommand.mockResolvedValueOnce({
        stdout: '{"success": true}',
        stderr: "",
        exitCode: 0,
      } as any);

      const result = await getSnowflakeEmulatorStatus();
      expect(result.isRunning).toBe(true);
      expect(result.isReady).toBe(true);
      expect(result.statusOutput).toContain('"success": true');
    });

    test("reports unhealthy response", async () => {
      mockedRunCommand.mockResolvedValueOnce({
        stdout: '{"success": false}',
        stderr: "",
        exitCode: 0,
      } as any);

      const result = await getSnowflakeEmulatorStatus();
      expect(result.isRunning).toBe(false);
      expect(result.isReady).toBe(false);
    });
  });
});
