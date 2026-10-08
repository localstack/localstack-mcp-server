// Tool tests live outside src/tools/ because xmcp registers every src/tools/*.ts as a tool.
import localstackAzureClient from "../tools/localstack-azure-client";
import { withToolAnalytics } from "../core/analytics";
import * as preflight from "../lib/azure/preflight";
import { runAzCommand } from "../lib/azure/services";

jest.mock("../core/analytics", () => ({
  withToolAnalytics: jest.fn((_name: string, _args: unknown, fn: () => unknown) => fn()),
}));
jest.mock("../lib/azure/preflight", () => ({
  requireAzureConfig: jest.fn(() => null),
  requireAzureEmulatorRunning: jest.fn(async () => null),
  requireAzureCli: jest.fn(async () => null),
  requireAzureCliConfigured: jest.fn(async () => null),
}));
jest.mock("../lib/azure/services", () => ({
  azureConfig: () => ({ timeoutMs: 300_000, healthBaseUrl: "http://localhost:4566" }),
  installedExtensionNames: () => new Set<string>(),
  runAzCommand: jest.fn(async () => ({
    exitCode: 0,
    stdout: '[{"name": "rg"}]\n',
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
  })),
}));

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const call = (command: string) => localstackAzureClient({ command });

describe("localstack-azure-client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
  });

  test("runs the command and records it for analytics like the AWS client", async () => {
    const answer = await call('az group list --query "[].name"');
    expect(text(answer)).toBe('[{"name": "rg"}]');
    expect(runAzCommand).toHaveBeenCalledWith(
      ["group", "list", "--query", "[].name"],
      expect.any(Object)
    );
    expect(withToolAnalytics).toHaveBeenCalledWith(
      "localstack-azure-client",
      { command: 'az group list --query "[].name"' },
      expect.any(Function)
    );
  });

  test("a refused command needs no emulator and no az", async () => {
    expect(text(await call("login"))).toMatch(/^❌ \*\*Command not allowed\*\*/);
    expect(preflight.requireAzureEmulatorRunning).not.toHaveBeenCalled();
    expect(preflight.requireAzureCli).not.toHaveBeenCalled();
    expect(runAzCommand).not.toHaveBeenCalled();
  });

  test("the token and the settings come before the policy", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    expect(text(await call("group list"))).toContain("Auth Token Required");
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    jest.mocked(preflight.requireAzureConfig).mockReturnValueOnce({
      content: [{ type: "text", text: "❌ **Azure Tool Configuration Error**" }],
    });
    expect(text(await call("login"))).toContain("Configuration Error");
  });

  test("a failed preflight stops before the profile and the command", async () => {
    jest.mocked(preflight.requireAzureEmulatorRunning).mockResolvedValueOnce({
      content: [{ type: "text", text: "❌ **LocalStack Azure Emulator Not Ready**" }],
    });
    expect(text(await call("group list"))).toContain("Emulator Not Ready");
    expect(preflight.requireAzureCliConfigured).not.toHaveBeenCalled();
    expect(runAzCommand).not.toHaveBeenCalled();
  });
});
