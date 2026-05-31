#!/usr/bin/env node
/**
 * Self-contained MCP stdio client that drives the LocalStack MCP Server (typically
 * the Docker image) through a sequence of real tool calls and reports pass/fail.
 *
 * No external deps: speaks newline-delimited JSON-RPC 2.0 over the child's stdio,
 * which is exactly what the MCP stdio transport uses.
 *
 * Usage:
 *   node tests/docker/validate-image.mjs -- <server-command> [args...]
 *
 * Example (Docker image):
 *   node tests/docker/validate-image.mjs -- \
 *     docker run -i --rm \
 *       -v /var/run/docker.sock:/var/run/docker.sock \
 *       -v "$HOME/.localstack-mcp:$HOME/.localstack-mcp" \
 *       -e XDG_CACHE_HOME="$HOME/.localstack-mcp" \
 *       --add-host host.docker.internal:host-gateway \
 *       --add-host s3.host.docker.internal:host-gateway \
 *       --add-host snowflake.localhost.localstack.cloud:host-gateway \
 *       -e LOCALSTACK_AUTH_TOKEN -e LOCALSTACK_HOSTNAME=host.docker.internal \
 *       -v "$PWD/data:/work/data" \
 *       localstack/localstack-mcp-server:dev
 *
 * The cache bind mount + XDG_CACHE_HOME are required for the management tool's
 * `start` action under Docker-out-of-Docker: `localstack start` asks the HOST
 * daemon to bind-mount its license/machine/volume files, whose source paths must
 * exist at an identical path on the host (see docs/DOCKER.md).
 *
 * Env knobs:
 *   HARNESS_DEPLOY_DIR   In-container path to the terraform sample (default /work/data/sample-terraform)
 *   HARNESS_CDK_DIR      In-container path to the CDK sample (default /work/data/sample-cdk)
 *   HARNESS_TOKEN_REAL   "1" if LOCALSTACK_AUTH_TOKEN is a real/valid token (affects Pro-tool expectations)
 *   HARNESS_SKIP         Comma-separated scenario keys to skip (e.g. "deploy,extensions")
 *   HARNESS_NO_CLEANUP   "1" to leave LocalStack running afterwards
 *   HARNESS_RUN_REMOTE   "1" to create remote resources (Cloud Pods, ephemeral instances)
 *   HARNESS_RUN_EPHEMERAL "1" to create/delete a cloud-hosted ephemeral instance
 */

import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1 || sep === argv.length - 1) {
  console.error("Usage: node validate-image.mjs -- <server-command> [args...]");
  process.exit(2);
}
const serverCmd = argv[sep + 1];
const serverArgs = argv.slice(sep + 2);

const DEPLOY_DIR = process.env.HARNESS_DEPLOY_DIR || "/work/data/sample-terraform";
const CDK_DIR = process.env.HARNESS_CDK_DIR || "/work/data/sample-cdk";
const TOKEN_REAL = process.env.HARNESS_TOKEN_REAL === "1";
const SKIP = new Set((process.env.HARNESS_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean));
const NO_CLEANUP = process.env.HARNESS_NO_CLEANUP === "1";
const RUN_REMOTE = process.env.HARNESS_RUN_REMOTE === "1";
const RUN_EPHEMERAL = RUN_REMOTE || process.env.HARNESS_RUN_EPHEMERAL === "1";
const RUN_REPLICATOR_START = process.env.HARNESS_RUN_REPLICATOR_START === "1";
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const EXPECTED_TOOLS = [
  "localstack-management", "localstack-deployer", "localstack-logs-analysis",
  "localstack-iam-policy-analyzer", "localstack-chaos-injector", "localstack-cloud-pods",
  "localstack-state-management", "localstack-extensions", "localstack-snowflake-client",
  "localstack-ephemeral-instances", "localstack-aws-client", "localstack-aws-replicator",
  "localstack-docs", "localstack-app-inspector",
];

// ---- JSON-RPC over stdio ----------------------------------------------------
const child = spawn(serverCmd, serverArgs, { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const pending = new Map();
const serverLog = [];

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { serverLog.push(`[stdout-nonjson] ${line}`); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
child.stderr.on("data", (c) => serverLog.push(`[stderr] ${c.toString().trimEnd()}`));
child.on("exit", (code, sig) => {
  for (const { reject } of pending.values()) reject(new Error(`server exited (code=${code} sig=${sig})`));
  pending.clear();
});

function rpc(method, params, timeoutMs = 300000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(payload);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
async function callTool(name, args, timeoutMs) {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const text = (res?.content || []).map((c) => c.text || "").join("\n");
  return { text, isError: res?.isError === true || text.trimStart().startsWith("❌") };
}
async function getPrompt(name, args, timeoutMs = 60000) {
  return await rpc("prompts/get", { name, arguments: args }, timeoutMs);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Call a tool, retrying until `ok(result)` (default: not an error) or attempts run out.
async function callToolUntil(name, args, { attempts = 6, delayMs = 5000, timeoutMs = 60000, ok } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { last = await callTool(name, args, timeoutMs); }
    catch (e) { last = { text: String(e.message), isError: true }; }
    if (ok ? ok(last) : !last.isError) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last;
}

// ---- scenario runner --------------------------------------------------------
const results = [];
function record(key, name, ok, detail, note) {
  results.push({ key, name, ok, detail, note });
  const tag = ok === true ? "✅ PASS" : ok === "warn" ? "⚠️  WARN" : "❌ FAIL";
  console.log(`\n${tag}  [${key}] ${name}`);
  if (detail) console.log("   " + detail.replace(/\n/g, "\n   ").slice(0, 1200));
  if (note) console.log("   ↳ " + note);
}
const snip = (t, n = 400) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);
const hasAwsCreds = () => Boolean(
  process.env.AWS_REPLICATOR_SOURCE_AWS_ACCESS_KEY_ID ||
  process.env.AWS_ACCESS_KEY_ID
) && Boolean(
  process.env.AWS_REPLICATOR_SOURCE_AWS_SECRET_ACCESS_KEY ||
  process.env.AWS_SECRET_ACCESS_KEY
) && Boolean(
  process.env.AWS_REPLICATOR_SOURCE_REGION_NAME ||
  process.env.AWS_DEFAULT_REGION ||
  process.env.AWS_REGION
);

function gracefulProGate(result) {
  return result.isError && /(Authentication|Auth Token|Feature Not Available|license|not seem to include|requires a LocalStack license)/i.test(result.text);
}

function recordToolResult(key, name, result, predicate = (r) => !r.isError, note) {
  if (TOKEN_REAL) {
    record(key, name, predicate(result), snip(result.text, 600), note);
    return;
  }
  const graceful = gracefulProGate(result);
  record(
    key,
    `${name} (dummy token)`,
    graceful ? "warn" : false,
    snip(result.text, 400),
    graceful ? "graceful auth/Pro-gate failure (expected without a real token)" : note
  );
}

function firstMarkdownTableValue(text) {
  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^[-|:\s]+$/.test(trimmed) || /Trace ID|Span ID|Event ID/.test(trimmed)) {
      continue;
    }
    const cells = trimmed.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells[0] && cells[0] !== "-") return cells[0].replace(/^`|`$/g, "");
  }
  return undefined;
}

async function main() {
  // 1. Handshake
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ls-mcp-docker-validator", version: "1.0.0" },
  }, 60000);
  notify("notifications/initialized", {});
  console.log(`Connected. Server: ${init?.serverInfo?.name ?? "?"} ${init?.serverInfo?.version ?? ""}`);

  // 2. tools/list
  const toolsRes = await rpc("tools/list", {}, 60000);
  const toolNames = (toolsRes?.tools || []).map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((t) => !toolNames.includes(t));
  record("tools", "tools/list exposes all 14 tools", missing.length === 0,
    `found ${toolNames.length} tools`, missing.length ? `MISSING: ${missing.join(", ")}` : undefined);

  // 2b. prompts/get
  if (!SKIP.has("prompt")) {
    try {
      const prompts = await rpc("prompts/list", {}, 60000);
      const hasPrompt = (prompts?.prompts || []).some((prompt) => prompt.name === "infrastructure-tester");
      const prompt = await getPrompt("infrastructure-tester", { iac_path: "/work/data/sample-terraform" });
      const text = (prompt?.messages || []).map((msg) => msg?.content?.text || "").join("\n");
      record(
        "prompt",
        "infrastructure-tester prompt is exposed and renders",
        hasPrompt && /# Infrastructure Tester \(LocalStack\)/.test(text),
        snip(text, 400),
        hasPrompt ? undefined : "prompt missing from prompts/list"
      );
    } catch (e) { record("prompt", "infrastructure-tester prompt", false, String(e.message)); }
  }

  // 3. docs (token-only; calls an external API, so retry once for transient blips)
  if (!SKIP.has("docs")) {
    try {
      const r = await callToolUntil(
        "localstack-docs",
        { query: "how to start localstack and configure auth token", limit: 2 },
        { attempts: 2, delayMs: 3000, timeoutMs: 60000, ok: (x) => !x.isError && /LocalStack Docs/i.test(x.text) }
      );
      record("docs", "localstack-docs returns snippets", !r.isError && /LocalStack Docs/i.test(r.text), snip(r.text));
    } catch (e) { record("docs", "localstack-docs", false, String(e.message)); }
  }

  // 4. management status (pre-start) — validates CLI + docker socket reachability
  if (!SKIP.has("status")) {
    try {
      const r = await callTool("localstack-management", { action: "status" }, 60000);
      record("status", "localstack-management status (pre-start)", !r.isError, snip(r.text));
    } catch (e) { record("status", "management status", false, String(e.message)); }
  }

  // 5. management start (aws) — THE DooD test: CLI in container starts sibling on host
  if (!SKIP.has("start")) {
    try {
      const r = await callTool("localstack-management", { action: "start" }, 240000);
      const ok = !r.isError && /(started successfully|already running)/i.test(r.text);
      record("start", "localstack-management start (DooD sibling on host)", ok, snip(r.text, 500));
    } catch (e) { record("start", "management start", false, String(e.message)); }
  }

  // 5b. Readiness gate — after a cold start the container reports "running" before
  // every service accepts connections. A well-behaved client waits for readiness;
  // poll a trivial awslocal call until it succeeds before exercising services.
  if (!SKIP.has("start") && (!SKIP.has("aws") || !SKIP.has("deploy"))) {
    const ready = await callToolUntil(
      "localstack-aws-client",
      { command: "sts get-caller-identity" },
      { attempts: 24, delayMs: 5000, timeoutMs: 30000 }
    );
    console.log(`\n[readiness] LocalStack services ${ready.isError ? "NOT ready after wait" : "ready"}`);
  }

  // 6. aws-client — validates docker exec of awslocal inside the LS container
  if (!SKIP.has("aws")) {
    try {
      const mb = await callTool("localstack-aws-client", { command: "s3 mb s3://harness-test-bucket" }, 60000);
      const ls = await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
      const ok = !mb.isError && !ls.isError && /harness-test-bucket/.test(ls.text);
      record("aws", "localstack-aws-client (awslocal s3 mb + ls)", ok, `mb: ${snip(mb.text, 120)} | ls: ${snip(ls.text, 200)}`);
    } catch (e) { record("aws", "aws-client", false, String(e.message)); }
  }

  // 6b. logs-analysis — validates docker log access to the sibling LocalStack container.
  if (!SKIP.has("logs")) {
    try {
      await callTool("localstack-aws-client", { command: "s3api head-bucket --bucket definitely-missing-harness-bucket" }, 60000).catch(() => {});
      const summary = await callTool("localstack-logs-analysis", { analysisType: "summary", lines: 1000 }, 60000);
      const errors = await callTool("localstack-logs-analysis", { analysisType: "errors", lines: 1000, service: "s3" }, 60000);
      const requests = await callTool("localstack-logs-analysis", { analysisType: "requests", lines: 1000, service: "s3", operation: "CreateBucket" }, 60000);
      const raw = await callTool("localstack-logs-analysis", { analysisType: "logs", lines: 1000, filter: "harness-test-bucket" }, 60000);
      const ok = [summary, errors, requests, raw].every((r) => !r.isError) && /LocalStack Summary|Summary/i.test(summary.text);
      record("logs", "localstack-logs-analysis summary/errors/requests/logs", ok,
        `summary: ${snip(summary.text, 180)} | errors: ${snip(errors.text, 120)} | requests: ${snip(requests.text, 120)} | raw: ${snip(raw.text, 120)}`);
    } catch (e) { record("logs", "logs-analysis", false, String(e.message)); }
  }

  // 6c. state-management — export local state to a mounted path, reset, import, inspect.
  if (!SKIP.has("state")) {
    const bucket = `harness-state-${RUN_ID}`;
    const statePath = `/work/data/harness-state-${RUN_ID}.zip`;
    try {
      await callTool("localstack-aws-client", { command: `s3 mb s3://${bucket}` }, 60000);
      const exported = await callTool("localstack-state-management", { action: "export", file_path: statePath, services: ["s3"] }, 120000);
      const inspected = await callTool("localstack-state-management", { action: "inspect", services: "s3" }, 60000);
      const reset = await callTool("localstack-state-management", { action: "reset", services: ["s3"] }, 120000);
      const afterReset = await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
      const imported = await callTool("localstack-state-management", { action: "import", file_path: statePath }, 120000);
      const afterImport = await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
      const ok = !exported.isError && !inspected.isError && !reset.isError && !imported.isError && /State Exported/i.test(exported.text) && afterImport.text.includes(bucket);
      recordToolResult("state", "localstack-state-management export/inspect/reset/import", { text: `export: ${exported.text}\ninspect: ${inspected.text}\nreset: ${reset.text}\nimport: ${imported.text}\nafter reset: ${afterReset.text}\nafter import: ${afterImport.text}`, isError: !ok }, () => ok);
    } catch (e) { record("state", "state-management", false, String(e.message)); }
  }

  // 6d. cloud-pods — remote/cloud-backed snapshot. Opt in because it creates account resources.
  if (!SKIP.has("cloudpods")) {
    const podName = `mcp-harness-${RUN_ID}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
    const bucket = `harness-pod-${RUN_ID}`;
    if (!RUN_REMOTE) {
      record("cloudpods", "localstack-cloud-pods save/load/delete", "warn", "skipped remote Cloud Pod create/load/delete", "set HARNESS_RUN_REMOTE=1 to exercise remote Cloud Pods");
    } else {
      try {
        await callTool("localstack-cloud-pods", { action: "delete", pod_name: podName }, 120000).catch(() => {});
        await callTool("localstack-aws-client", { command: `s3 mb s3://${bucket}` }, 60000);
        const save = await callTool("localstack-cloud-pods", { action: "save", pod_name: podName }, 300000);
        const reset = await callTool("localstack-state-management", { action: "reset", services: ["s3"] }, 120000);
        const load = await callTool("localstack-cloud-pods", { action: "load", pod_name: podName }, 300000);
        const ls = await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
        const del = await callTool("localstack-cloud-pods", { action: "delete", pod_name: podName }, 120000);
        const ok = !save.isError && !reset.isError && !load.isError && !del.isError && ls.text.includes(bucket);
        recordToolResult("cloudpods", "localstack-cloud-pods save/reset/load/delete", { text: `save: ${save.text}\nload: ${load.text}\ndelete: ${del.text}\nls: ${ls.text}`, isError: !ok }, () => ok);
      } catch (e) {
        try { await callTool("localstack-cloud-pods", { action: "delete", pod_name: podName }, 120000); } catch {}
        record("cloudpods", "cloud-pods", false, String(e.message));
      }
    }
  }

  // 6e. app-inspector — enable, generate traffic, list traces and drill into spans/events when present.
  if (!SKIP.has("appinspector")) {
    try {
      const enable = await callTool("localstack-app-inspector", { action: "set-status", status: "enabled" }, 60000);
      await callTool("localstack-aws-client", { command: `s3 mb s3://harness-ai-${RUN_ID}` }, 60000);
      await sleep(2000);
      const traces = await callToolUntil(
        "localstack-app-inspector",
        { action: "list-traces", limit: 10 },
        { attempts: 6, delayMs: 3000, timeoutMs: 60000, ok: (r) => !r.isError && !/No traces found/i.test(r.text) }
      );
      const traceId = firstMarkdownTableValue(traces.text);
      let trace = { text: "", isError: false };
      let spans = { text: "", isError: false };
      let events = { text: "", isError: false };
      let iamEvents = { text: "", isError: false };
      if (traceId) {
        trace = await callTool("localstack-app-inspector", { action: "get-trace", trace_id: traceId }, 60000);
        spans = await callTool("localstack-app-inspector", { action: "list-spans", trace_id: traceId, limit: 10 }, 60000);
        const spanId = firstMarkdownTableValue(spans.text);
        if (spanId) {
          events = await callTool("localstack-app-inspector", { action: "list-events", trace_id: traceId, span_id: spanId, limit: 10 }, 60000);
          iamEvents = await callTool("localstack-app-inspector", { action: "list-iam-events", trace_id: traceId, span_id: spanId, limit: 10 }, 60000);
        }
      }
      const ok = !enable.isError && !traces.isError && Boolean(traceId) && !trace.isError && !spans.isError && !events.isError && !iamEvents.isError;
      recordToolResult("appinspector", "localstack-app-inspector enable/list/get/spans/events", { text: `enable: ${enable.text}\ntraces: ${traces.text}\ntrace: ${trace.text}\nspans: ${spans.text}\nevents: ${events.text}\niam: ${iamEvents.text}`, isError: !ok }, () => ok);
    } catch (e) { record("appinspector", "app-inspector", false, String(e.message)); }
  }

  // 6f. chaos-injector — add a deterministic S3 ListBuckets fault, observe it, then clear faults/latency.
  if (!SKIP.has("chaos")) {
    const rule = {
      service: "s3",
      region: "us-east-1",
      operation: "ListBuckets",
      probability: 1,
      error: { statusCode: 503, code: "ServiceUnavailable" },
    };
    try {
      const add = await callTool("localstack-chaos-injector", { action: "add-fault-rule", rules: [rule] }, 60000);
      const faults = await callTool("localstack-chaos-injector", { action: "get-faults" }, 60000);
      const affected = await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
      const latency = await callTool("localstack-chaos-injector", { action: "inject-latency", latency_ms: 25 }, 60000);
      const getLatency = await callTool("localstack-chaos-injector", { action: "get-latency" }, 60000);
      const clearLatency = await callTool("localstack-chaos-injector", { action: "clear-latency" }, 60000);
      const clear = await callTool("localstack-chaos-injector", { action: "clear-all-faults" }, 60000);
      const ok = !add.isError && !faults.isError && affected.isError && !latency.isError && !getLatency.isError && !clearLatency.isError && !clear.isError;
      recordToolResult("chaos", "localstack-chaos-injector add/get/effect/clear", { text: `add: ${add.text}\nfaults: ${faults.text}\naffected: ${affected.text}\nlatency: ${latency.text}\nget latency: ${getLatency.text}\nclear latency: ${clearLatency.text}\nclear: ${clear.text}`, isError: !ok }, () => ok);
    } catch (e) {
      try { await callTool("localstack-chaos-injector", { action: "clear-all-faults" }, 60000); } catch {}
      try { await callTool("localstack-chaos-injector", { action: "clear-latency" }, 60000); } catch {}
      record("chaos", "chaos-injector", false, String(e.message));
    }
  }

  // 6g. IAM policy analyzer — mode transitions plus log analysis, then restore disabled.
  if (!SKIP.has("iam")) {
    try {
      const status = await callTool("localstack-iam-policy-analyzer", { action: "get-status" }, 60000);
      const soft = await callTool("localstack-iam-policy-analyzer", { action: "set-mode", mode: "SOFT_MODE" }, 60000);
      await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
      const analyze = await callTool("localstack-iam-policy-analyzer", { action: "analyze-policies" }, 60000);
      const disabled = await callTool("localstack-iam-policy-analyzer", { action: "set-mode", mode: "DISABLED" }, 60000);
      const ok = !status.isError && !soft.isError && !analyze.isError && !disabled.isError;
      recordToolResult("iam", "localstack-iam-policy-analyzer status/set/analyze/restore", { text: `status: ${status.text}\nsoft: ${soft.text}\nanalyze: ${analyze.text}\ndisabled: ${disabled.text}`, isError: !ok }, () => ok);
    } catch (e) {
      try { await callTool("localstack-iam-policy-analyzer", { action: "set-mode", mode: "DISABLED" }, 60000); } catch {}
      record("iam", "iam-policy-analyzer", false, String(e.message));
    }
  }

  // 6h. aws-replicator — list endpoints always; start a job only when source AWS creds are explicitly available.
  if (!SKIP.has("replicator")) {
    try {
      const resources = await callTool("localstack-aws-replicator", { action: "list-resources" }, 120000);
      const jobs = await callTool("localstack-aws-replicator", { action: "list" }, 120000);
      let start = { text: "start skipped: no HARNESS_RUN_REPLICATOR_START=1 or source AWS credentials", isError: false };
      if (RUN_REPLICATOR_START && hasAwsCreds()) {
        start = await callTool("localstack-aws-replicator", {
          action: "start",
          replication_type: "SINGLE_RESOURCE",
          resource_type: process.env.HARNESS_REPLICATOR_RESOURCE_TYPE || "AWS::SSM::Parameter",
          resource_identifier: process.env.HARNESS_REPLICATOR_RESOURCE_IDENTIFIER || "/localstack-mcp-harness",
        }, 300000);
      }
      const ok = !resources.isError && !jobs.isError && !start.isError;
      const note = RUN_REPLICATOR_START && hasAwsCreds() ? undefined : "replication job start skipped unless HARNESS_RUN_REPLICATOR_START=1 and source AWS creds are set";
      recordToolResult("replicator", "localstack-aws-replicator list-resources/list/start-if-configured", { text: `resources: ${resources.text}\njobs: ${jobs.text}\nstart: ${start.text}`, isError: !ok }, () => ok, note);
    } catch (e) { record("replicator", "aws-replicator", false, String(e.message)); }
  }

  // 6i. ephemeral instances — list always; create/logs/delete only with explicit opt-in.
  if (!SKIP.has("ephemeral")) {
    const instanceName = `mcp-harness-${RUN_ID}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    try {
      const list = await callTool("localstack-ephemeral-instances", { action: "list" }, 120000);
      if (!RUN_EPHEMERAL) {
        recordToolResult("ephemeral", "localstack-ephemeral-instances list", list, (r) => !r.isError, "create/logs/delete skipped; set HARNESS_RUN_EPHEMERAL=1 to provision a short-lived cloud instance");
      } else {
        const create = await callTool("localstack-ephemeral-instances", { action: "create", name: instanceName, lifetime: 10 }, 240000);
        if (create.isError && /compute\.resource_exhausted|quota|limit/i.test(create.text)) {
          record(
            "ephemeral",
            "localstack-ephemeral-instances list/create",
            "warn",
            `list: ${snip(list.text, 300)}\ncreate: ${snip(create.text, 500)}`,
            "platform quota exhausted; create/logs/delete could not be completed"
          );
        } else {
          const logs = await callTool("localstack-ephemeral-instances", { action: "logs", name: instanceName }, 180000);
          const del = await callTool("localstack-ephemeral-instances", { action: "delete", name: instanceName }, 120000);
          const ok = !list.isError && !create.isError && !logs.isError && !del.isError;
          recordToolResult("ephemeral", "localstack-ephemeral-instances list/create/logs/delete", { text: `list: ${list.text}\ncreate: ${create.text}\nlogs: ${logs.text}\ndelete: ${del.text}`, isError: !ok }, () => ok);
        }
      }
    } catch (e) {
      if (RUN_EPHEMERAL) {
        try { await callTool("localstack-ephemeral-instances", { action: "delete", name: instanceName }, 120000); } catch {}
      }
      record("ephemeral", "ephemeral-instances", false, String(e.message));
    }
  }

  // 7. deployer terraform — THE networking test: tflocal in container reaches LS host
  if (!SKIP.has("deploy")) {
    try {
      const r = await callTool("localstack-deployer", { action: "deploy", projectType: "terraform", directory: DEPLOY_DIR }, 300000);
      const ok = !r.isError && /(completed successfully|Apply complete|bucket_name|Terraform Outputs)/i.test(r.text);
      record("deploy", "localstack-deployer terraform deploy (tflocal -> LS)", ok, snip(r.text, 600));
    } catch (e) { record("deploy", "deployer terraform", false, String(e.message)); }
  }

  // 7b. deployer CDK — validates cdklocal endpoint injection and virtual-hosted S3 alias.
  if (!SKIP.has("deploy-cdk")) {
    try {
      const r = await callTool("localstack-deployer", { action: "deploy", projectType: "cdk", directory: CDK_DIR }, 300000);
      const ls = await callTool("localstack-aws-client", { command: "s3 ls" }, 60000);
      const ok = !r.isError && !ls.isError && /CDK stack deployed successfully/i.test(r.text) && ls.text.includes("mcp-cdk-sample-bucket") && !/Error during `cdklocal/i.test(r.text);
      record("deploy-cdk", "localstack-deployer CDK deploy (cdklocal -> LS)", ok, `deploy: ${snip(r.text, 500)} | s3 ls: ${snip(ls.text, 160)}`);
    } catch (e) { record("deploy-cdk", "deployer CDK", false, String(e.message)); }
  }

  // 8. extensions — Pro-gated (needs valid token + marketplace API)
  if (!SKIP.has("extensions")) {
    try {
      const r = await callTool("localstack-extensions", { action: "available" }, 60000);
      recordToolResult("extensions", "localstack-extensions available (Pro)", r, (x) => !x.isError && /Marketplace|extensions available/i.test(x.text));
    } catch (e) { record("extensions", "extensions", false, String(e.message)); }
  }

  // 9. cleanup and remaining management lifecycle coverage
  if (!NO_CLEANUP && !SKIP.has("deploy")) {
    try { await callTool("localstack-deployer", { action: "destroy", projectType: "terraform", directory: DEPLOY_DIR }, 180000); } catch {}
  }
  if (!NO_CLEANUP && !SKIP.has("deploy-cdk")) {
    try { await callTool("localstack-deployer", { action: "destroy", projectType: "cdk", directory: CDK_DIR }, 180000); } catch {}
  }

  if (!SKIP.has("restart")) {
    try {
      const r = await callTool("localstack-management", { action: "restart" }, 120000);
      const ready = await callToolUntil(
        "localstack-aws-client",
        { command: "sts get-caller-identity" },
        { attempts: 12, delayMs: 5000, timeoutMs: 30000 }
      );
      record("restart", "localstack-management restart", !r.isError && !ready.isError, `restart: ${snip(r.text, 300)} | readiness: ${snip(ready.text, 160)}`);
    } catch (e) { record("restart", "management restart", false, String(e.message)); }
  }

  if (!SKIP.has("stop")) {
    try {
      const r = await callTool("localstack-management", { action: "stop" }, 60000);
      record("stop", "localstack-management stop", !r.isError && /(stopped|stop command executed)/i.test(r.text), snip(r.text, 300));
    } catch (e) { record("stop", "management stop", false, String(e.message)); }
  }

  // 10. Snowflake stack — starts a separate runtime flavor after the AWS stack is stopped.
  if (!SKIP.has("snowflake")) {
    try {
      const start = await callTool("localstack-management", { action: "start", service: "snowflake" }, 240000);
      const check = await callTool("localstack-snowflake-client", { action: "check-connection" }, 120000);
      const exec = await callTool("localstack-snowflake-client", { action: "execute", file_path: "/work/data/sample-sql/snowflake_test.sql" }, 180000);
      const ok = !start.isError && !check.isError && !exec.isError;
      recordToolResult("snowflake", "localstack-snowflake-client check-connection/execute file", { text: `start: ${start.text}\ncheck: ${check.text}\nexecute: ${exec.text}`, isError: !ok }, () => ok);
    } catch (e) { record("snowflake", "snowflake-client", false, String(e.message)); }
    finally {
      if (!NO_CLEANUP) {
        try { await callTool("localstack-management", { action: "stop" }, 60000); } catch {}
      }
    }
  }
}

main()
  .then(() => finish())
  .catch((e) => { console.error("\nHARNESS ERROR:", e.message); finish(1); });

function finish(forceCode) {
  try { child.stdin.end(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  const hard = results.filter((r) => r.ok === false);
  const warn = results.filter((r) => r.ok === "warn");
  const pass = results.filter((r) => r.ok === true);
  console.log("\n" + "=".repeat(64));
  console.log(`SUMMARY: ${pass.length} passed, ${warn.length} warn, ${hard.length} failed`);
  for (const r of results) {
    const tag = r.ok === true ? "PASS" : r.ok === "warn" ? "WARN" : "FAIL";
    console.log(`  [${tag}] ${r.key} — ${r.name}`);
  }
  if (hard.length || forceCode) {
    console.log("\n--- recent server stderr (last 25 lines) ---");
    console.log(serverLog.slice(-25).join("\n"));
  }
  console.log("=".repeat(64));
  process.exit(forceCode || (hard.length ? 1 : 0));
}
