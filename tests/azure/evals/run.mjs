#!/usr/bin/env node
// E2: composition evals of the localstack-azure-client tool.
//
//   node tests/azure/evals/run.mjs [options]
//
// Runs the E2 tasks (tiers T-A, T-B, T-APIM; see README.md) against `node dist/cli.js`:
// Claude calls the Azure tool over MCP until it ends its turn, then the task's verifier reads the
// outcome from the emulator through a SEPARATE server session, then everything the run created is
// removed. One JSONL record per run; see README.md.
//
//   --runs N                  repetitions per task (default 1)
//   --max-usd X               stop starting runs once the spend reaches X (default $AZURE_EVALS_MAX_USD or 20)
//   --max-usd-per-run Y       stop one run's agent loop at Y (default $EVAL_MAX_USD_PER_RUN or 1)
//   --out DIR                 results directory (default test-results/e2)
//   --tasks id,id             only these tasks          --tier T-A,T-B,T-APIM   only these tiers
//   --model M                 default $EVAL_MODEL or claude-opus-5-5
//   --effort E                default $EVAL_EFFORT or high
//   --variant v[,v]           compact (default), long, help-tool, no-test-data; several interleave
//   --all-tools               offer every server tool (localstack-management is withheld), not only Azure
//   --key-file PATH           the API key file (else ANTHROPIC_API_KEY_FILE, else ANTHROPIC_API_KEY)
//   --phrasing alt|0|1        T-A phrasing: alternate by run index (default), or fixed
//   --verify-wait S           how long polling verifiers wait (default 90; 10 with --negative)
//   --seed N                  seed of the variant order (default 20260924)
//   --max-minutes M           start no new run after M minutes
//   --jobs N                  concurrent runs, each with its own two servers (default $EVAL_JOBS,
//                             else 3 when CI=true, else 1: keep 1 on a shared emulator)
//   --no-prewarm              skip the max_tokens:0 cache pre-warm per variant
//   --oracle                  no model: run each task's reference commands, the verifier must pass
//   --negative                no model: setup only, the verifier must fail
//   --dry-run                 no emulator, no model: list the plan and the tool definitions per variant
//   --list                    print the tasks and exit
//
// Exit status: 0 all passed (the gate, or every oracle/negative expectation), 1 not passed or
// stopped early, 2 a usage or configuration error (no API key for a model run, unknown model price,
// no dist/cli.js, Node.js older than 22.18). The API key is never printed, logged or written.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EXIT_USAGE = 2;

function fail(message, code = EXIT_USAGE) {
  console.error(`e2: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const env = process.env;
  const o = {
    runs: 1,
    maxUsd: Number(env.AZURE_EVALS_MAX_USD || 20),
    maxUsdPerRun: Number(env.EVAL_MAX_USD_PER_RUN || 1),
    out: "test-results/e2",
    tasks: [],
    tiers: [],
    model: env.EVAL_MODEL || "claude-opus-5-5",
    effort: env.EVAL_EFFORT || "high",
    variants: ["compact"],
    allTools: false,
    keyFile: undefined,
    phrasing: "alt",
    verifyWait: undefined,
    seed: 20260924,
    maxMinutes: undefined,
    // Concurrent runs, each with its own two server sessions. On a developer machine the
    // emulator may be shared, so one; CI's per-job emulator takes three, which leaves the
    // weekly E2 job room inside its 180 minutes.
    jobs: Number(env.EVAL_JOBS || (env.CI === "true" ? 3 : 1)),
    prewarm: true,
    oracle: false,
    negative: false,
    dryRun: false,
    list: false,
    help: false,
  };
  const list = (s) =>
    String(s)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) fail(`${arg} needs a value`);
      return next;
    };
    const num = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(`${arg} needs a non-negative number, not ${v}`);
      return n;
    };
    switch (arg) {
      case "--runs":
        o.runs = Math.floor(num(value()));
        break;
      case "--max-usd":
        o.maxUsd = num(value());
        break;
      case "--max-usd-per-run":
        o.maxUsdPerRun = num(value());
        break;
      case "--out":
        o.out = value();
        break;
      case "--tasks":
        o.tasks = list(value());
        break;
      case "--tier":
        o.tiers = list(value());
        break;
      case "--model":
        o.model = value();
        break;
      case "--effort":
        o.effort = value();
        break;
      case "--variant":
        o.variants = list(value());
        break;
      case "--all-tools":
        o.allTools = true;
        break;
      case "--key-file":
        o.keyFile = value();
        break;
      case "--phrasing":
        o.phrasing = value();
        break;
      case "--verify-wait":
        o.verifyWait = num(value());
        break;
      case "--seed":
        o.seed = Math.floor(num(value()));
        break;
      case "--max-minutes":
        o.maxMinutes = num(value());
        break;
      case "--no-prewarm":
        o.prewarm = false;
        break;
      case "--jobs":
        o.jobs = Math.floor(num(value()));
        break;
      case "--oracle":
        o.oracle = true;
        break;
      case "--negative":
        o.negative = true;
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--list":
        o.list = true;
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      default:
        fail(`unknown argument ${arg} (see --help)`);
    }
  }
  if ([o.oracle, o.negative, o.dryRun].filter(Boolean).length > 1)
    fail("--oracle, --negative and --dry-run exclude each other");
  if (!["alt", "0", "1"].includes(o.phrasing)) fail(`--phrasing is alt, 0 or 1, not ${o.phrasing}`);
  if (o.runs < 1) fail("--runs must be at least 1");
  if (!Number.isInteger(o.jobs) || o.jobs < 1 || o.jobs > 8) fail("--jobs must be 1 to 8");
  return o;
}

async function loadModules() {
  const load = (file) => import(pathToFileURL(join(HERE, file)).href);
  try {
    const [lib, agent, keys, variants, harness, ta, tb, tapim] = await Promise.all([
      load("verifiers.ts"),
      load("agent.ts"),
      load("keys.ts"),
      load("variants.ts"),
      load("harness.ts"),
      load("tasks-ta.ts"),
      load("tasks-tb.ts"),
      load("tasks-tapim.ts"),
    ]);
    const tasks = [...ta.taTasks(lib), ...tb.tbTasks(lib), ...tapim.tapimTasks(lib)];
    return { lib, agent, keys, variants, harness, tasks };
  } catch (error) {
    fail(
      `cannot load the eval modules (${error instanceof Error ? error.message : error}). E2 loads its TypeScript ` +
        `modules with Node's built-in type stripping, which needs Node.js 22.18 or newer (this is ${process.version}).`
    );
  }
}

function helpText() {
  // The header comment of this file is the help.
  return [
    "usage: node tests/azure/evals/run.mjs [--runs N] [--max-usd X] [--max-usd-per-run Y] [--out DIR]",
    "       [--tasks id,id] [--tier T-A,T-B,T-APIM] [--model M] [--effort E] [--variant v[,v]] [--all-tools]",
    "       [--key-file PATH] [--phrasing alt|0|1] [--verify-wait S] [--seed N] [--max-minutes M] [--no-prewarm]",
    "       [--jobs N] [--oracle | --negative | --dry-run] [--list]",
    "variants: compact (default), long, help-tool, no-test-data. See tests/azure/evals/README.md.",
  ].join("\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(helpText());
    return 0;
  }
  const { lib, agent, keys, variants, harness, tasks: allTasks } = await loadModules();
  let tasks;
  try {
    tasks = harness.selectTasks(allTasks, { ids: o.tasks, tiers: o.tiers });
  } catch (error) {
    fail(error.message);
  }
  if (!tasks.length) fail("no task matches --tasks/--tier");
  for (const v of o.variants)
    if (!variants.isVariant(v)) fail(`unknown variant ${v} (${variants.VARIANTS.join(", ")})`);
  if (o.list) {
    for (const t of tasks) console.log(`${t.tier.padEnd(7)} ${t.id.padEnd(38)} ${t.opId}`);
    console.log(`${tasks.length} tasks`);
    return 0;
  }
  const mode = o.oracle ? "oracle" : o.negative ? "negative" : o.dryRun ? "dry-run" : "llm";

  // The key first: a model run without one stops here, before any server or SDK is loaded.
  let loaded = null;
  let price;
  if (mode === "llm") {
    try {
      loaded = keys.loadKey({ keyFile: o.keyFile, env: process.env });
    } catch (error) {
      fail(error instanceof keys.KeyError ? error.message : "the API key could not be read");
    }
    if (!loaded) fail(keys.NO_KEY_MESSAGE);
    price = agent.priceFor(o.model);
    if (!price)
      fail(
        `no price for model ${o.model}; add it to PRICES in tests/azure/evals/agent.ts (the spend cap needs one)`
      );
  }
  const scrub = keys.scrubber(loaded?.key);

  const cli = join(REPO, "dist", "cli.js");
  if (!existsSync(cli)) fail(`${cli} does not exist; run \`yarn build\` first`);
  if (mode !== "dry-run" && !process.env.LOCALSTACK_AUTH_TOKEN) {
    fail("LOCALSTACK_AUTH_TOKEN is not set: the Azure tool refuses every call without it");
  }

  const outDir = resolve(REPO, o.out);
  mkdirSync(outDir, { recursive: true });

  // Debug logging could echo request details: never in a process that holds the key.
  delete process.env.ANTHROPIC_LOG;
  let client;
  let classifyError;
  if (mode === "llm") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey: loaded.key, authToken: null, maxRetries: 4, logLevel: "off" });
    classifyError = agent.makeErrorClassifier(Anthropic);
  }
  // The servers (and every az they run) never see an ANTHROPIC_* variable.
  keys.stripAnthropicEnv(process.env);

  const { startServer } = await import(
    pathToFileURL(join(REPO, "tests", "azure", "tools", "stdio-client.mjs")).href
  );
  const servers = [];
  const start = async (label, env) => {
    const server = await startServer({ cwd: REPO, env });
    servers.push({ label, server });
    return server;
  };
  const closeAll = async () => {
    for (const { label, server } of servers.splice(0)) {
      await server.close().catch(() => undefined);
      try {
        writeFileSync(join(outDir, `server-${label}.stderr.log`), scrub(server.stderr()));
      } catch {
        // the results directory may be gone; the logs are a convenience
      }
    }
  };
  const AGENT_ENV = { LOCALSTACK_AZ_TEST_ENVELOPE: "1", MCP_ANALYTICS_DISABLED: "1" };
  // The harness's own session: slow fixtures (a MySQL server) get more than the default 300 s.
  const HARNESS_ENV = { ...AGENT_ENV, LOCALSTACK_AZ_TIMEOUT_SECONDS: "900" };
  const started = new Date();
  const runTag = `mcpe2-${randomBytes(3).toString("hex")}`;
  const meta = {
    run_id: `${started
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z")}-${mode}`,
    started: started.toISOString(),
    mode,
    group_prefix: runTag,
    variants: o.variants,
    all_tools: o.allTools,
    model: mode === "llm" ? o.model : null,
    effort: mode === "llm" ? o.effort : null,
    thinking: agent.THINKING,
    max_tokens: agent.MAX_TOKENS,
    system_prompt: agent.SYSTEM_PROMPT,
    tasks: tasks.map((t) => t.id),
    runs: o.runs,
    phrasing: o.phrasing,
    seed: o.seed,
    max_usd: o.maxUsd,
    max_usd_per_run: o.maxUsdPerRun,
    price: price ?? null,
    key_source: loaded ? loaded.source : null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  const writeMeta = () =>
    writeFileSync(join(outDir, "meta.json"), scrub(JSON.stringify(meta, null, 2)) + "\n");

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error("e2: interrupted; stopping after the current run (Ctrl+C again to quit at once)");
  });

  try {
    const agentServer = await start("agent-0", AGENT_ENV);
    const listed = await agentServer.listTools();
    const variantTools = {};
    try {
      for (const v of o.variants)
        variantTools[v] = variants.buildVariantTools(v, listed, o.allTools);
    } catch (error) {
      fail(error.message);
    }
    meta.tool_definitions = Object.fromEntries(
      Object.entries(variantTools).map(([v, vt]) => [
        v,
        {
          tools: vt.tools.map((t) => t.name),
          bytes: JSON.stringify(vt.tools).length,
          azure_description: vt.azureDescription,
        },
      ])
    );

    if (mode === "dry-run") {
      const plan = tasks.map((t) => ({
        id: t.id,
        tier: t.tier,
        op: t.opId,
        verb: t.verb,
        prompts: t.prompts,
        oracle_steps: t.oracle.length,
      }));
      writeFileSync(
        join(outDir, "plan.json"),
        JSON.stringify({ meta, tasks: plan }, null, 2) + "\n"
      );
      writeMeta();
      for (const [v, d] of Object.entries(meta.tool_definitions))
        console.log(`[${v}] ${d.tools.join(", ")} (${d.bytes} bytes)`);
      console.log(
        `${tasks.length} tasks x ${o.runs} run(s) x ${o.variants.length} variant(s); plan: ${join(outDir, "plan.json")}`
      );
      return 0;
    }

    // One agent session and one harness session per worker: verification never shares
    // the agent's session, and concurrent runs never share one either.
    const workers = [];
    for (let w = 0; w < o.jobs; w++) {
      const agentSession = w === 0 ? agentServer : await start(`agent-${w}`, AGENT_ENV);
      const harnessSession = await start(`harness-${w}`, HARNESS_ENV);
      workers.push({
        lib,
        agent,
        variants,
        agentSession,
        harnessSession,
        now: () => performance.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (line) => console.log(line),
        scrub,
        client,
        classifyError,
      });
    }
    meta.jobs = o.jobs;
    const budget = { maxUsd: o.maxUsd, perRunUsd: o.maxUsdPerRun, spent: 0 };
    const prefix = {};
    if (mode === "llm" && o.prewarm) {
      meta.prewarm = {};
      for (const [v, vt] of Object.entries(variantTools)) {
        try {
          const pw = await agent.prewarm(client, o.model, o.effort, vt.tools);
          const cost = agent.costUsd([{ usage: pw.usage }], price);
          budget.spent += cost;
          prefix[v] = pw.prefix_tokens;
          meta.prewarm[v] = { usage: pw.usage, prefix_tokens: pw.prefix_tokens, cost_usd: cost };
        } catch (error) {
          meta.prewarm[v] = {
            error: scrub(
              error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)
            ).slice(0, 300),
          };
        }
      }
    }
    writeMeta();

    const records = [];
    const groups = new Set();
    const names = { vaults: new Set(), apim: new Set() };
    const runsPath = join(outDir, "runs.jsonl");
    const rand = harness.seededRandom(o.seed);
    const verifyWaitS = o.verifyWait ?? (mode === "negative" ? 10 : 90);
    const runVariants = mode === "llm" ? o.variants : [o.variants[0]];
    const t0 = performance.now();
    let stopped = null;
    let n = 0;
    // The whole schedule first, each task visiting the variants in a fresh seeded order, so a
    // rerun, and a run with more jobs, keeps the same order.
    const items = [];
    for (const task of tasks) {
      for (let run = 0; run < o.runs; run++) {
        for (const v of harness.shuffled(runVariants, rand)) items.push({ task, run, v });
      }
    }
    const runWorker = async (deps) => {
      for (;;) {
        if (stopped) return;
        if (interrupted) {
          stopped = "interrupted";
          return;
        }
        if (mode === "llm" && !harness.canStart(budget)) {
          stopped = `spend cap: $${budget.spent.toFixed(4)} of $${o.maxUsd}`;
          return;
        }
        if (o.maxMinutes !== undefined && (performance.now() - t0) / 60000 > o.maxMinutes) {
          stopped = `time: ${o.maxMinutes} minutes`;
          return;
        }
        const item = items[n];
        if (!item) return;
        n += 1;
        const { task, run, v } = item;
        {
          const rg = harness.groupName(runTag, task.id, n);
          groups.add(rg);
          const phrasing =
            o.phrasing === "alt"
              ? run % task.prompts.length
              : Number(o.phrasing) % task.prompts.length;
          let rec;
          try {
            rec = await harness.runOne(
              {
                task,
                mode,
                variant: variantTools[v],
                runIndex: run,
                phrasing,
                rg,
                model: o.model,
                effort: o.effort,
                price,
                prefixTokens: prefix[v] ?? null,
                budget,
                verifyWaitS,
                agentTimeoutMs: (agent.TOOL_CALL_TIMEOUT_S + 30) * 1000,
                harnessTimeoutMs: 960_000,
              },
              deps
            );
          } catch (error) {
            // A harness fault: recorded unscored; the final sweep removes the run's group.
            rec = {
              task_id: task.id,
              tier: task.tier,
              variant: v,
              mode,
              run,
              phrasing,
              rg,
              success: null,
              failure: "harness_error",
              reason: scrub(
                error instanceof Error ? `${error.name}: ${error.message}` : String(error)
              ).slice(0, 300),
            };
          }
          for (const s of task.vaultSlots ?? [])
            if (typeof rec.slots?.[s] === "string") names.vaults.add(rec.slots[s]);
          for (const s of task.apimSlots ?? [])
            if (typeof rec.slots?.[s] === "string") names.apim.add(rec.slots[s]);
          records.push(rec);
          appendFileSync(runsPath, scrub(JSON.stringify(rec)) + "\n");
          const mark = rec.success === true ? "PASS " : rec.success === false ? "FAIL " : "SETUP";
          const cost = mode === "llm" ? ` $${Number(rec.cost_usd ?? 0).toFixed(4)}` : "";
          console.log(
            `${mark} ${mode === "llm" ? v.padEnd(12) : mode.padEnd(8)} ${task.id.padEnd(38)} r${run} p${phrasing}` +
              ` calls=${rec.tool_calls ?? 0} verify=${Math.round(rec.verify_ms ?? 0)}ms${cost}  ${String(rec.reason ?? "").slice(0, 160)}`
          );
          if (rec.failure === "account_error") {
            stopped = "the API key can no longer be used";
            return;
          }
        }
      }
    };
    await Promise.all(workers.map((deps) => runWorker(deps)));

    const sweepTypes = [...new Set(tasks.flatMap((t) => t.sweep ?? []))];
    const sweepQuery = harness.sessionQuery(workers[0], workers[0].harnessSession, 60, 960_000);
    const sweep = await harness
      .finalSweep(sweepQuery, lib, {
        types: sweepTypes,
        groups,
        prefix: runTag,
        vaults: names.vaults,
        apim: names.apim,
      })
      .catch((error) => ({ error: String(error) }));
    writeFileSync(join(outDir, "cleanup.json"), scrub(JSON.stringify(sweep, null, 2)) + "\n");

    const summary = harness.summarize(records);
    meta.ended = new Date().toISOString();
    meta.spent_usd = Math.round(budget.spent * 1e6) / 1e6;
    meta.stopped = stopped;
    meta.runs_recorded = records.length;
    writeMeta();
    writeFileSync(
      join(outDir, "summary.json"),
      scrub(
        JSON.stringify(
          { stopped, spent_usd: meta.spent_usd, cleanup_clean: sweep.clean ?? false, ...summary },
          null,
          2
        )
      ) + "\n"
    );
    console.log(scrub(JSON.stringify(summary, null, 2)));
    if (stopped) console.log(`STOPPED: ${stopped}`);
    console.log(`records: ${runsPath}`);

    let ok = !stopped && sweep.clean === true;
    if (mode === "llm") ok = ok && Object.values(summary.llm ?? {}).every((s) => s.gate.passed);
    else ok = ok && records.every((r) => r.success === true);
    return ok ? 0 : 1;
  } finally {
    await closeAll();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`e2: ${error instanceof Error ? error.stack || error.message : error}`);
    process.exit(1);
  }
);
