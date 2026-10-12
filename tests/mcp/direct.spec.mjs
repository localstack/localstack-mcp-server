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

// The docs tool asks an external search service. When that service itself is down (a timeout, a
// network error or a 5xx), the test is skipped with the tool's answer, since nothing in this
// server is at fault. Any other answer, a 4xx included, must hold the snippets.
const DOCS_SERVICE_DOWN =
  /Request timed out|Connection refused|HTTP Error: 5\d\d|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i;

test("docs tool returns useful documentation snippets", async ({ mcp }) => {
  requireEnv("LOCALSTACK_AUTH_TOKEN");

  const result = await mcp.callTool("localstack-docs", {
    query: "How to start LocalStack and configure auth token",
    limit: 2,
  });
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  test.skip(
    text.includes("Docs Search Unavailable") && DOCS_SERVICE_DOWN.test(text),
    `the docs search service is unavailable: ${text.slice(0, 200)}`
  );

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
