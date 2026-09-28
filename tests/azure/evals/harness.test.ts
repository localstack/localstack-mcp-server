/**
 * The E2 harness against fake MCP sessions (no emulator, no key): one run in each mode,
 * the setup-error path, the cleanup sequence, the agent's tool dispatch (the synthetic
 * az_help included), the spend cap, the final sweep and the summary's gate.
 */
import type Anthropic from "@anthropic-ai/sdk";
import * as A from "./agent";
import * as H from "./harness";
import * as V from "./verifiers";
import * as VT from "./variants";
import type { McpResult, Task } from "./types";

type Answer = {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  classId?: string | null;
};
type Handler = (command: string) => Answer;

const MARKER = "ENVELOPE-MARKER-7f3a";

/** A session whose Azure tool answers with text + test envelope, from a handler. */
function fakeSession(handler: Handler) {
  const commands: string[] = [];
  const session: H.Session & { commands: string[] } = {
    commands,
    callTool: async (name, args): Promise<McpResult> => {
      if (name !== VT.AZURE_TOOL) throw new Error(`unexpected tool ${name}`);
      const command = String(args.command);
      commands.push(command);
      const a = handler(command);
      const text =
        a.exitCode === 0
          ? a.stdout || "The command succeeded and printed no output."
          : `❌ **Command Failed** (exit ${a.exitCode}, ${a.classId ?? "other"})\n\n${a.stderr ?? ""}`;
      const envelope = {
        exitCode: a.exitCode,
        stdout: a.stdout ?? "",
        stderr: a.stderr ?? "",
        notes: [],
        classId: a.classId ?? null,
        truncated: false,
        stoppedByTool: false,
        emulatorSession: MARKER,
      };
      return {
        content: [
          { type: "text", text },
          { type: "text", text: JSON.stringify(envelope) },
        ],
      };
    },
  };
  return session;
}

const OK = (stdout = ""): Answer => ({ exitCode: 0, stdout });
const NOT_FOUND: Answer = { exitCode: 1, stderr: "ERROR: NOT FOUND({})", classId: "not-found" };

/** The harness's own commands for group create and cleanup, then the task's. */
function harnessHandler(rg: string, task: Record<string, Answer | (() => Answer)>) {
  let exists = 0;
  return (command: string): Answer => {
    if (command === `group create --name ${rg} --location westeurope`)
      return OK(JSON.stringify({ name: rg }));
    if (command === `group exists --name ${rg}`) return OK(exists++ === 0 ? "true" : "false");
    if (command.startsWith(`resource list --resource-group ${rg}`)) return OK("[]");
    if (command.includes("/providers/Microsoft.Authorization/locks?"))
      return OK(JSON.stringify({ value: [] }));
    if (command === `group delete --name ${rg} --yes`) return OK("");
    const hit = task[command];
    if (hit) return typeof hit === "function" ? hit() : hit;
    throw new Error(`unscripted harness command: ${command}`);
  };
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function deps(
  agentSession: H.Session,
  harnessSession: H.Session,
  over: Partial<H.Deps> = {}
): H.Deps {
  const clock = fakeClock();
  return {
    lib: V,
    agent: A,
    variants: VT,
    agentSession,
    harnessSession,
    now: clock.now,
    sleep: clock.sleep,
    log: () => undefined,
    scrub: (s) => s,
    ...over,
  };
}

const TASK: Task = {
  id: "fake-read",
  tier: "T-A",
  caps: "T-A",
  opId: "Microsoft.Fake/Things_Get",
  verb: "read",
  prompts: [
    "What value does the thing {thing} in resource group {rg} hold?",
    "Tell me {thing}'s value ({rg}).",
  ],
  oracle: ["thing show --name {thing} --resource-group {rg}"],
  verify: V.claims("{value}"),
  setup: async (ctx) => {
    ctx.slots.thing = "t1";
    ctx.slots.value = "v-42";
    ctx.slots._secret_snapshot = "before";
    await V.azOk(ctx.q, `thing create --name t1 --resource-group ${ctx.rg}`);
  },
};

function spec(mode: H.Mode, rg: string, over: Partial<H.RunSpec> = {}): H.RunSpec {
  return {
    task: TASK,
    mode,
    variant: VT.buildVariantTools("compact", [
      { name: VT.AZURE_TOOL, description: "Run az.", inputSchema: { type: "object" } },
    ]),
    runIndex: 0,
    phrasing: 0,
    rg,
    model: "claude-opus-5-5",
    effort: "high",
    price: A.PRICES["claude-opus-5-5"],
    prefixTokens: 1000,
    budget: { maxUsd: 5, perRunUsd: 1, spent: 0 },
    verifyWaitS: 5,
    agentTimeoutMs: 1000,
    harnessTimeoutMs: 1000,
    ...over,
  };
}

describe("runOne", () => {
  test("oracle: the reference command through the agent session, the verifier through the harness", async () => {
    const rg = "mcpe2-t-fake-read-1";
    const harness = fakeSession(
      harnessHandler(rg, { [`thing create --name t1 --resource-group ${rg}`]: OK("{}") })
    );
    const agent = fakeSession((c) =>
      c === `thing show --name t1 --resource-group ${rg}`
        ? OK('{\n  "value": "v-42"\n}')
        : NOT_FOUND
    );
    const rec = await H.runOne(spec("oracle", rg), deps(agent, harness));
    expect(rec).toMatchObject({
      task_id: "fake-read",
      mode: "oracle",
      success: true,
      expected: "pass",
      failure: null,
      tool_calls: 1,
    });
    expect(agent.commands).toEqual([`thing show --name t1 --resource-group ${rg}`]);
    expect(harness.commands).not.toContain(`thing show --name t1 --resource-group ${rg}`);
    expect(rec.transcript).toContain(`ORACLE ✅ az thing show --name t1 --resource-group ${rg}`);
    expect(rec.cleanup).toMatchObject({ group_delete: "ok", gone: true });
    const input = rec.verify_input as { slots: Record<string, unknown> };
    expect(input.slots).toMatchObject({ _oracle: true, _secret_snapshot: "before", thing: "t1" });
    // Recorded slots leave the internal ones out.
    expect(rec.slots).toEqual({ resource_group: rg, rg, thing: "t1", value: "v-42" });
  });

  test("negative: setup only, and the verifier must fail", async () => {
    const rg = "mcpe2-t-fake-read-2";
    const harness = fakeSession(
      harnessHandler(rg, { [`thing create --name t1 --resource-group ${rg}`]: OK("{}") })
    );
    const agent = fakeSession(() => {
      throw new Error("the agent session must not be used");
    });
    const rec = await H.runOne(spec("negative", rg), deps(agent, harness));
    expect(rec).toMatchObject({ mode: "negative", expected: "fail", success: true, failure: null });
    expect((rec.verifier as { passed: boolean }).passed).toBe(false);
  });

  test("a setup failure is not scored, and the group is still cleaned up", async () => {
    const rg = "mcpe2-t-fake-read-3";
    const harness = fakeSession(
      harnessHandler(rg, {
        [`thing create --name t1 --resource-group ${rg}`]: { exitCode: 1, stderr: "ERROR: boom" },
      })
    );
    const rec = await H.runOne(
      spec("oracle", rg),
      deps(
        fakeSession(() => OK()),
        harness
      )
    );
    expect(rec).toMatchObject({ success: null, failure: "setup_error" });
    expect(String(rec.reason)).toContain("fixture: thing create --name t1");
    expect(harness.commands).toContain(`group delete --name ${rg} --yes`);
  });

  test("llm: the loop through a fake client; the envelope never reaches it; cost and budget", async () => {
    const rg = "mcpe2-t-fake-read-4";
    const harness = fakeSession(
      harnessHandler(rg, { [`thing create --name t1 --resource-group ${rg}`]: OK("{}") })
    );
    const agent = fakeSession((c) =>
      c.startsWith("thing show") ? OK('{"value": "v-42"}') : NOT_FOUND
    );
    const calls: unknown[] = [];
    const responses = [
      {
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: VT.AZURE_TOOL,
            input: { command: `thing show --name t1 --resource-group ${rg}` },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      {
        content: [{ type: "text", text: "The thing t1 holds v-42." }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000,
        },
      },
    ];
    const client: A.MessagesClient = {
      messages: {
        create: async (params) => {
          calls.push(JSON.parse(JSON.stringify(params)));
          return {
            id: "m",
            type: "message",
            role: "assistant",
            model: params.model,
            stop_sequence: null,
            stop_details: null,
            ...responses.shift(),
          } as unknown as Anthropic.Message;
        },
      },
    };
    const budget = { maxUsd: 5, perRunUsd: 1, spent: 0.5 };
    const rec = await H.runOne(
      spec("llm", rg, { budget }),
      deps(agent, harness, { client, classifyError: () => "api_error" })
    );
    expect(rec).toMatchObject({
      mode: "llm",
      success: true,
      failure: null,
      turns: 2,
      tool_calls: 1,
      refusal: false,
      prompt: `What value does the thing t1 in resource group ${rg} hold?`,
    });
    // (1000*4 + 100*20 + 200*4 + 50*20 + 1000*0.2) / 1e6
    expect(rec.cost_usd).toBe(0.008);
    expect(budget.spent).toBeCloseTo(0.508, 6);
    expect(JSON.stringify(calls)).not.toContain(MARKER);
    expect(rec.egress_events).toEqual([]);
    expect(rec.final_text).toBe("The thing t1 holds v-42.");
  });

  test("llm without a client is a programming error, not a silent pass", async () => {
    const rg = "mcpe2-t-fake-read-5";
    const harness = fakeSession(
      harnessHandler(rg, { [`thing create --name t1 --resource-group ${rg}`]: OK("{}") })
    );
    await expect(
      H.runOne(
        spec("llm", rg),
        deps(
          fakeSession(() => OK()),
          harness
        )
      )
    ).rejects.toThrow(/needs a client/);
  });
});

describe("cleanupRun", () => {
  test("settle, locks, vault delete and purge, group delete, soft-delete purge, gone", async () => {
    const rg = "mcpe2-t-kv-1";
    let exists = 0;
    const lockId = `/subscriptions/${V.SUBSCRIPTION}/resourceGroups/${rg}/providers/Microsoft.Authorization/locks/lk1`;
    const log: string[] = [];
    const session = fakeSession((c) => {
      log.push(c);
      if (c === `group exists --name ${rg}`) return OK(exists++ === 0 ? "true" : "false");
      if (c.startsWith(`resource list --resource-group ${rg} --query`)) return OK("[]");
      if (c.includes("/locks?api-version=2020-05-01") && c.includes("--method get"))
        return OK(JSON.stringify({ value: [{ id: lockId }] }));
      if (c.includes(`--method delete --url "${lockId}?api-version=2020-05-01"`)) return OK("");
      if (
        c.startsWith(
          `resource list --resource-group ${rg} --resource-type Microsoft.KeyVault/vaults`
        )
      )
        return OK('["kv1"]');
      if (c === `keyvault delete --name kv1 --resource-group ${rg}`) return OK("");
      if (c === "keyvault purge --name kv1") return OK("");
      if (c === "keyvault purge --name kv2") return NOT_FOUND;
      if (c === `group delete --name ${rg} --yes`) return OK("");
      if (c.startsWith("keyvault list-deleted")) return OK("[]");
      throw new Error(`unscripted: ${c}`);
    });
    const task: Task = { ...TASK, vaultSlots: ["vault_name", "kv2"] };
    const clock = fakeClock();
    const query = H.sessionQuery(deps(session, session, clock), session, 5, 1000);
    const out = await H.cleanupRun(query, V, task, rg, { vault_name: "kv1", kv2: "kv2" });
    expect(out).toMatchObject({
      locks_removed: ["lk1"],
      vaults_purged: ["kv1"],
      group_delete: "ok",
      gone: true,
    });
    const order = [
      `group exists --name ${rg}`,
      "resource list",
      "Microsoft.Authorization/locks?",
      "--method delete",
      "--resource-type Microsoft.KeyVault/vaults",
      "keyvault delete --name kv1",
      "keyvault purge --name kv1",
      "keyvault purge --name kv2",
      `group delete --name ${rg} --yes`,
      "keyvault list-deleted",
      `group exists --name ${rg}`,
    ];
    let i = 0;
    for (const want of order) {
      while (i < log.length && !log[i].includes(want)) i++;
      expect(i).toBeLessThan(log.length);
      i++;
    }
  });

  test("a group that is already gone needs nothing else", async () => {
    const session = fakeSession((c) => (c.startsWith("group exists") ? OK("false") : NOT_FOUND));
    const out = await H.cleanupRun(
      H.sessionQuery(deps(session, session), session, 5, 1000),
      V,
      TASK,
      "g",
      {}
    );
    expect(out.gone).toBe(true);
    expect(session.commands).toEqual(["group exists --name g"]);
  });
});

describe("the agent's tool dispatch", () => {
  const listed: VT.ListedTool[] = [
    {
      name: VT.AZURE_TOOL,
      description: `x\n${VT.HELP_SENTENCE}\ny`,
      inputSchema: { type: "object" },
    },
    { name: "localstack-docs", description: "docs", inputSchema: { type: "object" } },
  ];

  test("az_help runs `<prefix> --help` through the Azure tool", async () => {
    const agent = fakeSession(() => OK("Group\n    az storage account : Manage storage accounts."));
    const vt = VT.buildVariantTools("help-tool", listed);
    const call = H.agentToolCaller(
      deps(agent, agent),
      vt.tools.map((t) => t.name),
      1000
    );
    const out = await call("az_help", { prefix: "storage account" });
    expect(agent.commands).toEqual(["storage account --help"]);
    expect(out.text).toContain("Manage storage accounts");
    expect(out.text).not.toContain(MARKER);
    expect(out.envelope?.emulatorSession).toBe(MARKER);
  });

  test("a tool the run did not offer is an error the model sees", async () => {
    const agent = fakeSession(() => OK());
    const call = H.agentToolCaller(deps(agent, agent), [VT.AZURE_TOOL], 1000);
    expect(await call("localstack-docs", {})).toMatchObject({
      isError: true,
      text: "❌ Unknown tool 'localstack-docs' for this run",
    });
    expect(agent.commands).toEqual([]);
  });

  test("a transport failure is reported to the model as a failed call", async () => {
    const broken: H.Session = {
      callTool: async () => {
        throw new Error("timeout waiting for tools/call");
      },
    };
    const call = H.agentToolCaller(deps(broken, broken), [VT.AZURE_TOOL], 1000);
    expect(await call(VT.AZURE_TOOL, { command: "group list" })).toMatchObject({
      isError: true,
      text: "❌ Tool call failed: Error: timeout waiting for tools/call",
      command: "group list",
    });
  });
});

describe("the spend cap", () => {
  test("no new run once the spend reaches the cap", () => {
    expect(H.canStart({ maxUsd: 1, perRunUsd: 1, spent: 0.99 })).toBe(true);
    expect(H.canStart({ maxUsd: 1, perRunUsd: 1, spent: 1 })).toBe(false);
    expect(H.remaining({ maxUsd: 1, perRunUsd: 1, spent: 0.25 })).toBe(0.75);
  });

  test("an exhausted budget stops a run's loop before its first request", async () => {
    const rg = "mcpe2-t-fake-read-6";
    const harness = fakeSession(
      harnessHandler(rg, { [`thing create --name t1 --resource-group ${rg}`]: OK("{}") })
    );
    let requests = 0;
    const client: A.MessagesClient = {
      messages: {
        create: async () => {
          requests++;
          throw new Error("must not be called");
        },
      },
    };
    const budget = { maxUsd: 1, perRunUsd: 1, spent: 1 };
    const rec = await H.runOne(
      spec("llm", rg, { budget }),
      deps(
        fakeSession(() => OK()),
        harness,
        { client, classifyError: () => "api_error" }
      )
    );
    expect(requests).toBe(0);
    expect(rec).toMatchObject({ success: false, failure: "spend_cap", cost_usd: 0 });
  });
});

describe("finalSweep", () => {
  test("deletes what an emptied group index left behind, and checks again", async () => {
    const orphan = `/subscriptions/${V.SUBSCRIPTION}/resourceGroups/MCPE2-X-T-1/providers/Microsoft.KeyVault/vaults/kvo`;
    let gone = false;
    const session = fakeSession((c) => {
      if (c.includes("/providers/Microsoft.KeyVault/vaults?api-version=2023-07-01"))
        return OK(
          JSON.stringify({
            value: [
              { id: orphan },
              {
                id: `/subscriptions/${V.SUBSCRIPTION}/resourceGroups/other/providers/Microsoft.KeyVault/vaults/theirs`,
              },
            ],
          })
        );
      if (c.includes(`--method delete --url "${orphan}?`)) {
        gone = true;
        return OK("");
      }
      if (c.includes(`--method get --url "${orphan}?`)) return gone ? NOT_FOUND : OK("{}");
      if (c.startsWith("group list")) return OK("[]");
      if (c.startsWith("keyvault list-deleted")) return OK('["kvo", "not-mine"]');
      if (c === "keyvault purge --name kvo") return OK("");
      throw new Error(`unscripted: ${c}`);
    });
    const out = await H.finalSweep(H.sessionQuery(deps(session, session), session, 5, 1000), V, {
      types: ["Microsoft.KeyVault/vaults@2023-07-01"],
      groups: new Set(["mcpe2-x-t-1"]),
      prefix: "mcpe2-x",
      vaults: new Set(["kvo"]),
      apim: new Set(),
    });
    expect(out.orphans_deleted).toEqual([{ id: orphan, delete: 200, after: 404 }]);
    expect(out.vaults_purged).toEqual(["kvo"]);
    expect(session.commands.some((c) => c.includes("theirs"))).toBe(false);
  });
});

describe("selection, order, names", () => {
  const tasks = [
    { ...TASK, id: "a", tier: "T-A" as const },
    { ...TASK, id: "b", tier: "T-B" as const },
  ];
  test("selectTasks by id and tier, refusing unknown ones", () => {
    expect(H.selectTasks(tasks, { tiers: ["t-b"] }).map((t) => t.id)).toEqual(["b"]);
    expect(H.selectTasks(tasks, { ids: ["a"] }).map((t) => t.id)).toEqual(["a"]);
    expect(() => H.selectTasks(tasks, { ids: ["zz"] })).toThrow(/unknown task id/);
    expect(() => H.selectTasks(tasks, { tiers: ["T-D"] })).toThrow(/unknown tier/);
  });

  test("the seeded variant order repeats", () => {
    const a = H.shuffled(["x", "y", "z", "w"], H.seededRandom(7));
    const b = H.shuffled(["x", "y", "z", "w"], H.seededRandom(7));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(["w", "x", "y", "z"]);
  });

  test("group names carry the run's prefix and fit Azure's 90 characters", () => {
    expect(H.groupName("mcpe2-abc123", "kv-sign", 3)).toBe("mcpe2-abc123-kv-sign-3");
    expect(H.groupName("mcpe2-abc123", "x".repeat(200), 1).length).toBe(90);
  });
});

describe("summarize and the gate", () => {
  const row = (task: string, success: boolean | null, extra: Record<string, unknown> = {}) => ({
    mode: "llm",
    variant: "compact",
    task_id: task,
    success,
    cost_usd: 0.02,
    cost_warm_usd: 0.015,
    time_to_verified_ms: success ? 9000 : null,
    egress_events: [],
    ...extra,
  });

  test("95% success and zero egress pass the gate; cost per completed task is warm", () => {
    const rows = [...Array.from({ length: 19 }, (_, i) => row(`t${i}`, true)), row("t19", false)];
    const s = H.summarize(rows) as { llm: Record<string, any> };
    expect(s.llm.compact).toMatchObject({
      scored: 20,
      successes: 19,
      success_rate: 0.95,
      gate: { passed: true },
    });
    expect(s.llm.compact.cost_per_completed_task_warm_usd).toBeCloseTo((20 * 0.015) / 19, 6);
    expect(s.llm.compact.failed_tasks).toEqual(["t19 0/1"]);
  });

  test("one egress event fails the gate; infrastructure faults are not scored", () => {
    const rows = [
      row("a", true),
      row("b", true, { egress_events: [{ hosts: ["management.azure.com"] }] }),
      row("c", null, { failure: "infra_error" }),
    ];
    const s = H.summarize(rows) as { llm: Record<string, any> };
    expect(s.llm.compact).toMatchObject({
      scored: 2,
      success_rate: 1,
      egress_events: 1,
      infra_errors: 1,
      gate: { zero_egress: false, passed: false },
    });
  });

  test("refusals are counted, and Key Vault crypto refusals apart (experiment 3)", () => {
    const rows = [
      row("kv-sign", false, { refusal: true, kv_crypto: true }),
      row("x", false, { refusal: true }),
      row("kv-decrypt", true, { kv_crypto: true }),
    ];
    const s = H.summarize(rows) as { llm: Record<string, any> };
    expect(s.llm.compact).toMatchObject({ refusals: 2, kv_crypto_refusals: 1, kv_crypto_runs: 2 });
  });

  test("oracle and negative runs report met / not met", () => {
    const s = H.summarize([
      { mode: "oracle", task_id: "a", success: true, cleanup: { gone: true } },
      {
        mode: "oracle",
        task_id: "b",
        success: false,
        reason: "r",
        cleanup: { gone: false },
        rg: "g",
      },
    ]) as { oracle: Record<string, unknown> };
    expect(s.oracle).toMatchObject({
      runs: 2,
      met: 1,
      not_met: [{ task: "b", reason: "r" }],
      cleanup_not_gone: ["g"],
    });
  });
});
