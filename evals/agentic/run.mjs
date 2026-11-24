#!/usr/bin/env node
// End-to-end agentic evaluation of the IAM tools (`localstack-iam`, `localstack-iam-management`).
//
// For each scenario: deploy a small CloudFormation project that fails on an IAM problem, give a coding agent (Claude
// Code headless) this MCP server, the AWS CLI, LocalStack's log and the project (with --without-mcp, all but the
// server), let it fix the project, then redeploy, rerun the workload and grade the final state with deterministic
// checks.
//
// Usage:
//   yarn build && node evals/agentic/run.mjs [--scenario 01] [--repeat 3] [--endpoint http://localhost:4700]
//
// Needs Docker (unless --endpoint), the AWS CLI, Claude Code (`claude`), and LOCALSTACK_AUTH_TOKEN. See README.md
// in this directory for the provider settings (Claude subscription locally, OPENROUTER_API_KEY in CI).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describeProvider, removeMcpConfig, runAgent, writeMcpConfig } from "./lib/agent.mjs";
import { baseEnv, redact } from "./lib/secrets.mjs";
import { runCheck } from "./lib/checks.mjs";
import {
  localstackVersion,
  prepareScenario,
  settledDenials,
  startLocalStack,
} from "./lib/localstack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// The workload and the deploy script are the test harness: a fix that edits them proves nothing. A run that timed
// out, or a project that no longer deploys, is graded as failed whatever else holds. Which tools the agent picked is
// reported, not graded: a correct fix found without them still passes.
const GLOBAL_CHECKS = [
  { type: "agent_completed" },
  { type: "redeploy_succeeds" },
  { type: "analyzer_not_used", report: true },
  { type: "files_unchanged", files: ["deploy.sh", "trigger.sh"] },
];

// --hint: point the agent to the tool, to measure whether it can use it once it knows it should (not whether it finds
// it on its own)
const HINT =
  "Use the LocalStack MCP server's IAM tool (localstack-iam) for IAM: it lists denied requests, explains why each was denied with LocalStack's suggested fix, and derives the policies a run needs.";

function parseArgs(argv) {
  const options = {
    repeat: 1,
    scenario: undefined,
    endpoint: undefined,
    timeoutMinutes: 15,
    hint: false,
    reproduceOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--scenario":
        options.scenario = value;
        i += 1;
        break;
      case "--repeat":
        options.repeat = Number(value);
        i += 1;
        break;
      case "--endpoint":
        options.endpoint = value;
        i += 1;
        break;
      // check that each scenario fails for its stated reason, without running an agent (no model, no cost)
      case "--reproduce-only":
        options.reproduceOnly = true;
        break;
      case "--hint":
        options.hint = true;
        break;
      // the comparison arm: the agent gets neither IAM tool, and the server's instructions don't point to them
      case "--without-iam-tools":
      case "--without-app-inspector": // the earlier name
        options.withoutAppInspector = true;
        break;
      // the baseline: no MCP server at all, only what an agent has without it (the AWS CLI and LocalStack's logs in
      // Bash, and the project's files); compare it with a normal run, which adds the server and nothing else
      case "--without-mcp":
        options.withoutMcp = true;
        break;
      case "--timeout-minutes":
        options.timeoutMinutes = Number(value);
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument ${argv[i]}`);
    }
  }
  return options;
}

function loadScenarios(filter) {
  const root = join(here, "scenarios");
  return (
    readdirSync(root)
      // only scenario directories: skips files the OS adds there, such as .DS_Store
      .filter((name) => existsSync(join(root, name, "scenario.json")))
      // --scenario 01 or --scenario 01,04: scenarios whose name starts with one of the prefixes
      .filter((name) => !filter || filter.split(",").some((prefix) => name.startsWith(prefix)))
      .sort()
      .map((name) => ({
        name,
        dir: join(root, name),
        ...JSON.parse(readFileSync(join(root, name, "scenario.json"), "utf8")),
      }))
  );
}

function awsEnv(endpoint) {
  // No secrets: the scripts need only the fake AWS credentials, and their output ends up in the results.
  return baseEnv({
    AWS_ENDPOINT_URL: endpoint,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_PAGER: "",
  });
}

function runScript(script, workdir, endpoint) {
  const result = spawnSync(`./${script}`, [], {
    cwd: workdir,
    env: awsEnv(endpoint),
    encoding: "utf8",
    timeout: 300_000,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A scenario's platform/ directory holds what another team owns, such as a shared bucket and its policy: the runner
// deploys it before the project, and it is not copied into the agent's project, so its template is not there to read.
// With `platform_account`, it goes into that account (LocalStack takes a 12-digit access key ID as the account), where
// the agent's tools, which run as the project's account, can't read its policies, as on AWS.
function deployPlatform(scenario, endpoint) {
  const template = join(scenario.dir, "platform", "template.yaml");
  if (!existsSync(template)) return undefined;
  const result = spawnSync(
    "aws",
    [
      "cloudformation",
      "deploy",
      "--template-file",
      template,
      "--stack-name",
      "platform",
      "--capabilities",
      "CAPABILITY_NAMED_IAM",
      "--no-fail-on-empty-changeset",
    ],
    {
      env: {
        ...awsEnv(endpoint),
        ...(scenario.platform_account && { AWS_ACCESS_KEY_ID: scenario.platform_account }),
      },
      encoding: "utf8",
      timeout: 300_000,
    }
  );
  return result.status === 0
    ? undefined
    : `platform deploy failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** Runs the AWS CLI against the emulator and returns its parsed JSON output, for the checks */
function awsJson(endpoint) {
  return (args) => {
    const result = spawnSync("aws", [...args, "--output", "json"], {
      env: awsEnv(endpoint),
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`aws ${args.join(" ")}: ${result.stderr.trim()}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  };
}

// The repository lives outside the project, so the agent can't edit git's config or hooks, and git runs without the
// job's secrets and without external diff tools, fsmonitor or hooks.
function git(workdir, ...args) {
  return spawnSync(
    "git",
    [
      `--git-dir=${join(dirname(workdir), "repo.git")}`,
      `--work-tree=${workdir}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: workdir, encoding: "utf8", env: baseEnv({}) }
  );
}

async function runScenario(
  scenario,
  {
    endpoint,
    port,
    containerName,
    resultsDir,
    attempt,
    timeoutMinutes,
    hint,
    reproduceOnly,
    withoutAppInspector,
    withoutMcp,
  }
) {
  // A neutral name: the agent sees this path, and the scenario's name would give the diagnosis away.
  const base = mkdtempSync(join(tmpdir(), "app-"));
  const workdir = join(base, "project");
  cpSync(scenario.dir, workdir, {
    recursive: true,
    filter: (src) =>
      !src.endsWith("scenario.json") &&
      src !== join(scenario.dir, "platform") &&
      !src.startsWith(join(scenario.dir, "platform") + sep),
  });
  git(workdir, "init", "-q");
  git(workdir, "add", ".");
  git(
    workdir,
    "-c",
    "user.name=eval",
    "-c",
    "user.email=eval@localhost",
    "commit",
    "-qm",
    "scenario"
  );
  // Read-only, so the agent can't widen its Bash allowlist by rewriting the scripts it may run.
  for (const script of ["deploy.sh", "trigger.sh"]) chmodSync(join(workdir, script), 0o555);

  const iamMode = scenario.iam_mode ?? "ENFORCED";
  await prepareScenario(endpoint, { iamMode });
  const platformError = deployPlatform(scenario, endpoint);
  if (platformError) return { error: platformError };
  const deploy = runScript("deploy.sh", workdir, endpoint);
  if (deploy.exitCode !== 0) return { error: `initial deploy failed:\n${deploy.output}` };
  // The scenario must reproduce for the stated reason, or the agent is graded on a different problem.
  const initial = runScript("trigger.sh", workdir, endpoint);
  const expectFailure = scenario.expect_initial_failure !== false;
  if (expectFailure === (initial.exitCode === 0)) {
    return {
      error: `trigger.sh ${expectFailure ? "succeeded" : "failed"} before the agent ran, so the scenario does not reproduce:\n${initial.output}`,
    };
  }
  if (scenario.initial_denial) {
    const { service, operation } = scenario.initial_denial;
    const denials = await settledDenials(endpoint);
    const found = denials.some(
      (d) => d.payload?.service === service && d.payload?.operation === operation
    );
    if (!found && denials.length > 0 && denials.every((d) => d.payload === undefined)) {
      return {
        error: `App Inspector recorded ${denials.length} denial(s) without their details (the IAM event payload), so the scenario can't be checked. This LocalStack version doesn't record them: use localstack/localstack-pro:dev (EVAL_LOCALSTACK_IMAGE).`,
      };
    }
    if (!found) {
      return {
        error: `App Inspector recorded no denial of ${service}:${operation} before the agent ran, so the scenario does not reproduce. Recorded: ${denials.map((d) => `${d.payload?.service}:${d.payload?.operation}`).join(", ") || "none"}`,
      };
    }
  }

  if (reproduceOnly) return { reproduced: true, pass: true, checks: [] };

  const mcpConfigPath = withoutMcp
    ? undefined
    : writeMcpConfig(workdir, { repoRoot, port, containerName });
  const transcriptPath = join(resultsDir, `${scenario.name}-${attempt}.jsonl`);
  const started = Date.now();
  let agent;
  try {
    agent = await runAgent({
      prompt: hint ? `${scenario.prompt} ${HINT}` : scenario.prompt,
      workdir,
      mcpConfigPath,
      transcriptPath,
      timeoutMs: timeoutMinutes * 60_000,
      // the agent runs deploy.sh and trigger.sh against the same emulator as the runner
      env: awsEnv(endpoint),
      withoutIamTools: withoutAppInspector,
      containerName,
    });
  } finally {
    if (mcpConfigPath) removeMcpConfig(mcpConfigPath);
  }

  // Grade the project as the agent left it, on a clean emulator: whatever the agent changed outside the template (the
  // IAM mode, App Inspector's status, resources) is reset, so only the template can make the workload pass.
  await prepareScenario(endpoint, { iamMode: scenario.iam_mode_after ?? iamMode });
  const regradePlatformError = deployPlatform(scenario, endpoint);
  if (regradePlatformError) return { error: regradePlatformError };
  const redeploy = runScript("deploy.sh", workdir, endpoint);
  const rerun = runScript("trigger.sh", workdir, endpoint);
  const denials = await settledDenials(endpoint);
  const diff = git(workdir, "diff", "--no-ext-diff").stdout;
  writeFileSync(join(resultsDir, `${scenario.name}-${attempt}.diff`), redact(diff).text);

  const changedFiles = git(workdir, "diff", "--name-only").stdout.split("\n").filter(Boolean);
  const context = {
    workdir,
    changedFiles,
    agent,
    rerun: {
      redeployExitCode: redeploy.exitCode,
      triggerExitCode: redeploy.exitCode === 0 ? rerun.exitCode : -1,
      denials,
    },
    aws: awsJson(endpoint),
  };
  const checks = [...scenario.checks, ...GLOBAL_CHECKS].map((check) => ({
    ...check,
    ...runCheck(check, context),
  }));
  return {
    // A secret in the agent's output fails the run even though it was redacted: the model provider saw it. Checks
    // marked `report` (e.g. which tools the agent used) are reported, not graded.
    pass: checks.every((check) => check.report || check.pass) && agent.leakedSecrets.length === 0,
    // Whether the agent used the tools the scenario expects, graded or only reported
    usedExpectedTools: checks
      .filter((check) => TOOL_CHECKS.has(check.type))
      .every((check) => check.pass),
    // Whether the agent checked its fix with list-denials newer_than (undefined where the scenario doesn't ask)
    checkedFix: checks.find((check) => check.type === "newer_than_used")?.pass,
    leakedSecrets: agent.leakedSecrets,
    checks,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    turns: agent.turns,
    costUsd: agent.costUsd,
    usage: agent.usage,
    timedOut: agent.timedOut,
    agentExitCode: agent.exitCode,
    finalMessage: agent.finalMessage,
    redeployOutput: redeploy.exitCode === 0 ? undefined : redeploy.output,
    transcript: transcriptPath,
    workdir,
  };
}

const TOOL_CHECKS = new Set(["tool_called", "tool_sequence"]);

/**
 * A copy of the server build whose instructions don't mention the IAM tools, for --without-iam-tools: the
 * instructions stay in the agent's context and would point it to tools it doesn't have. The copy lives in the results
 * directory, inside the repository, so it resolves the server's external modules.
 */
function withoutIamInstructions(resultsDir) {
  const source = resolve(process.env.EVAL_MCP_DIST ?? join(repoRoot, "dist"));
  const target = join(resultsDir, "dist");
  cpSync(source, target, { recursive: true });
  const stdio = join(target, "stdio.js");
  const code = readFileSync(stdio, "utf8");
  const pattern = /instructions:"IAM in LocalStack:(?:[^"\\]|\\.)*"/;
  if (!pattern.test(code))
    throw new Error(`No IAM server instructions found in ${stdio} to remove.`);
  writeFileSync(stdio, code.replace(pattern, 'instructions:""'));
  return target;
}

/** A command's first output line, or undefined: for the versions in the results */
function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", env: baseEnv({}) });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : undefined;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(repoRoot, "dist/cli.js"))) throw new Error("Run `yarn build` first.");
  const scenarios = loadScenarios(options.scenario);
  if (scenarios.length === 0) throw new Error(`No scenario matches ${options.scenario}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Runs started together (one per model) must not share a directory: name it after the model too, and fail rather
  // than overwrite one that exists.
  const model =
    (process.env.OPENROUTER_API_KEY
      ? process.env.OPENROUTER_MODEL
      : process.env.EVAL_CLAUDE_MODEL) || "default";
  const label =
    `${stamp}-${model}${options.withoutAppInspector ? "-without-iam-tools" : ""}${options.withoutMcp ? "-without-mcp" : ""}`.replace(
      /[^A-Za-z0-9._-]/g,
      "_"
    );
  mkdirSync(join(here, "results"), { recursive: true });
  const resultsDir = join(here, "results", label);
  mkdirSync(resultsDir);
  if (options.withoutAppInspector) process.env.EVAL_MCP_DIST = withoutIamInstructions(resultsDir);

  let localstack;
  let endpoint = options.endpoint;
  let port = endpoint ? Number(new URL(endpoint).port || 80) : undefined;
  // With --endpoint, MAIN_CONTAINER_NAME names that emulator's container for the server's Docker-based tools.
  let containerName = process.env.MAIN_CONTAINER_NAME;
  // The agent's `localstack-logs` reads that container's log, and the IAM policy analyzer reads container logs too.
  if (endpoint && !containerName) {
    throw new Error(
      "With --endpoint, set MAIN_CONTAINER_NAME to that emulator's container name: the agent's localstack-logs command reads its log."
    );
  }
  if (!endpoint) {
    localstack = await startLocalStack();
    ({ endpoint, port, containerName } = localstack);
  }
  const localstackVersionValue = await localstackVersion(endpoint);
  console.log(
    `LocalStack ${localstackVersionValue ?? "(unknown version)"}: ${endpoint} | agent: ${describeProvider()} | results: ${resultsDir}`
  );

  const results = [];
  try {
    for (const scenario of scenarios) {
      for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
        process.stdout.write(`▶ ${scenario.name} (attempt ${attempt}) … `);
        let result;
        try {
          result = await runScenario(scenario, {
            endpoint,
            port,
            containerName,
            resultsDir,
            attempt,
            timeoutMinutes: options.timeoutMinutes,
            hint: options.hint,
            reproduceOnly: options.reproduceOnly,
            withoutAppInspector: options.withoutAppInspector,
            withoutMcp: options.withoutMcp,
          });
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        results.push({ scenario: scenario.name, attempt, ...result });
        if (result.error) console.log(`ERROR\n  ${result.error}`);
        else {
          console.log(result.reproduced ? "REPRODUCES" : result.pass ? "PASS" : "FAIL");
          for (const check of result.checks) {
            const mark = check.report ? (check.pass ? "·" : "○") : check.pass ? "✓" : "✗";
            console.log(
              `  ${mark} ${check.type}${check.report ? " (reported)" : ""}: ${check.detail}`
            );
          }
        }
      }
    }
  } finally {
    localstack?.stop();
  }

  const summary = scenarios.map((scenario) => {
    const runs = results.filter((r) => r.scenario === scenario.name);
    const passed = runs.filter((r) => r.pass).length;
    const usedTools = runs.filter((r) => r.usedExpectedTools).length;
    const checkedFix = runs.some((r) => r.checkedFix !== undefined)
      ? runs.filter((r) => r.checkedFix).length
      : undefined;
    return { scenario: scenario.name, passed, usedTools, checkedFix, runs: runs.length };
  });
  const report = {
    provider: describeProvider(),
    // What ran, so a change in results can be traced to a change in the emulator, the agent or this repository
    versions: {
      localstackImage: localstack?.image,
      localstack: localstackVersionValue,
      claudeCode: commandOutput("claude", ["--version"]),
      commit: commandOutput("git", ["rev-parse", "HEAD"]),
    },
    hint: options.hint ? HINT : undefined,
    withoutAppInspector: options.withoutAppInspector || undefined,
    withoutMcp: options.withoutMcp || undefined,
    endpoint,
    startedAt: stamp,
    summary,
    results,
  };
  const written = redact(JSON.stringify(report, null, 2));
  writeFileSync(join(resultsDir, "results.json"), written.text);
  const leaked = new Set([...written.found, ...results.flatMap((r) => r.leakedSecrets ?? [])]);
  if (leaked.size > 0) {
    console.error(
      `\nSecrets appeared in the agent's output and were redacted from the results: ${[...leaked].join(", ")}. Rotate them.`
    );
  }
  console.log("\nSummary:");
  for (const row of summary) {
    console.log(
      options.reproduceOnly
        ? `  ${row.scenario}: ${row.passed}/${row.runs} reproduce`
        : `  ${row.scenario}: ${row.passed}/${row.runs} passed, ${row.usedTools}/${row.runs} used the expected tools` +
            (row.checkedFix === undefined
              ? ""
              : `, ${row.checkedFix}/${row.runs} checked the fix with newer_than`)
    );
  }
  console.log(`Report: ${join(resultsDir, "results.json")}`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
