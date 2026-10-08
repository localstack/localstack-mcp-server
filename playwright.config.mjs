import { defineConfig } from "@playwright/test";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mcpCommand = process.env.MCP_TEST_COMMAND || "node";
const mcpArgs = process.env.MCP_TEST_ARGS
  ? process.env.MCP_TEST_ARGS.split(" ").filter(Boolean)
  : ["dist/cli.js"];

// A port where nothing listens, for the Azure tool's tests without an emulator.
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const freePort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

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
          transport: "stdio",
          command: mcpCommand,
          args: mcpArgs,
          cwd: process.cwd(),
          quiet: true,
          connectTimeoutMs: 30000,
          requestTimeoutMs: 300000,
          callTimeoutMs: 300000,
          env: {
            ...process.env,
            LOCALSTACK_AUTH_TOKEN: process.env.LOCALSTACK_AUTH_TOKEN || "",
          },
        },
      },
    },
    {
      // The Azure tool with no emulator: a dummy token, a port where nothing listens and a
      // config dir of its own.
      name: "azure-offline",
      testMatch: /azure-offline\.spec\.mjs$/,
      use: {
        mcpConfig: {
          transport: "stdio",
          command: mcpCommand,
          args: mcpArgs,
          cwd: process.cwd(),
          quiet: true,
          connectTimeoutMs: 30000,
          requestTimeoutMs: 300000,
          callTimeoutMs: 300000,
          env: {
            ...process.env,
            LOCALSTACK_AUTH_TOKEN: "ls-dummy-token-for-offline-tests",
            LOCALSTACK_PORT: String(freePort),
            LOCALSTACK_AZ_CONFIG_DIR: join(tmpdir(), "lsmcp-azure-offline"),
            MCP_ANALYTICS_DISABLED: "1",
          },
        },
      },
    },
  ],
});
