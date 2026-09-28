"use strict";
// The Node half of the L4 `az` shim (plan task 4.4; review R02 gap C and N2).
//
// `tests/azure/samples-shim/az` (bash) hands this script its argv, NUL-separated on stdin
// with the count in AZ_SHIM_ARGC. That keeps every byte intact on all platforms: on
// Windows, Git Bash would otherwise rewrite `/subscriptions/...` arguments into Windows
// paths on their way to node.exe (MSYS path conversion). Run directly
// (`node az-shim.cjs group list`), it takes its arguments from process.argv instead.
//
// For each call it:
// 1. quotes argv back into ONE command string (quote.cjs, the tokenizer's inverse);
// 2. spawns the built server (`node dist/cli.js`) over stdio with this process's WHOLE
//    environment (not the SDK transport's safe list), plus LOCALSTACK_AZ_TEST_ENVELOPE=1,
//    LOCALSTACK_AZ_WORKDIR=<this cwd> (scripts pass relative file names after a `cd`, and
//    the tool runs az in its workdir; AZ_SHIM_ROOT widens it for a file elsewhere in the
//    sample, see workdirFor) and this directory removed from PATH (else the tool would
//    resolve `az` to this shim);
// 3. calls `localstack-azure-client` once, and reads the test envelope (task 2.9):
//    `{exitCode, stdout, stderr, notes, classId, truncated}`;
// 4. writes the envelope's stdout to fd 1 and its stderr plus the notes to fd 2, and
//    exits with its exitCode, so `VAR=$(az ...)` captures exactly what az printed.
//
// Exit codes besides az's own (see README.md):
//   1   the tool stopped az or az never finished (timeout, cancel, egress fail-fast,
//       capture cap, spawn error): the tool's first line says `exit none`;
//   2   the tool answered without running az: a policy refusal, or a preflight or
//       configuration error (no envelope). Like az's own usage errors, which exit 2;
//   125 the shim itself failed: the server did not start, crashed, timed out, broke the
//       protocol, or answered without an envelope.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { toToolCommand } = require("./quote.cjs");

const TOOL_NAME = "localstack-azure-client";
const SHIM_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_SERVER_JS = path.join(REPO_ROOT, "dist", "cli.js");

const EXIT = Object.freeze({ STOPPED: 1, REFUSED: 2, SHIM_ERROR: 125 });

/** Set in the server's environment; seeing it here means the tool ran this shim as `az`. */
const RECURSION_VAR = "LOCALSTACK_AZ_SHIM_ACTIVE";
/** The first line of every note or message the shim adds on fd 2. */
const NOTE_PREFIX = "[localstack-azure-client] ";
/** go-azure-sdk and `az acr login` use this user name with an ACR access token. */
const ACR_TOKEN_USER = "00000000-0000-0000-0000-000000000000";

class ShimError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ShimError";
    this.details = details;
  }
}

// ---------------------------------------------------------------------------------------
// Arguments

/**
 * The argv to run. With AZ_SHIM_ARGC set (the bash shim), `stdin` holds exactly that many
 * NUL-terminated fields (`printf '%s\0' "$@"`); otherwise `fallback` (process.argv) is used.
 */
function readArgv(env, stdin, fallback) {
  const raw = env.AZ_SHIM_ARGC;
  if (raw === undefined || raw === "") return fallback;
  const argc = Number(raw);
  if (!Number.isInteger(argc) || argc < 0) {
    throw new ShimError(`AZ_SHIM_ARGC is not an argument count: ${JSON.stringify(raw)}`);
  }
  const text = (stdin || Buffer.alloc(0)).toString("utf8");
  if (argc === 0) {
    if (text !== "") throw new ShimError("AZ_SHIM_ARGC=0, but arguments arrived on stdin");
    return [];
  }
  // A NUL never occurs inside a UTF-8 multi-byte sequence, so splitting the decoded text
  // is safe. printf ends every field with a NUL, so the last element must be empty.
  const fields = text.split("\0");
  if (fields.length !== argc + 1 || fields[argc] !== "") {
    throw new ShimError(
      `expected ${argc} NUL-terminated arguments on stdin, got ${fields.length - 1}`
    );
  }
  return fields.slice(0, argc);
}

/**
 * Git Bash converts a `/c/...` argument into `C:/...` when it starts a native Windows program, so
 * a sample's `$(pwd)/file` reaches a real Windows az as a Windows path. The bash shim hands this
 * script its argv NUL-separated precisely to skip that conversion (it would also rewrite ARM ids
 * such as `/subscriptions/...`), so on Windows the shim redoes the one part a Windows az needs: a
 * single-letter drive root, alone or as a `--flag=` value. Multi-letter roots are left alone
 * (without it, `apim api import --specification-path /c/...` could not be opened).
 */
function msysDrivePath(value) {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(value);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : value;
}

function convertMsysDrivePaths(argv, platform = process.platform) {
  if (platform !== "win32") return argv;
  return argv.map((arg) => {
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      return eq > 0 ? arg.slice(0, eq + 1) + msysDrivePath(arg.slice(eq + 1)) : arg;
    }
    return msysDrivePath(arg);
  });
}

function isInside(target, dir, api) {
  const rel = api.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The workdir for one call. The tool runs az in its workdir and refuses files outside it, so it is
 * the cwd the script called az from: relative paths then resolve as a real az's would. A script
 * that `cd`s into a subfolder and names a file elsewhere in the sample by absolute path
 * (`$SCRIPT_DIR/../apim/openapi.json`) was then refused, which no user sees: a user's workdir is
 * the whole project. So when an argument (or a `--flag=` or `@file` value) names an existing file
 * inside `root` (AZ_SHIM_ROOT, the sample's folder) but outside the cwd, the workdir is `root`,
 * unless another argument is a relative path, which moving az would change.
 */
function workdirFor(argv, cwd, root, platform = process.platform) {
  const api = pathApi(platform);
  if (!root || !isInside(api.resolve(cwd), api.resolve(root), api)) return cwd;
  let widen = false;
  for (const arg of argv) {
    let value = arg;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq <= 0) continue;
      value = arg.slice(eq + 1);
    }
    if (value.startsWith("@")) value = value.slice(1);
    if (value === "") continue;
    if (!api.isAbsolute(value)) {
      if (fs.existsSync(api.resolve(cwd, value))) return cwd;
      continue;
    }
    const target = api.resolve(value);
    if (!isInside(target, cwd, api) && isInside(target, root, api) && isFile(target)) widen = true;
  }
  return widen ? api.resolve(root) : cwd;
}

function readStdin(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------------------
// The server's environment

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function samePath(a, b, platform) {
  const api = pathApi(platform);
  const norm = (p) => {
    let resolved = api.resolve(p);
    if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (norm(a) === norm(b)) return true;
  try {
    return norm(fs.realpathSync(a)) === norm(fs.realpathSync(b));
  } catch {
    return false;
  }
}

/** PATH without `dir` (empty entries, which mean the cwd, are kept as they are). */
function stripDirFromPath(value, dir, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(value || "")
    .split(delimiter)
    .filter((entry) => entry === "" || !samePath(entry.replace(/^"(.*)"$/, "$1"), dir, platform))
    .join(delimiter);
}

/**
 * `parent` minus the shim's own AZ_SHIM_* control variables, with this directory removed
 * from PATH (one PATH key, whatever its case on Windows).
 */
function childEnv(parent, { platform = process.platform, shimDir = SHIM_DIR } = {}) {
  const env = {};
  let pathValue;
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const isPath = platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";
    if (isPath) {
      if (pathValue === undefined) pathValue = value;
      continue;
    }
    if (key.startsWith("AZ_SHIM_")) continue;
    env[key] = value;
  }
  if (pathValue !== undefined) env.PATH = stripDirFromPath(pathValue, shimDir, platform);
  return env;
}

/**
 * The server's environment: all of `parent` (review R02 gap C) as childEnv() leaves it,
 * plus the variables the replay depends on.
 */
function serverEnv(
  parent,
  { cwd, workdir = cwd, platform = process.platform, shimDir = SHIM_DIR } = {}
) {
  const env = childEnv(parent, { platform, shimDir });
  env.LOCALSTACK_AZ_TEST_ENVELOPE = "1";
  // az runs in the tool's workdir, so relative paths resolve against it: the cwd the script
  // called az from, as a real az would, or the sample's folder (workdirFor).
  env.LOCALSTACK_AZ_WORKDIR = workdir;
  if (env.MCP_ANALYTICS_DISABLED === undefined) env.MCP_ANALYTICS_DISABLED = "1";
  env[RECURSION_VAR] = "1";
  return env;
}

// ---------------------------------------------------------------------------------------
// One tool call over stdio (mirrors tests/azure/tools/stdio-client.mjs)

function timeoutMsFrom(env) {
  const explicit = Number(env.AZ_SHIM_TIMEOUT_SECONDS);
  if (env.AZ_SHIM_TIMEOUT_SECONDS && Number.isFinite(explicit) && explicit > 0) {
    return Math.round(explicit * 1000);
  }
  // The tool's own per-command limit, plus room for the server start, the preflights and
  // a first-call bootstrap (five az calls).
  const tool = Number(env.LOCALSTACK_AZ_TIMEOUT_SECONDS);
  const toolSeconds = Number.isFinite(tool) && tool > 0 ? tool : 300;
  return (toolSeconds + 300) * 1000;
}

/**
 * Spawn the server, initialize, call the tool once, and close. Resolves
 * `{ result, serverStderr }`; rejects with a ShimError.
 */
function callTool(command, opts) {
  const {
    serverJs = DEFAULT_SERVER_JS,
    node = process.execPath,
    cwd,
    env,
    timeoutMs,
    toolName = TOOL_NAME,
  } = opts;
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(serverJs)) {
      reject(
        new ShimError(
          `the MCP server ${serverJs} does not exist; run \`yarn build\` (or set AZ_SHIM_SERVER_JS)`
        )
      );
      return;
    }
    const child = spawn(node, [serverJs], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let serverStderr = "";
    let buffer = "";
    let settled = false;
    let answer;
    const pending = new Map();
    let nextId = 1;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The server exits when its stdin closes (its exit hook also kills any live az tree).
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      const killTimer = setTimeout(() => child.kill(), 5000);
      const done = () => {
        clearTimeout(killTimer);
        if (error) reject(error);
        else resolve({ ...value, serverStderr });
      };
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once("close", done);
    };

    const timer = setTimeout(() => {
      finish(
        new ShimError(`no answer from the MCP server within ${Math.round(timeoutMs / 1000)} s`)
      );
    }, timeoutMs);

    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(new ShimError(`could not start the MCP server: ${error.message}`));
    });
    child.stderr.on("data", (chunk) => {
      serverStderr += chunk.toString("utf8");
      if (serverStderr.length > 200_000) serverStderr = serverStderr.slice(-100_000);
    });
    child.stdin.on("error", () => {
      /* the server went away; reported through 'close' */
    });
    // 'close', not 'exit': it fires after stdout has delivered everything it read.
    child.on("close", (code, signal) => {
      if (answer === undefined && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new ShimError(
            `the MCP server exited (code ${code}, signal ${signal}) before answering`,
            serverStderr.slice(-4000)
          )
        );
      }
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // not JSON-RPC (a stray log line)
        }
        if (message.id !== undefined && pending.has(message.id)) {
          const handler = pending.get(message.id);
          pending.delete(message.id);
          handler(message);
        }
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params, onReply) => {
      const id = nextId++;
      pending.set(id, onReply);
      send({ jsonrpc: "2.0", id, method, params });
    };

    request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "localstack-az-shim", version: "0.0.0" },
      },
      (init) => {
        if (init.error) {
          finish(new ShimError(`initialize failed: ${JSON.stringify(init.error)}`));
          return;
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        request("tools/call", { name: toolName, arguments: { command } }, (reply) => {
          if (reply.error) {
            finish(new ShimError(`tools/call failed: ${JSON.stringify(reply.error)}`));
            return;
          }
          answer = reply.result;
          finish(undefined, { result: reply.result });
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------------------
// Turning the tool's answer into fd 1, fd 2 and an exit code

function textItems(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
}

/** The test envelope, `null` when there is none, `undefined` when it is malformed. */
function parseEnvelope(text) {
  if (text === undefined) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const ok =
    value &&
    typeof value === "object" &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => typeof note === "string");
  return ok ? value : undefined;
}

/** The tool's failure line when it stopped az itself (src/lib/azure/output.ts firstLine). */
const STOPPED_BY_TOOL = /^❌ \*\*Command Failed\*\* \(exit none, /;

function isVersionCommand(argv) {
  return argv[0] === "version" || (argv.length === 1 && argv[0] === "--version");
}

function noteLines(notes) {
  return notes.map((note) => `${NOTE_PREFIX}${note}\n`).join("");
}

function withNewline(text) {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * What to write to fd 1 and fd 2, and the exit code, for one tool answer. Pure; the
 * returned `record` feeds the AZ_SHIM_LOG line.
 *
 * `newlines: "lf"` turns CRLF into LF in both streams (AZ_SHIM_NEWLINES=lf). Windows az
 * prints CRLF, which bash's `$(...)` keeps as a trailing CR; the samples expect LF.
 */
function planOutput(result, argv, { newlines = "keep" } = {}) {
  const texts = textItems(result);
  const text = texts[0] ?? "";
  const envelope = parseEnvelope(texts[1]);
  const convert = (s) => (newlines === "lf" ? s.replace(/\r\n/g, "\n") : s);
  const firstLine = text.split("\n", 1)[0];

  if (envelope === undefined) {
    return {
      stdout: "",
      stderr: `${NOTE_PREFIX}the tool's second content item is not a test envelope.\n${withNewline(text)}`,
      exitCode: EXIT.SHIM_ERROR,
      record: { envelope: false, shimError: "malformed envelope", toolFirstLine: firstLine },
    };
  }

  if (envelope) {
    let stderr = envelope.stderr;
    if (envelope.notes.length > 0) stderr = withNewline(stderr) + noteLines(envelope.notes);
    let exitCode = envelope.exitCode;
    const stopped =
      typeof envelope.stoppedByTool === "boolean"
        ? envelope.stoppedByTool
        : STOPPED_BY_TOOL.test(firstLine);
    if (exitCode === null || stopped) {
      // The tool stopped az (timeout, cancel, egress fail-fast, capture cap) or never got
      // it running. The envelope then holds the killed process's code (null after a POSIX
      // signal, 1 after taskkill; even 0 after a fail-fast), so the envelope's
      // stoppedByTool says so (older servers: the first line, `(exit none, <class>)`).
      stderr = withNewline(stderr) + `${NOTE_PREFIX}${withNewline(text)}`;
      exitCode = EXIT.STOPPED;
    } else if (exitCode < 0 || exitCode > 255) {
      stderr = withNewline(stderr) + `${NOTE_PREFIX}az exited with code ${exitCode}.\n`;
      exitCode = EXIT.STOPPED;
    }
    return {
      stdout: convert(envelope.stdout),
      stderr: convert(stderr),
      exitCode,
      record: {
        envelope: true,
        azExitCode: envelope.exitCode,
        classId: envelope.classId ?? null,
        truncated: Boolean(envelope.truncated),
        notes: envelope.notes,
        toolFirstLine: envelope.exitCode === 0 ? undefined : firstLine,
      },
    };
  }

  // No envelope: the tool did not run the command through az.
  if (result && result.isError !== true && !text.startsWith("❌") && isVersionCommand(argv)) {
    // `version` is answered locally (az version would call Microsoft): a JSON body, a blank
    // line, then a sentence. The JSON goes to fd 1, as `az version` prints it.
    const cut = text.indexOf("\n\n");
    const head = cut === -1 ? text : text.slice(0, cut);
    let json;
    try {
      json = JSON.parse(head);
    } catch {
      json = undefined;
    }
    if (json !== undefined) {
      const rest = cut === -1 ? "" : text.slice(cut + 2).trim();
      return {
        stdout: `${head}\n`,
        stderr: rest ? `${NOTE_PREFIX}${rest}\n` : "",
        exitCode: 0,
        record: { envelope: false, local: "version" },
      };
    }
  }
  if ((result && result.isError === true) || text.startsWith("❌")) {
    return {
      stdout: "",
      stderr: withNewline(text),
      exitCode: EXIT.REFUSED,
      record: { envelope: false, refusal: firstLine },
    };
  }
  return {
    stdout: "",
    stderr:
      `${NOTE_PREFIX}the tool answered without a test envelope; is LOCALSTACK_AZ_TEST_ENVELOPE=1 ` +
      `reaching the server?\n${withNewline(text)}`,
    exitCode: EXIT.SHIM_ERROR,
    record: { envelope: false, shimError: "no envelope", toolFirstLine: firstLine },
  };
}

// ---------------------------------------------------------------------------------------
// CI only: `acr login` without --expose-token (review R02 N1)

const ACR_VALUE_FLAGS = new Set([
  "--name",
  "-n",
  "--resource-group",
  "-g",
  "--subscription",
  "--suffix",
]);
const ACR_SWITCHES = new Set(["--only-show-errors", "--verbose", "--debug"]);

/**
 * The policy refuses `acr login` without --expose-token (az would run `docker login` with
 * the token on its command line). With AZURE_SAMPLES_CI_REWRITE=1 the shim instead asks
 * for the token and pipes it to `docker login --password-stdin` itself. Only the plain
 * forms the samples use are rewritten; anything else (a --username, say) is left alone
 * and refused as usual. Returns null when the call is not rewritten.
 */
function planAcrLoginRewrite(argv) {
  if (argv[0] !== "acr" || argv[1] !== "login") return null;
  const kept = [];
  let registry;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === "--expose-token" || flag === "-t") return null; // already the token form
    if (ACR_VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) return null;
      if (flag === "--name" || flag === "-n") registry = value;
      kept.push(flag, value);
    } else if (ACR_SWITCHES.has(flag)) {
      kept.push(arg);
    } else if (flag === "--output" || flag === "-o") {
      if (eq <= 0) i++; // replaced by --output json below
    } else {
      return null;
    }
  }
  if (!registry) return null;
  return { registry, toolArgv: ["acr", "login", ...kept, "--expose-token", "--output", "json"] };
}

/** `{accessToken, loginServer}` from `acr login --expose-token --output json`. */
function parseAcrToken(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!value || typeof value.accessToken !== "string" || typeof value.loginServer !== "string") {
    return undefined;
  }
  return { accessToken: value.accessToken, loginServer: value.loginServer };
}

/** `docker login <server> -u <token user> --password-stdin`, token on stdin (never argv). */
function dockerLogin(token, { env, docker, stdout, stderr }) {
  return new Promise((resolve) => {
    if (!env.DOCKER_CONFIG) {
      stderr.write(
        `${NOTE_PREFIX}refusing to run docker login without DOCKER_CONFIG (a throwaway docker config dir).\n`
      );
      resolve(EXIT.REFUSED);
      return;
    }
    const child = spawn(
      docker,
      ["login", token.loginServer, "--username", ACR_TOKEN_USER, "--password-stdin"],
      { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.on("error", (error) => {
      stderr.write(`${NOTE_PREFIX}could not run ${docker}: ${error.message}\n`);
      resolve(EXIT.SHIM_ERROR);
    });
    child.on("close", (code) => resolve(code === null ? EXIT.STOPPED : code));
    child.stdin.on("error", () => {});
    child.stdin.end(`${token.accessToken}\n`);
  });
}

// ---------------------------------------------------------------------------------------
// main

function writeAll(stream, data) {
  return new Promise((resolve) => {
    if (!data) {
      resolve();
      return;
    }
    stream.write(data, () => resolve());
  });
}

function appendLog(file, record) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* the log is best effort */
  }
}

function clip(value, max = 500) {
  return value.length > max ? `${value.slice(0, max)}...(${value.length} chars)` : value;
}

async function main() {
  const env = process.env;
  const stdout = process.stdout;
  const stderr = process.stderr;
  // A closed pipe (`az ... | head -1`) must not crash the shim.
  stdout.on("error", () => {});
  stderr.on("error", () => {});

  if (env.AZ_SHIM_IDENTIFY) {
    await writeAll(stdout, `localstack-az-shim ${SHIM_DIR}\n`);
    return 0;
  }
  if (env[RECURSION_VAR] === "1") {
    await writeAll(
      stderr,
      `${NOTE_PREFIX}the az shim was started from inside the MCP server: the tool resolved \`az\` ` +
        "to the shim. Set LOCALSTACK_AZ_PATH to the real az.\n"
    );
    return EXIT.SHIM_ERROR;
  }

  const started = Date.now();
  const cwd = process.cwd();
  const record = { ts: new Date(started).toISOString(), step: env.AZ_SHIM_STEP, cwd };
  let exitCode = EXIT.SHIM_ERROR;
  try {
    const stdin =
      env.AZ_SHIM_ARGC && env.AZ_SHIM_ARGC !== "0" ? await readStdin(process.stdin) : undefined;
    // Git Bash callers (the bash shim sets AZ_SHIM_ARGC) get the drive-root conversion a native
    // Windows az would have had from MSYS; cmd.exe callers (az.cmd) pass Windows paths.
    const read = readArgv(env, stdin, process.argv.slice(2));
    const argv = env.AZ_SHIM_ARGC ? convertMsysDrivePaths(read) : read;
    record.argv = argv.map((arg) => clip(arg));
    const workdir = workdirFor(argv, cwd, env.AZ_SHIM_ROOT);
    if (workdir !== cwd) record.workdir = workdir;

    const callOpts = {
      serverJs: env.AZ_SHIM_SERVER_JS || DEFAULT_SERVER_JS,
      cwd,
      env: serverEnv(env, { cwd, workdir }),
      timeoutMs: timeoutMsFrom(env),
    };
    const newlines = env.AZ_SHIM_NEWLINES === "lf" ? "lf" : "keep";
    const rewrite = env.AZURE_SAMPLES_CI_REWRITE === "1" ? planAcrLoginRewrite(argv) : null;

    if (rewrite) {
      record.rewrite = "acr-login";
      const { result } = await callTool(toToolCommand(rewrite.toolArgv), callOpts);
      const plan = planOutput(result, rewrite.toolArgv, { newlines });
      Object.assign(record, plan.record);
      const token = plan.exitCode === 0 ? parseAcrToken(plan.stdout) : undefined;
      if (!token) {
        await writeAll(
          stderr,
          plan.stderr || `${NOTE_PREFIX}acr login --expose-token printed no token.\n`
        );
        exitCode = plan.exitCode === 0 ? EXIT.SHIM_ERROR : plan.exitCode;
      } else {
        exitCode = await dockerLogin(token, {
          env: childEnv(env),
          docker: env.AZ_SHIM_DOCKER || "docker",
          stdout,
          stderr,
        });
      }
    } else {
      const { result, serverStderr } = await callTool(toToolCommand(argv), callOpts);
      const plan = planOutput(result, argv, { newlines });
      Object.assign(record, plan.record);
      await writeAll(stdout, plan.stdout);
      await writeAll(stderr, plan.stderr);
      if (env.AZ_SHIM_DEBUG === "1") {
        await writeAll(
          stderr,
          `${NOTE_PREFIX}tool answer:\n${withNewline(textItems(result)[0] ?? "")}`
        );
        if (serverStderr)
          await writeAll(stderr, `${NOTE_PREFIX}server stderr:\n${withNewline(serverStderr)}`);
      }
      exitCode = plan.exitCode;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.shimError = message;
    const details = error && error.details ? `\n${withNewline(String(error.details))}` : "\n";
    await writeAll(stderr, `${NOTE_PREFIX}az shim error: ${message}${details}`);
    exitCode = EXIT.SHIM_ERROR;
  }
  record.exitCode = exitCode;
  record.ms = Date.now() - started;
  appendLog(env.AZ_SHIM_LOG, record);
  return exitCode;
}

module.exports = {
  EXIT,
  NOTE_PREFIX,
  RECURSION_VAR,
  ShimError,
  callTool,
  childEnv,
  convertMsysDrivePaths,
  dockerLogin,
  parseAcrToken,
  parseEnvelope,
  planAcrLoginRewrite,
  planOutput,
  readArgv,
  serverEnv,
  stripDirFromPath,
  timeoutMsFrom,
  workdirFor,
};

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${NOTE_PREFIX}az shim crashed: ${error && error.stack}\n`);
      process.exitCode = EXIT.SHIM_ERROR;
    }
  );
}
