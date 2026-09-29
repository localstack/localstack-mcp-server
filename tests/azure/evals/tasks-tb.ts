/**
 * The E2 tasks of tier T-B: multi-step goals with one phrasing, verified step by step
 * (partial credit is recorded). The agent gets the goal, the resource group and the names to
 * use; the fixture only picks random names, except for tb-tag-audit, whose group it fills.
 *
 * The verifier library arrives as a parameter (see verifiers.ts).
 */
import type * as V from "./verifiers";
import type { Query, SetupContext, Slots, Task, Verify } from "./types";

export function tbTasks(v: typeof V): Task[] {
  const RG = "/subscriptions/{sub}/resourceGroups/{rg}/providers";
  const EG = "2025-02-15";
  const EH = "2026-01-01";
  const KV = "2026-02-01";
  const NET = "2025-09-01";
  const SB = "2026-01-01";
  const STORAGE = "2026-06-01";
  const WEB = "2026-07-15";
  const MYSQL = "2023-12-30";

  const SA = RG + "/Microsoft.Storage/storageAccounts/{sa}";
  const PLAN = RG + "/Microsoft.Web/serverfarms/{plan}";
  const SITE = RG + "/Microsoft.Web/sites/{app}";
  const SBNS = RG + "/Microsoft.ServiceBus/namespaces/{ns}";
  const EHNS = RG + "/Microsoft.EventHub/namespaces/{ehns}";
  const MYS = RG + "/Microsoft.DBforMySQL/flexibleServers/{my}";
  const HUB_ID =
    "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.EventHub/namespaces/{ehns}/eventhubs/{hub}";

  /**
   * Random names for everything the goal creates; a trailing `#`
   * drops the hyphens (storage accounts, vaults).
   */
  function names(ctx: SetupContext, prefixes: Record<string, string>) {
    for (const [k, p] of Object.entries(prefixes)) {
      ctx.slots[k] = p.endsWith("#") ? ctx.name(p.slice(0, -1)).replace(/-/g, "") : ctx.name(p);
    }
  }

  const LINUX_PLAN: [string, Verify] = [
    "Linux plan",
    v.fieldIs(PLAN, WEB, "properties.reserved", "true"),
  ];

  const tasks: Task[] = [];
  const add = (t: Omit<Task, "tier" | "caps" | "verb">) =>
    tasks.push({ tier: "T-B", caps: "T-B", verb: "workflow", ...t });

  // ── 1. storage account + container ──────────────────────────────────────

  add({
    id: "tb-storage-blob",
    opId: "workflow/storage-blob",
    prompts: [
      "In resource group {rg}, create a StorageV2 storage account named {sa} with the Standard_LRS SKU, then create a private blob container named {container} in it.",
    ],
    oracle: [
      "storage account create --name {sa} --resource-group {rg} --sku Standard_LRS --kind StorageV2",
      "storage container-rm create --storage-account {sa} --name {container} --resource-group {rg}",
    ],
    verify: v.workflow(
      ["account", v.readyWith(SA, STORAGE, { "sku.name": "Standard_LRS", kind: "StorageV2" })],
      ["container", v.exists(SA + "/blobServices/default/containers/{container}", STORAGE)]
    ),
    setup: async (ctx) => names(ctx, { sa: "tbsa#", container: "uploads-" }),
    sweep: [`Microsoft.Storage/storageAccounts@${STORAGE}`],
  });

  // ── 4. Key Vault: secret round trip, key, signature ─────────────────────

  add({
    id: "tb-keyvault-secret-sign",
    opId: "workflow/keyvault-secret-sign",
    prompts: [
      "In resource group {rg}: create a key vault {kv}; store a secret {secret} with the value {secret_value} and read it back to confirm the value; create an RSA key {key}; then sign the SHA-256 digest {digest} (base64url) with that key using RS256 and give me the signature.",
    ],
    oracle: [
      "keyvault create --name {kv} --resource-group {rg} --location westeurope",
      "keyvault secret set --vault-name {kv} --name {secret} --value {secret_value}",
      "keyvault secret show --vault-name {kv} --name {secret}",
      "keyvault key create --vault-name {kv} --name {key} --kty RSA",
      "keyvault key sign --vault-name {kv} --name {key} --algorithm RS256 --digest {digest_b64}",
    ],
    verify: v.workflow(
      ["vault", v.exists(RG + "/Microsoft.KeyVault/vaults/{kv}", KV)],
      ["secret stored", v.secretIs("kv", "secret", "{secret_value}")],
      ["secret read back", v.claims("{secret_value}")],
      ["signature", v.signatureVerifiesIn("kv", "key", "digest")]
    ),
    setup: async (ctx) => {
      names(ctx, { kv: "tbkv#", secret: "db-password-", key: "signing-" });
      const raw = v.sha256(Buffer.from(ctx.uuid().replace(/-/g, ""), "hex"));
      // The prompt gives Key Vault's own encoding (base64url); az keyvault key sign
      // --digest wants standard base64 with padding.
      Object.assign(ctx.slots, {
        secret_value: `S3cret-${ctx.hex(10)}`,
        digest: v.b64url(raw),
        digest_b64: v.b64std(raw),
      });
    },
    kvCrypto: true,
    vaultSlots: ["kv"],
    sweep: ["Microsoft.KeyVault/vaults@2023-07-01"],
  });

  // ── 5. Service Bus topic with two subscriptions ─────────────────────────

  add({
    id: "tb-servicebus-topic",
    opId: "workflow/servicebus-topic",
    prompts: [
      "In resource group {rg}, create a Standard Service Bus namespace {ns} with a topic {topic}, add two subscriptions to the topic named {s1} and {s2}, then list the topic's subscriptions and tell me their names.",
    ],
    oracle: [
      "servicebus namespace create --name {ns} --resource-group {rg} --location westeurope --sku Standard",
      "servicebus topic create --name {topic} --namespace-name {ns} --resource-group {rg}",
      "servicebus topic subscription create --name {s1} --topic-name {topic} --namespace-name {ns} --resource-group {rg}",
      "servicebus topic subscription create --name {s2} --topic-name {topic} --namespace-name {ns} --resource-group {rg}",
      "servicebus topic subscription list --topic-name {topic} --namespace-name {ns} --resource-group {rg}",
    ],
    verify: v.workflow(
      ["namespace", v.exists(SBNS, SB)],
      ["topic", v.exists(SBNS + "/topics/{topic}", SB)],
      ["subscription 1", v.exists(SBNS + "/topics/{topic}/subscriptions/{s1}", SB)],
      ["subscription 2", v.exists(SBNS + "/topics/{topic}/subscriptions/{s2}", SB)],
      ["listed", v.claims("{s1}", "{s2}")]
    ),
    setup: async (ctx) =>
      names(ctx, { ns: "tbsb", topic: "orders-", s1: "billing-", s2: "shipping-" }),
    sweep: [`Microsoft.ServiceBus/namespaces@${SB}`],
  });

  // ── 9. Resource Graph over two tagged creates ───────────────────────────

  add({
    id: "tb-resource-graph-tags",
    opId: "workflow/resource-graph-tags",
    prompts: [
      "In resource group {rg}, create two key vaults, {kv1} and {kv2}, both tagged costcenter={cc}. Then use Azure Resource Graph to find every resource in the subscription tagged costcenter={cc}, and tell me their names.",
    ],
    oracle: [
      "keyvault create --name {kv1} --resource-group {rg} --location westeurope --tags costcenter={cc}",
      "keyvault create --name {kv2} --resource-group {rg} --location westeurope --tags costcenter={cc}",
      // A KQL filter needs a pipe, which the tool refuses; az resource list --tag answers
      // the question (the tagged steps read the ARM resource index).
      "resource list --tag costcenter={cc}",
    ],
    verify: v.workflow(
      ["vault 1 tagged", v.indexTagIs("kv1", "costcenter", "{cc}")],
      ["vault 2 tagged", v.indexTagIs("kv2", "costcenter", "{cc}")],
      ["found by the query", v.claims("{kv1}", "{kv2}")]
    ),
    setup: async (ctx) => {
      names(ctx, { kv1: "tbkva#", kv2: "tbkvb#" });
      ctx.slots.cc = `cc-${ctx.hex(6)}`;
    },
    vaultSlots: ["kv1", "kv2"],
    sweep: ["Microsoft.KeyVault/vaults@2023-07-01"],
  });

  // ── 10. Tag audit over a group the fixture fills ────────────────────────

  add({
    id: "tb-tag-audit",
    opId: "workflow/tag-audit",
    prompts: [
      "Audit resource group {rg}: list every resource in it and tell me which ones have no owner tag.",
    ],
    oracle: ["resource list --resource-group {rg}"],
    // Verifier defect 3 fixed (verifiers.untaggedVerdicts: per line).
    verify: v.workflow(["untagged reported", v.untaggedReported(["u1", "u2"], ["t1", "t2"])]),
    setup: async (ctx) => {
      // _audit_group: four resources, two with an owner tag and two without.
      names(ctx, { t1: "tbvnet-", t2: "tbnsg-", u1: "tbpip-", u2: "tbrt-" });
      const owner = { owner: `team-${ctx.hex(4)}` };
      const items: Array<[string, string, Record<string, unknown>]> = [
        [
          "t1",
          "virtualNetworks",
          { properties: { addressSpace: { addressPrefixes: ["10.8.0.0/16"] } }, tags: owner },
        ],
        ["t2", "networkSecurityGroups", { tags: owner }],
        [
          "u1",
          "publicIPAddresses",
          { sku: { name: "Standard" }, properties: { publicIPAllocationMethod: "Static" } },
        ],
        ["u2", "routeTables", {}],
      ];
      for (const [slot, kind, body] of items) {
        const path = v.fill(
          `${RG}/Microsoft.Network/${kind}/${String(ctx.slots[slot])}`,
          ctx.slots
        );
        await v.putOk(ctx.q, path, NET, { location: "westeurope", ...body }, kind);
        await v.waitReady(ctx.q, path, NET);
      }
    },
    sweep: [
      `Microsoft.Network/virtualNetworks@${NET}`,
      `Microsoft.Network/networkSecurityGroups@${NET}`,
      `Microsoft.Network/publicIPAddresses@${NET}`,
      `Microsoft.Network/routeTables@${NET}`,
    ],
  });

  // ── 20. MySQL server, database, firewall rule, host name ────────────────

  const mysqlFqdn = async (q: Query, slots: Slots): Promise<string> => {
    const r = await v.arm(q, "GET", v.fill(MYS, slots), MYSQL);
    return r.status === 200
      ? v.pyStr(v.dotted(r.body, "properties.fullyQualifiedDomainName") ?? "")
      : "";
  };

  add({
    id: "tb-mysql-firewall",
    opId: "workflow/mysql-firewall",
    prompts: [
      "In resource group {rg}: create a MySQL flexible server {my} (Burstable Standard_B1ms, admin myadmin, password LocalStack123!), a database {db} on it, and a firewall rule {rule} that allows {ip_start} to {ip_end}. Then tell me the server's fully qualified domain name.",
    ],
    oracle: [
      "mysql flexible-server create --name {my} --resource-group {rg} --location westeurope --tier Burstable --sku-name Standard_B1ms --admin-user myadmin --admin-password LocalStack123! --public-access None --yes",
      "mysql flexible-server db create --server-name {my} --resource-group {rg} --database-name {db}",
      "mysql flexible-server firewall-rule create --name {my} --resource-group {rg} --rule-name {rule} --start-ip-address {ip_start} --end-ip-address {ip_end}",
      "mysql flexible-server show --name {my} --resource-group {rg}",
    ],
    verify: v.workflow(
      ["server", v.exists(MYS, MYSQL)],
      ["database", v.exists(MYS + "/databases/{db}", MYSQL)],
      [
        "firewall rule",
        v.fieldIs(MYS + "/firewallRules/{rule}", MYSQL, "properties.endIpAddress", "{ip_end}"),
      ],
      // Verifier defect 4 fixed (verifiers.hostOf: the name with or without the port).
      ["host name reported", v.hostStated(mysqlFqdn)]
    ),
    setup: async (ctx) => {
      names(ctx, { my: "tbmy-", db: "shop", rule: "office-" });
      const octet = 20 + ctx.randomInt(0, 199);
      Object.assign(ctx.slots, {
        ip_start: `203.0.113.${octet}`,
        ip_end: `203.0.113.${octet + 5}`,
      });
    },
    sweep: [`Microsoft.DBforMySQL/flexibleServers@${MYSQL}`],
    notes: "the heaviest task: the emulator runs a MySQL container per server",
  });

  // ── 12 (S15). Event Hub as the destination of an Event Grid topic ───────

  add({
    id: "tb-eventgrid-to-eventhub",
    opId: "workflow/eventgrid-to-eventhub",
    prompts: [
      "In resource group {rg}: create a Standard Event Hubs namespace {ehns} with an event hub {hub}, create an Event Grid topic {topic}, and add an event subscription {esub} on the topic that delivers events to that event hub.",
    ],
    oracle: [
      "eventhubs namespace create --name {ehns} --resource-group {rg} --location westeurope --sku Standard",
      "eventhubs eventhub create --name {hub} --namespace-name {ehns} --resource-group {rg}",
      "eventgrid topic create --name {topic} --resource-group {rg} --location westeurope",
      "eventgrid event-subscription create --name {esub} --source-resource-id /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.EventGrid/topics/{topic} --endpoint-type eventhub --endpoint " +
        HUB_ID,
    ],
    verify: v.workflow(
      ["namespace", v.exists(EHNS, EH)],
      ["event hub", v.exists(EHNS + "/eventhubs/{hub}", EH)],
      ["topic", v.exists(RG + "/Microsoft.EventGrid/topics/{topic}", EG)],
      [
        "delivers to the hub",
        v.fieldIs(
          RG +
            "/Microsoft.EventGrid/topics/{topic}/providers/Microsoft.EventGrid/eventSubscriptions/{esub}",
          EG,
          "properties.destination.properties.resourceId",
          HUB_ID
        ),
      ]
    ),
    setup: async (ctx) =>
      names(ctx, { ehns: "tbeh", hub: "clicks-", topic: "tbtopic-", esub: "tohub-" }),
    sweep: [`Microsoft.EventHub/namespaces@${EH}`, `Microsoft.EventGrid/topics@${EG}`],
  });

  // ── 7. Web app with a plan, an app setting, a restart ───────────────────

  add({
    id: "tb-webapp-settings",
    opId: "workflow/webapp-settings",
    prompts: [
      "In resource group {rg}, create a Linux App Service plan {plan} on the B1 SKU and a Python 3.12 web app {app} on it. Set the application setting FEATURE_FLAG to {flag}, then restart the app.",
    ],
    oracle: [
      "appservice plan create --name {plan} --resource-group {rg} --sku B1 --is-linux",
      "webapp create --name {app} --resource-group {rg} --plan {plan} --runtime PYTHON:3.12",
      "webapp config appsettings set --name {app} --resource-group {rg} --settings FEATURE_FLAG={flag}",
      "webapp restart --name {app} --resource-group {rg}",
    ],
    // The restart has no observable result in the emulator, so it is not a checked step.
    verify: v.workflow(
      ["plan", v.readyWith(PLAN, WEB, { "sku.name": "B1" })],
      LINUX_PLAN,
      [
        "app on the plan",
        v.fieldIs(
          SITE,
          WEB,
          "properties.serverFarmId",
          "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/serverfarms/{plan}"
        ),
      ],
      ["setting", v.appSetting(SITE, WEB, "FEATURE_FLAG", "{flag}")]
    ),
    setup: async (ctx) => {
      names(ctx, { plan: "tbplan-", app: "tbweb-" });
      ctx.slots.flag = `on-${ctx.hex(6)}`;
    },
    sweep: [`Microsoft.Web/serverfarms@${WEB}`, `Microsoft.Web/sites@${WEB}`],
  });

  return tasks;
}
