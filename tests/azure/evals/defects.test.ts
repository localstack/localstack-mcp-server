/**
 * Regression tests for the seven verifier defects the benchmark found after data
 * collection (research-2026-09-24/19-campaign-log.md, "verifier defect"; the fixes are in
 * benchmark/report/rescore.py). For each defect:
 *   1. the benchmark's ORIGINAL reader (ported below, as it was) misreads a correct answer;
 *   2. the fixed E2 verifier reads the same answer correctly;
 *   3. a wrong answer still fails, so the fix did not just loosen the check.
 */
import * as V from "./verifiers";
import type { AzAnswer, Slots } from "./types";

const SUB = V.SUBSCRIPTION;
const RG = "mcpe2-defects-rg";
const ok = (body: unknown): AzAnswer => ({
  exitCode: 0,
  stdout: JSON.stringify(body),
  stderr: "",
  classId: null,
});
const notFound = (): AzAnswer => ({
  exitCode: 1,
  stdout: "",
  stderr: 'ERROR: NOT FOUND({"error": {"code": "DeploymentNotFound"}})',
  classId: "not-found",
});
const q = (calls: Array<[string, AzAnswer]>) =>
  V.replayQuery(calls.map(([command, answer]) => ({ command, answer })));

// ── the benchmark's original readers, verbatim in logic ─────────────────────

/** ta.py rights_claim (before fix 1): 30 characters back, and a negation pattern whose
 * \b before "n't" can never match inside "doesn't". */
function originalRightsAffirmed(text: string): Set<string> {
  const low = text.toLowerCase();
  const affirmed = new Set<string>();
  for (const right of ["listen", "send", "manage"]) {
    for (const m of low.matchAll(new RegExp(`\\b${right}\\b`, "g"))) {
      const before = low.slice(Math.max(0, m.index! - 30), m.index!);
      if (!/\b(not|no|without|lacks?|excluding|except|n't)\b/.test(before)) {
        affirmed.add(right);
        break;
      }
    }
  }
  return affirmed;
}

/** ta.py validation_claim (before fix 2): any "error(s)" or "fail" anywhere fails. */
function originalValidation(text: string): boolean {
  const neg = /\binvalid\b|\bnot\s+valid\b|\bfail(?:ed|s)?\b|\berrors?\b/i;
  const pos = /\bvalid\b|\bpass(?:ed|es)?\b|\bsucceed(?:ed|s)?\b|\bsuccessful(?:ly)?\b/i;
  return pos.test(text) && !neg.test(text);
}

/** tb.py untagged_reported (before fix 3): each name's stretch per sentence (verifiers.spans). */
function originalUntagged(text: string, untagged: string[], tagged: string[]): boolean {
  const neg = /\b(?:no|without|missing|lacks?|lacking|untagged|not\s+tagged|none)\b|❌/i;
  const pos = /\bhas\b|\bhave\b|\btagged\b|owner\s*[=:]|✅/i;
  const stated = V.statedBooleans(text, [...untagged, ...tagged], pos, neg);
  const one = (s: Set<boolean> | undefined, v: boolean) =>
    s !== undefined && s.size === 1 && s.has(v);
  return (
    untagged.every((n) => one(stated.get(n), false)) &&
    !tagged.some((n) => stated.get(n)?.has(false))
  );
}

/** tb.py endpoint_stated (before fix 4): the emulator's value verbatim, port included. */
function originalEndpointStated(want: string, text: string): boolean {
  const w = want.replace(/\/+$/, "");
  return w !== "" && text.toLowerCase().includes(w.toLowerCase());
}

/** pilot.py availability (before fix 5), as reused for Front Door host names. */
function originalAvailability(text: string, truth: Record<string, boolean>): boolean {
  const neg =
    /\bnot\s+(be\s+)?(available|free|usable)\b|\bunavailable\b|\btaken\b|\balready\b|alreadyexists|\bin\s+use\b|\bcan\s*(not|'t)\s+(be\s+)?use|name\s*available["']?\s*[:=]\s*false|❌/i;
  const pos =
    /\bavailable\b|\bfree\b|\bcan\s+be\s+used\b|\bcan\s+(?:create|use)\b|\busable\b|name\s*available["']?\s*[:=]\s*true|✅/i;
  const stated = V.statedBooleans(text, Object.keys(truth), pos, neg);
  return Object.entries(truth).every(([n, t]) => {
    const s = stated.get(n);
    return s !== undefined && s.size === 1 && s.has(t);
  });
}

/** tapim.py membership_stated (before fix 6): every stretch's verdict is collected. */
function originalMembership(text: string, truth: Record<string, boolean>): boolean {
  const neg =
    /\bnot\s+(?:a\s+)?member\b|\bisn'?t\s+(?:a\s+)?member\b|\bnot\s+in\s+(?:the\s+)?group\b|\bdoes\s*n[o']?t\s+belong\b|\bnot\s+part\s+of\b|\bnon-?member\b|❌/i;
  const pos = /\bmember\b|\bbelongs?\b|\bin\s+the\s+group\b|\bpart\s+of\b|✅/i;
  const stated = V.statedBooleans(text, Object.keys(truth), pos, neg);
  return Object.entries(truth).every(([n, t]) => {
    const s = stated.get(n);
    return s !== undefined && s.size === 1 && s.has(t);
  });
}

/** tapim.py access_stated (before fix 7): the stretches about "direct"/"management". */
function originalAccess(text: string, want: boolean): boolean {
  const neg =
    /\bnot\s+(?:currently\s+)?(?:allowed|enabled|permitted|on)\b|\bdisallowed\b|\bdisabled\b|\bblocked\b|\bdenied\b|\bturned\s+off\b|\bswitched\s+off\b|\bis\s+off\b|\ballow\W{0,4}false\b|❌/i;
  const pos =
    /\ballowed\b|\benabled\b|\bpermitted\b|\bturned\s+on\b|\bis\s+on\b|\ballow\W{0,4}true\b|✅/i;
  const verdicts = new Set<boolean>();
  for (const [name, span] of V.spans(text, ["direct", "management", "git"])) {
    if (name === "git") continue;
    const v = neg.test(span) ? false : pos.test(span) ? true : null;
    if (v !== null) verdicts.add(v);
  }
  return verdicts.size === 1 && verdicts.has(want);
}

// ── 1. eventhub-hub-auth-rule-rights ─────────────────────────────────────────

describe('defect 1: eventhub-hub-auth-rule-rights (negation inside "doesn\'t")', () => {
  const path =
    "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.EventHub/namespaces/{namespace_name}/eventhubs/{eventhub_name}/authorizationRules/{auth_rule_name}";
  const cmd = V.restCommand(
    "GET",
    `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.EventHub/namespaces/ns1/eventhubs/hub1/authorizationRules/rule1`,
    "2026-01-01"
  );
  const slots: Slots = {
    rg: RG,
    namespace_name: "ns1",
    eventhub_name: "hub1",
    auth_rule_name: "rule1",
  };
  const rule = (rights: string[]) => q([[cmd, ok({ properties: { rights } })]]);
  const verify = V.rightsClaim(path, "2026-01-01");

  const SEND_ONLY =
    "The rule rule1 grants only one right: **Send**. It doesn't include Listen or Manage.";
  test("the campaign's answer: the original reader affirmed all three rights", () => {
    expect([...originalRightsAffirmed(SEND_ONLY)].sort()).toEqual(["listen", "manage", "send"]);
  });
  test("the fixed reader affirms Send only, and the verifier passes", async () => {
    expect([...V.affirmedRights(SEND_ONLY)]).toEqual(["send"]);
    expect((await verify(rule(["Send"]), slots, SEND_ONLY)).passed).toBe(true);
  });

  const BULLETS =
    "The policy grants two rights:\n- **Listen**: receive events\n- **Send**: publish events\n\nIt cannot manage the hub.";
  test("a bullet list after 'grants N rights:' (the original read Manage from 'cannot manage')", async () => {
    expect([...originalRightsAffirmed(BULLETS)].sort()).toEqual(["listen", "manage", "send"]);
    expect((await verify(rule(["Listen", "Send"]), slots, BULLETS)).passed).toBe(true);
  });

  test("a wrong answer still fails", async () => {
    expect((await verify(rule(["Send"]), slots, "It grants Listen and Send.")).passed).toBe(false);
    expect((await verify(rule(["Listen", "Send", "Manage"]), slots, SEND_ONLY)).passed).toBe(false);
  });
});

// ── 2. deployment-sub-validate ───────────────────────────────────────────────

describe("defect 2: deployment-sub-validate (any 'error' or 'fail' failed the answer)", () => {
  const path = "/subscriptions/{sub}/providers/Microsoft.Resources/deployments/{deployment_name}";
  const cmd = V.restCommand(
    "GET",
    `/subscriptions/${SUB}/providers/Microsoft.Resources/deployments/dep-1`,
    "2022-09-01"
  );
  const verify = V.validationClaim(path, "2022-09-01");
  const slots: Slots = { deployment_name: "dep-1" };
  const ANSWER =
    "The template passed validation at subscription scope (westeurope): no errors, and nothing was deployed.";

  test("the original reader failed the correct answer", () => {
    expect(originalValidation(ANSWER)).toBe(false);
  });
  test("the fixed reader passes it (nothing was deployed)", async () => {
    expect(V.validationVerdict(ANSWER)).toBe(true);
    expect((await verify(q([[cmd, notFound()]]), slots, ANSWER)).passed).toBe(true);
  });
  test("an invalid verdict fails, and so does a run that deployed", async () => {
    expect(
      (await verify(q([[cmd, notFound()]]), slots, "Validation failed: the template is invalid."))
        .passed
    ).toBe(false);
    expect(
      await verify(
        q([[cmd, ok({ properties: { provisioningState: "Succeeded" } })]]),
        slots,
        ANSWER
      )
    ).toEqual({
      passed: false,
      reason: "a deployment was created (validation must not deploy)",
    });
  });
});

// ── 3. tb-tag-audit ──────────────────────────────────────────────────────────

describe("defect 3: tb-tag-audit (stretches per sentence lost the table's verdicts)", () => {
  const names = { t1: "tbvnet-a1", t2: "tbnsg-b2", u1: "tbpip-c3", u2: "tbrt-d4" };
  const TABLE = [
    "| Name | Type | owner tag |",
    "|---|---|---|",
    "| tbvnet-a1 | Microsoft.Network/virtualNetworks | ✅ owner=team-1a2b |",
    "| tbnsg-b2 | Microsoft.Network/networkSecurityGroups | ✅ owner=team-1a2b |",
    "| tbpip-c3 | Microsoft.Network/publicIPAddresses | ❌ **missing** (no tags) |",
    "| tbrt-d4 | Microsoft.Network/routeTables | ❌ **missing** (no tags) |",
    "",
    "Only tbvnet-a1 and tbnsg-b2 carry an owner tag, so tbpip-c3 and tbrt-d4 need one.",
  ].join("\n");
  const verify = V.untaggedReported(["u1", "u2"], ["t1", "t2"]);

  test("the original reader missed the table's ❌ rows", () => {
    expect(originalUntagged(TABLE, [names.u1, names.u2], [names.t1, names.t2])).toBe(false);
  });
  test("the fixed per-line reader passes it", async () => {
    expect(await verify(q([]), { ...names }, TABLE)).toEqual({
      passed: true,
      reason: "untagged not reported: []; tagged reported as untagged: []",
    });
  });
  test("calling a tagged resource untagged still fails", async () => {
    const wrong = TABLE.replace(
      "| tbvnet-a1 | Microsoft.Network/virtualNetworks | ✅ owner=team-1a2b |",
      "| tbvnet-a1 | Microsoft.Network/virtualNetworks | ❌ missing |"
    );
    expect((await verify(q([]), { ...names }, wrong)).passed).toBe(false);
    expect((await verify(q([]), { ...names }, "Every resource has an owner tag.")).passed).toBe(
      false
    );
  });
});

// ── 4. tb-mysql-firewall ─────────────────────────────────────────────────────

describe("defect 4: tb-mysql-firewall (the FQDN demanded with the emulator's port)", () => {
  // The emulator's fullyQualifiedDomainName, as recorded on 2026-09-27 (a port included).
  const FQDN = "tbmy-fa57a1.mysql.database.localhost.localstack.cloud:4513";
  const verify = V.hostStated(async () => FQDN);
  const ANSWER =
    "The server's fully qualified domain name is tbmy-fa57a1.mysql.database.localhost.localstack.cloud.";

  test("the original check failed a domain name without the port", () => {
    expect(originalEndpointStated(FQDN, ANSWER)).toBe(false);
  });
  test("the fixed check accepts it with or without the port", async () => {
    expect(V.hostOf(FQDN)).toBe("tbmy-fa57a1.mysql.database.localhost.localstack.cloud");
    expect((await verify(q([]), {}, ANSWER)).passed).toBe(true);
    expect((await verify(q([]), {}, `FQDN: ${FQDN}`)).passed).toBe(true);
  });
  test("another host still fails", async () => {
    expect(
      (await verify(q([]), {}, "The FQDN is tbmy-fa57a1.mysql.database.azure.com.")).passed
    ).toBe(false);
  });
});

// ── 5. td-afd-hostname-check (T-D; the fixed reader is in the library) ──────

describe("defect 5: td-afd-hostname-check (dots in host names split the sentences)", () => {
  const slots: Slots = { taken_host: "shop-x1.contoso.com", free_host: "store-y2.contoso.com" };
  const truth = { "shop-x1.contoso.com": false, "store-y2.contoso.com": true };
  const verify = V.hostAvailability("taken_host", "free_host");
  const TABLE =
    "| Host | Available |\n|---|---|\n| shop-x1.contoso.com | ❌ No | nameAvailable: false, already in use |\n| store-y2.contoso.com | ✅ Yes | free |";
  const SENTENCE = "store-y2.contoso.com is available, but shop-x1.contoso.com is already taken.";

  test("the original reader found no verdict in a table or a sentence", () => {
    expect(originalAvailability(TABLE, truth)).toBe(false);
    expect(originalAvailability(SENTENCE, truth)).toBe(false);
  });
  test("the fixed reader: the first verdict word after each host decides", async () => {
    expect((await verify(q([]), slots, TABLE)).passed).toBe(true);
    expect((await verify(q([]), slots, SENTENCE)).passed).toBe(true);
  });
  test("swapped verdicts still fail", async () => {
    expect(
      (
        await verify(
          q([]),
          slots,
          "shop-x1.contoso.com is available, but store-y2.contoso.com is already taken."
        )
      ).passed
    ).toBe(false);
  });
});

// ── 6. apim-group-user-check ─────────────────────────────────────────────────

describe("defect 6: apim-group-user-check (verdicts collected across stretches)", () => {
  const slots: Slots = { user1: "alice1a2", user2: "bob3c4", member: "alice1a2", group: "devs5e6" };
  const truth = { alice1a2: true, bob3c4: false };
  const ANSWER = [
    "I checked whether alice1a2 and bob3c4 belong to devs5e6.",
    "- alice1a2: ✅ member of devs5e6",
    "- bob3c4: not a member (the user account does exist)",
  ].join("\n");
  const verify = V.membershipStated();

  test("the original reader read bob3c4 as both (the 'whether' line affirmed him)", () => {
    expect(originalMembership(ANSWER, truth)).toBe(false);
  });
  test("the fixed reader skips the 'whether' line; the first verdict word decides", async () => {
    expect((await verify(q([]), slots, ANSWER)).passed).toBe(true);
  });
  test("a wrong membership still fails", async () => {
    expect((await verify(q([]), { ...slots, member: "bob3c4" }, ANSWER)).passed).toBe(false);
    expect((await verify(q([]), slots, "Both alice1a2 and bob3c4 are members.")).passed).toBe(
      false
    );
  });
});

// ── 7. apim-tenant-access ────────────────────────────────────────────────────

describe('defect 7: apim-tenant-access ("enabled: false" read as enabled)', () => {
  const ANSWER =
    "No. Direct management API access is turned off.\n\n- Management API: `enabled: false`\n- Git access: enabled";
  const verify = V.accessStated();

  test("the original reader read the answer as mixed", () => {
    expect(originalAccess(ANSWER, false)).toBe(false);
  });
  test("the fixed reader: the first verdict word decides", async () => {
    expect(V.tenantAccessVerdict(ANSWER)).toBe(false);
    expect((await verify(q([]), { access_enabled: false }, ANSWER)).passed).toBe(true);
  });
  test("the opposite verdict still fails", async () => {
    expect((await verify(q([]), { access_enabled: true }, ANSWER)).passed).toBe(false);
    expect(
      (
        await verify(
          q([]),
          { access_enabled: false },
          "Yes, direct management API access is enabled."
        )
      ).passed
    ).toBe(false);
  });
});
