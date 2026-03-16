import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

const EXPECTED_TOOLS = [
  "localstack-management",
  "localstack-deployer",
  "localstack-logs-analysis",
  "localstack-iam-policy-analyzer",
  "localstack-chaos-injector",
  "localstack-cloud-pods",
  "localstack-extensions",
  "localstack-ephemeral-instances",
  "localstack-aws-client",
  "localstack-docs",
];

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

test("docs tool returns useful documentation snippets", async ({ mcp }) => {
  requireEnv("LOCALSTACK_AUTH_TOKEN");

  const result = await mcp.callTool("localstack-docs", {
    query: "How to start LocalStack and configure auth token",
    limit: 2,
  });

  expect(result).not.toBeToolError();
  expect(result).toContainToolText("LocalStack Docs");
});
