import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// P3 (plan task 2.16): the Azure tool's error paths with no emulator. The
// azure-offline project gives the server a dummy token and a port where nothing
// listens (playwright.config.mjs).

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

test("no emulator on the configured port: the not-running answer names the port", async ({
  mcp,
}) => {
  const result = await mcp.callTool("localstack-azure-client", { command: "group list" });
  const answer = text(result);
  expect(answer).toMatch(/^❌ \*\*LocalStack Azure Emulator Not Ready\*\*/);
  expect(answer).toMatch(/not running at http:\/\/127\.0\.0\.1:\d+/);
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

test("the description is filled with the 200-character workdir and stays in budget", async ({
  mcp,
}) => {
  const tools = await mcp.listTools();
  const azure = tools.find((tool) => tool.name === "localstack-azure-client");
  expect(azure.description).toMatch(/Files must be inside .*w{50,}\./);
  const entryBytes = Buffer.byteLength(JSON.stringify(azure));
  console.log(`Azure entry with a 200-character workdir: ${entryBytes} bytes`);
  expect(entryBytes).toBeLessThanOrEqual(3200);
});
