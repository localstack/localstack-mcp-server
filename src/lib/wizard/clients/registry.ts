import * as fs from "fs";
import * as path from "path";
import { opencodeEntry, standardEntry, vscodeEntry } from "../entry-builders.logic";
import {
  amazonQConfigPath,
  antigravityConfigPath,
  claudeDesktopConfigPath,
  cursorConfigPath,
  opencodeConfigDir,
  opencodeConfigPath,
  vscodeConfigPath,
  vscodeUserDir,
} from "../paths.logic";
import { ClientId } from "../types";
import { claudeCodeAdapter } from "./claude-code";
import { cliAvailable, cliVersionOutput } from "./cli-utils";
import { codexAdapter } from "./codex";
import { createFileClientAdapter } from "./file-client";
import { ClientAdapter } from "./types";

const exists = (candidate: string) => fs.existsSync(candidate);

const cursorAdapter = createFileClientAdapter({
  id: "cursor",
  label: "Cursor",
  restartNote: "Restart Cursor — the server appears under Cursor Settings > MCP.",
  configPath: (ctx) => cursorConfigPath(ctx),
  detectInstalled: async (ctx) => exists(path.join(ctx.homeDir, ".cursor")),
  rootPath: ["mcpServers"],
  buildEntry: standardEntry,
});

const antigravityAdapter = createFileClientAdapter({
  id: "antigravity",
  label: "Antigravity",
  restartNote:
    "Restart Antigravity — the server appears under the Agent panel ▸ MCP Servers ▸ Manage MCP Servers.",
  configPath: (ctx) => antigravityConfigPath(ctx),
  // ~/.gemini is Antigravity's home (the standalone Gemini CLI that also used it is retired).
  detectInstalled: async (ctx) => exists(path.join(ctx.homeDir, ".gemini")),
  rootPath: ["mcpServers"],
  buildEntry: standardEntry,
});

const claudeDesktopAdapter = createFileClientAdapter({
  id: "claude-desktop",
  label: "Claude Desktop",
  restartNote: "Restart the Claude desktop app to load the server.",
  configPath: claudeDesktopConfigPath,
  unsupportedReason: (ctx) =>
    ctx.platform !== "darwin" && ctx.platform !== "win32"
      ? "Claude Desktop is only available on macOS and Windows"
      : undefined,
  detectInstalled: async (ctx) => {
    const configPath = claudeDesktopConfigPath(ctx);
    return configPath !== null && exists(path.dirname(configPath));
  },
  rootPath: ["mcpServers"],
  buildEntry: standardEntry,
});

const vscodeAdapter = createFileClientAdapter({
  id: "vscode",
  label: "VS Code",
  restartNote: "Restart VS Code — MCP requires the GitHub Copilot Chat extension.",
  configPath: (ctx) => vscodeConfigPath(ctx),
  detectInstalled: async (ctx) => exists(vscodeUserDir(ctx)),
  rootPath: ["servers"],
  buildEntry: vscodeEntry,
});

const opencodeAdapter = createFileClientAdapter({
  id: "opencode",
  label: "OpenCode",
  restartNote: "Run `opencode mcp list` to verify the server is loaded.",
  configPath: (ctx) => opencodeConfigPath(ctx, exists),
  detectInstalled: async (ctx) => exists(opencodeConfigDir(ctx)) || cliAvailable("opencode", ctx),
  rootPath: ["mcp"],
  buildEntry: opencodeEntry,
  newFileSeed: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
});

const amazonQAdapter = createFileClientAdapter({
  id: "amazon-q",
  label: "Amazon Q CLI (Kiro)",
  restartNote: "Start a new `q chat` / `kiro-cli chat` session to load the server.",
  configPath: (ctx) => amazonQConfigPath(ctx, exists),
  unsupportedReason: (ctx) =>
    ctx.platform === "win32"
      ? "not configurable from native Windows yet — run the wizard inside WSL (Kiro CLI 2.0+ users can add the entry to ~/.kiro/settings/mcp.json manually)"
      : undefined,
  detectInstalled: async (ctx) => {
    if (
      exists(path.join(ctx.homeDir, ".kiro")) ||
      exists(path.join(ctx.homeDir, ".aws", "amazonq")) ||
      (await cliAvailable("kiro-cli", ctx))
    ) {
      return true;
    }
    // `q` is a heavily overloaded binary name (harelba/q etc.) — only count
    // it when its --version output actually looks like Amazon Q / Kiro.
    const version = await cliVersionOutput("q", ctx);
    return version !== null && /amazon|kiro|^q \d/i.test(version);
  },
  rootPath: ["mcpServers"],
  buildEntry: standardEntry,
});

/**
 * Display order for the wizard's client picker. Codex is CLI-managed and only
 * offered when its binary is detected (see init flow).
 */
export const CLIENT_ADAPTERS: ClientAdapter[] = [
  cursorAdapter,
  antigravityAdapter,
  claudeCodeAdapter,
  claudeDesktopAdapter,
  vscodeAdapter,
  codexAdapter,
  opencodeAdapter,
  amazonQAdapter,
];

export function getClientAdapter(id: ClientId): ClientAdapter {
  const adapter = CLIENT_ADAPTERS.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`Unknown MCP client: ${id}`);
  return adapter;
}

export const ALL_CLIENT_IDS = CLIENT_ADAPTERS.map((adapter) => adapter.id);
