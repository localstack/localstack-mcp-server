/**
 * The E2 verifier library against recorded answers (no emulator): each verifier with a
 * passing and a failing recording, the query helpers, and offline checks of the answer
 * readers, case by case.
 */
import * as V from "./verifiers";
import type { AzAnswer, Slots } from "./types";

const SUB = V.SUBSCRIPTION;
const RG = "mcpe2-test-rg";

function ok(stdout: unknown): AzAnswer {
  return {
    exitCode: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout, null, 2),
    stderr: "",
    classId: null,
  };
}
/** As az rest prints a 404 on this emulator (recorded 2026-09-27: upper-case reason). */
function notFound(): AzAnswer {
  return {
    exitCode: 1,
    stdout: "",
    stderr:
      'ERROR: NOT FOUND({"error": {"code": "ResourceNotFound", "message": "not found", "details": [], "additionalInfo": []}})\r\n',
    classId: "not-found",
  };
}
function failed(stderr: string, exitCode = 1, classId: string | null = "other"): AzAnswer {
  return { exitCode, stdout: "", stderr, classId };
}
const get = (path: string, api: string) => V.restCommand("GET", path, api);
const post = (path: string, api: string) => V.restCommand("POST", path, api);
const rgPath = (rest: string) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers${rest}`;
const slots = (extra: Slots = {}): Slots => ({ rg: RG, resource_group: RG, ...extra });

function replay(calls: Array<[string, AzAnswer] | [string, AzAnswer, number]>, waitS = 90) {
  return V.replayQuery(
    calls.map(([command, answer, repeat]) => ({ command, answer, ...(repeat ? { repeat } : {}) })),
    waitS
  );
}

describe("Python-compatible helpers", () => {
  test("pyStr renders JSON values as Python's str() did", () => {
    expect([
      V.pyStr(true),
      V.pyStr(false),
      V.pyStr(null),
      V.pyStr(undefined),
      V.pyStr(14),
      V.pyStr("x"),
    ]).toEqual(["True", "False", "None", "None", "14", "x"]);
  });

  test("pyJson matches json.dumps layout", () => {
    expect(V.pyJson({ a: [1, "b"], c: { d: null, e: true } })).toBe(
      '{"a": [1, "b"], "c": {"d": null, "e": true}}'
    );
    expect(V.pyJson({ $schema: "s", resources: [] })).toBe('{"$schema": "s", "resources": []}');
  });

  test("fmt fills {name}, keeps {{ }} as braces and refuses an unknown name", () => {
    expect(V.fmt("a {x} {{0,8}} {y}", { x: 1, y: true })).toBe("a 1 {0,8} True");
    expect(() => V.fmt("{nope}", {})).toThrow(/no value for \{nope\}/);
    expect(V.fill("/subscriptions/{sub}/resourceGroups/{rg}", { rg: "g" })).toBe(
      `/subscriptions/${SUB}/resourceGroups/g`
    );
  });

  test("normText drops whitespace, underscores and hyphens", () => {
    expect(V.normText("North Europe")).toBe("northeurope");
    expect(V.normText("General_Purpose-x")).toBe("generalpurposex");
  });

  // test_verifiers.py: _dotted
  test("dotted: selections, list indexes, missing parts", () => {
    const body = {
      keys: [
        { keyName: "key1", value: "A" },
        { keyName: "key2", value: "B" },
      ],
      value: [{ name: "Primary", value: "P" }],
      c: { list: [{ image: "nginx" }] },
    };
    expect(V.dotted(body, "keys[keyName=key2].value")).toBe("B");
    expect(V.dotted(body, "value[name=Primary].value")).toBe("P");
    expect(V.dotted(body, "c.list.0.image")).toBe("nginx");
    expect(V.dotted(body, "keys[keyName=nope].value")).toBeNull();
    expect(V.dotted(body, "c.list.5.image")).toBeNull();
    expect(V.dotted({ a: { b: null } }, "a.b.c")).toBeNull();
  });

  test("base64 forms", () => {
    expect(V.toStdB64("ab-_")).toBe("ab+/");
    expect(V.toStdB64("abc")).toBe("abc=");
    expect(V.toB64url("ab+/cd==")).toBe("ab-_cd");
    expect(V.b64url("order-1")).toBe("b3JkZXItMQ");
  });
});

describe("az rest status", () => {
  test("exit 0 is 200; a reason phrase in stderr gives the status", () => {
    expect(V.httpStatus(ok({}))).toBe(200);
    expect(V.httpStatus(notFound())).toBe(404);
    expect(V.httpStatus(failed("ERROR: GONE({})"))).toBe(410);
    expect(V.httpStatus(failed("ERROR: Bad Request({})"))).toBe(400);
    expect(V.httpStatus(failed("WARNING: x\nERROR: NOT IMPLEMENTED({})"))).toBe(501);
    expect(
      V.httpStatus(failed("ERROR: the following arguments are required: --name", 2, "argument"))
    ).toBe(0);
  });

  test("a command the tool stopped is not a 200", () => {
    expect(V.httpStatus({ ...ok({}), stoppedByTool: true })).toBe(0);
  });

  test("restCommand quotes the URL and refuses a single quote in a body", () => {
    expect(V.restCommand("PUT", "/x", "1", { a: 1 })).toBe(
      `rest --method put --url "/x?api-version=1" --body '{"a":1}'`
    );
    expect(() => V.restCommand("PUT", "/x", "1", { a: "it's" })).toThrow(/single quote/);
  });
});

describe("replay and recording", () => {
  test("a recorded command replays in order, then keeps its last answer", async () => {
    const q = replay([
      ["group exists --name g", ok("true")],
      ["group exists --name g", ok("false")],
    ]);
    expect((await q.az("group exists --name g")).stdout).toBe("true");
    expect((await q.az("group exists --name g")).stdout).toBe("false");
    expect((await q.az("group exists --name g")).stdout).toBe("false");
  });

  test("an unrecorded command is an error, never a silent default", async () => {
    await expect(replay([]).az("group list")).rejects.toThrow(/unrecorded query/);
  });

  test("recordingQuery folds repeated identical answers", async () => {
    const log: V.RecordedCall[] = [];
    const inner = replay([["a", ok(1)]]);
    const q = V.recordingQuery(inner, log);
    await q.az("a");
    await q.az("a");
    await q.az("a");
    expect(log).toEqual([{ command: "a", answer: V.recordable(ok(1)), repeat: 3 }]);
  });
});

describe("state verifiers", () => {
  const path = rgPath("/Microsoft.Compute/disks/{disk_name}");
  const cmd = get(rgPath("/Microsoft.Compute/disks/d1"), "2026-03-02");

  test("exists: GET 200 with Succeeded passes; Failed or 404 fails", async () => {
    const s = slots({ disk_name: "d1" });
    const good = await V.exists(path, "2026-03-02")(
      replay([[cmd, ok({ properties: { provisioningState: "Succeeded" } })]]),
      s,
      ""
    );
    expect(good).toEqual({ passed: true, reason: "GET d1 -> 200 Succeeded" });
    const bad = await V.exists(path, "2026-03-02")(
      replay([[cmd, ok({ properties: { provisioningState: "Failed" } })]]),
      s,
      ""
    );
    expect(bad.passed).toBe(false);
    const missing = await V.exists(path, "2026-03-02")(replay([[cmd, notFound()]], 5), s, "");
    expect(missing).toEqual({ passed: false, reason: "GET d1 -> 404" });
  });

  test("exists polls until the state is terminal", async () => {
    const q = replay([
      [cmd, ok({ properties: { provisioningState: "Creating" } })],
      [cmd, ok({ properties: { provisioningState: "Succeeded" } })],
    ]);
    expect((await V.exists(path, "2026-03-02")(q, slots({ disk_name: "d1" }), "")).passed).toBe(
      true
    );
    expect(q.asked.length).toBe(2);
  });

  test("gone: 404 or 410 passes, 200 fails at the deadline", async () => {
    const s = slots({ disk_name: "d1" });
    expect((await V.gone(path, "2026-03-02")(replay([[cmd, notFound()]]), s, "")).passed).toBe(
      true
    );
    expect(
      (await V.gone(path, "2026-03-02")(replay([[cmd, failed("ERROR: GONE({})")]]), s, "")).passed
    ).toBe(true);
    expect(await V.gone(path, "2026-03-02")(replay([[cmd, ok({})]], 3), s, "")).toEqual({
      passed: false,
      reason: "GET d1 -> 200",
    });
  });

  test("readyWith compares fields as Python's str() did (True, numbers)", async () => {
    const body = {
      sku: { name: "StandardSSD_LRS" },
      properties: { diskSizeGB: 64, provisioningState: "Succeeded", flag: true },
    };
    const s = slots({ disk_name: "d1", size_gb: 64 });
    const v = V.readyWith(path, "2026-03-02", {
      "properties.diskSizeGB": "{size_gb}",
      "sku.name": "StandardSSD_LRS",
      "properties.flag": "True",
    });
    expect((await v(replay([[cmd, ok(body)]]), s, "")).passed).toBe(true);
    const wrong = await V.readyWith(path, "2026-03-02", { "properties.diskSizeGB": "{size_gb}" })(
      replay([[cmd, ok({ ...body, properties: { ...body.properties, diskSizeGB: 32 } })]]),
      s,
      ""
    );
    expect(wrong.passed).toBe(false);
    expect(wrong.reason).toContain('fields differ {"properties.diskSizeGB":32}');
  });

  test("fieldIs polls until the value arrives, case-insensitively", async () => {
    const q = replay([
      [cmd, ok({ properties: { state: "Running" } })],
      [cmd, ok({ properties: { state: "STOPPED" } })],
    ]);
    expect(
      await V.fieldIs(
        path,
        "2026-03-02",
        "properties.state",
        "Stopped"
      )(q, slots({ disk_name: "d1" }), "")
    ).toEqual({
      passed: true,
      reason: "properties.state -> STOPPED",
    });
  });

  test("fieldIs fails at the deadline with the last value", async () => {
    const q = replay([[cmd, ok({ properties: { locked: true } })]], 2);
    const r = await V.fieldIs(
      path,
      "2026-03-02",
      "properties.locked",
      "false"
    )(q, slots({ disk_name: "d1" }), "");
    expect(r).toEqual({ passed: false, reason: "properties.locked -> True" });
    expect(q.asked.length).toBeGreaterThan(3);
  });

  test("listFieldContains: every item, any order, case-insensitive", async () => {
    const c1 = get(rgPath("/Microsoft.Compute/disks/d1"), "1");
    const check = V.listFieldContains(path, "1", "properties.actions", ["push", "delete"]);
    const has = replay([[c1, ok({ properties: { actions: ["Delete", "push"] } })]]);
    expect((await check(has, slots({ disk_name: "d1" }), "")).passed).toBe(true);
    const missing = replay([[c1, ok({ properties: { actions: ["push"] } })]], 2);
    expect((await check(missing, slots({ disk_name: "d1" }), "")).passed).toBe(false);
  });

  test("changedAndKept: the changed key differs, the kept one does not", async () => {
    const keysPath = rgPath("/Microsoft.EventGrid/topics/{topic_name}/listKeys");
    const c = post(rgPath("/Microsoft.EventGrid/topics/t1/listKeys"), "2025-02-15");
    const s = slots({ topic_name: "t1", _before_changed: "old1", _before_kept: "k2" });
    const v = V.changedAndKept(keysPath, "2025-02-15", "key1", "key2");
    expect(await v(replay([[c, ok({ key1: "new1", key2: "k2" })]]), s, "")).toEqual({
      passed: true,
      reason: "key1 rotated, key2 kept",
    });
    expect((await v(replay([[c, ok({ key1: "old1", key2: "k2" })]]), s, "")).reason).toBe(
      "key1 unchanged, key2 kept"
    );
    expect((await v(replay([[c, ok({ key1: "new1", key2: "new2" })]]), s, "")).reason).toBe(
      "key1 rotated, key2 CHANGED"
    );
  });

  test("answerHasFields: the answer states the emulator's value", async () => {
    const regPath = rgPath("/Microsoft.ContainerRegistry/registries/{registry_name}");
    const c = get(rgPath("/Microsoft.ContainerRegistry/registries/acr1"), "2025-11-01");
    const body = {
      properties: { loginServer: "acr1.azurecr.azure.localhost.localstack.cloud:4566" },
    };
    const v = V.answerHasFields(regPath, "2025-11-01", ["properties.loginServer"]);
    const s = slots({ registry_name: "acr1" });
    expect(
      (
        await v(
          replay([[c, ok(body)]]),
          s,
          "Log in to acr1.azurecr.azure.localhost.localstack.cloud:4566."
        )
      ).passed
    ).toBe(true);
    expect((await v(replay([[c, ok(body)]]), s, "Log in to acr1.azurecr.io.")).passed).toBe(false);
    expect(await v(replay([[c, notFound()]]), s, "anything")).toEqual({
      passed: false,
      reason: "GET -> 404",
    });
  });

  test("allOf runs every check and joins the reasons", async () => {
    const r = await V.allOf(V.claims("a"), V.claims("b"))(replay([]), {}, "a");
    expect(r).toEqual({ passed: false, reason: 'all claims present; missing ["b"]' });
  });
});

describe("answer verifiers", () => {
  test("claims is a case-insensitive substring check of every template", async () => {
    const v = V.claims("{lock1}", "{lock2}");
    expect(
      (
        await v(
          replay([]),
          { lock1: "lk-ops-1", lock2: "lk-audit-2" },
          "Locks: LK-OPS-1 and lk-audit-2"
        )
      ).passed
    ).toBe(true);
    expect(
      (await v(replay([]), { lock1: "lk-ops-1", lock2: "lk-audit-2" }, "Locks: lk-ops-1")).reason
    ).toBe('missing ["lk-audit-2"]');
  });

  test("claimsNorm and claimsAnyNorm ignore spaces, case, hyphens and underscores", async () => {
    expect(
      (
        await V.claimsNorm("{region}")(
          replay([]),
          { region: "northeurope" },
          "It is in North Europe."
        )
      ).passed
    ).toBe(true);
    expect(
      (
        await V.claimsAnyNorm("{tier}", "{sku}")(
          replay([]),
          { tier: "GeneralPurpose", sku: "GP_Gen5" },
          "General Purpose"
        )
      ).passed
    ).toBe(true);
    expect(
      (
        await V.claimsAnyNorm("{tier}", "{sku}")(
          replay([]),
          { tier: "GeneralPurpose", sku: "GP_Gen5" },
          "Business Critical"
        )
      ).passed
    ).toBe(false);
  });

  test("textMatches escapes slot values before they reach the pattern", async () => {
    const v = V.textMatches("\\b{prefix}\\b");
    expect((await v(replay([]), { prefix: "10.1.2.0/24" }, "prefix 10.1.2.0/24")).passed).toBe(
      true
    );
    expect((await v(replay([]), { prefix: "10.1.2.0/24" }, "prefix 10x1x2x0/24")).passed).toBe(
      false
    );
  });

  test("the rotation-policy patterns read P45D and '45 days'", async () => {
    const v = V.allOf(
      V.textMatches("(?:P{rotate_days}D|\\b{rotate_days}\\s*-?\\s*days?\\b)"),
      V.textMatches("(?:P{expiry_days}D|\\b{expiry_days}\\s*-?\\s*days?\\b)")
    );
    const s = { rotate_days: 45, expiry_days: 270 };
    expect(
      (await v(replay([]), s, "It rotates 45 days after creation and expires after 270 days."))
        .passed
    ).toBe(true);
    expect(
      (await v(replay([]), s, '"timeAfterCreate": "P45D" ... "expiryTime": "P270D"')).passed
    ).toBe(true);
    expect(
      (await v(replay([]), s, "It rotates after 45 days and expires after 365 days.")).passed
    ).toBe(false);
  });

  test("plaintextStated accepts the text or its base64url form", async () => {
    const v = V.plaintextStated();
    expect(
      (await v(replay([]), { plaintext: "order-abc" }, "The plaintext is order-abc.")).passed
    ).toBe(true);
    expect((await v(replay([]), { plaintext: "order-abc" }, "b3JkZXItYWJj")).passed).toBe(true);
    expect(
      (await v(replay([]), { plaintext: "order-abc" }, "I could not decrypt it.")).passed
    ).toBe(false);
  });

  test("workflow passes only when every step does, and keeps each step", async () => {
    const r = await V.workflow(["one", V.claims("a")], ["two", V.claims("b")])(replay([]), {}, "a");
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("1/2 steps; failed: two");
    expect(r.steps).toEqual([
      { step: "one", passed: true, reason: "all claims present" },
      { step: "two", passed: false, reason: 'missing ["b"]' },
    ]);
  });

  test("workflow turns a step's exception into that step's failure", async () => {
    const boom = async () => {
      throw new Error("kaput");
    };
    const r = await V.workflow(["ok", V.claims("a")], ["boom", boom])(replay([]), {}, "a");
    expect(r.steps?.[1]).toEqual({
      step: "boom",
      passed: false,
      reason: "verifier error: Error: kaput",
    });
  });
});

// ── offline checks of the answer readers ────────────────────────────────────────

describe("offline checks: exists_claims", () => {
  const HAVE = "feature-flags-7a1";
  const MISSING = "legacy-timeout-3c9";
  const SLOTS = { key: HAVE, missing_key: MISSING };
  const CHECK = V.existsClaims({ key: true, missing_key: false });
  const CASES: Array<[string, boolean]> = [
    [`${HAVE} exists, but ${MISSING} does not exist.`, true],
    [`Found ${HAVE}. ${MISSING} was not found in the store.`, true],
    [`- \`${HAVE}\`: ✅ present\n- \`${MISSING}\`: ❌ missing`, true],
    [
      `| Key | Exists |\n|---|---|\n| ${HAVE} | yes, it exists |\n| ${MISSING} | no such key |`,
      true,
    ],
    [`The key ${HAVE} is there; there is no key named ${MISSING}.`, true],
    [`Both ${HAVE} and ${MISSING} exist.`, false],
    [`${HAVE} does not exist. ${MISSING} exists.`, false],
    [`I looked at ${HAVE} and ${MISSING}.`, false],
    [`${HAVE} exists.`, false],
  ];
  test.each(CASES)("%s -> %s", async (text, want) => {
    expect((await CHECK(replay([]), { ...SLOTS }, text)).passed).toBe(want);
  });

  test("oracle: filtered listings name only the existing key", async () => {
    const r = await CHECK(
      replay([]),
      { ...SLOTS, _oracle: true },
      `[{"key": "${HAVE}", "value": "on"}]\n[]`
    );
    expect(r.passed).toBe(true);
  });

  test("oracle: a transcript that echoes both names in its command lines", async () => {
    const text = [
      V.oracleBlock(`appconfig kv list --name s --key ${HAVE}`, ok([{ key: HAVE, locked: false }])),
      V.oracleBlock(`appconfig kv list --name s --key ${MISSING}`, ok([])),
    ].join("\n");
    expect((await CHECK(replay([]), { ...SLOTS, _oracle: true }, text)).passed).toBe(true);
  });

  test("truth: fixture drift fails before the answer is read", async () => {
    const truth = async () => false;
    const r = await V.existsClaims({ key: true, missing_key: false }, truth)(
      replay([]),
      { ...SLOTS },
      `${HAVE} exists; ${MISSING} is missing.`
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("fixture drift");
  });
});

describe("offline checks: migration_verdict", () => {
  const MIGRATE = V.migrationVerdict("can_migrate");
  const CASES: Array<[boolean, string, boolean]> = [
    [
      true,
      "Yes — the classic CDN profile cdnp1 can be migrated to Azure Front Door. The check returned canMigrate: true with no errors; the default target SKU is Standard_AzureFrontDoor.",
      true,
    ],
    [true, "The profile cdnp1 is eligible for migration; no blocking issues were found.", true],
    [
      true,
      "Yes, it can be migrated. Note that once you commit the migration it cannot be undone.",
      true,
    ],
    [true, "Yes. Nothing is blocking it.", true],
    [
      true,
      "No — cdnp1 cannot be migrated yet: it has no endpoints to migrate (NoEndpointsToMigrate).",
      false,
    ],
    [true, "The profile is not eligible for migration.", false],
    [true, "I checked the profile cdnp1.", false],
    [
      false,
      "No — cdnp1 cannot be migrated yet: it has no endpoints to migrate (NoEndpointsToMigrate). Create an endpoint first.",
      true,
    ],
    [false, "It is not eligible because the profile doesn't have any endpoints.", true],
    [false, "The compatibility check failed with NoEndpointsToMigrate.", true],
    [
      false,
      "It can be migrated once it has endpoints; right now the profile has 0 endpoints.",
      true,
    ],
    [false, "Yes, the profile cdnp1 can be migrated to Azure Front Door.", false],
    [false, "No, it cannot be migrated.", false],
  ];
  test.each(CASES)("can=%s %s -> %s", async (can, text, want) => {
    expect((await MIGRATE(replay([]), { can_migrate: can }, text)).passed).toBe(want);
  });

  test("oracle outputs carry the verdict", async () => {
    const yes = '{"canMigrate": true, "defaultSku": "Standard_AzureFrontDoor", "errors": []}';
    const no = '{"canMigrate": false, "errors": [{"code": "NoEndpointsToMigrate"}]}';
    expect((await MIGRATE(replay([]), { can_migrate: true, _oracle: true }, yes)).passed).toBe(
      true
    );
    expect((await MIGRATE(replay([]), { can_migrate: false, _oracle: true }, no)).passed).toBe(
      true
    );
    expect(
      (
        await MIGRATE(
          replay([]),
          { can_migrate: true, _oracle: true },
          "Profile 'p' checked successfully."
        )
      ).passed
    ).toBe(false);
  });
});

describe("offline checks: sql-elastic-pool and sql-db-audit-policy patterns", () => {
  // ta.py's POOL_CAPACITY and AUDIT_RETENTION (the SQL tasks are not in E2; the patterns
  // exercise textMatches' Python-format escaping).
  const POOL_CAPACITY =
    "\\b{capacity}\\s*-?\\s*v?-?cores?\\b|\\b(?:capacity|v-?cores?)\\b(?:[\\s:|=*\"'`]|of|is|set\\s+to){{0,8}}\\b{capacity}\\b";
  const AUDIT_RETENTION =
    "\\b{audit_days}\\s*-?\\s*days?\\b|\\bretention(?:\\s*(?:period|days?))?\\b(?:[\\s:|=*\"'`()]|of|is|days?|set\\s+to){{0,10}}\\b{audit_days}\\b";
  const POOL = V.allOf(V.claimsAnyNorm("{pool_tier}", "{pool_sku}"), V.textMatches(POOL_CAPACITY));
  const POOL_SLOTS = { pool_tier: "GeneralPurpose", pool_sku: "GP_Gen5", capacity: 8 };
  const POOL_CASES: Array<[string, boolean]> = [
    ["The pool uses the General Purpose tier (GP_Gen5) with 8 vCores.", true],
    ["Tier: GeneralPurpose, capacity: 8", true],
    [
      '{"sku": {"name": "GP_Gen5", "tier": "GeneralPurpose", "family": "Gen5", "capacity": 8}}',
      true,
    ],
    ["**Tier:** General Purpose · **Capacity:** 8", true],
    ["It is a General Purpose pool with a capacity of 8 vCores.", true],
    ["| Tier | Business Critical |\n| vCores | 8 |", false],
    ["The pool is General Purpose with 4 vCores (8 GB max per database).", false],
  ];
  test.each(POOL_CASES)("pool %s -> %s", async (text, want) => {
    expect((await POOL(replay([]), { ...POOL_SLOTS }, text)).passed).toBe(want);
  });
  const AUDIT = V.textMatches(AUDIT_RETENTION);
  const AUDIT_CASES: Array<[string, boolean]> = [
    ["Audit logs are retained for 45 days.", true],
    ["Retention: 45", true],
    ["**Retention (days):** 45", true],
    ["The retention period is 45 days.", true],
    ['{"retentionDays": 45, "state": "Enabled"}', true],
    ["Retention is 90 days; 45 GB used.", false],
  ];
  test.each(AUDIT_CASES)("audit %s -> %s", async (text, want) => {
    expect((await AUDIT(replay([]), { audit_days: 45 }, text)).passed).toBe(want);
  });
});

// ── task-specific verifiers ──────────────────────────────────────────────────

describe("Key Vault verifiers", () => {
  const verifyCmd = (vault: string, key: string, version: string, digest: string, sig: string) =>
    `keyvault key verify --vault-name ${vault} --name ${key} --version ${version} --algorithm RS256 --digest ${V.toStdB64(digest)} --signature ${V.toStdB64(sig)}`;
  const SIG = "A".repeat(300) + "+/";
  const s = { vault_name: "kv1", key_name: "k1", key_version: "abc", digest: "ZGlnZXN0" };

  test("signatureVerifies: a stated signature that the vault verifies", async () => {
    const q = replay([[verifyCmd("kv1", "k1", "abc", "ZGlnZXN0", SIG), ok({ isValid: true })]]);
    expect(await V.signatureVerifies()(q, s, `Signature: ${SIG}`)).toEqual({
      passed: true,
      reason: "a signature in the answer verifies",
    });
  });

  test("signatureVerifies: no candidate, or the vault says invalid", async () => {
    expect((await V.signatureVerifies()(replay([]), s, "Signed it, done.")).passed).toBe(false);
    const q = replay([[verifyCmd("kv1", "k1", "abc", "ZGlnZXN0", SIG), ok({ isValid: false })]]);
    expect((await V.signatureVerifies()(q, s, SIG)).passed).toBe(false);
  });

  test("signatureVerifiesIn tries every key version", async () => {
    const sig = "B".repeat(80);
    const q = replay([
      [
        "keyvault key list-versions --vault-name v --name k",
        ok([{ kid: "https://v.vault/keys/k/v1" }, { kid: "https://v.vault/keys/k/v2" }]),
      ],
      [verifyCmd("v", "k", "v1", "ZA", sig), ok({ isValid: false })],
      [verifyCmd("v", "k", "v2", "ZA", sig), ok({ isValid: true })],
    ]);
    expect(
      (
        await V.signatureVerifiesIn("kv", "key", "digest")(
          q,
          { kv: "v", key: "k", digest: "ZA" },
          `sig=${sig}`
        )
      ).passed
    ).toBe(true);
  });

  test("accessPolicyGrants: the principal's policy holds the permissions", async () => {
    const vaultPath = rgPath("/Microsoft.KeyVault/vaults/{vault_name}");
    const c = get(rgPath("/Microsoft.KeyVault/vaults/kv1"), "2023-07-01");
    const oid = "11111111-2222-3333-4444-555555555555";
    const body = (perms: string[]) => ({
      properties: {
        accessPolicies: [{ objectId: oid.toUpperCase(), permissions: { secrets: perms } }],
      },
    });
    const v = V.accessPolicyGrants(vaultPath, "2023-07-01", "object_id", "secrets", [
      "get",
      "list",
    ]);
    expect(
      (
        await v(
          replay([[c, ok(body(["Get", "List", "Set"]))]]),
          slots({ vault_name: "kv1", object_id: oid }),
          ""
        )
      ).passed
    ).toBe(true);
    expect(
      (await v(replay([[c, ok(body(["get"]))]]), slots({ vault_name: "kv1", object_id: oid }), ""))
        .passed
    ).toBe(false);
  });

  test("secretIs reads the data plane through az", async () => {
    const q = replay([
      ["keyvault secret show --vault-name kv1 --name s1", ok({ value: "S3cret-abc" })],
    ]);
    expect(
      (await V.secretIs("kv", "secret", "{v}")(q, { kv: "kv1", secret: "s1", v: "S3cret-abc" }, ""))
        .passed
    ).toBe(true);
    const missing = replay([
      ["keyvault secret show --vault-name kv1 --name s1", failed("ERROR: (SecretNotFound) no")],
    ]);
    expect(
      (
        await V.secretIs("kv", "secret", "{v}")(
          missing,
          { kv: "kv1", secret: "s1", v: "S3cret-abc" },
          ""
        )
      ).passed
    ).toBe(false);
  });

  test("kidVersion", () => {
    expect(
      V.kidVersion("https://kv.vault.azure.localhost.localstack.cloud:4566/keys/k1/b5f4e5559079")
    ).toBe("b5f4e5559079");
  });
});

describe("resource index, web app and API Management verifiers", () => {
  test("indexTagIs reads the ARM resource index", async () => {
    const c = get(`/subscriptions/${SUB}/resourceGroups/${RG}/resources`, "2021-04-01");
    const q = replay([
      [
        c,
        ok({
          value: [
            { name: "kva", tags: { costcenter: "cc-1" } },
            { name: "kvb", tags: null },
          ],
        }),
      ],
    ]);
    expect(
      (await V.indexTagIs("kv1", "costcenter", "{cc}")(q, slots({ kv1: "kva", cc: "cc-1" }), ""))
        .passed
    ).toBe(true);
    const q2 = replay([[c, ok({ value: [{ name: "kvb", tags: null }] })]]);
    expect(
      (await V.indexTagIs("kv1", "costcenter", "{cc}")(q2, slots({ kv1: "kvb", cc: "cc-1" }), ""))
        .passed
    ).toBe(false);
  });

  test("appSetting reads config/appsettings/list", async () => {
    const site = "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{app}";
    const c = post(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Web/sites/web1/config/appsettings/list`,
      "2026-07-15"
    );
    const q = replay([[c, ok({ properties: { FEATURE_FLAG: "on-1" } })]]);
    expect(
      (
        await V.appSetting(
          site,
          "2026-07-15",
          "FEATURE_FLAG",
          "{flag}"
        )(q, slots({ app: "web1", flag: "on-1" }), "")
      ).passed
    ).toBe(true);
    expect(
      (
        await V.appSetting(
          site,
          "2026-07-15",
          "FEATURE_FLAG",
          "{flag}"
        )(q, slots({ app: "web1", flag: "on-2" }), "")
      ).passed
    ).toBe(false);
  });

  test("policyRateLimit reads calls and renewal-period in either order", async () => {
    const p =
      "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiManagement/service/{service_name}/apis/{api}/operations/{operation}/policies/policy";
    const c = get(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ApiManagement/service/s1/apis/a1/operations/o1/policies/policy`,
      "2024-05-01"
    );
    const s = slots({ service_name: "s1", api: "a1", operation: "o1", calls: 25 });
    const xml = (attrs: string) =>
      ok({
        properties: { value: `<policies><inbound><rate-limit ${attrs} /></inbound></policies>` },
      });
    expect(
      (
        await V.policyRateLimit(p, "2024-05-01")(
          replay([[c, xml('calls="25" renewal-period="60"')]]),
          s,
          ""
        )
      ).passed
    ).toBe(true);
    expect(
      (
        await V.policyRateLimit(p, "2024-05-01")(
          replay([[c, xml('renewal-period="60" calls="25"')]]),
          s,
          ""
        )
      ).passed
    ).toBe(true);
    expect(
      (
        await V.policyRateLimit(p, "2024-05-01")(
          replay([[c, xml('calls="40" renewal-period="60"')]]),
          s,
          ""
        )
      ).passed
    ).toBe(false);
    expect(
      (await V.policyRateLimit(p, "2024-05-01")(replay([[c, notFound()]], 3), s, "")).passed
    ).toBe(false);
  });

  test("membershipStated in oracle mode reads the transcript's marks", async () => {
    const s = { user1: "alice1", user2: "bob1", member: "bob1", _oracle: true };
    const text = [
      V.oracleBlock("rest --method head --url x1", notFound()),
      V.oracleBlock("rest --method head --url x2", ok("")),
    ].join("\n");
    expect((await V.membershipStated()(replay([]), s, text)).passed).toBe(true);
    expect((await V.membershipStated()(replay([]), { ...s, member: "alice1" }, text)).passed).toBe(
      false
    );
  });

  test("accessStated in oracle mode reads the access entry", async () => {
    const tenant = ok({
      value: [
        { name: "access", properties: { enabled: false } },
        { name: "gitAccess", properties: { enabled: true } },
      ],
    });
    const text = V.oracleBlock("rest --method get --url /tenant", tenant);
    expect(
      (await V.accessStated()(replay([]), { access_enabled: false, _oracle: true }, text)).passed
    ).toBe(true);
    expect(
      (await V.accessStated()(replay([]), { access_enabled: true, _oracle: true }, text)).passed
    ).toBe(false);
  });
});

describe("the oracle transcript", () => {
  test("a block marks success or failure and fences az's output", () => {
    expect(V.oracleBlock("group list", ok([{ name: "g" }]))).toBe(
      'ORACLE ✅ az group list\n```json\n[\n  {\n    "name": "g"\n  }\n]\n```'
    );
    expect(
      V.oracleBlock("x", { ...notFound(), text: "❌ **Command Failed** (exit 1, not-found)" })
    ).toBe("ORACLE ❌ az x\n```\n❌ **Command Failed** (exit 1, not-found)\n```");
  });
});

describe("fixture helpers", () => {
  test("azOk returns JSON and turns a failure into a FixtureError", async () => {
    expect(await V.azOk(replay([["a", ok({ x: 1 })]]), "a")).toEqual({ x: 1 });
    await expect(V.azOk(replay([["a", failed("ERROR: boom")]]), "a")).rejects.toBeInstanceOf(
      V.FixtureError
    );
  });

  test("putOk refuses a non-2xx answer", async () => {
    const c = V.restCommand("PUT", "/p", "1", { a: 1 });
    await expect(
      V.putOk(replay([[c, failed("ERROR: CONFLICT({})")]]), "/p", "1", { a: 1 }, "thing")
    ).rejects.toThrow(/thing PUT 409/);
    await expect(
      V.putOk(replay([[c, ok({ id: "x" })]]), "/p", "1", { a: 1 }, "thing")
    ).resolves.toEqual({ id: "x" });
  });

  test("snapshot stores _before_ slots and refuses an empty value", async () => {
    const c = post("/k", "1");
    const s: Slots = {};
    await V.snapshot(replay([[c, ok({ key1: "a", key2: "b" })]]), s, "/k", "1", {
      changed: "key1",
      kept: "key2",
    });
    expect(s).toEqual({ _before_changed: "a", _before_kept: "b" });
    await expect(
      V.snapshot(replay([[c, ok({ key1: "" })]]), {}, "/k", "1", { changed: "key1" })
    ).rejects.toThrow(/nothing to snapshot/);
  });

  test("makeSetupContext names and picks", () => {
    const ctx = V.makeSetupContext(replay([]), {}, RG);
    expect(ctx.name("lk-ops-")).toMatch(/^lk-ops-[0-9a-f]{6}$/);
    expect(ctx.hex(10)).toMatch(/^[0-9a-f]{10}$/);
    expect([1, 2, 3]).toContain(ctx.pick([1, 2, 3]));
    const sample = ctx.sample([1, 2, 3, 4], 2);
    expect(new Set(sample).size).toBe(2);
    const n = ctx.randomInt(10, 12);
    expect(n >= 10 && n <= 12).toBe(true);
  });
});
