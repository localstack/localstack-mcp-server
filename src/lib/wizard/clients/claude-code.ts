import * as fs from "fs";
import * as jsonc from "jsonc-parser";
import { detectExistingEntries } from "../json-config.logic";
import { claudeCodeUserConfigPath } from "../paths.logic";
import { windowsSpawnSafeSpec } from "../server-config.logic";
import { InstallOutcome, SERVER_NAME, ServerSpec } from "../types";
import { cliAvailable, describeCliFailure, redactValues, runClientCli } from "./cli-utils";
import { ClientAdapter, ClientContext, ExistingState } from "./types";

/**
 * Local-scope servers (the `claude mcp add` default) live under
 * projects.<path>.mcpServers in the same ~/.claude.json and shadow user scope
 * inside those projects. We manage user scope only, but must surface local
 * entries — and must pass --scope user explicitly, because an unscoped
 * `claude mcp remove` exits 1 when the name exists in multiple scopes.
 */
function findLocalScopeProjects(configText: string): string[] {
  const root = jsonc.parse(configText, [], { allowTrailingComma: true });
  const projects = root?.projects;
  if (typeof projects !== "object" || projects === null) return [];
  return Object.entries(projects as Record<string, { mcpServers?: Record<string, unknown> }>)
    .filter(([, project]) => SERVER_NAME in (project?.mcpServers ?? {}))
    .map(([projectPath]) => projectPath);
}

export const claudeCodeAdapter: ClientAdapter = {
  id: "claude-code",
  label: "Claude Code",
  restartNote: "Restart any open Claude Code sessions to load the server.",

  async detect(ctx: ClientContext) {
    return { installed: await cliAvailable("claude", ctx) };
  },

  async getExisting(ctx: ClientContext): Promise<ExistingState> {
    const configPath = claudeCodeUserConfigPath(ctx);
    if (!fs.existsSync(configPath)) return { entries: [] };
    try {
      const text = fs.readFileSync(configPath, "utf8");
      const localProjects = findLocalScopeProjects(text);
      const warnings =
        localProjects.length > 0
          ? [
              `Claude Code also has project-local LocalStack entries in: ${localProjects.join(", ")} — those take precedence there; remove them with \`claude mcp remove\` inside each project.`,
            ]
          : undefined;
      return { entries: detectExistingEntries(text, ["mcpServers"]), warnings };
    } catch {
      return { entries: [] };
    }
  },

  async install(rawSpec: ServerSpec, ctx: ClientContext): Promise<InstallOutcome> {
    const spec = ctx.platform === "win32" ? windowsSpawnSafeSpec(rawSpec) : rawSpec;
    const secrets = Object.values(spec.env);
    const { entries } = await this.getExisting(ctx);
    for (const entry of entries) {
      // Scoped to user: that's the scope we detected and the scope we write.
      await runClientCli("claude", ["mcp", "remove", entry.key, "--scope", "user"], ctx);
    }

    const args = ["mcp", "add", SERVER_NAME, "--scope", "user"];
    for (const [key, value] of Object.entries(spec.env)) {
      args.push("--env", `${key}=${value}`);
    }
    args.push("--", spec.command, ...spec.args);

    const result = await runClientCli("claude", args, ctx);
    if (result.exitCode === 0) {
      return {
        status: "installed",
        detail: `added via \`claude mcp add\` (user scope in ${claudeCodeUserConfigPath(ctx)})`,
      };
    }
    return { status: "failed", detail: describeCliFailure(result, "claude", secrets) };
  },

  async remove(ctx: ClientContext): Promise<InstallOutcome> {
    const { entries, warnings } = await this.getExisting(ctx);
    if (entries.length === 0) {
      return {
        status: "skipped",
        detail: warnings?.[0] ?? "no LocalStack entry found",
      };
    }
    const failures: string[] = [];
    for (const entry of entries) {
      const result = await runClientCli(
        "claude",
        ["mcp", "remove", entry.key, "--scope", "user"],
        ctx
      );
      if (result.exitCode !== 0) {
        failures.push(`${entry.key}: ${describeCliFailure(result, "claude")}`);
      }
    }
    if (failures.length > 0) {
      return { status: "failed", detail: redactValues(failures.join("; "), []) };
    }
    const removedDetail = `removed ${entries.map((entry) => entry.key).join(", ")} from user scope in ${claudeCodeUserConfigPath(ctx)}`;
    return {
      status: "installed",
      detail: warnings?.length ? `${removedDetail} (${warnings[0]})` : removedDetail,
    };
  },
};
