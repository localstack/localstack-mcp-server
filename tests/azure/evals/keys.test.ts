/**
 * The API key's handling: where it is read from, how a bad file is refused, that no
 * message or record ever carries it, that child processes never inherit it, and that a
 * model run without a key refuses at once (exit 2) without a single network connection.
 */
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import * as K from "./keys";

const KEY = "sk-ant-api03-TESTKEY_abcdefghijklmnop-0123456789";

function deps(
  files: Record<string, { text: string; mode?: number; uid?: number }>,
  platform = "linux",
  uid: number | null = 1000
): K.KeyFileDeps {
  return {
    platform,
    uid,
    read: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p].text;
    },
    stat: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return { mode: files[p].mode ?? 0o100600, uid: files[p].uid ?? 1000 };
    },
  };
}

/** Runs fn and returns the thrown error's message (never the key itself). */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "(no error)";
}

describe("loading the key", () => {
  test("ANTHROPIC_API_KEY (an environment variable)", () => {
    expect(K.loadKey({ env: { ANTHROPIC_API_KEY: `  ${KEY}\n` } }, deps({}))).toEqual({
      key: KEY,
      source: "ANTHROPIC_API_KEY",
    });
  });

  test("--key-file wins over ANTHROPIC_API_KEY_FILE, which wins over ANTHROPIC_API_KEY", () => {
    const d = deps({ "/a": { text: KEY }, "/b": { text: KEY.replace("TESTKEY", "OTHERKEY") } });
    expect(
      K.loadKey(
        { keyFile: "/a", env: { ANTHROPIC_API_KEY_FILE: "/b", ANTHROPIC_API_KEY: "sk-ant-x" } },
        d
      )?.source
    ).toBe("key file /a");
    expect(
      K.loadKey({ env: { ANTHROPIC_API_KEY_FILE: "/b", ANTHROPIC_API_KEY: "sk-ant-x" } }, d)?.source
    ).toBe("key file /b");
  });

  test("no key configured is null (the runner then refuses)", () => {
    expect(K.loadKey({ env: {} }, deps({}))).toBeNull();
    expect(K.loadKey({ env: { ANTHROPIC_API_KEY: "  " } }, deps({}))).toBeNull();
  });

  test("a key file may carry a BOM and a newline (Notepad)", () => {
    expect(K.readKeyFile("/k", deps({ "/k": { text: `\ufeff${KEY}\r\n` } }))).toBe(KEY);
  });

  test("a file readable by others, or not the user's, is refused on POSIX", () => {
    expect(
      messageOf(() => K.readKeyFile("/k", deps({ "/k": { text: KEY, mode: 0o100644 } })))
    ).toBe("/k is readable by others; run: chmod 600 /k");
    expect(messageOf(() => K.readKeyFile("/k", deps({ "/k": { text: KEY, uid: 0 } })))).toBe(
      "/k is not owned by the current user"
    );
  });

  test("Windows has no such mode bits: the mode is not checked there", () => {
    expect(
      K.readKeyFile("C:\\k", deps({ "C:\\k": { text: KEY, mode: 0o100666 } }, "win32", null))
    ).toBe(KEY);
  });

  test("a missing file, or one that is not a single key, is refused without echoing its content", () => {
    expect(messageOf(() => K.readKeyFile("/none", deps({})))).toBe("no API key file at /none");
    const two = `${KEY}\n${KEY}`;
    const m = messageOf(() => K.readKeyFile("/k", deps({ "/k": { text: two } })));
    expect(m).toBe("/k does not contain a single Anthropic API key");
    expect(m).not.toContain(KEY);
    const bad = messageOf(() =>
      K.loadKey({ env: { ANTHROPIC_API_KEY: "not-a-key with spaces" } }, deps({}))
    );
    expect(bad).toBe("ANTHROPIC_API_KEY does not contain a single Anthropic API key");
  });
});

describe("keeping the key out of every output", () => {
  test("scrubber replaces the key and nothing else", () => {
    const scrub = K.scrubber(KEY);
    expect(scrub(`error: invalid x-api-key ${KEY} (401)`)).toBe(
      "error: invalid x-api-key [redacted] (401)"
    );
    expect(scrub("no key here")).toBe("no key here");
    expect(K.scrubber(null)("unchanged")).toBe("unchanged");
  });

  test("childEnv and stripAnthropicEnv remove every ANTHROPIC_* variable", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_LOG: "debug",
      anthropic_api_key_file: "/k",
      LOCALSTACK_AUTH_TOKEN: "ls-x",
      PATH: "/bin",
    };
    expect(Object.keys(K.childEnv(env)).sort()).toEqual(["LOCALSTACK_AUTH_TOKEN", "PATH"]);
    expect(K.stripAnthropicEnv(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_LOG",
      "anthropic_api_key_file",
    ]);
    expect(env).toEqual({ LOCALSTACK_AUTH_TOKEN: "ls-x", PATH: "/bin" });
  });

  test("the refusal message names the ways to provide a key and the no-spend modes", () => {
    expect(K.NO_KEY_MESSAGE).toContain("ANTHROPIC_API_KEY");
    expect(K.NO_KEY_MESSAGE).toContain("--key-file");
    expect(K.NO_KEY_MESSAGE).toContain("--oracle, --negative and --dry-run");
  });
});

// run.mjs loads its .ts modules with Node's built-in type stripping (22.18+, 23.6+).
const [major, minor] = process.versions.node.split(".").map(Number);
const TYPE_STRIPPING = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

(TYPE_STRIPPING ? describe : describe.skip)("run.mjs without a key", () => {
  const runMjs = path.join(__dirname, "run.mjs");

  function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^ANTHROPIC_/i.test(k)) env[k] = v;
    return { ...env, NODE_NO_WARNINGS: "1", ...extra };
  }

  test("exits 2 with the clear message, writes nothing and opens no connection", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "e2-nokey-"));
    const marker = path.join(tmp, "connect-attempted");
    const hook = path.join(tmp, "no-network.mjs");
    // Preloaded into the runner: any socket connection (http, https, fetch all end in
    // net.Socket#connect) writes the marker and throws.
    writeFileSync(
      hook,
      [
        'import net from "node:net";',
        'import { writeFileSync } from "node:fs";',
        `const marker = ${JSON.stringify(marker)};`,
        "const connect = net.Socket.prototype.connect;",
        "net.Socket.prototype.connect = function (...args) {",
        '  writeFileSync(marker, "connect");',
        '  throw new Error("network access in a no-key run");',
        "};",
        "void connect;",
      ].join("\n")
    );
    const out = path.join(tmp, "results");
    const r = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(hook).href, runMjs, "--runs", "1", "--out", out],
      {
        env: cleanEnv(),
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "E2 needs an Anthropic API key to call the model, and none was found."
    );
    expect(existsSync(out)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("an unreadable key file is refused the same way, and its content is not echoed", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "e2-badkey-"));
    const keyFile = path.join(tmp, "key.txt");
    writeFileSync(keyFile, "sk-ant-api03-SECRET-1 sk-ant-api03-SECRET-2\n");
    chmodSync(keyFile, 0o600); // private, so POSIX refuses it for its content, not its mode
    const r = spawnSync(
      process.execPath,
      [runMjs, "--key-file", keyFile, "--out", path.join(tmp, "o")],
      {
        env: cleanEnv(),
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("does not contain a single Anthropic API key");
    expect(`${r.stdout}${r.stderr}`).not.toContain("SECRET");
    expect(readFileSync(keyFile, "utf8")).toContain("SECRET-1");
  });
});
