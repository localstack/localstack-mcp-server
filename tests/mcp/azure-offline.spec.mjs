import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// The Azure tool's answers with no emulator: the azure-offline project gives the server a dummy
// token and a port where nothing listens (playwright.config.mjs).

const text = (result) => (result?.content ?? []).map((c) => c.text ?? "").join("\n");

test("shell syntax is refused before anything runs", async ({ mcp }) => {
  const result = await mcp.callTool("localstack-azure-client", {
    command: "group list; echo pwned",
  });
  expect(text(result)).toMatch(/^❌ /);
  expect(text(result)).toMatch(/forbidden shell syntax/);
});

test("a denied command group is refused with the policy's message", async ({ mcp }) => {
  const result = await mcp.callTool("localstack-azure-client", { command: "login" });
  expect(text(result)).toMatch(/^❌ /);
  expect(text(result)).toMatch(/already logged in to the emulator/);
});

test("no emulator on the configured port: the answer names the gateway and the start action", async ({
  mcp,
}) => {
  const result = await mcp.callTool("localstack-azure-client", { command: "group list" });
  const answer = text(result);
  // A missing az is reported first; CI runners have it.
  test.skip(answer.includes("Azure CLI Not Available"), "needs the Azure CLI on PATH");
  expect(answer).toMatch(/^❌ \*\*LocalStack Azure Emulator Not Ready\*\*/);
  expect(answer).toMatch(/not running at http:\/\/[^\s:]+:\d+/);
  expect(answer).toContain("service: azure");
});

test("a blank command is a schema error (-32602) that never reaches the handler", async ({
  mcp,
}) => {
  let answer;
  try {
    answer = text(await mcp.callTool("localstack-azure-client", { command: "   " }));
  } catch (error) {
    answer = String(error?.message ?? error);
  }
  expect(answer).toMatch(/-32602|Input validation error/);
  expect(answer).toContain("The command string cannot be empty.");
});

test("the tool entry: a static description and destructive annotations", async ({ mcp }) => {
  const tools = await mcp.listTools();
  const azure = tools.find((tool) => tool.name === "localstack-azure-client");
  expect(azure.description).toContain("LocalStack Azure emulator");
  expect(azure.description).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  expect(azure.annotations).toMatchObject({ destructiveHint: true, openWorldHint: false });
});
