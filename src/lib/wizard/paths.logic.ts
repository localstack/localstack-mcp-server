import * as path from "path";
import { ClientContext } from "./clients/types";

export type ExistsFn = (candidate: string) => boolean;

/**
 * Resolve paths with the separator semantics of the TARGET platform (`ctx.platform`)
 * rather than the host's. At runtime `ctx.platform` is always the host platform
 * (`process.platform`), so this is identical to the native `path` module there — it
 * only differs when resolving a foreign platform (e.g. unit tests that inject
 * darwin/linux/win32). That keeps each client's path contract deterministic on any
 * host OS, so the suite behaves the same whether CI runs on Linux, macOS, or Windows.
 */
function pathFor(ctx: ClientContext): path.PlatformPath {
  return ctx.platform === "win32" ? path.win32 : path.posix;
}

export function cursorConfigPath(ctx: ClientContext): string {
  return pathFor(ctx).join(ctx.homeDir, ".cursor", "mcp.json");
}

/** Claude Desktop ships for macOS and Windows only — null elsewhere. */
export function claudeDesktopConfigPath(ctx: ClientContext): string | null {
  const p = pathFor(ctx);
  if (ctx.platform === "darwin") {
    return p.join(ctx.homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA || p.join(ctx.homeDir, "AppData", "Roaming");
    return p.join(appData, "Claude", "claude_desktop_config.json");
  }
  return null;
}

export function vscodeUserDir(ctx: ClientContext): string {
  const p = pathFor(ctx);
  if (ctx.platform === "darwin") {
    return p.join(ctx.homeDir, "Library", "Application Support", "Code", "User");
  }
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA || p.join(ctx.homeDir, "AppData", "Roaming");
    return p.join(appData, "Code", "User");
  }
  const configBase = ctx.env.XDG_CONFIG_HOME || p.join(ctx.homeDir, ".config");
  return p.join(configBase, "Code", "User");
}

export function vscodeConfigPath(ctx: ClientContext): string {
  return pathFor(ctx).join(vscodeUserDir(ctx), "mcp.json");
}

export function opencodeConfigDir(ctx: ClientContext): string {
  const p = pathFor(ctx);
  const xdgConfigHome = ctx.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome || p.join(ctx.homeDir, ".config");
  return p.join(base, "opencode");
}

/** Prefers an existing opencode.jsonc over opencode.json. */
export function opencodeConfigPath(ctx: ClientContext, exists: ExistsFn): string {
  const p = pathFor(ctx);
  const dir = opencodeConfigDir(ctx);
  const jsoncPath = p.join(dir, "opencode.jsonc");
  if (exists(jsoncPath)) return jsoncPath;
  return p.join(dir, "opencode.json");
}

/**
 * Amazon Q Developer CLI was renamed to Kiro CLI (Nov 2025); config moved from
 * ~/.aws/amazonq/mcp.json to ~/.kiro/settings/mcp.json. Write to whichever
 * tree exists, preferring the new one.
 */
export function amazonQConfigPath(ctx: ClientContext, exists: ExistsFn): string {
  const p = pathFor(ctx);
  const kiroPath = p.join(ctx.homeDir, ".kiro", "settings", "mcp.json");
  const legacyPath = p.join(ctx.homeDir, ".aws", "amazonq", "mcp.json");
  if (exists(p.join(ctx.homeDir, ".kiro"))) return kiroPath;
  return legacyPath;
}

/** Claude Code stores user-scope MCP servers at the top level of ~/.claude.json. */
export function claudeCodeUserConfigPath(ctx: ClientContext): string {
  return pathFor(ctx).join(ctx.homeDir, ".claude.json");
}

/** Codex stores MCP servers under CODEX_HOME when set, else ~/.codex. */
export function codexConfigPath(ctx: ClientContext): string {
  const p = pathFor(ctx);
  const codexHome = ctx.env.CODEX_HOME || p.join(ctx.homeDir, ".codex");
  return p.join(codexHome, "config.toml");
}
