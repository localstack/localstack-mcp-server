/**
 * The Anthropic API key for E2: it comes
 * from ANTHROPIC_API_KEY or a private key file (--key-file or
 * ANTHROPIC_API_KEY_FILE), goes straight into the SDK client, and is never printed, logged
 * or written. `scrubber` removes it from any error text before that text is recorded, and
 * `childEnv` keeps every ANTHROPIC_* variable away from the MCP servers (and their `az`).
 *
 * No runtime imports of local modules (run.mjs loads this file with type stripping).
 */
import { readFileSync, statSync } from "node:fs";

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export interface LoadedKey {
  key: string;
  /** Where it came from, without the key: "ANTHROPIC_API_KEY" or "key file <path>". */
  source: string;
}

export const NO_KEY_MESSAGE =
  "E2 needs an Anthropic API key to call the model, and none was found. Set ANTHROPIC_API_KEY, " +
  "or pass --key-file <path> (or ANTHROPIC_API_KEY_FILE=<path>) naming a file that " +
  "holds only the key. The key is never printed or logged. Without a key, --oracle, --negative and " +
  "--dry-run still run: they call no model.";

/** One key, as the Console issues it; the file may carry a BOM and a trailing newline. */
export function parseKey(raw: string, where: string): string {
  const key = raw.replace(/^﻿/, "").trim();
  if (!key.startsWith("sk-ant-") || /\s/.test(key)) {
    throw new KeyError(`${where} does not contain a single Anthropic API key`);
  }
  return key;
}

export interface KeyFileDeps {
  read: (path: string) => string;
  stat: (path: string) => { mode: number; uid: number };
  platform: string;
  uid: number | null;
}

const realDeps: KeyFileDeps = {
  read: (p) => readFileSync(p, "utf8"),
  stat: (p) => statSync(p),
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
};

/**
 * The key from a file. On POSIX the file must belong to the user and be private (mode
 * 600), as ssh demands of private keys; Windows has no such mode bits to check.
 */
export function readKeyFile(path: string, deps: KeyFileDeps = realDeps): string {
  let st: { mode: number; uid: number };
  try {
    st = deps.stat(path);
  } catch {
    throw new KeyError(`no API key file at ${path}`);
  }
  if (deps.platform !== "win32") {
    if (deps.uid !== null && st.uid !== deps.uid)
      throw new KeyError(`${path} is not owned by the current user`);
    if (st.mode & 0o077)
      throw new KeyError(`${path} is readable by others; run: chmod 600 ${path}`);
  }
  return parseKey(deps.read(path), path);
}

/**
 * The key, or null when none is configured. Precedence: --key-file, then
 * ANTHROPIC_API_KEY_FILE, then ANTHROPIC_API_KEY. A configured but unusable key is a
 * KeyError (its message never contains the key).
 */
export function loadKey(
  opts: { keyFile?: string; env: Record<string, string | undefined> },
  deps: KeyFileDeps = realDeps
): LoadedKey | null {
  const file = opts.keyFile || opts.env.ANTHROPIC_API_KEY_FILE;
  if (file) return { key: readKeyFile(file, deps), source: `key file ${file}` };
  const fromEnv = opts.env.ANTHROPIC_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { key: parseKey(fromEnv, "ANTHROPIC_API_KEY"), source: "ANTHROPIC_API_KEY" };
  }
  return null;
}

/** Replaces the key (and nothing else) in a text before it is stored or printed. */
export function scrubber(key: string | null | undefined): (text: string) => string {
  if (!key) return (text) => text;
  return (text) => (typeof text === "string" ? text.split(key).join("[redacted]") : text);
}

/** The environment for child processes: every ANTHROPIC_* variable removed. */
export function childEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, value] of Object.entries(env)) {
    if (!/^ANTHROPIC_/i.test(k)) out[k] = value;
  }
  return out;
}

/** Removes every ANTHROPIC_* variable from this process's environment (in place). */
export function stripAnthropicEnv(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(k)) {
      delete env[k];
      removed.push(k);
    }
  }
  return removed;
}

/** True when a text contains the key anywhere (used to prove a record is clean). */
export function containsKey(text: string, key: string): boolean {
  return key.length > 0 && text.includes(key);
}
