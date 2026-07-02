// NOTE: lives at src/ root (not src/tools/) on purpose — xmcp discovers every file
// under src/tools/ as a tool and bundles it into the server, so a *.test.ts there
// would be loaded at runtime and crash the server with "jest is not defined".
import localstackManagement from "./tools/localstack-management";
import { runCommand } from "./core/command-runner";
import { httpClient } from "./core/http-client";
import { LocalStackContainerNotFoundError } from "./lib/docker/docker.client";

jest.mock("./core/command-runner", () => ({ runCommand: jest.fn() }));
jest.mock("./core/http-client", () => ({
  httpClient: { request: jest.fn() },
  HttpError: class HttpError extends Error {},
}));
// Run the tool body directly without the analytics wrapper / network.
jest.mock("./core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

const mockFindContainer = jest.fn();
const mockStopContainer = jest.fn();
const mockInspectContainer = jest.fn();
jest.mock("./lib/docker/docker.client", () => ({
  LocalStackContainerNotFoundError: class LocalStackContainerNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "LocalStackContainerNotFoundError";
    }
  },
  isLocalStackContainerNotFoundError: (error: unknown) =>
    error instanceof Error && error.name === "LocalStackContainerNotFoundError",
  DockerApiClient: jest.fn().mockImplementation(() => ({
    findLocalStackContainer: mockFindContainer,
    stopContainer: mockStopContainer,
    inspectContainer: mockInspectContainer,
  })),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedRequest = httpClient.request as jest.MockedFunction<typeof httpClient.request>;

const callStatus = () =>
  localstackManagement({ action: "status", service: "aws" } as never) as Promise<{
    content: Array<{ text: string }>;
  }>;
const textOf = (res: { content: Array<{ text: string }> }) =>
  res.content.map((c) => c.text).join("\n");

describe("localstack-management status (pre-start)", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedRequest.mockReset();
    mockFindContainer.mockReset();
    mockStopContainer.mockReset();
    mockInspectContainer.mockReset();
    process.env.LOCALSTACK_AUTH_TOKEN = "test-token";
    delete process.env.MAIN_CONTAINER_NAME;
  });

  test("renders an informational 'not running' status, never an ❌ error, when the gateway is down and `localstack status` yields nothing", async () => {
    mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));
    mockedRunCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "localstack" && args[0] === "status") {
        return { stdout: "", stderr: "", exitCode: 1, error: new Error("exit 1") } as never;
      }
      return { stdout: "LocalStack CLI 4.0.0", stderr: "", exitCode: 0 } as never;
    });

    const text = textOf(await callStatus());
    expect(text.trimStart().startsWith("❌")).toBe(false);
    expect(text).toMatch(/not currently running|not running/i);
  });

  test("status does not require the Python LocalStack CLI when gateway health is reachable", async () => {
    mockedRequest.mockResolvedValueOnce({
      services: { s3: "available" },
      edition: "pro",
      version: "4.0.0",
    });
    mockedRunCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "localstack" && args[0] === "--help") {
        return {
          stdout: "",
          stderr: "command not found: localstack",
          exitCode: null,
          error: new Error("spawn localstack ENOENT"),
        } as never;
      }
      return { stdout: "", stderr: "", exitCode: 0 } as never;
    });

    const text = textOf(await callStatus());
    expect(text).toContain("LocalStack gateway is reachable");
    expect(text).toContain("ready to accept requests");
    expect(mockedRunCommand).not.toHaveBeenCalledWith("localstack", ["--help"]);
  });
});

describe("localstack-management lifecycle (provenance-agnostic)", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedRequest.mockReset();
    mockFindContainer.mockReset();
    mockStopContainer.mockReset();
    mockInspectContainer.mockReset();
    process.env.LOCALSTACK_AUTH_TOKEN = "test-token";
    delete process.env.MAIN_CONTAINER_NAME;
  });

  test("start reports a clear error when neither the localstack nor lstk CLI is present", async () => {
    mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));
    // Both CLI presence probes (`--version`) fail → no lifecycle CLI available.
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          stdout: "",
          stderr: "not found",
          exitCode: null,
          error: new Error("ENOENT"),
        } as never;
      }
      return { stdout: "", stderr: "", exitCode: 0 } as never;
    });

    const res = (await localstackManagement({ action: "start", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text).toContain("No LocalStack CLI found");
    expect(text).toMatch(/lstk/);
  });

  test("start reports already-running before requiring a lifecycle CLI", async () => {
    mockedRequest.mockResolvedValueOnce({
      services: { s3: "available" },
      edition: "pro",
      version: "4.0.0",
    });
    mockedRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "not found",
      exitCode: null,
      error: new Error("ENOENT"),
    } as never);

    const res = (await localstackManagement({ action: "start", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text).toMatch(/already running/i);
    expect(mockedRunCommand).not.toHaveBeenCalled();
  });

  test("stop stops the detected container via the Docker API (no CLI)", async () => {
    mockFindContainer.mockResolvedValue("abc123");
    mockStopContainer.mockResolvedValue(undefined);

    const res = (await localstackManagement({ action: "stop", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text.trimStart().startsWith("❌")).toBe(false);
    expect(text).toMatch(/stopped successfully/i);
    expect(mockStopContainer).toHaveBeenCalledWith("abc123");
    // Stop must not shell out to the `localstack` CLI anymore.
    expect(mockedRunCommand).not.toHaveBeenCalled();
  });

  test("stop reports not-running (no error) when no container is found", async () => {
    mockFindContainer.mockRejectedValue(new LocalStackContainerNotFoundError("no container"));
    mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = (await localstackManagement({ action: "stop", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text.trimStart().startsWith("❌")).toBe(false);
    expect(text).toMatch(/not running/i);
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  test("stop reports Docker lookup failures instead of pretending LocalStack is stopped", async () => {
    mockFindContainer.mockRejectedValue(new Error("connect ECONNREFUSED /var/run/docker.sock"));

    const res = (await localstackManagement({ action: "stop", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text).toMatch(/Docker lookup failed/i);
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  test("stop reports Docker stop failures as structured errors", async () => {
    mockFindContainer.mockResolvedValue("abc123");
    mockStopContainer.mockRejectedValue(new Error("permission denied"));

    const res = (await localstackManagement({ action: "stop", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text).toMatch(/Failed to stop LocalStack/i);
    expect(text).toMatch(/permission denied/i);
  });

  test("restart does not stop the running container when no start CLI is available", async () => {
    mockFindContainer.mockResolvedValue("abc123");
    mockInspectContainer.mockResolvedValue({ name: "localstack-aws", env: [] });
    mockedRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "not found",
      exitCode: null,
      error: new Error("ENOENT"),
    } as never);

    const res = (await localstackManagement({ action: "restart", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text).toContain("No LocalStack CLI found");
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  test("restart aborts when Docker stop fails", async () => {
    mockFindContainer.mockResolvedValue("abc123");
    mockInspectContainer.mockResolvedValue({ name: "localstack-main", env: [] });
    mockStopContainer.mockRejectedValue(new Error("permission denied"));
    mockedRunCommand.mockImplementation(async (cmd: string, args: string[]) =>
      cmd === "localstack" && args[0] === "--version"
        ? ({ stdout: "LocalStack CLI 4.0.0", stderr: "", exitCode: 0 } as never)
        : ({ stdout: "", stderr: "", exitCode: 0 } as never)
    );

    const res = (await localstackManagement({ action: "restart", service: "aws" } as never)) as {
      content: Array<{ text: string }>;
    };
    const text = textOf(res);
    expect(text).toMatch(/Failed to stop LocalStack/i);
    expect(text).toMatch(/permission denied/i);
  });
});
