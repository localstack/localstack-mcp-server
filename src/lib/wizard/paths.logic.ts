import * as path from "path";
import { ClientContext } from "./clients/types";

export type ExistsFn = (candidate: string) => boolean;

export function cursorConfigPath(ctx: ClientContext): string {
  return path.join(ctx.homeDir, ".cursor", "mcp.json");
}

/** Claude Desktop ships for macOS and Windows only — null elsewhere. */
export function claudeDesktopConfigPath(ctx: ClientContext): string | null {
  if (ctx.platform === "darwin") {
    return path.join(
      ctx.homeDir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA || path.join(ctx.homeDir, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return null;
}

export function vscodeUserDir(ctx: ClientContext): string {
  if (ctx.platform === "darwin") {
    return path.join(ctx.homeDir, "Library", "Application Support", "Code", "User");
  }
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA || path.join(ctx.homeDir, "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  const configBase = ctx.env.XDG_CONFIG_HOME || path.join(ctx.homeDir, ".config");
  return path.join(configBase, "Code", "User");
}

export function vscodeConfigPath(ctx: ClientContext): string {
  return path.join(vscodeUserDir(ctx), "mcp.json");
}

export function opencodeConfigDir(ctx: ClientContext): string {
  const xdgConfigHome = ctx.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome || path.join(ctx.homeDir, ".config");
  return path.join(base, "opencode");
}

/** Prefers an existing opencode.jsonc over opencode.json. */
export function opencodeConfigPath(ctx: ClientContext, exists: ExistsFn): string {
  const dir = opencodeConfigDir(ctx);
  const jsoncPath = path.join(dir, "opencode.jsonc");
  if (exists(jsoncPath)) return jsoncPath;
  return path.join(dir, "opencode.json");
}

/**
 * Amazon Q Developer CLI was renamed to Kiro CLI (Nov 2025); config moved from
 * ~/.aws/amazonq/mcp.json to ~/.kiro/settings/mcp.json. Write to whichever
 * tree exists, preferring the new one.
 */
export function amazonQConfigPath(ctx: ClientContext, exists: ExistsFn): string {
  const kiroPath = path.join(ctx.homeDir, ".kiro", "settings", "mcp.json");
  const legacyPath = path.join(ctx.homeDir, ".aws", "amazonq", "mcp.json");
  if (exists(path.join(ctx.homeDir, ".kiro"))) return kiroPath;
  return legacyPath;
}

/** Claude Code stores user-scope MCP servers at the top level of ~/.claude.json. */
export function claudeCodeUserConfigPath(ctx: ClientContext): string {
  return path.join(ctx.homeDir, ".claude.json");
}
