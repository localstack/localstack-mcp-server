import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

const EXPECTED_TOOLS = [
  "localstack-management",
  "localstack-deployer",
  "localstack-logs-analysis",
  "localstack-iam-policy-analyzer",
  "localstack-chaos-injector",
  "localstack-cloud-pods",
  "localstack-state-management",
  "localstack-extensions",
  "localstack-snowflake-client",
  "localstack-ephemeral-instances",
  "localstack-aws-client",
  "localstack-aws-replicator",
  "localstack-docs",
  "localstack-app-inspector",
];

const EXPECTED_PROMPT = "infrastructure-tester";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

test("exposes all expected LocalStack MCP tools", async ({ mcp }) => {
  const tools = await mcp.listTools();
  const toolNames = tools.map((tool) => tool.name);

  for (const expectedTool of EXPECTED_TOOLS) {
    expect(toolNames).toContain(expectedTool);
  }
});

test("smoke tests the infrastructure tester prompt", async ({ mcp }) => {
  const prompts = await mcp.client.listPrompts();
  const prompt = prompts.prompts.find((entry) => entry.name === EXPECTED_PROMPT);

  expect(prompt).toBeDefined();

  const result = await mcp.client.getPrompt({
    name: EXPECTED_PROMPT,
    arguments: {
      iac_path: "./infra",
    },
  });

  expect(result.messages).toHaveLength(1);
  expect(result.messages[0].role).toBe("user");
  expect(result.messages[0].content.type).toBe("text");
  expect(result.messages[0].content.text).toContain("# Infrastructure Tester (LocalStack)");
  expect(result.messages[0].content.text).toContain("`./infra`");
});

test("docs tool returns useful documentation snippets", async ({ mcp }) => {
  requireEnv("LOCALSTACK_AUTH_TOKEN");

  const result = await mcp.callTool("localstack-docs", {
    query: "How to start LocalStack and configure auth token",
    limit: 2,
  });

  expect(result).not.toBeToolError();
  expect(result).toContainToolText("LocalStack Docs");
});
