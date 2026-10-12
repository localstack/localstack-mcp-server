import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// The Azure tool's answers with no emulator: the azure-offline project gives the server a dummy
// token and a port where nothing listens (playwright.config.mjs).

const text = (result) => (result?.content ?? []).map((c) => c.text ?? "").join("\n");

// Asked of az itself, so a regression in how the tool finds az fails the test below.
const azRuns =
  spawnSync("az", ["version", "-o", "json"], {
    shell: process.platform === "win32",
    stdio: "ignore",
    env: { ...process.env, AZURE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "lsmcp-az-probe-")) },
  }).status === 0;

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
  // A missing az is reported first; CI runners have it.
  test.skip(!azRuns, "needs the Azure CLI on PATH");
  const answer = text(await mcp.callTool("localstack-azure-client", { command: "group list" }));
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
