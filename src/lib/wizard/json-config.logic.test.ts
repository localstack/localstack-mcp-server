import {
  applyServerEntry,
  detectExistingEntries,
  removeServerEntries,
  validateConfigText,
} from "./json-config.logic";

const NPX_ENTRY = {
  command: "npx",
  args: ["-y", "@localstack/localstack-mcp-server"],
  env: { LOCALSTACK_AUTH_TOKEN: "tok" },
};

describe("validateConfigText", () => {
  it("accepts empty files, objects, and JSONC comments", () => {
    expect(validateConfigText("")).toBeNull();
    expect(validateConfigText("{}")).toBeNull();
    expect(validateConfigText('{\n  // comment\n  "a": 1,\n}')).toBeNull();
  });

  it("rejects broken JSON and non-objects", () => {
    expect(validateConfigText("{ nope")).not.toBeNull();
    expect(validateConfigText("[1, 2]")).not.toBeNull();
  });
});

describe("detectExistingEntries", () => {
  it("finds the localstack entry and classifies its method", () => {
    const text = JSON.stringify({ mcpServers: { localstack: { command: "docker", args: [] } } });
    expect(detectExistingEntries(text, ["mcpServers"])).toEqual([
      { key: "localstack", method: "docker" },
    ]);
  });

  it("finds legacy docs-style entries", () => {
    const text = JSON.stringify({
      mcpServers: { "localstack-mcp-server": { command: "npx", args: [] } },
    });
    expect(detectExistingEntries(text, ["mcpServers"])).toEqual([
      { key: "localstack-mcp-server", method: "npx" },
    ]);
  });

  it("classifies OpenCode array commands", () => {
    const text = JSON.stringify({
      mcp: { localstack: { type: "local", command: ["docker", "run"] } },
    });
    expect(detectExistingEntries(text, ["mcp"])).toEqual([{ key: "localstack", method: "docker" }]);
  });

  it("returns nothing for unrelated servers or missing files", () => {
    expect(detectExistingEntries('{"mcpServers":{"other":{}}}', ["mcpServers"])).toEqual([]);
    expect(detectExistingEntries("", ["mcpServers"])).toEqual([]);
  });
});

describe("applyServerEntry", () => {
  it("creates the entry in an empty config", () => {
    const result = applyServerEntry("", ["mcpServers"], NPX_ENTRY);
    expect(JSON.parse(result)).toEqual({ mcpServers: { localstack: NPX_ENTRY } });
  });

  it("preserves other servers and comments", () => {
    const text = '{\n  // keep me\n  "mcpServers": {\n    "other": { "command": "foo" }\n  }\n}';
    const result = applyServerEntry(text, ["mcpServers"], NPX_ENTRY);
    expect(result).toContain("// keep me");
    const parsed = JSON.parse(result.replace("// keep me", ""));
    expect(parsed.mcpServers.other).toEqual({ command: "foo" });
    expect(parsed.mcpServers.localstack).toEqual(NPX_ENTRY);
  });

  it("migrates legacy entries: writes localstack, deletes localstack-mcp-server", () => {
    const text = JSON.stringify({
      mcpServers: {
        "localstack-mcp-server": { command: "npx", args: [] },
        other: { command: "foo" },
      },
    });
    const parsed = JSON.parse(applyServerEntry(text, ["mcpServers"], NPX_ENTRY));
    expect(parsed.mcpServers["localstack-mcp-server"]).toBeUndefined();
    expect(parsed.mcpServers.localstack).toEqual(NPX_ENTRY);
    expect(parsed.mcpServers.other).toEqual({ command: "foo" });
  });

  it("works with VS Code's top-level servers key", () => {
    const result = applyServerEntry("{}", ["servers"], { type: "stdio", ...NPX_ENTRY });
    expect(JSON.parse(result).servers.localstack.type).toBe("stdio");
  });
});

describe("removeServerEntries", () => {
  it("removes both managed keys and reports them", () => {
    const text = JSON.stringify({
      mcpServers: {
        localstack: { command: "npx" },
        "localstack-mcp-server": { command: "npx" },
        other: { command: "foo" },
      },
    });
    const { text: result, removed } = removeServerEntries(text, ["mcpServers"]);
    expect(removed.sort()).toEqual(["localstack", "localstack-mcp-server"]);
    const parsed = JSON.parse(result);
    expect(parsed.mcpServers).toEqual({ other: { command: "foo" } });
  });

  it("is a no-op when nothing is installed", () => {
    const text = '{"mcpServers":{"other":{}}}';
    const { text: result, removed } = removeServerEntries(text, ["mcpServers"]);
    expect(removed).toEqual([]);
    expect(result).toBe(text);
  });
});
