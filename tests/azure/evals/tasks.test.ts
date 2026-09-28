/**
 * The E2 task catalogue, and every task's verifier against answers recorded in live runs
 * against the LocalStack Azure emulator: the benchmark's oracle (the verifier must pass) and
 * setup alone (the verifier must fail). Replaying the recordings proves the verifiers score
 * real emulator answers as they did live, without an emulator.
 */
import { readFileSync } from "fs";
import path from "path";
import { tapimTasks } from "./tasks-tapim";
import { taTasks } from "./tasks-ta";
import { tbTasks } from "./tasks-tb";
import * as V from "./verifiers";
import type { AzAnswer, Task } from "./types";

const TASKS: Task[] = [...taTasks(V), ...tbTasks(V), ...tapimTasks(V)];
const BY_ID = new Map(TASKS.map((t) => [t.id, t]));

const EXPECTED: Record<string, string[]> = {
  "T-A": [
    "appconfig-kv-unlock",
    "appconfig-check-keys",
    "appconfig-regenerate-key",
    "lock-delete",
    "locks-list",
    "role-definition-get",
    "acr-login-server",
    "acr-webhook-create",
    "eventgrid-topic-regenerate-key",
    "eventgrid-domain-disable-local-auth",
    "eventhub-hub-auth-rule-rights",
    "insights-activity-log-alert-create",
    "kv-sign",
    "kv-decrypt",
    "kv-rotation-policy",
    "kv-access-policy-grant",
    "identity-create",
    "identity-list",
    "route-get",
    "private-dns-zones-list",
    "vnet-address-space",
    "la-workspace-retention",
    "deployment-sub-validate",
    "sb-queue-regenerate-key",
    "sb-dp-queue-max-delivery",
    "storage-regenerate-key",
    "disk-create",
    "cdn-can-migrate",
  ],
  "T-B": [
    "tb-storage-blob",
    "tb-keyvault-secret-sign",
    "tb-servicebus-topic",
    "tb-resource-graph-tags",
    "tb-tag-audit",
    "tb-mysql-firewall",
    "tb-eventgrid-to-eventhub",
    "tb-webapp-settings",
  ],
  "T-APIM": [
    "apim-group-user-check",
    "apim-workspace-product-update",
    "apim-tenant-access",
    "apim-git-regenerate-primary",
    "apim-api-create",
    "apim-operation-delete",
    "apim-operation-policy",
    "apim-tag-assign-api",
    "apim-tag-detach-product",
    "apim-api-tag-descriptions",
    "apim-graphql-resolver",
    "apim-certificate-create",
    "apim-oidc-secret",
    "apim-migrate-stv2",
  ],
};

/** Every `{name}` a template names (Python str.format fields; `{{` escapes skipped). */
function fields(template: string): string[] {
  return [...template.replace(/\{\{|\}\}/g, "").matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    (m) => m[1]
  );
}

describe("the task catalogue", () => {
  test("50 tasks drawn from T-A, T-B and T-APIM, with the benchmark's ids", () => {
    expect(TASKS).toHaveLength(50);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const [tier, ids] of Object.entries(EXPECTED)) {
      expect(TASKS.filter((t) => t.tier === tier).map((t) => t.id)).toEqual(ids);
    }
  });

  test("the E2 tasks of the benchmark's verifier defects are all here", () => {
    for (const id of [
      "eventhub-hub-auth-rule-rights",
      "deployment-sub-validate",
      "tb-tag-audit",
      "tb-mysql-firewall",
      "apim-group-user-check",
      "apim-tenant-access",
    ]) {
      expect(BY_ID.has(id)).toBe(true);
    }
  });

  test("the Key Vault crypto tasks that experiment 3 counts", () => {
    expect(TASKS.filter((t) => t.kvCrypto).map((t) => t.id)).toEqual([
      "kv-sign",
      "kv-decrypt",
      "tb-keyvault-secret-sign",
    ]);
  });

  test.each(TASKS.map((t) => [t.id, t] as const))("%s is complete", (_id, t) => {
    expect(t.prompts.length).toBeGreaterThanOrEqual(1);
    expect(t.prompts.length).toBe(t.tier === "T-A" ? 2 : 1);
    expect(t.oracle.length).toBeGreaterThanOrEqual(1);
    expect(typeof t.verify).toBe("function");
    expect(t.caps).toBe(t.tier === "T-B" ? "T-B" : "T-A");
    expect(t.opId).toMatch(/^(Microsoft\.[A-Za-z.]+|workflow)\/\S+$/);
    for (const step of t.oracle) {
      if (typeof step === "string") expect(step).not.toMatch(/^az\s/);
    }
  });

  test("a task that has the agent create a vault or an APIM service names it for the purge", () => {
    for (const t of TASKS) {
      for (const step of t.oracle) {
        if (typeof step !== "string") continue;
        const vault = /^keyvault create --name \{(\w+)\}/.exec(step);
        if (vault) expect([t.id, t.vaultSlots]).toEqual([t.id, expect.arrayContaining([vault[1]])]);
      }
      if (t.tier === "T-APIM") expect(t.apimSlots).toEqual(["service_name"]);
    }
  });
});

interface Entry {
  task: string;
  mode: "oracle" | "negative";
  passed: boolean;
  wait_s: number;
  slots: Record<string, unknown>;
  text: string;
  queries: Array<{ command: string; repeat?: number; answer: AzAnswer }>;
}

const RECORDED: { entries: Entry[] } = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "recorded-verifications.json"), "utf8")
);

describe("recorded verifications (live oracle and negative runs, replayed)", () => {
  test("every task has a passing (oracle) and a failing (negative) recording", () => {
    for (const t of TASKS) {
      const modes = RECORDED.entries.filter((e) => e.task === t.id).map((e) => [e.mode, e.passed]);
      expect([t.id, modes]).toEqual([
        t.id,
        expect.arrayContaining([
          ["oracle", true],
          ["negative", false],
        ]),
      ]);
    }
  });

  test.each(
    RECORDED.entries
      .filter((e) => BY_ID.has(e.task))
      .map((e) => [e.task, e.mode, e.passed, e] as const)
  )("%s (%s) replays to passed=%s", async (_task, _mode, passed, entry) => {
    const task = BY_ID.get(entry.task)!;
    const q = V.replayQuery(entry.queries, entry.wait_s);
    const verdict = await task.verify(q, { ...entry.slots }, entry.text);
    expect([verdict.passed, verdict.reason]).toEqual([passed, expect.any(String)]);
  });

  test("every prompt and oracle template is filled by a recorded setup's slots", () => {
    for (const e of RECORDED.entries.filter((x) => x.mode === "oracle")) {
      const task = BY_ID.get(e.task);
      if (!task) continue;
      const have = new Set([...Object.keys(e.slots), "sub"]);
      const templates = [
        ...task.prompts,
        ...task.oracle.filter((s): s is string => typeof s === "string"),
      ];
      const missing = templates.flatMap(fields).filter((f) => !have.has(f));
      expect([e.task, missing]).toEqual([e.task, []]);
    }
  });
});
