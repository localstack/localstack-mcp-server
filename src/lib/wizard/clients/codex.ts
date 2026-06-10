import { windowsSpawnSafeSpec } from "../server-config.logic";
import {
  InstallMethod,
  InstallOutcome,
  LEGACY_SERVER_NAMES,
  SERVER_NAME,
  ServerSpec,
} from "../types";
import { cliAvailable, describeCliFailure, runClientCli } from "./cli-utils";
import { ClientAdapter, ClientContext, ExistingState } from "./types";

const MANAGED_KEYS = [SERVER_NAME, ...LEGACY_SERVER_NAMES];

function classifyCommand(command: unknown): InstallMethod | "unknown" {
  if (command === "docker") return "docker";
  if (command === "npx") return "npx";
  return "unknown";
}

/**
 * Codex is managed exclusively through its CLI (the wizard only offers it when
 * `codex` is on PATH). `codex mcp add` overwrites existing entries silently;
 * `codex mcp remove` is idempotent (exit 0 when missing).
 */
export const codexAdapter: ClientAdapter = {
  id: "codex",
  label: "Codex",
  restartNote: "Restart any open Codex sessions to load the server.",

  async detect(ctx: ClientContext) {
    return { installed: await cliAvailable("codex", ctx) };
  },

  async getExisting(ctx: ClientContext): Promise<ExistingState> {
    const result = await runClientCli("codex", ["mcp", "list", "--json"], ctx);
    if (result.exitCode !== 0) return { entries: [] };
    try {
      const servers: Array<{ name?: string; transport?: { command?: string } }> = JSON.parse(
        result.stdout
      );
      return {
        entries: servers
          .filter((server) => server.name && MANAGED_KEYS.includes(server.name))
          .map((server) => ({
            key: server.name as string,
            method: classifyCommand(server.transport?.command),
          })),
      };
    } catch {
      return { entries: [] };
    }
  },

  async install(rawSpec: ServerSpec, ctx: ClientContext): Promise<InstallOutcome> {
    const spec = ctx.platform === "win32" ? windowsSpawnSafeSpec(rawSpec) : rawSpec;
    const secrets = Object.values(spec.env);
    for (const legacyKey of LEGACY_SERVER_NAMES) {
      await runClientCli("codex", ["mcp", "remove", legacyKey], ctx);
    }

    const args = ["mcp", "add", SERVER_NAME];
    for (const [key, value] of Object.entries(spec.env)) {
      args.push("--env", `${key}=${value}`);
    }
    args.push("--", spec.command, ...spec.args);

    const result = await runClientCli("codex", args, ctx);
    if (result.exitCode === 0) {
      return { status: "installed", detail: "added via `codex mcp add`" };
    }
    return { status: "failed", detail: describeCliFailure(result, "codex", secrets) };
  },

  async remove(ctx: ClientContext): Promise<InstallOutcome> {
    const { entries } = await this.getExisting(ctx);
    if (entries.length === 0) {
      return { status: "skipped", detail: "no LocalStack entry found" };
    }
    const failures: string[] = [];
    for (const entry of entries) {
      const result = await runClientCli("codex", ["mcp", "remove", entry.key], ctx);
      if (result.exitCode !== 0) {
        failures.push(`${entry.key}: ${describeCliFailure(result, "codex")}`);
      }
    }
    if (failures.length > 0) return { status: "failed", detail: failures.join("; ") };
    return {
      status: "installed",
      detail: `removed ${entries.map((entry) => entry.key).join(", ")} via \`codex mcp remove\``,
    };
  },
};
