/**
 * One E2 run, end to end, and what surrounds it: a port of the benchmark's harness/run.py
 * (run_one, _cleanup, the budget stop) for the unified server.
 *
 *   group create -> the task's setup (harness session) -> the oracle, the agent or nothing
 *   (agent session) -> the verifier (harness session, every answer recorded) -> teardown
 *   -> cleanup (settle, locks, vault purge, group delete, soft-delete purges, gone check)
 *
 * Two server sessions: the agent's (what the model, or the oracle, calls) and the harness's
 * own, which does setup, verification and cleanup, so verification never shares the
 * agent's session. The modules this file uses at runtime arrive in `deps` (run.mjs loads
 * everything with Node's type stripping; see verifiers.ts).
 */
import type * as A from "./agent";
import type * as V from "./verifiers";
import type * as VT from "./variants";
import type { AzAnswer, EgressEvent, McpResult, Price, Query, Slots, Task, Verdict } from "./types";

export type Mode = "llm" | "oracle" | "negative";

export interface Session {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpResult>;
}

export interface Deps {
  lib: typeof V;
  agent: typeof A;
  variants: typeof VT;
  agentSession: Session;
  harnessSession: Session;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  scrub: (text: string) => string;
  client?: A.MessagesClient;
  classifyError?: (e: unknown) => A.ErrorClass;
}

// ── the spend cap ─────────────────────────────────────────────────────────────

export interface Budget {
  /** Stop starting runs once the spend reaches it (the benchmark's --max-usd). */
  maxUsd: number;
  /** Stop a run's agent loop once the run's own cost reaches it. */
  perRunUsd: number;
  /** Billed so far (pre-warms included). */
  spent: number;
}

export function canStart(b: Budget): boolean {
  return b.spent < b.maxUsd;
}

export function remaining(b: Budget): number {
  return b.maxUsd - b.spent;
}

// ── sessions as queries ───────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** An AzAnswer from a split tool result; no envelope means the tool refused the command. */
export function answerOf(s: A.SplitResult): AzAnswer {
  if (s.envelope) {
    return {
      exitCode: s.envelope.exitCode,
      stdout: s.envelope.stdout ?? "",
      stderr: s.envelope.stderr ?? "",
      classId: s.envelope.classId ?? null,
      text: s.text,
      notes: s.envelope.notes ?? [],
      stoppedByTool: Boolean(s.envelope.stoppedByTool),
    };
  }
  return {
    exitCode: null,
    stdout: "",
    stderr: s.text,
    classId: "tool-refused",
    text: s.text,
    notes: [],
  };
}

/** A Query over a server session's Azure tool (egress refusals, which must not happen, are collected). */
export function sessionQuery(
  deps: Deps,
  session: Session,
  waitS: number,
  timeoutMs: number,
  egress: EgressEvent[] = []
): Query {
  let calls = 0;
  return {
    waitS,
    now: deps.now,
    sleep: deps.sleep,
    az: async (command) => {
      const index = calls++;
      let result: McpResult;
      try {
        result = await session.callTool(deps.variants.AZURE_TOOL, { command }, timeoutMs);
      } catch (e) {
        return {
          exitCode: null,
          stdout: "",
          stderr: `tool call failed: ${errorMessage(e)}`,
          classId: "tool-error",
          text: "",
        };
      }
      const split = deps.agent.splitEnvelope(result);
      egress.push(...deps.agent.egressOf(index, command, split.text, split.envelope).events);
      return answerOf(split);
    },
  };
}

/** The agent's tool calls: the Azure tool, the synthetic az_help, or (all tools) any other. */
export function agentToolCaller(
  deps: Deps,
  offered: readonly string[],
  timeoutMs: number
): (name: string, input: Record<string, unknown>) => Promise<A.ToolOutcome> {
  const names = new Set(offered);
  const { AZURE_TOOL, HELP_TOOL, helpCommand } = deps.variants;
  return async (name, input) => {
    const t0 = deps.now();
    if (!names.has(name))
      return {
        text: `❌ Unknown tool '${name}' for this run`,
        isError: true,
        ms: 0,
        envelope: null,
      };
    let target = name;
    let args = input;
    let command: string | undefined;
    if (name === HELP_TOOL) {
      command = helpCommand(String(input.prefix ?? ""));
      target = AZURE_TOOL;
      args = { command };
    } else if (name === AZURE_TOOL) {
      command = String(input.command ?? "");
    }
    try {
      const result = await deps.agentSession.callTool(target, args, timeoutMs);
      const split = deps.agent.splitEnvelope(result);
      return {
        text: split.text,
        isError: split.isError,
        ms: deps.now() - t0,
        envelope: split.envelope,
        command,
      };
    } catch (e) {
      return {
        text: `❌ Tool call failed: ${errorMessage(e)}`,
        isError: true,
        ms: deps.now() - t0,
        envelope: null,
        command,
      };
    }
  };
}

// ── cleanup ───────────────────────────────────────────────────────────────────

function list(stdout: string | undefined): string[] {
  try {
    const v = JSON.parse(stdout || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function slotNames(
  task: Task,
  key: "vaultSlots" | "apimSlots" | "appConfigSlots",
  slots: Slots
): string[] {
  return (task[key] ?? [])
    .map((s) => slots[s])
    .filter((x): x is string => typeof x === "string" && x !== "");
}

/**
 * Leaves nothing behind (plan section 7, local safety): wait until nothing in the group is
 * still provisioning (a group deleted while a storage account is Creating leaks its Azurite
 * container), remove its locks, delete and purge its Key Vaults, delete the group and wait,
 * purge what soft-deleted, and check the group is gone.
 */
export async function cleanupRun(
  q: Query,
  lib: typeof V,
  task: Task,
  rg: string,
  slots: Slots
): Promise<Record<string, unknown>> {
  const t0 = q.now();
  const out: Record<string, unknown> = {};
  const exists = await q.az(`group exists --name ${rg}`);
  if (exists.exitCode === 0 && exists.stdout.trim() === "false") {
    out.gone = true;
    out.ms = q.now() - t0;
    return out;
  }
  const pendingQuery =
    "[?provisioningState && provisioningState!='Succeeded' && provisioningState!='Failed' && provisioningState!='Canceled'].id";
  const settleDeadline = q.now() + 90_000;
  let pending: string[] = [];
  for (;;) {
    pending = list(
      (await q.az(`resource list --resource-group ${rg} --query "${pendingQuery}" -o json`)).stdout
    );
    if (pending.length === 0 || q.now() > settleDeadline) break;
    await q.sleep(2000);
  }
  if (pending.length) out.still_provisioning = pending.slice(0, 10);

  const locks = await lib.arm(
    q,
    "GET",
    `/subscriptions/${lib.SUBSCRIPTION}/resourceGroups/${rg}/providers/Microsoft.Authorization/locks`,
    "2020-05-01"
  );
  const lockIds =
    (lib.dotted(locks.body, "value") as unknown[] | null)
      ?.map((l) => lib.dotted(l, "id"))
      .filter((x): x is string => typeof x === "string") ?? [];
  const removedLocks: string[] = [];
  for (const id of lockIds) {
    const r = await lib.arm(q, "DELETE", id, "2020-05-01");
    if (r.status === 200) removedLocks.push(id.split("/").pop() || id);
  }
  if (removedLocks.length) out.locks_removed = removedLocks;

  const vaultsInGroup = list(
    (
      await q.az(
        `resource list --resource-group ${rg} --resource-type Microsoft.KeyVault/vaults --query "[].name" -o json`
      )
    ).stdout
  );
  const vaults = [...new Set([...vaultsInGroup, ...slotNames(task, "vaultSlots", slots)])];
  const purged: string[] = [];
  for (const n of vaultsInGroup) await q.az(`keyvault delete --name ${n} --resource-group ${rg}`);
  for (const n of vaults) {
    if ((await q.az(`keyvault purge --name ${n}`)).exitCode === 0) purged.push(n);
  }

  const del = await q.az(`group delete --name ${rg} --yes`);
  out.group_delete =
    del.exitCode === 0 ? "ok" : `exit ${del.exitCode}: ${(del.stderr || "").trim().slice(0, 200)}`;

  if (vaults.length) {
    const deleted = new Set(
      list((await q.az(`keyvault list-deleted --query "[].name" -o json`)).stdout)
    );
    for (const n of vaults.filter((x) => deleted.has(x))) {
      if ((await q.az(`keyvault purge --name ${n}`)).exitCode === 0) purged.push(n);
    }
  }
  if (purged.length) out.vaults_purged = purged;
  const apim = slotNames(task, "apimSlots", slots);
  if (apim.length) {
    const deleted = new Set(
      list((await q.az(`apim deletedservice list --query "[].name" -o json`)).stdout)
    );
    const done = [];
    for (const n of apim.filter((x) => deleted.has(x))) {
      if (
        (await q.az(`apim deletedservice purge --service-name ${n} --location westeurope`))
          .exitCode === 0
      )
        done.push(n);
    }
    if (done.length) out.apim_purged = done;
  }
  const stores = slotNames(task, "appConfigSlots", slots);
  if (stores.length) {
    const deleted = new Set(
      list((await q.az(`appconfig list-deleted --query "[].name" -o json`)).stdout)
    );
    const done = [];
    for (const n of stores.filter((x) => deleted.has(x))) {
      if ((await q.az(`appconfig purge --name ${n} --yes`)).exitCode === 0) done.push(n);
    }
    if (done.length) out.appconfig_purged = done;
  }
  const after = await q.az(`group exists --name ${rg}`);
  out.gone = after.exitCode === 0 && after.stdout.trim() === "false";
  out.ms = q.now() - t0;
  return out;
}

/**
 * The end-of-run orphan sweep (the benchmark's orphans.py): a PUT on a group that already
 * exists empties the group's resource index, and a later group delete then leaves those
 * resources running. The per-type subscription listings still show them, so every listed
 * type is read and whatever still sits in one of this run's groups is deleted. Then the
 * groups, the soft-deleted vaults and APIM services of this run are checked once more.
 */
export async function finalSweep(
  q: Query,
  lib: typeof V,
  opts: {
    types: readonly string[];
    groups: ReadonlySet<string>;
    prefix: string;
    vaults: ReadonlySet<string>;
    apim: ReadonlySet<string>;
  }
): Promise<Record<string, unknown>> {
  const groups = new Set([...opts.groups].map((g) => g.toLowerCase()));
  const orphans: Array<Record<string, unknown>> = [];
  for (const spec of [...new Set(opts.types)]) {
    const [type, api] = spec.split("@");
    const r = await lib.arm(q, "GET", `/subscriptions/${lib.SUBSCRIPTION}/providers/${type}`, api);
    const items = lib.dotted(r.body, "value");
    for (const item of Array.isArray(items) ? items : []) {
      const id = lib.pyStr(lib.dotted(item, "id") ?? "");
      const parts = id.split("/");
      if (
        parts.length < 5 ||
        parts[3].toLowerCase() !== "resourcegroups" ||
        !groups.has(parts[4].toLowerCase())
      )
        continue;
      const del = await lib.arm(q, "DELETE", id, api);
      const gone = await lib.waitStatus(q, id, api, [404, 410], 60);
      orphans.push({ id, delete: del.status, after: gone.status });
    }
  }
  const leftGroups = list(
    (await q.az(`group list --query "[?starts_with(name, '${opts.prefix}')].name" -o json`)).stdout
  );
  for (const g of leftGroups) await q.az(`group delete --name ${g} --yes`);
  const deletedVaults = list(
    (await q.az(`keyvault list-deleted --query "[].name" -o json`)).stdout
  ).filter((n) => opts.vaults.has(n));
  for (const n of deletedVaults) await q.az(`keyvault purge --name ${n}`);
  const deletedApim = opts.apim.size
    ? list((await q.az(`apim deletedservice list --query "[].name" -o json`)).stdout).filter((n) =>
        opts.apim.has(n)
      )
    : [];
  for (const n of deletedApim)
    await q.az(`apim deletedservice purge --service-name ${n} --location westeurope`);
  const stillGroups = list(
    (await q.az(`group list --query "[?starts_with(name, '${opts.prefix}')].name" -o json`)).stdout
  );
  const stillVaults = list(
    (await q.az(`keyvault list-deleted --query "[].name" -o json`)).stdout
  ).filter((n) => opts.vaults.has(n));
  return {
    orphans_deleted: orphans,
    groups_left_before: leftGroups,
    vaults_purged: deletedVaults,
    apim_purged: deletedApim,
    groups_left: stillGroups,
    deleted_vaults_left: stillVaults,
    clean: stillGroups.length === 0 && stillVaults.length === 0,
  };
}

// ── one run ─────────────────────────────────────────────────────────────────

export interface RunSpec {
  task: Task;
  mode: Mode;
  variant: VT.VariantTools;
  runIndex: number;
  phrasing: number;
  rg: string;
  model: string;
  effort: string;
  price?: Price;
  prefixTokens?: number | null;
  budget: Budget;
  verifyWaitS: number;
  agentTimeoutMs: number;
  harnessTimeoutMs: number;
}

const MAX_RECORDED_QUERIES = 80;
const MAX_RECORDED_STDOUT = 20_000;

function compactQueries(log: V.RecordedCall[]): Array<Record<string, unknown>> {
  return log.slice(0, MAX_RECORDED_QUERIES).map((c) => ({
    command: c.command,
    ...(c.repeat ? { repeat: c.repeat } : {}),
    answer: {
      ...c.answer,
      stdout:
        c.answer.stdout.length > MAX_RECORDED_STDOUT
          ? c.answer.stdout.slice(0, MAX_RECORDED_STDOUT)
          : c.answer.stdout,
      ...(c.answer.stdout.length > MAX_RECORDED_STDOUT ? { stdout_truncated: true } : {}),
    },
  }));
}

function recordSlots(slots: Slots): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(slots)) {
    if (!k.startsWith("_") && ["string", "number", "boolean"].includes(typeof value)) {
      out[k] =
        typeof value === "string" && value.length > 400
          ? `${value.slice(0, 40)}...(${value.length} chars)`
          : value;
    }
  }
  return out;
}

const MAX_VERIFY_TEXT = 64_000;

/** The slots a verifier read: primitives only, internal ones (snapshots) included. */
function verifySlots(slots: Slots): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(slots)) {
    if (["string", "number", "boolean"].includes(typeof value)) out[k] = value;
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One run of one task; returns its JSONL record. Never throws for a task's own failure. */
export async function runOne(spec: RunSpec, deps: Deps): Promise<Record<string, unknown>> {
  const { task, mode, rg, lib } = { ...spec, lib: deps.lib };
  const rec: Record<string, unknown> = {
    task_id: task.id,
    tier: task.tier,
    op_id: task.opId,
    provider: task.opId.split("/")[0],
    verb: task.verb,
    variant: spec.variant.variant,
    mode,
    model: mode === "llm" ? spec.model : null,
    effort: mode === "llm" ? spec.effort : null,
    run: spec.runIndex,
    phrasing: spec.phrasing,
    rg,
    guessable: Boolean(task.guessable),
    kv_crypto: Boolean(task.kvCrypto),
    started: nowIso(),
  };
  const harnessEgress: EgressEvent[] = [];
  const setupLog: V.RecordedCall[] = [];
  const q = sessionQuery(
    deps,
    deps.harnessSession,
    spec.verifyWaitS,
    spec.harnessTimeoutMs,
    harnessEgress
  );
  const setupQ = lib.recordingQuery(q, setupLog);
  const slots: Slots = { resource_group: rg, rg };

  const setupStart = deps.now();
  try {
    await lib.azOk(setupQ, `group create --name ${rg} --location westeurope`, "resource group");
    if (task.setup) await task.setup(lib.makeSetupContext(setupQ, slots, rg));
  } catch (e) {
    rec.setup = {
      ms: deps.now() - setupStart,
      calls: setupLog.length,
      error: deps.scrub(errorMessage(e)).slice(0, 500),
    };
    rec.success = null;
    rec.failure = "setup_error";
    rec.reason = `setup failed: ${deps.scrub(errorMessage(e)).slice(0, 300)}`;
    rec.slots = recordSlots(slots);
    rec.cleanup = await cleanupRun(q, lib, task, rg, slots).catch((err) => ({
      error: errorMessage(err),
    }));
    rec.harness_egress = harnessEgress;
    rec.ended = nowIso();
    return rec;
  }
  rec.setup = { ms: deps.now() - setupStart, calls: setupLog.length };

  let text = "";
  let run: A.AgentRun | null = null;
  const oracleTrace: Array<Record<string, unknown>> = [];
  const oracleEgress: EgressEvent[] = [];
  let oracleMs = 0;
  if (mode === "oracle") {
    const blocks: string[] = [];
    const t0 = deps.now();
    for (const step of task.oracle) {
      const command = typeof step === "string" ? lib.fill(step, slots) : await step(q, slots);
      const c0 = deps.now();
      let answer: AzAnswer;
      try {
        const result = await deps.agentSession.callTool(
          deps.variants.AZURE_TOOL,
          { command },
          spec.agentTimeoutMs
        );
        const split = deps.agent.splitEnvelope(result);
        oracleEgress.push(
          ...deps.agent.egressOf(oracleTrace.length, command, split.text, split.envelope).events
        );
        answer = answerOf(split);
      } catch (e) {
        answer = {
          exitCode: null,
          stdout: "",
          stderr: `tool call failed: ${errorMessage(e)}`,
          classId: "tool-error",
          text: "",
        };
      }
      oracleTrace.push({
        command: command.length > 600 ? `${command.slice(0, 600)}...` : command,
        exit_code: answer.exitCode,
        class_id: answer.classId,
        ms: deps.now() - c0,
      });
      blocks.push(lib.oracleBlock(command, answer));
    }
    oracleMs = deps.now() - t0;
    slots._oracle = true;
    text = blocks.join("\n");
  } else if (mode === "llm") {
    if (!deps.client || !spec.price || !deps.classifyError)
      throw new Error("llm mode needs a client, a price and an error classifier");
    const prompt = lib.fmt(task.prompts[spec.phrasing % task.prompts.length], slots);
    rec.prompt = prompt;
    try {
      run = await deps.agent.runAgent({
        client: deps.client,
        model: spec.model,
        effort: spec.effort,
        tools: spec.variant.tools,
        prompt,
        caps: deps.agent.CAPS[task.caps],
        price: spec.price,
        perRunUsd: spec.budget.perRunUsd,
        remainingUsd: () => remaining(spec.budget),
        // Every turn counts against the campaign's cap at once, so concurrent runs see it.
        onCost: (usd) => {
          spec.budget.spent += usd;
        },
        callTool: agentToolCaller(
          deps,
          spec.variant.tools.map((t) => t.name),
          spec.agentTimeoutMs
        ),
        classifyError: deps.classifyError,
        scrub: deps.scrub,
        now: deps.now,
      });
    } catch (e) {
      // A fault of the harness itself: not scored (as an infrastructure error), and the
      // run's group is still verified and cleaned up below.
      run = {
        final_text: "",
        stop: deps.scrub(errorMessage(e)).slice(0, 300),
        failure: "infra_error",
        refusal: false,
        stop_details: null,
        turns: [],
        tool_calls: [],
        egress: [],
        housekeeping: [],
        wall_ms: 0,
      };
    }
    text = run.final_text;
  }

  const verifyLog: V.RecordedCall[] = [];
  const vq = lib.recordingQuery(q, verifyLog);
  const v0 = deps.now();
  let verdict: Verdict;
  try {
    verdict = await task.verify(vq, slots, text);
  } catch (e) {
    verdict = { passed: false, reason: `verifier error: ${errorMessage(e).slice(0, 200)}` };
  }
  const verifyMs = deps.now() - v0;

  let teardown: string | undefined;
  if (task.teardown) {
    try {
      await task.teardown(q, slots);
      teardown = "ok";
    } catch (e) {
      teardown = errorMessage(e).slice(0, 200);
    }
  }
  const cleanup = await cleanupRun(q, lib, task, rg, slots).catch((err) => ({
    error: errorMessage(err),
  }));
  if (teardown) (cleanup as Record<string, unknown>).teardown = teardown;

  const expectPass = mode !== "negative";
  rec.expected = expectPass ? "pass" : "fail";
  rec.verifier = {
    passed: Boolean(verdict.passed),
    reason: deps.scrub(String(verdict.reason)).slice(0, 1000),
    ...(verdict.steps ? { steps: verdict.steps } : {}),
    queries: compactQueries(verifyLog),
  };
  if (verdict.steps) {
    rec.steps = verdict.steps;
    rec.steps_passed = verdict.steps.filter((s) => s.passed).length;
  }
  rec.verify_ms = verifyMs;
  // Everything the verifier read, so a verifier fixed later can re-score the run offline
  // (the benchmark's report/rescore.py needed exactly this): the slots at verification
  // time, snapshots included, and the text it was given.
  rec.verify_input = {
    slots: verifySlots(slots),
    text: text.length > MAX_VERIFY_TEXT ? text.slice(0, MAX_VERIFY_TEXT) : text,
    ...(text.length > MAX_VERIFY_TEXT ? { text_truncated: true } : {}),
  };

  if (mode === "llm" && run) {
    const infra = run.failure === "infra_error" || run.failure === "account_error";
    const price = spec.price!;
    // Already counted into the budget turn by turn (onCost).
    const cost = run.turns.length ? deps.agent.costUsd(run.turns, price) : 0;
    Object.assign(rec, {
      success: infra ? null : Boolean(verdict.passed),
      reason: infra
        ? `infrastructure: ${run.stop}`
        : rec.verifier && (rec.verifier as { reason: string }).reason,
      failure: verdict.passed ? null : (run.failure ?? "verify_failed"),
      stop: run.stop,
      refusal: run.refusal,
      stop_details: run.stop_details,
      wall_ms: Math.round(run.wall_ms),
      time_to_verified_ms: verdict.passed ? Math.round(run.wall_ms + verifyMs) : null,
      turns: run.turns.length,
      tool_calls: run.tool_calls.length,
      tool_ms: run.tool_calls.map((c) => c.ms),
      tokens: deps.agent.totals(run.turns),
      prefix_tokens: spec.prefixTokens ?? null,
      cost_usd: cost,
      cost_warm_usd: deps.agent.pricedCostUsd(run.turns, spec.prefixTokens, "warm", price),
      cost_cold_usd: deps.agent.pricedCostUsd(run.turns, spec.prefixTokens, "cold", price),
      egress_events: run.egress,
      housekeeping_blocks: run.housekeeping,
      turn_log: run.turns,
      tool_trace: run.tool_calls,
      final_text: deps.scrub(run.final_text).slice(0, 16000),
    });
  } else {
    const met = expectPass ? Boolean(verdict.passed) : !verdict.passed;
    Object.assign(rec, {
      success: met,
      reason: rec.verifier && (rec.verifier as { reason: string }).reason,
      failure: met ? null : expectPass ? "verify_failed" : "verifier_passed_without_action",
      wall_ms: oracleMs,
      egress_events: oracleEgress,
      tool_calls: oracleTrace.length,
      ...(mode === "oracle" ? { oracle: oracleTrace, transcript: text.slice(0, 16000) } : {}),
      cost_usd: 0,
    });
  }
  rec.harness_egress = harnessEgress;
  rec.slots = recordSlots(slots);
  rec.cleanup = cleanup;
  rec.ended = nowIso();
  return rec;
}

// ── selection, order and the summary ─────────────────────────────────────────

export function selectTasks(all: Task[], opts: { ids?: string[]; tiers?: string[] }): Task[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const unknown = (opts.ids ?? []).filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(", ")}`);
  const tiers = (opts.tiers ?? []).map((t) => t.toUpperCase());
  const badTier = tiers.filter((t) => !["T-A", "T-B", "T-APIM"].includes(t));
  if (badTier.length) throw new Error(`unknown tier(s): ${badTier.join(", ")} (T-A, T-B, T-APIM)`);
  return all.filter(
    (t) =>
      (!opts.ids?.length || opts.ids.includes(t.id)) && (!tiers.length || tiers.includes(t.tier))
  );
}

/** mulberry32: a small seeded generator, so the variant order is the same on a rerun. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function groupName(prefix: string, taskId: string, n: number): string {
  return `${prefix}-${taskId}-${n}`.slice(0, 90);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

type Rec = Record<string, any>;

/** Per variant: success, cost per completed task, time, egress, refusals, and the gate. */
export function summarize(records: Rec[], gate = { success: 0.95 }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const modes = [...new Set(records.map((r) => r.mode))];
  for (const mode of modes) {
    const rows = records.filter((r) => r.mode === mode);
    if (mode !== "llm") {
      const met = rows.filter((r) => r.success === true).length;
      out[mode] = {
        runs: rows.length,
        met,
        not_met: rows
          .filter((r) => r.success === false)
          .map((r) => ({ task: r.task_id, reason: r.reason })),
        setup_errors: rows
          .filter((r) => r.success === null)
          .map((r) => ({ task: r.task_id, reason: r.reason })),
        egress_events: rows.reduce((n, r) => n + (r.egress_events?.length ?? 0), 0),
        harness_egress: rows.reduce((n, r) => n + (r.harness_egress?.length ?? 0), 0),
        cleanup_not_gone: rows
          .filter((r) => r.cleanup && r.cleanup.gone === false)
          .map((r) => r.rg),
      };
      continue;
    }
    const variants: Record<string, unknown> = {};
    for (const variant of [...new Set(rows.map((r) => r.variant))]) {
      const vr = rows.filter((r) => r.variant === variant);
      const scored = vr.filter((r) => r.success !== null && r.success !== undefined);
      const ok = scored.filter((r) => r.success === true);
      const perTask = new Map<string, { n: number; ok: number }>();
      for (const r of scored) {
        const e = perTask.get(r.task_id) ?? { n: 0, ok: 0 };
        e.n += 1;
        e.ok += r.success ? 1 : 0;
        perTask.set(r.task_id, e);
      }
      const taskMeans = [...perTask.values()].map((e) => e.ok / e.n);
      const billed = vr.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      const warm = scored.reduce((s, r) => s + (r.cost_warm_usd ?? r.cost_usd ?? 0), 0);
      const egress = vr.reduce((n, r) => n + (r.egress_events?.length ?? 0), 0);
      const rate = scored.length ? ok.length / scored.length : 0;
      variants[variant] = {
        runs: vr.length,
        scored: scored.length,
        successes: ok.length,
        success_rate: Math.round(rate * 10000) / 10000,
        success_mean_over_tasks: taskMeans.length
          ? Math.round((taskMeans.reduce((a, b) => a + b, 0) / taskMeans.length) * 10000) / 10000
          : 0,
        billed_usd: Math.round(billed * 1e6) / 1e6,
        cost_per_completed_task_warm_usd: ok.length
          ? Math.round((warm / ok.length) * 1e6) / 1e6
          : null,
        cost_per_completed_task_billed_usd: ok.length
          ? Math.round((billed / ok.length) * 1e6) / 1e6
          : null,
        median_time_to_verified_ms: median(
          ok.map((r) => r.time_to_verified_ms).filter((x) => typeof x === "number")
        ),
        egress_events: egress,
        refusals: vr.filter((r) => r.refusal).length,
        kv_crypto_refusals: vr.filter((r) => r.refusal && r.kv_crypto).length,
        kv_crypto_runs: vr.filter((r) => r.kv_crypto).length,
        setup_errors: vr.filter((r) => r.failure === "setup_error").length,
        infra_errors: vr.filter((r) => r.failure === "infra_error" || r.failure === "account_error")
          .length,
        spend_capped: vr.filter((r) => r.failure === "spend_cap").length,
        failed_tasks: [...perTask]
          .filter(([, e]) => e.ok < e.n)
          .map(([id, e]) => `${id} ${e.ok}/${e.n}`),
        gate: {
          success_at_least: gate.success,
          success_ok: rate >= gate.success,
          zero_egress: egress === 0,
          passed: rate >= gate.success && egress === 0 && scored.length > 0,
        },
      };
    }
    out.llm = variants;
  }
  return out;
}
