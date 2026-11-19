#!/usr/bin/env node
/**
 * Checks that the server manages a container lstk started: lstk starts the AWS emulator
 * with a pinned tag (so its container is `localstack-aws-<tag>`), the server restarts
 * it, and lstk still finds it afterwards.
 *
 * Usage:
 *   node tests/docker/validate-lstk.mjs -- <server-command> [args...]
 *
 * The server command must pass LOCALSTACK_PORT=<HARNESS_LSTK_PORT> to the server, so its
 * tools reach the gateway lstk publishes. Needs `lstk` on PATH, LOCALSTACK_AUTH_TOKEN,
 * and free host ports 443 and 4510-4560 (lstk always publishes them).
 *
 * Env knobs:
 *   HARNESS_LSTK_TAG    Image tag lstk runs (default "mcp-ci"). A tag that exists only
 *                       locally works: lstk falls back to the local image when the pull fails.
 *   HARNESS_LSTK_PORT   Gateway port lstk publishes (default 4577).
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1 || sep === argv.length - 1) {
  console.error("Usage: node validate-lstk.mjs -- <server-command> [args...]");
  process.exit(2);
}

const TAG = process.env.HARNESS_LSTK_TAG || "mcp-ci";
const PORT = process.env.HARNESS_LSTK_PORT || "4577";
const NAME = `localstack-aws-${TAG}`;
const LSTK_LABEL = "cloud.localstack.lstk";

const configDir = mkdtempSync(join(tmpdir(), "lsmcp-lstk-"));
const configPath = join(configDir, "config.toml");
writeFileSync(configPath, `[[containers]]\ntype = "aws"\ntag = "${TAG}"\nport = "${PORT}"\n`);

// ---- helpers ----------------------------------------------------------------
function run(cmd, args, timeoutMs = 300000) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LSTK_STARTUP_TIMEOUT: "180s" },
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ""}${error.stderr || ""}${error.message}` };
  }
}
const lstk = (...args) => run("lstk", ["--config", configPath, ...args]);

function inspect(name) {
  const r = run("docker", ["inspect", name], 30000);
  if (!r.ok) return undefined;
  return JSON.parse(r.out)[0];
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  ${name}`);
  if (detail) console.log("   " + String(detail).replace(/\n/g, "\n   ").slice(0, 1200));
}

// ---- MCP stdio client -------------------------------------------------------
const child = spawn(argv[sep + 1], argv.slice(sep + 2), { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
const serverLog = [];
let buf = "";
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const waiter = msg.id !== undefined && pending.get(msg.id);
    if (!waiter) continue;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  }
});
child.stderr.on("data", (c) => serverLog.push(c.toString().trimEnd()));

function rpc(method, params, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => (clearTimeout(timer), resolve(r)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function callTool(name, args, timeoutMs) {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const text = (res?.content || []).map((c) => c.text || "").join("\n");
  return { text, isError: res?.isError === true || text.trimStart().startsWith("❌") };
}

// ---- scenario ---------------------------------------------------------------
async function main() {
  const started = lstk("start");
  const before = inspect(NAME);
  record(
    `lstk start runs ${NAME}`,
    started.ok && before?.State?.Running && before.Config.Labels?.[LSTK_LABEL] === "true",
    started.out.slice(-600)
  );
  if (!before?.State?.Running) return;

  await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ls-mcp-lstk-validator", version: "1.0.0" },
    },
    60000
  );
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );

  const restart = await callTool("localstack-management", { action: "restart" }, 300000);
  record("localstack-management restart succeeds", !restart.isError, restart.text.slice(0, 600));

  const after = inspect(NAME);
  const gateway = after?.HostConfig?.PortBindings?.["4566/tcp"]?.[0]?.HostPort;
  record(
    "the recreated container keeps lstk's name, image and label, on LOCALSTACK_PORT",
    Boolean(after?.State?.Running) &&
      after.Id !== before.Id &&
      after.Config.Image === before.Config.Image &&
      after.Config.Labels?.[LSTK_LABEL] === "true" &&
      gateway === PORT,
    `id changed: ${after?.Id !== before.Id}, image: ${after?.Config?.Image}, ` +
      `label: ${after?.Config?.Labels?.[LSTK_LABEL]}, gateway host port: ${gateway}`
  );

  const status = lstk("status");
  record(
    "lstk status finds the restarted container",
    status.ok && !/not running/i.test(status.out),
    status.out.slice(-400)
  );

  const stopped = lstk("stop");
  record(
    "lstk stop stops the restarted container",
    stopped.ok && !inspect(NAME)?.State?.Running,
    stopped.out.slice(-400)
  );
}

function finish(code) {
  try {
    child.stdin.end();
    child.kill("SIGTERM");
  } catch {}
  run("docker", ["rm", "-f", NAME], 60000);
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(64));
  console.log(`SUMMARY: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length || code) {
    console.log("\n--- recent server stderr (last 25 lines) ---");
    console.log(serverLog.slice(-25).join("\n"));
  }
  console.log("=".repeat(64));
  process.exit(code || (failed.length || results.length === 0 ? 1 : 0));
}

main()
  .then(() => finish(0))
  .catch((e) => {
    console.error("\nHARNESS ERROR:", e.message);
    finish(1);
  });
