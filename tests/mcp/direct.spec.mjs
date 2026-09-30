import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  "localstack-azure-client",
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
  expect(toolNames).toHaveLength(EXPECTED_TOOLS.length);
});

// The Azure tool's entry and the whole catalogue stay in budget.
// The azure-offline project fills the description with a 200-character workdir.
test("the tools/list budget: Azure entry <= 3,200 bytes, catalogue < 24,000 bytes", async ({
  mcp,
}) => {
  const tools = await mcp.listTools();
  const azure = tools.find((tool) => tool.name === "localstack-azure-client");
  expect(azure).toBeDefined();
  const entryBytes = Buffer.byteLength(JSON.stringify(azure));
  const catalogueBytes = Buffer.byteLength(JSON.stringify(tools));
  console.log(
    `tools/list: ${tools.length} tools, ${catalogueBytes} bytes; Azure entry ${entryBytes} bytes`
  );
  expect(entryBytes).toBeLessThanOrEqual(3200);
  expect(catalogueBytes).toBeLessThan(24000);
  // The description reaches the client byte-identical, line breaks included.
  expect(azure.description.split("\n").length).toBeGreaterThanOrEqual(9);
  expect(azure.description).toContain("never real Azure");
  expect(azure.annotations).toMatchObject({
    title: "LocalStack Azure Client",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
});

test("manifest.json and server.json list the Azure tool and valid variables", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const server = JSON.parse(readFileSync("server.json", "utf8"));
  expect(manifest.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  for (const tool of manifest.tools) expect(tool.description.length).toBeGreaterThan(10);
  const variables = server.packages[0].environmentVariables;
  const names = variables.map((v) => v.name);
  expect(new Set(names).size).toBe(names.length);
  for (const v of variables) {
    expect(v).toEqual({
      description: expect.any(String),
      isRequired: expect.any(Boolean),
      format: "string",
      isSecret: expect.any(Boolean),
      name: expect.stringMatching(/^[A-Z][A-Z0-9_]*$/),
    });
  }
  for (const name of [
    "LOCALSTACK_AZURE_PORT",
    "LOCALSTACK_AZ_CONFIG_DIR",
    "LOCALSTACK_AZ_WORKDIR",
    "LOCALSTACK_AZ_BICEP_PATH",
    "LOCALSTACK_AZ_BICEP_ENV",
  ]) {
    expect(names).toContain(name);
  }
  expect(server.description).toContain("Azure");
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

test("wizard: init --help prints usage without starting the server", () => {
  const output = execFileSync("node", ["dist/cli.js", "init", "--help"], { encoding: "utf8" });
  expect(output).toContain("init");
  expect(output).toContain("--method <npx|docker>");
  expect(output).toContain("--client <ids>");
});

test("wizard: non-interactive init writes a Cursor config", () => {
  const home = mkdtempSync(join(tmpdir(), "ls-wizard-test-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });

  execFileSync(
    "node",
    [
      "dist/cli.js",
      "init",
      "--method",
      "npx",
      "--client",
      "cursor",
      "--token",
      "ls-test-token",
      "--config",
      "DEBUG=1",
      "--force",
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } }
  );

  const config = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  expect(config.mcpServers.localstack.command).toBe("npx");
  expect(config.mcpServers.localstack.args).toEqual(["-y", "@localstack/localstack-mcp-server"]);
  expect(config.mcpServers.localstack.env.LOCALSTACK_AUTH_TOKEN).toBe("ls-test-token");
  expect(config.mcpServers.localstack.env.DEBUG).toBe("1");
});

test("wizard: no-arg dist/cli.js still serves MCP over stdio", async () => {
  const child = spawn("node", ["dist/cli.js"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const response = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("no MCP response within 30s")), 30000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(buffer.slice(0, newlineIndex)));
        }
      });
      child.on("error", reject);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "wizard-regression-test", version: "0.0.0" },
          },
        }) + "\n"
      );
    });
    expect(response.result.capabilities).toBeDefined();
  } finally {
    child.kill();
  }
});

test("dist/cli.js exits when the client closes stdin", async () => {
  const child = spawn("node", ["-e", 'setInterval(() => {}, 1000); require("./dist/cli.js")'], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const exited = once(child, "exit");
    child.stdin.end();

    const [code, signal] = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("server did not exit after stdin closed")), 5000)
      ),
    ]);

    expect(code).toBe(0);
    expect(signal).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
