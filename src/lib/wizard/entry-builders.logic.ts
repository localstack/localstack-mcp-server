import { ServerSpec } from "./types";

/** The {command, args, env} shape shared by Cursor, Claude Desktop, and Amazon Q. */
export function standardEntry(spec: ServerSpec): Record<string, unknown> {
  return { command: spec.command, args: spec.args, env: spec.env };
}

/** VS Code uses a top-level "servers" key and documents "type": "stdio" as required. */
export function vscodeEntry(spec: ServerSpec): Record<string, unknown> {
  return { type: "stdio", ...standardEntry(spec) };
}

/**
 * OpenCode's schema differs: the command line is a single array including the
 * binary, and the env key is "environment" (not "env").
 */
export function opencodeEntry(spec: ServerSpec): Record<string, unknown> {
  return {
    type: "local",
    command: [spec.command, ...spec.args],
    environment: spec.env,
    enabled: true,
  };
}
