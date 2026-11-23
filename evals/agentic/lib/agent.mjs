// Runs Claude Code headless as the agent under test, with only this repository's MCP server attached.
//
// Provider selection:
// - default: the local Claude Code login (a Claude subscription or ANTHROPIC_API_KEY), for local runs
// - OPENROUTER_API_KEY set: OpenRouter's Anthropic-compatible endpoint, for CI or for other models locally;
//   OPENROUTER_MODEL (required with it) picks the model, as an OpenRouter model slug
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pickEnv, redact } from "./secrets.mjs";

const MCP_SERVER_NAME = "localstack";
export const APP_INSPECTOR_TOOL = `mcp__${MCP_SERVER_NAME}__localstack-app-inspector`;
export const ANALYZER_TOOL = `mcp__${MCP_SERVER_NAME}__localstack-iam-policy-analyzer`;
const AWS_CLIENT_TOOL = `mcp__${MCP_SERVER_NAME}__localstack-aws-client`;
const LOGS_TOOL = `mcp__${MCP_SERVER_NAME}__localstack-logs-analysis`;

export function describeProvider() {
  if (process.env.OPENROUTER_API_KEY) {
    return `openrouter:${openRouterModel()}`;
  }
  return process.env.EVAL_CLAUDE_MODEL
    ? `claude:${process.env.EVAL_CLAUDE_MODEL}`
    : "claude:default";
}

// The agent gets `base` (no secrets) plus only what Claude Code needs to reach its model. The LocalStack token goes
// to the MCP server through its config, never to the agent or the scripts it runs.
function agentEnv(base) {
  const env = { ...base, ...pickEnv(["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"]) };
  if (process.env.OPENROUTER_API_KEY) {
    env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    env.ANTHROPIC_AUTH_TOKEN = process.env.OPENROUTER_API_KEY;
    // OpenRouter must not receive a real Anthropic key, and Claude Code must not prefer it
    env.ANTHROPIC_API_KEY = "";
  }
  return env;
}

function openRouterModel() {
  const model = process.env.OPENROUTER_MODEL;
  if (!model)
    throw new Error(
      "Set OPENROUTER_MODEL (an OpenRouter model slug) together with OPENROUTER_API_KEY."
    );
  return model;
}

function agentModel() {
  if (process.env.OPENROUTER_API_KEY) return openRouterModel();
  return process.env.EVAL_CLAUDE_MODEL;
}

export function writeMcpConfig(workdir, { repoRoot, port, containerName }) {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        // EVAL_MCP_DIST: a variant build of the server, for comparing tool names and descriptions
        args: [resolve(process.env.EVAL_MCP_DIST ?? resolve(repoRoot, "dist"), "cli.js")],
        env: {
          LOCALSTACK_AUTH_TOKEN: process.env.LOCALSTACK_AUTH_TOKEN ?? "",
          LOCALSTACK_HOSTNAME: "localhost",
          LOCALSTACK_PORT: String(port),
          MCP_ANALYTICS_DISABLED: "1",
          // The server's Docker-based tools prefer a running `localstack-main` or `localstack-aws`, which may be the
          // user's own emulator: name the eval's container so they never reach another one.
          ...(containerName ? { MAIN_CONTAINER_NAME: containerName } : {}),
        },
      },
    },
  };
  // It holds the auth token: a private directory outside the workdir, which the agent may not read (see runAgent),
  // removed with removeMcpConfig once the agent is done.
  const path = join(mkdtempSync(join(tmpdir(), "agentic-eval-mcp-")), "mcp-config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}

export function removeMcpConfig(path) {
  rmSync(dirname(path), { recursive: true, force: true });
}

// Told to the agent in every arm, as a developer's own setup would (a CLAUDE.md, a README)
const AWS_CLI_NOTE =
  "The AWS CLI (`aws`) is configured for LocalStack, and `localstack-logs [lines]` prints the last lines of LocalStack's log (default 300).";

function writeLogsCommand(containerName) {
  if (!containerName)
    throw new Error(
      "The localstack-logs command needs the emulator's container name (MAIN_CONTAINER_NAME)."
    );
  const binDir = join(mkdtempSync(join(tmpdir(), "agentic-eval-bin-")), "bin");
  mkdirSync(binDir);
  const script = join(binDir, "localstack-logs");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'n="${1:-300}"',
      'case "$n" in ""|*[!0-9]*) echo "usage: localstack-logs [lines]" >&2; exit 2 ;; esac',
      `exec docker logs --tail "$n" ${containerName} 2>&1`,
      "",
    ].join("\n")
  );
  chmodSync(script, 0o555);
  return binDir;
}

/**
 * Runs the agent until it finishes or `timeoutMs` passes. Returns the parsed stream-json transcript: every tool call
 * in order, and the final message.
 */
export function runAgent({
  prompt,
  workdir,
  mcpConfigPath,
  transcriptPath,
  timeoutMs,
  env,
  withoutIamTools = false,
  containerName,
}) {
  // Without --mcp-config (the --without-mcp baseline), --strict-mcp-config still keeps the user's own MCP servers out
  const withMcp = Boolean(mcpConfigPath);
  // What an agent has without the MCP server, in every arm, so the comparison measures only what the server adds:
  // the AWS CLI against the emulator, and LocalStack's log through `localstack-logs`, a wrapper on PATH that reads
  // only the eval's container
  const binDir = writeLogsCommand(containerName);
  // The comparison arm (--without-app-inspector): neither IAM tool, so the agent has only what it would have without
  // them, the AWS CLI, the logs and the project's files
  const iamTools = [APP_INSPECTOR_TOOL, ANALYZER_TOOL];
  const args = [
    "-p",
    `${prompt} ${AWS_CLI_NOTE}`,
    ...(withMcp ? ["--mcp-config", mcpConfigPath] : []),
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "default",
    // File access stays inside the project, and the scripts the agent may run stay as the scenario wrote them, so
    // the Bash allowlist can't be widened by editing a script.
    "--allowedTools",
    "Read(./**)",
    "Edit(./**)",
    "Write(./**)",
    "Bash(./deploy.sh)",
    "Bash(./trigger.sh)",
    // The AWS CLI in Bash too, against the emulator (the agent's environment points it there): agents reach for it
    // before the MCP tool, and blocking it would cost the agent turns that a developer's setup doesn't
    "Bash(aws:*)",
    "Bash(localstack-logs:*)",
    "Bash(localstack-logs)",
    // The IAM tools, and the two an agent reaches for first to see why something failed: the AWS CLI (execution
    // history) and the logs. The analyzer stays allowed so the eval sees whether the agent picks it over
    // the recommended app-inspector actions. Changes the agent makes through the AWS CLI don't count: the grade comes from a clean redeploy of the
    // template. State, chaos and the other tools stay off.
    ...(withMcp ? [...(withoutIamTools ? [] : iamTools), AWS_CLIENT_TOOL, LOGS_TOOL] : []),
  ];
  args.push(
    "--disallowedTools",
    "Edit(./deploy.sh)",
    "Edit(./trigger.sh)",
    "Write(./deploy.sh)",
    "Write(./trigger.sh)",
    // project settings could widen the agent's own permissions
    "Edit(./.claude/**)",
    "Write(./.claude/**)",
    ...(withoutIamTools ? iamTools : [])
  );
  const model = agentModel();
  if (model) args.push("--model", model);

  return new Promise((resolvePromise) => {
    const child = spawn("claude", args, {
      cwd: workdir,
      // The AWS CLI must not find the user's own AWS profiles and credentials
      env: agentEnv({
        ...env,
        AWS_CONFIG_FILE: "/dev/null",
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
        PATH: `${binDir}:${env.PATH ?? process.env.PATH}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (binDir) rmSync(dirname(binDir), { recursive: true, force: true });
      const transcript = redact(stdout);
      const errors = redact(stderr);
      writeFileSync(transcriptPath, transcript.text);
      resolvePromise({
        ...parseTranscript(transcript.text),
        exitCode: code,
        timedOut,
        stderr: errors.text,
        leakedSecrets: [...new Set([...transcript.found, ...errors.found])],
      });
    });
  });
}

export function parseTranscript(streamJson) {
  const toolCalls = [];
  const byId = new Map();
  let finalMessage = "";
  let usage;
  let costUsd;
  let turns;
  for (const line of streamJson.split("\n")) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === "assistant") {
      for (const item of message.message?.content ?? []) {
        if (item.type === "tool_use") {
          const call = { name: item.name, input: item.input ?? {}, isError: undefined };
          toolCalls.push(call);
          if (item.id) byId.set(item.id, call);
        }
      }
    } else if (message.type === "user") {
      // The tool results: a call whose result is an error doesn't count as using the tool.
      const content = message.message?.content;
      for (const item of Array.isArray(content) ? content : []) {
        const call = item.type === "tool_result" ? byId.get(item.tool_use_id) : undefined;
        if (call) call.isError = item.is_error === true;
      }
    } else if (message.type === "result") {
      finalMessage = message.result ?? "";
      usage = message.usage;
      costUsd = message.total_cost_usd;
      turns = message.num_turns;
    }
  }
  return { toolCalls, finalMessage, usage, costUsd, turns };
}
