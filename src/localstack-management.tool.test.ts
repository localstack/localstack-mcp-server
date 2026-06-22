// NOTE: lives at src/ root (not src/tools/) on purpose — xmcp discovers every file
// under src/tools/ as a tool and bundles it into the server, so a *.test.ts there
// would be loaded at runtime and crash the server with "jest is not defined".
import localstackManagement from "./tools/localstack-management";
import { runCommand } from "./core/command-runner";
import { httpClient } from "./core/http-client";

jest.mock("./core/command-runner", () => ({ runCommand: jest.fn() }));
jest.mock("./core/http-client", () => ({
  httpClient: { request: jest.fn() },
  HttpError: class HttpError extends Error {},
}));
// Run the tool body directly without the analytics wrapper / network.
jest.mock("./core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedRequest = httpClient.request as jest.MockedFunction<typeof httpClient.request>;

describe("localstack-management status (pre-start)", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedRequest.mockReset();
    process.env.LOCALSTACK_AUTH_TOKEN = "test-token";
    delete process.env.MAIN_CONTAINER_NAME;
  });

  test("renders an informational 'not running' status, never an ❌ error, when the gateway is down and `localstack status` yields nothing", async () => {
    // Gateway unreachable (pre-start).
    mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));
    // The `localstack` CLI exists (--help / --version succeed) but `localstack status`
    // produces no usable output pre-start — the behavior the Docker smoke test hit.
    mockedRunCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "localstack" && args[0] === "status") {
        return { stdout: "", stderr: "", exitCode: 1, error: new Error("exit 1") } as never;
      }
      return { stdout: "LocalStack CLI 4.0.0", stderr: "", exitCode: 0 } as never;
    });

    const res = (await localstackManagement({
      action: "status",
      service: "aws",
    } as never)) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");

    // The Docker harness flags a failure when the text starts with "❌".
    expect(text.trimStart().startsWith("❌")).toBe(false);
    expect(text).toMatch(/not currently running|not running/i);
  });
});
