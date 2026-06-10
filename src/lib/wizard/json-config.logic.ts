import * as jsonc from "jsonc-parser";
import { ExistingEntrySummary, InstallMethod, LEGACY_SERVER_NAMES, SERVER_NAME } from "./types";

const MODIFY_OPTIONS: jsonc.ModificationOptions = {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
};

const MANAGED_KEYS = [SERVER_NAME, ...LEGACY_SERVER_NAMES];

function parseConfig(text: string): { root: any; errors: jsonc.ParseError[] } {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parse(text || "{}", errors, { allowTrailingComma: true });
  return { root, errors };
}

/** Returns an error message when the text is not valid JSON(C), else null. */
export function validateConfigText(text: string): string | null {
  const { root, errors } = parseConfig(text);
  if (errors.length > 0) {
    return `file contains invalid JSON (${jsonc.printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})`;
  }
  if (text.trim() && (typeof root !== "object" || root === null || Array.isArray(root))) {
    return "file does not contain a JSON object";
  }
  return null;
}

function classifyMethod(entry: unknown): InstallMethod | "unknown" {
  if (typeof entry !== "object" || entry === null) return "unknown";
  const command = (entry as Record<string, unknown>).command;
  // OpenCode stores the full command line as an array.
  const binary = Array.isArray(command) ? command[0] : command;
  if (binary === "docker") return "docker";
  if (binary === "npx") return "npx";
  return "unknown";
}

function getServersObject(text: string, rootPath: string[]): Record<string, unknown> {
  const { root } = parseConfig(text);
  let node: unknown = root;
  for (const segment of rootPath) {
    if (typeof node !== "object" || node === null) return {};
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
}

/** Finds `localstack` and legacy `localstack-mcp-server` entries under rootPath. */
export function detectExistingEntries(text: string, rootPath: string[]): ExistingEntrySummary[] {
  const servers = getServersObject(text, rootPath);
  return MANAGED_KEYS.filter((key) => key in servers).map((key) => ({
    key,
    method: classifyMethod(servers[key]),
  }));
}

/**
 * Writes the `localstack` entry under rootPath and deletes any legacy-named
 * entries in the same pass. Preserves comments and formatting (JSONC edits).
 */
export function applyServerEntry(text: string, rootPath: string[], entry: unknown): string {
  let result = text.trim() ? text : "{}";
  for (const legacyKey of LEGACY_SERVER_NAMES) {
    if (legacyKey in getServersObject(result, rootPath)) {
      const edits = jsonc.modify(result, [...rootPath, legacyKey], undefined, MODIFY_OPTIONS);
      result = jsonc.applyEdits(result, edits);
    }
  }
  const edits = jsonc.modify(result, [...rootPath, SERVER_NAME], entry, MODIFY_OPTIONS);
  result = jsonc.applyEdits(result, edits);
  return result;
}

/** Deletes `localstack` and legacy entries under rootPath. */
export function removeServerEntries(
  text: string,
  rootPath: string[]
): { text: string; removed: string[] } {
  let result = text;
  const removed: string[] = [];
  for (const key of MANAGED_KEYS) {
    if (key in getServersObject(result, rootPath)) {
      const edits = jsonc.modify(result, [...rootPath, key], undefined, MODIFY_OPTIONS);
      result = jsonc.applyEdits(result, edits);
      removed.push(key);
    }
  }
  return { text: result, removed };
}
