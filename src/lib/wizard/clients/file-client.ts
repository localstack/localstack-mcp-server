import * as fs from "fs";
import * as path from "path";
import {
  applyServerEntry,
  detectExistingEntries,
  removeServerEntries,
  validateConfigText,
} from "../json-config.logic";
import { ClientId, InstallOutcome, ServerSpec } from "../types";
import { ClientAdapter, ClientContext, DetectResult, ExistingState } from "./types";

export interface FileClientConfig {
  id: ClientId;
  label: string;
  restartNote: string;
  /** Null means the client does not exist on this platform. */
  configPath(ctx: ClientContext): string | null;
  unsupportedReason?(ctx: ClientContext): string | undefined;
  detectInstalled(ctx: ClientContext): Promise<boolean>;
  rootPath: string[];
  buildEntry(spec: ServerSpec, ctx: ClientContext): unknown;
  /** Initial file content when the config does not exist yet. */
  newFileSeed?: string;
}

export function createFileClientAdapter(config: FileClientConfig): ClientAdapter {
  /** null = file absent; { error } = present but unreadable. */
  const readConfigText = (ctx: ClientContext): string | null | { error: string } => {
    const configPath = config.configPath(ctx);
    if (!configPath || !fs.existsSync(configPath)) return null;
    try {
      return fs.readFileSync(configPath, "utf8");
    } catch (error) {
      return { error: `cannot read ${configPath}: ${String(error)}` };
    }
  };

  return {
    id: config.id,
    label: config.label,
    restartNote: config.restartNote,

    async detect(ctx: ClientContext): Promise<DetectResult> {
      const unsupportedReason = config.unsupportedReason?.(ctx);
      if (unsupportedReason || config.configPath(ctx) === null) {
        return {
          installed: false,
          unsupportedReason: unsupportedReason ?? `not available on ${ctx.platform}`,
        };
      }
      return { installed: await config.detectInstalled(ctx) };
    },

    async getExisting(ctx: ClientContext): Promise<ExistingState> {
      const text = readConfigText(ctx);
      if (text === null) return { entries: [] };
      if (typeof text !== "string") return { entries: [], error: text.error };
      const validationError = validateConfigText(text);
      if (validationError) return { entries: [], error: validationError };
      return { entries: detectExistingEntries(text, config.rootPath) };
    },

    async install(spec: ServerSpec, ctx: ClientContext): Promise<InstallOutcome> {
      const configPath = config.configPath(ctx);
      if (!configPath) {
        return { status: "failed", detail: `${config.label} is not available on this platform` };
      }

      const existingText = readConfigText(ctx);
      if (existingText !== null && typeof existingText !== "string") {
        return { status: "failed", detail: existingText.error };
      }
      const text = existingText ?? config.newFileSeed ?? "{}";
      const validationError = validateConfigText(text);
      if (validationError) {
        return {
          status: "failed",
          detail: `${configPath}: ${validationError} — fix it manually and re-run`,
        };
      }

      try {
        const updated = applyServerEntry(text, config.rootPath, config.buildEntry(spec, ctx));
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        // mode applies only when the file is created — it carries the auth
        // token, so don't leave fresh files world-readable.
        fs.writeFileSync(configPath, updated.endsWith("\n") ? updated : `${updated}\n`, {
          mode: 0o600,
        });
        return { status: "installed", detail: configPath };
      } catch (error) {
        return { status: "failed", detail: `could not write ${configPath}: ${String(error)}` };
      }
    },

    async remove(ctx: ClientContext): Promise<InstallOutcome> {
      const configPath = config.configPath(ctx);
      const text = readConfigText(ctx);
      if (!configPath) {
        return { status: "skipped", detail: `${config.label} is not available on this platform` };
      }
      if (text === null) {
        return { status: "skipped", detail: `no config file found at ${configPath}` };
      }
      if (typeof text !== "string") {
        return { status: "failed", detail: text.error };
      }
      const validationError = validateConfigText(text);
      if (validationError) {
        return { status: "failed", detail: `${configPath}: ${validationError}` };
      }

      try {
        const { text: updated, removed } = removeServerEntries(text, config.rootPath);
        if (removed.length === 0) {
          return { status: "skipped", detail: "no LocalStack entry found" };
        }
        fs.writeFileSync(configPath, updated);
        return { status: "installed", detail: `removed ${removed.join(", ")} from ${configPath}` };
      } catch (error) {
        return { status: "failed", detail: `could not update ${configPath}: ${String(error)}` };
      }
    },
  };
}
