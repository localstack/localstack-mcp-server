import { defineConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mcpCommand = process.env.MCP_TEST_COMMAND || "node";
const mcpArgs = process.env.MCP_TEST_ARGS
  ? process.env.MCP_TEST_ARGS.split(" ").filter(Boolean)
  : ["dist/cli.js"];

const sharedMcpConfig = {
  transport: "stdio",
  command: mcpCommand,
  args: mcpArgs,
  cwd: process.cwd(),
  quiet: true,
  connectTimeoutMs: 30000,
  requestTimeoutMs: 300000,
  callTimeoutMs: 300000,
};

// P3 (plan task 2.16): the Azure tool without an emulator. A port that is free right
// now keeps "no emulator" true even where one runs on 4566; 4766 and 4710-4790 are
// never picked because the OS chooses from its ephemeral range.
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const azureOfflinePort = await freePort();

// P2 measures the description filled with a 200-character workdir.
const workdirRoot = join(tmpdir(), "lsmcp-p2");
const azureWorkdir = join(workdirRoot, "w".repeat(Math.max(1, 200 - workdirRoot.length - 1)));
mkdirSync(azureWorkdir, { recursive: true });

export default defineConfig({
  testDir: "./tests/mcp",
  timeout: 120000,
  fullyParallel: false,
  reporter: [
    ["list"],
    [
      "@gleanwork/mcp-server-tester/reporters/mcpReporter",
      {
        outputDir: ".mcp-test-results",
        autoOpen: false,
        historyLimit: 20,
      },
    ],
  ],
  projects: [
    {
      name: "localstack-mcp-server",
      testIgnore: /azure-offline\.spec\.mjs$/,
      use: {
        mcpConfig: {
          ...sharedMcpConfig,
          env: {
            ...process.env,
            LOCALSTACK_AUTH_TOKEN: process.env.LOCALSTACK_AUTH_TOKEN || "",
          },
        },
      },
    },
    {
      // Its own env (review R02, N8): a dummy token, and the Azure tool pointed at a
      // port where nothing listens, with its own config dir.
      name: "azure-offline",
      testMatch: /azure-offline\.spec\.mjs$/,
      use: {
        mcpConfig: {
          ...sharedMcpConfig,
          env: {
            ...process.env,
            LOCALSTACK_AUTH_TOKEN: "ls-dummy-token-for-offline-tests",
            LOCALSTACK_AZURE_PORT: String(azureOfflinePort),
            LOCALSTACK_AZ_CONFIG_DIR: join(workdirRoot, "azure-config"),
            LOCALSTACK_AZ_WORKDIR: azureWorkdir,
            MCP_ANALYTICS_DISABLED: "1",
          },
        },
      },
    },
  ],
});
