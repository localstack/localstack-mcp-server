import { defineConfig } from "@playwright/test";

const mcpCommand = process.env.MCP_TEST_COMMAND || "node";
const mcpArgs = process.env.MCP_TEST_ARGS
  ? process.env.MCP_TEST_ARGS.split(" ").filter(Boolean)
  : ["dist/stdio.js"];

export default defineConfig({
  testDir: "./tests/mcp",
  timeout: 120000,
  fullyParallel: false,
  reporter: [["list"]],
  projects: [
    {
      name: "localstack-mcp-server",
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
  ],
});
