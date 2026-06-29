import {
  amazonQConfigPath,
  antigravityConfigPath,
  claudeCodeUserConfigPath,
  claudeDesktopConfigPath,
  codexConfigPath,
  cursorConfigPath,
  opencodeConfigPath,
  vscodeConfigPath,
} from "./paths.logic";
import { ClientContext } from "./clients/types";

const mac: ClientContext = { platform: "darwin", homeDir: "/Users/dev", env: {} };
const linux: ClientContext = { platform: "linux", homeDir: "/home/dev", env: {} };
const win: ClientContext = {
  platform: "win32",
  homeDir: "C:\\Users\\dev",
  env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
};

describe("client config paths", () => {
  it("resolves Cursor's global config in the home directory", () => {
    expect(cursorConfigPath(mac)).toBe("/Users/dev/.cursor/mcp.json");
    expect(cursorConfigPath(linux)).toBe("/home/dev/.cursor/mcp.json");
  });

  it("resolves Antigravity's shared MCP config in the home directory", () => {
    expect(antigravityConfigPath(mac)).toBe("/Users/dev/.gemini/config/mcp_config.json");
    expect(antigravityConfigPath(linux)).toBe("/home/dev/.gemini/config/mcp_config.json");
    expect(antigravityConfigPath(win)).toContain(".gemini/config/mcp_config.json");
  });

  it("resolves Claude Desktop on macOS and Windows, null on Linux", () => {
    expect(claudeDesktopConfigPath(mac)).toBe(
      "/Users/dev/Library/Application Support/Claude/claude_desktop_config.json"
    );
    expect(claudeDesktopConfigPath(win)).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json"
    );
    expect(claudeDesktopConfigPath(linux)).toBeNull();
  });

  it("resolves VS Code's per-platform user mcp.json", () => {
    expect(vscodeConfigPath(mac)).toBe("/Users/dev/Library/Application Support/Code/User/mcp.json");
    expect(vscodeConfigPath(linux)).toBe("/home/dev/.config/Code/User/mcp.json");
    expect(vscodeConfigPath(win)).toBe("C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\mcp.json");
    const xdg: ClientContext = { ...linux, env: { XDG_CONFIG_HOME: "/custom/config" } };
    expect(vscodeConfigPath(xdg)).toBe("/custom/config/Code/User/mcp.json");
  });

  it("resolves OpenCode config respecting XDG_CONFIG_HOME and existing .jsonc", () => {
    expect(opencodeConfigPath(mac, () => false)).toBe("/Users/dev/.config/opencode/opencode.json");
    const xdg: ClientContext = { ...linux, env: { XDG_CONFIG_HOME: "/custom/config" } };
    expect(opencodeConfigPath(xdg, () => false)).toBe("/custom/config/opencode/opencode.json");
    expect(opencodeConfigPath(mac, (p) => p.endsWith("opencode.jsonc"))).toBe(
      "/Users/dev/.config/opencode/opencode.jsonc"
    );
  });

  it("prefers the Kiro tree for Amazon Q when present", () => {
    expect(amazonQConfigPath(mac, (p) => p === "/Users/dev/.kiro")).toBe(
      "/Users/dev/.kiro/settings/mcp.json"
    );
    expect(amazonQConfigPath(mac, () => false)).toBe("/Users/dev/.aws/amazonq/mcp.json");
  });

  it("resolves Claude Code's user config", () => {
    expect(claudeCodeUserConfigPath(mac)).toBe("/Users/dev/.claude.json");
  });

  it("resolves Codex config with CODEX_HOME support", () => {
    expect(codexConfigPath(mac)).toBe("/Users/dev/.codex/config.toml");
    expect(codexConfigPath({ ...mac, env: { CODEX_HOME: "/tmp/codex" } })).toBe(
      "/tmp/codex/config.toml"
    );
  });
});
