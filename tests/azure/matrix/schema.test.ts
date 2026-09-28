// U16: the L2 matrix is validated in the unit suite, so a malformed case fails here, not in a
// live run (plan section 5.4, "Tests of the test code"). No emulator is needed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { evaluateAzCommand } from "../../../src/lib/azure/policy";
import type { PolicyOptions } from "../../../src/lib/azure/types";
import {
  BICEP_FIXTURES,
  capturedNames,
  capturedValues,
  caseVars,
  checkValue,
  commandsOf,
  evaluate,
  fileForProvider,
  loadMatrix,
  MATRIX_DIR,
  PROVIDERS,
  parseShard,
  placeholdersOf,
  render,
  resolvePath,
  selectCases,
  shardCases,
  subsetCases,
  type MatrixCase,
  type Vars,
} from "../matrix.live.test";

const loaded = loadMatrix();
const { cases } = loaded;

/**
 * The typed server's 127 COVERAGE_SKIPS diagnoses (retirement task R.1), as coverage-list keys.
 * Each is carried by a matrix case: as a known gap, or as a passing case when the CLI path does
 * not share the typed server's limitation (see the YAML comments at each case).
 */
const TYPED_SERVER_SKIPS = [
  "Microsoft.AppConfiguration ConfigurationStores ListKeyValue",
  "Microsoft.AppConfiguration PrivateEndpointConnections CreateOrUpdate",
  "Microsoft.AppConfiguration PrivateEndpointConnections Get",
  "Microsoft.Cdn AfdProfiles CheckEndpointNameAvailability",
  "Microsoft.Cdn EdgeActions AddAttachment",
  "Microsoft.Cdn EdgeActions DeleteAttachment",
  "Microsoft.Cdn Profiles GenerateSsoUri",
  "Microsoft.Cdn Routes Delete",
  "Microsoft.Cdn Routes Get",
  "Microsoft.Cdn Routes Update",
  "Microsoft.Compute NetworkInterfaces GetVirtualMachineScaleSetNetworkInterface",
  "Microsoft.Compute NetworkInterfaces ListVirtualMachineScaleSetVMNetworkInterfaces",
  "Microsoft.Compute VirtualMachineImages Get",
  "Microsoft.Compute VirtualMachineScaleSetVMs Get",
  "Microsoft.Compute VirtualMachineScaleSetVMs Update",
  "Microsoft.Compute VirtualMachines AttachDetachDataDisks",
  "Microsoft.ContainerInstance Containers ExecuteCommand",
  "Microsoft.ContainerService AgentPools Delete",
  "Microsoft.ContainerService AgentPools Get",
  "Microsoft.ContainerService Machines CreateOrUpdate",
  "Microsoft.ContainerService Machines Get",
  "Microsoft.ContainerService Machines List",
  "Microsoft.ContainerService MaintenanceConfigurations Delete",
  "Microsoft.ContainerService MaintenanceConfigurations Get",
  "Microsoft.ContainerService ManagedClusters Delete",
  "Microsoft.ContainerService ManagedClusters RunCommand",
  "Microsoft.ContainerService ManagedClusters Start",
  "Microsoft.DBforMySQL FlexibleServers Maintenances_Read",
  "Microsoft.DBforMySQL FlexibleServers Maintenances_Update",
  "Microsoft.DBforMySQL FlexibleServers Servers_ResetGtid",
  "Microsoft.DBforPostgreSQL FlexibleServers CapturedLogs_ListByServer",
  "Microsoft.DBforPostgreSQL FlexibleServers Servers_Restart",
  "Microsoft.DBforPostgreSQL FlexibleServers Servers_Start",
  "Microsoft.DBforPostgreSQL FlexibleServers Servers_Stop",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Clusters_Delete",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Clusters_Get",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Clusters_Restart",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Clusters_Start",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Clusters_Stop",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 FirewallRules_CreateOrUpdate",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 FirewallRules_Delete",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 FirewallRules_Get",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 FirewallRules_ListByCluster",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Servers_Get",
  "Microsoft.DBforPostgreSQL ServerGroupsv2 Servers_ListByCluster",
  "Microsoft.DocumentDB MongoDbResources GetMongoDbCollection",
  "Microsoft.DocumentDB MongoDbResources GetMongoDbCollectionThroughput",
  "Microsoft.DocumentDB MongoDbResources GetMongoDbDatabaseThroughput",
  "Microsoft.DocumentDB MongoDbResources ListMongoDbCollections",
  "Microsoft.DocumentDB SqlResources CreateUpdateSqlContainer",
  "Microsoft.DocumentDB SqlResources CreateUpdateSqlDatabase",
  "Microsoft.DocumentDB SqlResources DeleteSqlContainer",
  "Microsoft.DocumentDB SqlResources DeleteSqlDatabase",
  "Microsoft.DocumentDB SqlResources GetSqlContainer",
  "Microsoft.DocumentDB SqlResources GetSqlDatabase",
  "Microsoft.DocumentDB SqlResources ListSqlContainers",
  "Microsoft.EventGrid TopicEventSubscriptions GetDeliveryAttributes",
  "Microsoft.EventGrid TopicEventSubscriptions List",
  "Microsoft.EventGrid Topics ListEventTypes",
  "Microsoft.EventHub Namespaces Failover",
  "Microsoft.EventHub NetworkSecurityPerimeterConfigurations CreateOrUpdate",
  "Microsoft.EventHub NetworkSecurityPerimeterConfigurations GetResourceAssociationName",
  "Microsoft.KeyVault Microsoft.KeyVault CreateCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault DeleteCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault DeleteCertificateContacts",
  "Microsoft.KeyVault Microsoft.KeyVault GetCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault GetCertificateContacts",
  "Microsoft.KeyVault Microsoft.KeyVault GetCertificateOperation",
  "Microsoft.KeyVault Microsoft.KeyVault GetCertificatePolicy",
  "Microsoft.KeyVault Microsoft.KeyVault GetCertificateVersions",
  "Microsoft.KeyVault Microsoft.KeyVault GetCertificates",
  "Microsoft.KeyVault Microsoft.KeyVault GetDeletedCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault GetDeletedCertificates",
  "Microsoft.KeyVault Microsoft.KeyVault PurgeDeletedCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault RecoverDeletedCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault SetCertificateContacts",
  "Microsoft.KeyVault Microsoft.KeyVault UpdateCertificate",
  "Microsoft.KeyVault Microsoft.KeyVault UpdateCertificatePolicy",
  "Microsoft.KeyVault Microsoft.KeyVault UpdateSecret",
  "Microsoft.KeyVault Secrets Update",
  "Microsoft.KubernetesConfiguration Extensions Create",
  "Microsoft.KubernetesConfiguration Extensions Delete",
  "Microsoft.KubernetesConfiguration Extensions Get",
  "Microsoft.KubernetesConfiguration Extensions Update",
  "Microsoft.KubernetesConfiguration OperationStatus Get",
  "Microsoft.ManagedIdentity FederatedIdentityCredentials CreateOrUpdate",
  "Microsoft.ManagedIdentity FederatedIdentityCredentials Delete",
  "Microsoft.ManagedIdentity FederatedIdentityCredentials Get",
  "Microsoft.ManagedIdentity FederatedIdentityCredentials List",
  "Microsoft.ManagedIdentity SystemAssignedIdentities GetByScope",
  "Microsoft.ManagedIdentity UserAssignedIdentities RevokeTokens",
  "Microsoft.Network PrivateLinkServices DeletePrivateEndpointConnection",
  "Microsoft.Network PrivateLinkServices GetPrivateEndpointConnection",
  "Microsoft.Network PrivateLinkServices UpdatePrivateEndpointConnection",
  "Microsoft.OperationalInsights Workspaces Failover",
  "Microsoft.OperationalInsights Workspaces ListLinkTargets",
  "Microsoft.OperationalInsights Workspaces ReconcileNSP",
  "Microsoft.ServiceBus Subscriptions CreateOrUpdate",
  "Microsoft.Sql DatabaseColumns Get",
  "Microsoft.Sql DatabaseColumns ListByTable",
  "Microsoft.Sql DatabaseSchemas Get",
  "Microsoft.Sql DatabaseSchemas ListByDatabase",
  "Microsoft.Sql DatabaseTables Get",
  "Microsoft.Sql DatabaseTables ListBySchema",
  "Microsoft.Sql Databases Rename",
  "Microsoft.Sql RestorableDroppedDatabases Get",
  "Microsoft.Sql ServerConnectionPolicies Get",
  "Microsoft.Storage BlobContainers Get",
  "Microsoft.Storage FileShares Get",
  "Microsoft.Storage FileShares Lease",
  "Microsoft.Storage FileShares Restore",
  "Microsoft.Storage FileShares Update",
  "Microsoft.Storage Queue Create",
  "Microsoft.Storage Queue Get",
  "Microsoft.Storage StorageAccounts Update",
  "Microsoft.Storage Table Create",
  "Microsoft.Storage Table Get",
  "Microsoft.Storage Table Update",
  "Microsoft.Web WebApps GetProductionSiteDeploymentStatus",
  "Microsoft.Web WebApps ListConnectionStrings",
  "Microsoft.Web WebApps ListFunctions",
  "Microsoft.Web WebApps ListSyncFunctionTriggers",
  "Microsoft.Web WebApps ListSyncStatus",
  "Microsoft.Web WebApps SyncFunctionTriggers",
  "Microsoft.Web WebApps UpdateFtpAllowed",
  "Microsoft.Web WebApps UpdateScmAllowed",
  "Microsoft.Web WebApps UpdateSourceControl",
];

/**
 * Dummy values for the placeholders: built-ins from caseVars; a captured value stands in as an
 * emulator host name, since captured endpoints and ids come from the emulator and are local.
 */
function dummyVars(c: MatrixCase): Vars {
  const vars = caseVars("schemacheck1", {
    sub: "00000000-0000-0000-0000-000000000000",
    tenant: "00000000-0000-0000-0000-000000000001",
    location: "westeurope",
    uuid: "00000000-0000-0000-0000-0000000000aa",
  });
  for (const step of c.setup) {
    for (const name of capturedNames(step)) {
      vars.values[name] = `x-${name.replace(/_/g, "-")}.localhost.localstack.cloud`;
    }
  }
  return vars;
}

describe("L2 matrix schema (U16)", () => {
  test("every file parses and every case validates", () => {
    expect(loaded.problems).toEqual([]);
    expect(loaded.files.length).toBeGreaterThan(0);
  });

  test("one file per provider, named after it, for all 29 providers of the coverage list", () => {
    expect(PROVIDERS).toHaveLength(29);
    expect([...loaded.files].sort()).toEqual(PROVIDERS.map(fileForProvider).sort());
    for (const p of PROVIDERS) expect(cases.some((c) => c.provider === p)).toBe(true);
  });

  test("case ids are unique across files", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every operation key has the three-part coverage form and names the file's provider", () => {
    for (const c of cases) {
      for (const op of c.operations) {
        const parts = op.split(" ");
        expect(parts).toHaveLength(3);
        expect(parts[0]).toBe(c.provider);
      }
      if (c.operations.length === 0) expect(c.note?.trim()).toBeTruthy();
    }
  });

  test("required fields are present, and booleans are booleans", () => {
    for (const c of cases) {
      expect(typeof c.id).toBe("string");
      expect(c.command.trim()).not.toBe("");
      expect(Array.isArray(c.operations)).toBe(true);
      expect(typeof c.pr).toBe("boolean");
      expect(typeof c.backing).toBe("boolean");
    }
  });

  test("the validator reports each kind of malformed case (a broken file fails fast)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lsaz-matrix-bad-"));
    try {
      const bad = [
        "provider: Microsoft.Storage",
        "extra: 1",
        "cases:",
        "  - id: Bad_Id",
        "    operations: [Microsoft.Storage StorageAccounts]",
        "    command: storage account list",
        "  - id: dup",
        "    operations: [Microsoft.Network VirtualNetworks Get]",
        "    backing: 'true'",
        "    command: az group list",
        "  - id: dup",
        "    operations: []",
        "    pr: true",
        "    command: group list --name {nope}",
        "    known_gap: { reason: flaky }",
        "  - id: leaky",
        "    operations: [Microsoft.Storage StorageAccounts List]",
        "    setup:",
        "      - group create --name {rg} --location {location}",
        "      - keyvault create --name {vault} --resource-group {rg}",
        "      - lock create --name l1 --resource-group {rg} --lock-type CanNotDelete",
        "    command: storage account list --resource-group {rg} -o tsv",
        "    expect: { json: { path: '', equals: [] }, colour: red }",
        "    cleanup:",
        "      - group delete --name {rg} --yes",
      ].join("\n");
      writeFileSync(path.join(dir, "storage.yaml"), bad + "\n");
      const { problems } = loadMatrix(dir);
      const expected = [
        /unknown key "extra"/,
        /Bad_Id: id must match/,
        /is not "<resource_provider> <service> <operation>"/,
        /is not of Microsoft\.Storage/,
        /backing must be true or false/,
        /drop the leading `az`/,
        /dup: id already used/,
        /empty operations list needs a note/,
        /unknown or not yet captured placeholder \{nope\}/,
        /a pr case cannot be a known gap/,
        /json checks need JSON output/,
        /unknown key "colour"/,
        /group delete in cleanup must use --no-wait/,
        /creates vault .*keyvault purge/,
        /creates lock l1/,
      ];
      for (const re of expected) expect(problems.some((p) => re.test(p))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the PR subset has at least 20 light cases, and is part of the full run by construction", () => {
    const pr = subsetCases(cases, "pr");
    const full = subsetCases(cases, "full");
    expect(pr.length).toBeGreaterThanOrEqual(20);
    for (const c of pr) {
      expect(full).toContain(c);
      expect(c.backing).toBe(false);
      expect(c.known_gap).toBeUndefined();
    }
    // The same holds through the runner's selection, with and without sharding.
    for (const total of [1, 2, 3, 4, 6]) {
      const shards = shardCases(full, total);
      expect(
        shards
          .flat()
          .map((c) => c.id)
          .sort()
      ).toEqual(full.map((c) => c.id).sort());
      for (const c of pr) expect(shards.filter((s) => s.includes(c))).toHaveLength(1);
      const prRun = Array.from(
        { length: total },
        (_, i) =>
          selectCases(cases, {
            matrix: "pr",
            backing: true,
            gaps: "run",
            shard: { index: i + 1, total },
          }).run
      ).flat();
      expect(prRun.map((c) => c.id).sort()).toEqual(pr.map((c) => c.id).sort());
    }
  });

  test("selection: backing and known-gap cases are skipped with a reason, never dropped", () => {
    const light = selectCases(cases, { matrix: "full", backing: false, gaps: "skip" });
    expect(light.run.length + light.skipped.length).toBe(cases.length);
    for (const c of light.run) {
      expect(c.backing).toBe(false);
      expect(c.known_gap).toBeUndefined();
    }
    for (const { reason } of light.skipped) expect(reason).toMatch(/backing|known gap/);
  });

  test("shard parsing", () => {
    expect(parseShard(undefined)).toBeUndefined();
    expect(parseShard("2/4")).toEqual({ index: 2, total: 4 });
    for (const bad of ["0/4", "5/4", "1/0", "a/b", "1-4"]) expect(() => parseShard(bad)).toThrow();
  });

  test("every placeholder renders, and no case hides an unknown one", () => {
    for (const c of cases) {
      const vars = dummyVars(c);
      for (const { command } of commandsOf(c)) {
        expect(() => render(command, vars)).not.toThrow();
        expect(render(command, vars)).not.toMatch(/\{[a-z][a-z0-9_]*(:[a-z0-9-]+)?\}/);
      }
    }
  });

  describe("every command, setup and cleanup line passes the real policy", () => {
    let root: string;
    let opts: PolicyOptions;
    beforeAll(() => {
      root = mkdtempSync(path.join(os.tmpdir(), "lsaz-matrix-schema-"));
      const workdir = path.join(root, "work");
      const configDir = path.join(root, "config");
      const homeDir = path.join(configDir, "home");
      mkdirSync(workdir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      const home = os.homedir();
      opts = {
        workdir,
        homeDir,
        protectedDirs: [".azure", ".ssh", ".kube", ".docker"]
          .map((d) => path.join(home, d))
          .concat(configDir),
        platform: process.platform,
      };
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test("no matrix line is a policy refusal", () => {
      const refused: string[] = [];
      for (const c of cases) {
        const vars = dummyVars(c);
        for (const { phase, command } of commandsOf(c)) {
          const result = evaluateAzCommand(render(command, vars), opts);
          if (!result.ok) {
            refused.push(`${c.file}#${c.id} ${phase}: ${result.ruleId}: ${command}`);
          } else if (result.local === "version") {
            refused.push(
              `${c.file}#${c.id} ${phase}: answered locally, not by the emulator: ${command}`
            );
          }
        }
      }
      expect(refused).toEqual([]);
    });
  });

  test("Bicep cases reference fixtures that exist (no registry modules)", () => {
    for (const c of cases) {
      for (const { command } of commandsOf(c)) {
        for (const m of command.matchAll(/bicep\/([\w.-]+\.bicep)\b/g)) {
          const fixture = path.join(BICEP_FIXTURES, m[1]);
          const text = readFileSync(fixture, "utf8");
          expect(text).not.toMatch(/(br:|br\/|ts:)[^\s'"()]/);
        }
      }
    }
    const bicepCases = cases.filter((c) => commandsOf(c).some((x) => /\.bicep\b/.test(x.command)));
    expect(bicepCases.length).toBeGreaterThan(0);
    expect(bicepCases.some((c) => c.pr)).toBe(true);
  });

  test("known gaps carry a reason, and every typed-server skip is carried (R.1)", () => {
    for (const c of cases.filter((x) => x.known_gap)) {
      expect(c.known_gap!.reason.trim().length).toBeGreaterThan(10);
      expect(c.operations.length).toBeGreaterThan(0);
    }
    expect(new Set(TYPED_SERVER_SKIPS).size).toBe(127);
    const covered = new Set(cases.flatMap((c) => c.operations));
    expect(TYPED_SERVER_SKIPS.filter((k) => !covered.has(k))).toEqual([]);
  });

  test("the matrix files use LF line endings", () => {
    for (const f of loaded.files) {
      expect(readFileSync(path.join(MATRIX_DIR, f), "utf8")).not.toContain("\r");
    }
  });
});

describe("the runner's value checks", () => {
  const doc = { a: { b: [{ c: 1 }, { c: 2, d: "x-y" }] }, list: ["p", "q"], s: "Succeeded" };

  test("resolvePath: dots, indexes, negative indexes, root", () => {
    expect(resolvePath(doc, "a.b[1].d")).toEqual({ found: true, value: "x-y" });
    expect(resolvePath(doc, "a.b[-1].c")).toEqual({ found: true, value: 2 });
    expect(resolvePath(doc.list, "[0]")).toEqual({ found: true, value: "p" });
    expect(resolvePath(doc, "")).toEqual({ found: true, value: doc });
    expect(resolvePath(doc, "a.missing")).toEqual({ found: false });
    expect(resolvePath(doc, "list[5]")).toEqual({ found: false });
    expect(() => resolvePath(doc, "a..b")).toThrow();
  });

  test("checkValue predicates", () => {
    expect(checkValue(true, "Succeeded", { equals: "Succeeded" }, "x")).toBeUndefined();
    expect(checkValue(true, "Creating", { equals: "Succeeded" }, "x")).toMatch(/expected/);
    expect(checkValue(true, ["p", "q"], { contains: "q" }, "x")).toBeUndefined();
    expect(checkValue(true, "abc", { contains: "b" }, "x")).toBeUndefined();
    expect(checkValue(true, { k: 1 }, { contains: "k" }, "x")).toBeUndefined();
    expect(checkValue(true, "v1.2", { matches: "^v\\d" }, "x")).toBeUndefined();
    expect(checkValue(false, undefined, { exists: false }, "x")).toBeUndefined();
    expect(checkValue(true, [1, 2], { length: 2 }, "x")).toBeUndefined();
    expect(checkValue(false, undefined, { equals: 1 }, "x")).toMatch(/no value/);
  });

  test("capturedValues: an empty capture fails the step", () => {
    // acr-run captured `acr run --no-wait --query runId -o tsv`, which prints nothing (the id is in
    // a stderr warning), and then passed against runs//listLogSasUrl without any run.
    expect(capturedValues({ run: "x", capture: "run_id" }, "rc1\r\n")).toEqual({ run_id: "rc1" });
    expect(() => capturedValues({ run: "x", capture: "run_id" }, " \r\n")).toThrow(
      /capture run_id: az printed nothing/
    );
    expect(capturedValues({ run: "x", capture: { a: "name" } }, '{"name": "n"}')).toEqual({
      a: "n",
    });
    expect(() => capturedValues({ run: "x", capture: { a: "name" } }, '{"name": ""}')).toThrow(
      /capture a: empty value at name/
    );
    expect(() => capturedValues({ run: "x", capture: { a: "id" } }, '{"id": null}')).toThrow(
      /capture a: empty value at id/
    );
    expect(capturedValues({ run: "x" }, "anything")).toEqual({});
  });

  test("render: built-ins, kinds, and unknown placeholders", () => {
    const vars = caseVars("abc123def456", { sub: "s", tenant: "t", location: "westeurope" });
    expect(render("group create --name {rg} --location {location}", vars)).toBe(
      "group create --name mcp-abc123def456-rg --location westeurope"
    );
    expect(render("{name:ns} {alnum:acr}", vars)).toBe("mcp-abc123def456-ns mcpabc123def456acr");
    expect(render(`--body '{"a": {"b": 1}}'`, vars)).toBe(`--body '{"a": {"b": 1}}'`);
    expect(() => render("{nope}", vars)).toThrow(/unknown placeholder/);
    expect(placeholdersOf("{rg} {name:x}")).toEqual([{ name: "rg" }, { name: "name", arg: "x" }]);
  });

  test("evaluate reads the envelope, never the prose", () => {
    const envelope = (stdout: string, exitCode = 0, classId: string | null = null) => ({
      command: "x",
      text: "prose that is not JSON",
      envelope: {
        exitCode,
        stdout,
        stderr: "",
        notes: [],
        classId: classId as never,
        truncated: false,
      },
      exitCode,
      stdout,
      classId,
      ms: 1,
      ok: exitCode === 0,
    });
    expect(evaluate(envelope('{"name": "n"}'), { json: { path: "name", equals: "n" } })).toEqual(
      []
    );
    expect(evaluate(envelope("n\r\n"), { stdout: { equals: "n" } })).toEqual([]);
    expect(evaluate(envelope("", 3, "not-found"), { exitCode: 3, classId: "not-found" })).toEqual(
      []
    );
    expect(evaluate(envelope("", 1, "other"), {})[0]).toMatch(/exit 1/);
    const refusal = { ...envelope(""), envelope: undefined, exitCode: null, text: "❌ refused" };
    expect(evaluate(refusal, {})[0]).toMatch(/without running az/);
  });
});
