import { opencodeEntry, standardEntry, vscodeEntry } from "./entry-builders.logic";
import { ServerSpec } from "./types";

const spec: ServerSpec = {
  command: "npx",
  args: ["-y", "@localstack/localstack-mcp-server"],
  env: { LOCALSTACK_AUTH_TOKEN: "tok", DEBUG: "1" },
};

describe("entry builders", () => {
  it("builds the standard mcpServers entry", () => {
    expect(standardEntry(spec)).toEqual({
      command: "npx",
      args: ["-y", "@localstack/localstack-mcp-server"],
      env: { LOCALSTACK_AUTH_TOKEN: "tok", DEBUG: "1" },
    });
  });

  it("adds type: stdio for VS Code", () => {
    expect(vscodeEntry(spec)).toMatchObject({ type: "stdio", command: "npx" });
  });

  it("builds OpenCode's array-command/environment shape", () => {
    expect(opencodeEntry(spec)).toEqual({
      type: "local",
      command: ["npx", "-y", "@localstack/localstack-mcp-server"],
      environment: { LOCALSTACK_AUTH_TOKEN: "tok", DEBUG: "1" },
      enabled: true,
    });
  });
});
