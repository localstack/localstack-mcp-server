/**
 * E2 tasks drawn from the benchmark's T-A tier (benchmark/harness/ta.py): task ids, both
 * phrasings, oracle commands and verifiers as the benchmark had them. The fixtures came
 * from the typed server's builders (tests/coverage_mapping.py of the typed repo) and the
 * benchmark's setup steps; here they run as `az` commands through the harness's own server
 * session, with the benchmark's ARM bodies wherever it sent one (`az rest`).
 *
 * The verifier library arrives as a parameter (no runtime import of a local module: see
 * verifiers.ts), so run.mjs can load this file unbundled.
 */
import type * as V from "./verifiers";
import type { Query, SetupContext, Slots, Task } from "./types";

export function taTasks(v: typeof V): Task[] {
  const SUB = "/subscriptions/{sub}";
  const RG = SUB + "/resourceGroups/{rg}/providers";

  // api-versions of the benchmark's verifiers (ta.py)
  const APPCFG = "2024-06-01";
  const LOCKS = "2020-05-01";
  const ROLES = "2022-04-01";
  const ACR = "2025-11-01";
  const EG = "2025-02-15";
  const EH = "2026-01-01";
  const INS = "2026-01-01";
  const VAULT_API = "2023-07-01";
  const MSI = "2024-11-30";
  const NET = "2025-09-01";
  const PDNS = "2024-06-01";
  const LA = "2026-03-01";
  const DEPLOY_API = "2022-09-01";
  const SB = "2026-01-01";
  const STORAGE = "2026-06-01";
  const DISKS = "2026-03-02";
  const CDN = "2024-02-01";

  const STORE = RG + "/Microsoft.AppConfiguration/configurationStores/{store_name}";
  const LOCK = RG + "/Microsoft.Authorization/locks/{lock_name}";
  const REG = RG + "/Microsoft.ContainerRegistry/registries/{registry_name}";
  const DOMAIN = RG + "/Microsoft.EventGrid/domains/{domain_name}";
  const EG_TOPIC = RG + "/Microsoft.EventGrid/topics/{topic_name}";
  const EH_NS = RG + "/Microsoft.EventHub/namespaces/{namespace_name}";
  const ALERT = RG + "/Microsoft.Insights/activityLogAlerts/{name}";
  const VAULT = RG + "/Microsoft.KeyVault/vaults/{vault_name}";
  const UAI = RG + "/Microsoft.ManagedIdentity/userAssignedIdentities/{name}";
  const ROUTE_TABLE = RG + "/Microsoft.Network/routeTables/{route_table_name}";
  const VNET = RG + "/Microsoft.Network/virtualNetworks/{vnet_name}";
  const WS = RG + "/Microsoft.OperationalInsights/workspaces/{name}";
  const SUB_DEPLOY = SUB + "/providers/Microsoft.Resources/deployments/{deployment_name}";
  const SB_NS = RG + "/Microsoft.ServiceBus/namespaces/{namespace_name}";
  const ACCT_N = RG + "/Microsoft.Storage/storageAccounts/{name}";
  const DISK = RG + "/Microsoft.Compute/disks/{disk_name}";
  const PROFILE = RG + "/Microsoft.Cdn/profiles/{profile_name}";

  const SWEEP = {
    appcfg: `Microsoft.AppConfiguration/configurationStores@${APPCFG}`,
    acr: `Microsoft.ContainerRegistry/registries@${ACR}`,
    egTopic: `Microsoft.EventGrid/topics@${EG}`,
    egDomain: `Microsoft.EventGrid/domains@${EG}`,
    eh: `Microsoft.EventHub/namespaces@${EH}`,
    alert: `Microsoft.Insights/activityLogAlerts@${INS}`,
    vault: `Microsoft.KeyVault/vaults@${VAULT_API}`,
    uai: `Microsoft.ManagedIdentity/userAssignedIdentities@${MSI}`,
    routeTable: `Microsoft.Network/routeTables@${NET}`,
    vnet: `Microsoft.Network/virtualNetworks@${NET}`,
    pdns: `Microsoft.Network/privateDnsZones@${PDNS}`,
    la: `Microsoft.OperationalInsights/workspaces@${LA}`,
    sb: `Microsoft.ServiceBus/namespaces@${SB}`,
    storage: `Microsoft.Storage/storageAccounts@${STORAGE}`,
    disk: `Microsoft.Compute/disks@${DISKS}`,
    cdn: `Microsoft.Cdn/profiles@${CDN}`,
  };

  // ── fixture builders (typed server's coverage_mapping.py, rebuilt with az) ──

  /** _appcfg_args: a store, optionally a data-plane key-value and its lock. */
  async function appcfgStore(ctx: SetupContext, opts: { kv?: boolean; lock?: boolean } = {}) {
    const s = ctx.hex(8);
    Object.assign(ctx.slots, {
      name: `appcfg${s}`,
      store_name: `appcfg${s}`,
      key: `key${s}`,
      replica_name: `rep${s}`,
      snapshot_name: `snap${s}`,
    });
    const { store_name, key } = ctx.slots as Record<string, string>;
    await v.azOk(
      ctx.q,
      `appconfig create --name ${store_name} --resource-group ${ctx.rg} --location westeurope --sku Standard`
    );
    if (opts.kv || opts.lock)
      await v.azOk(ctx.q, `appconfig kv set --name ${store_name} --key ${key} --value v1 --yes`);
    if (opts.lock) await v.azOk(ctx.q, `appconfig kv lock --name ${store_name} --key ${key} --yes`);
  }

  /** _acr_args: a Basic registry and the names of its would-be children. */
  async function registry(ctx: SetupContext) {
    const s = ctx.hex(10);
    Object.assign(ctx.slots, {
      name: `acr${s}`,
      registry_name: `acr${s}`,
      webhook_name: `wh${s}`,
      replication_name: "northeurope",
    });
    await v.azOk(ctx.q, `acr create --name acr${s} --resource-group ${ctx.rg} --sku Basic`);
  }

  /**
   * _eh_args(fresh_namespace=True, with_hub_auth_rule=True): a Standard namespace in the
   * run's group, polled until Get-able, with an event hub and an authorization rule on it.
   */
  async function ehNamespace(ctx: SetupContext) {
    const s = ctx.hex(8);
    Object.assign(ctx.slots, {
      name: `ehns-${s}`,
      namespace_name: `ehns-${s}`,
      eventhub_name: `hub-${s}`,
      auth_rule_name: `rule-${s}`,
    });
    const {
      namespace_name: ns,
      eventhub_name: hub,
      auth_rule_name: rule,
    } = ctx.slots as Record<string, string>;
    await v.azOk(
      ctx.q,
      `eventhubs namespace create --name ${ns} --resource-group ${ctx.rg} --location westeurope --sku Standard`
    );
    const ready = await v.waitReady(ctx.q, v.fill(EH_NS, ctx.slots), EH, 240);
    if (ready.status !== 200)
      throw new v.FixtureError(
        `fixture: Event Hubs namespace ${ns} not Get-able (${ready.status})`
      );
    await v.azOk(
      ctx.q,
      `eventhubs eventhub create --name ${hub} --namespace-name ${ns} --resource-group ${ctx.rg}`
    );
    await v.azOk(
      ctx.q,
      `eventhubs eventhub authorization-rule create --name ${rule} --eventhub-name ${hub} --namespace-name ${ns} --resource-group ${ctx.rg} --rights Listen`
    );
  }

  /** _kv_key_args: a vault and (optionally) an RSA key with its version. */
  async function vaultKey(ctx: SetupContext, opts: { key: boolean }) {
    const s = ctx.hex(10);
    Object.assign(ctx.slots, { vault_name: `kv${s}`, key_name: `k${s}` });
    const { vault_name: vault, key_name: key } = ctx.slots as Record<string, string>;
    await v.azOk(
      ctx.q,
      `keyvault create --name ${vault} --resource-group ${ctx.rg} --location westeurope`
    );
    if (!opts.key) return;
    const created = await v.azOk(
      ctx.q,
      `keyvault key create --vault-name ${vault} --name ${key} --kty RSA`
    );
    const version = v.kidVersion(v.dotted(created, "key.kid"));
    if (!version) throw new v.FixtureError(`fixture: no key version for ${key}`);
    ctx.slots.key_version = version;
  }

  /** _sb_args: a namespace (polled), optionally a queue and a queue authorization rule. */
  async function sbNamespace(ctx: SetupContext, opts: { queue?: boolean; queueRule?: boolean }) {
    const s = ctx.hex(10);
    Object.assign(ctx.slots, {
      name: `sb${s}`,
      namespace_name: `sb${s}`,
      queue_name: `q-${s}`,
      topic_name: `t-${s}`,
      subscription_name: `s-${s}`,
      auth_rule_name: `a-${s}`,
    });
    const {
      namespace_name: ns,
      queue_name: queue,
      auth_rule_name: rule,
    } = ctx.slots as Record<string, string>;
    await v.azOk(
      ctx.q,
      `servicebus namespace create --name ${ns} --resource-group ${ctx.rg} --location westeurope`
    );
    const ready = await v.waitReady(ctx.q, v.fill(SB_NS, ctx.slots), SB, 60);
    if (ready.status !== 200)
      throw new v.FixtureError(
        `fixture: Service Bus namespace ${ns} not Get-able (${ready.status})`
      );
    if (opts.queue || opts.queueRule)
      await v.azOk(
        ctx.q,
        `servicebus queue create --name ${queue} --namespace-name ${ns} --resource-group ${ctx.rg}`
      );
    if (opts.queueRule) {
      await v.azOk(
        ctx.q,
        `servicebus queue authorization-rule create --name ${rule} --queue-name ${queue} --namespace-name ${ns} --resource-group ${ctx.rg} --rights Listen Send`
      );
    }
  }

  const ROLE_ACTIONS = [
    "Microsoft.Storage/storageAccounts/read",
    "Microsoft.Network/virtualNetworks/read",
    "Microsoft.KeyVault/vaults/read",
    "Microsoft.Web/sites/restart/action",
    "Microsoft.Compute/virtualMachines/start/action",
    "Microsoft.Insights/alertRules/read",
  ];

  const DEPLOY_TEMPLATE = {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    resources: [] as unknown[],
  };

  const tasks: Task[] = [];
  const add = (t: Omit<Task, "tier" | "caps">) => tasks.push({ tier: "T-A", caps: "T-A", ...t });

  // ── Microsoft.AppConfiguration ───────────────────────────────────────────

  add({
    id: "appconfig-kv-unlock",
    opId: "Microsoft.AppConfiguration/Microsoft.AppConfiguration_DeleteLock",
    verb: "delete",
    prompts: [
      "Unlock the key-value {key} in the App Configuration store {store_name} (resource group {rg}).",
      "The setting {key} in our App Configuration store {store_name} ({rg}) is locked and we need to edit it. Please unlock it.",
    ],
    oracle: ["appconfig kv unlock --name {store_name} --key {key} --yes"],
    verify: v.fieldIs(STORE + "/keyValues/{key}", APPCFG, "properties.locked", "false"),
    setup: (ctx) => appcfgStore(ctx, { lock: true }),
    appConfigSlots: ["store_name"],
    sweep: [SWEEP.appcfg],
  });

  const kvExists = async (q: Query, slots: Slots, key: string) =>
    (await v.arm(q, "GET", v.fill(STORE + "/keyValues/" + key, slots), APPCFG)).status === 200;

  add({
    id: "appconfig-check-keys",
    opId: "Microsoft.AppConfiguration/Microsoft.AppConfiguration_CheckKeyValues",
    verb: "check",
    prompts: [
      "Check whether the keys {key} and {missing_key} exist in the App Configuration store {store_name} (resource group {rg}). Say for each whether it exists.",
      "Do the settings {key} and {missing_key} exist in our App Configuration store {store_name} ({rg})? Tell me for each one.",
    ],
    oracle: [
      "appconfig kv list --name {store_name} --key {key}",
      "appconfig kv list --name {store_name} --key {missing_key}",
    ],
    verify: v.existsClaims({ key: true, missing_key: false }, kvExists),
    setup: async (ctx) => {
      await appcfgStore(ctx, { kv: true });
      ctx.slots.missing_key = ctx.name("legacy-timeout-");
    },
    appConfigSlots: ["store_name"],
    sweep: [SWEEP.appcfg],
  });

  add({
    id: "appconfig-regenerate-key",
    opId: "Microsoft.AppConfiguration/ConfigurationStores_RegenerateKey",
    verb: "action",
    prompts: [
      "Regenerate the primary access key of the App Configuration store {store_name} in resource group {rg}. Leave the secondary key as it is.",
      "Our App Configuration store {store_name} ({rg}) needs a new primary access key; please rotate it and keep the secondary one unchanged.",
    ],
    oracle: [
      "appconfig credential regenerate --name {store_name} --resource-group {rg} --id {_primary_id}",
    ],
    verify: v.changedAndKept(
      STORE + "/listKeys",
      APPCFG,
      "value[name=Primary].value",
      "value[name=Secondary].value"
    ),
    setup: async (ctx) => {
      await appcfgStore(ctx);
      const keys = await v.arm(ctx.q, "POST", v.fill(STORE + "/listKeys", ctx.slots), APPCFG);
      const primary = v.dotted(keys.body, "value[name=Primary]");
      const id = v.dotted(primary, "id");
      if (!id)
        throw new v.FixtureError(
          `fixture: no Primary key in ${JSON.stringify(keys.body).slice(0, 200)}`
        );
      ctx.slots.key_id = id;
      ctx.slots._primary_id = id;
      await v.snapshot(ctx.q, ctx.slots, STORE + "/listKeys", APPCFG, {
        changed: "value[name=Primary].value",
        kept: "value[name=Secondary].value",
      });
    },
    appConfigSlots: ["store_name"],
    sweep: [SWEEP.appcfg],
  });

  // ── Microsoft.Authorization ──────────────────────────────────────────────

  add({
    id: "lock-delete",
    opId: "Microsoft.Authorization/ManagementLocks_DeleteAtResourceGroupLevel",
    verb: "delete",
    prompts: [
      "Remove the management lock {lock_name} from resource group {rg}.",
      "We need to delete things in {rg}; please take off the management lock {lock_name}.",
    ],
    // The natural CLI commands fail here: `az lock delete` and `az group lock delete` first
    // list locks at subscription level (501 on this emulator); `resource delete --ids` works.
    oracle: [
      "resource delete --ids /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Authorization/locks/{lock_name}",
    ],
    verify: v.gone(LOCK, LOCKS),
    setup: async (ctx) => {
      ctx.slots.lock_name = `lk-${ctx.hex(8)}`;
      await v.putOk(
        ctx.q,
        v.fill(LOCK, ctx.slots),
        LOCKS,
        { properties: { level: "CanNotDelete" } },
        "lock"
      );
    },
  });

  add({
    id: "locks-list",
    opId: "Microsoft.Authorization/ManagementLocks_ListAtResourceGroupLevel",
    verb: "list",
    prompts: [
      "List the management locks on resource group {rg}.",
      "Which management locks are set on the {rg} resource group? Tell me their names.",
    ],
    oracle: ["lock list --resource-group {rg}"],
    verify: v.claims("{lock1}", "{lock2}"),
    setup: async (ctx) => {
      ctx.slots.lock1 = ctx.name("lk-ops-");
      ctx.slots.lock2 = ctx.name("lk-audit-");
      for (const n of [ctx.slots.lock1, ctx.slots.lock2]) {
        await v.putOk(
          ctx.q,
          v.fill(RG + "/Microsoft.Authorization/locks/" + String(n), ctx.slots),
          LOCKS,
          { properties: { level: "CanNotDelete", notes: "benchmark fixture" } },
          "lock"
        );
      }
    },
  });

  const ROLE_DEF = SUB + "/providers/Microsoft.Authorization/roleDefinitions/{role_id}";
  add({
    id: "role-definition-get",
    opId: "Microsoft.Authorization/RoleDefinitions_Get",
    verb: "read",
    prompts: [
      "What is the name of the role definition {role_id}, and which actions does it allow?",
      "Can you look up the Azure role definition with ID {role_id} and tell me its role name and the actions it permits?",
    ],
    oracle: ["role definition list --name {role_id}"],
    verify: v.claims("{role_name}", "{action1}", "{action2}"),
    setup: async (ctx) => {
      const roleId = ctx.uuid();
      const roleName = `Bench Operator ${ctx.hex(4)}`;
      const actions = ctx.sample(ROLE_ACTIONS, 2);
      Object.assign(ctx.slots, {
        role_definition_name: roleId,
        role_id: roleId,
        role_name: roleName,
        action1: actions[0],
        action2: actions[1],
      });
      await v.putOk(
        ctx.q,
        v.fill(ROLE_DEF, ctx.slots),
        ROLES,
        {
          properties: {
            roleName,
            description: "Benchmark fixture role",
            type: "CustomRole",
            permissions: [{ actions, notActions: [] }],
            assignableScopes: [`/subscriptions/${v.SUBSCRIPTION}`],
          },
        },
        "role definition"
      );
    },
    teardown: async (q, slots) => {
      await v.arm(q, "DELETE", v.fill(ROLE_DEF, slots), ROLES);
    },
  });

  // ── Microsoft.ContainerRegistry ──────────────────────────────────────────

  add({
    id: "acr-login-server",
    opId: "Microsoft.ContainerRegistry/Registries_Get",
    verb: "read",
    prompts: [
      "What is the login server of the container registry {registry_name} in resource group {rg}?",
      "Which hostname do I use to docker login to our registry {registry_name} ({rg})?",
    ],
    oracle: ["acr show --name {registry_name} --resource-group {rg}"],
    verify: v.answerHasFields(REG, ACR, ["properties.loginServer"]),
    setup: registry,
    sweep: [SWEEP.acr],
  });

  add({
    id: "acr-webhook-create",
    opId: "Microsoft.ContainerRegistry/Webhooks_Create",
    verb: "create",
    prompts: [
      "Create a webhook named {webhook_name} on the container registry {registry_name} (resource group {rg}) that calls https://example.com/hooks/{hook_id} on push and delete events.",
      "Please add a webhook {webhook_name} to our registry {registry_name} in {rg}: it should notify https://example.com/hooks/{hook_id} whenever an image is pushed or deleted.",
    ],
    oracle: [
      "acr webhook create --name {webhook_name} --registry {registry_name} --resource-group {rg} --uri https://example.com/hooks/{hook_id} --actions push delete",
    ],
    verify: v.allOf(
      v.readyWith(REG + "/webhooks/{webhook_name}", ACR, {}),
      v.listFieldContains(REG + "/webhooks/{webhook_name}", ACR, "properties.actions", [
        "push",
        "delete",
      ])
    ),
    setup: async (ctx) => {
      await registry(ctx);
      ctx.slots.hook_id = ctx.hex(8);
    },
    sweep: [SWEEP.acr],
  });

  // ── Microsoft.EventGrid ──────────────────────────────────────────────────

  add({
    id: "eventgrid-topic-regenerate-key",
    opId: "Microsoft.EventGrid/Topics_RegenerateKey",
    verb: "action",
    prompts: [
      "Regenerate the primary access key (key1) of the Event Grid topic {topic_name} in resource group {rg}. Leave key2 unchanged.",
      "key1 of our Event Grid topic {topic_name} ({rg}) was exposed in a log. Please rotate key1 and keep key2 as it is.",
    ],
    oracle: [
      "eventgrid topic key regenerate --name {topic_name} --resource-group {rg} --key-name key1",
    ],
    verify: v.changedAndKept(EG_TOPIC + "/listKeys", EG, "key1", "key2"),
    setup: async (ctx) => {
      ctx.slots.topic_name = `t${ctx.hex(10)}`;
      await v.azOk(
        ctx.q,
        `eventgrid topic create --name ${String(ctx.slots.topic_name)} --resource-group ${ctx.rg} --location westeurope`
      );
      await v.snapshot(ctx.q, ctx.slots, EG_TOPIC + "/listKeys", EG, {
        changed: "key1",
        kept: "key2",
      });
    },
    sweep: [SWEEP.egTopic],
  });

  add({
    id: "eventgrid-domain-disable-local-auth",
    opId: "Microsoft.EventGrid/Domains_Update",
    verb: "update",
    prompts: [
      "Disable local (access key) authentication on the Event Grid domain {domain_name} in resource group {rg}.",
      "From now on only Entra ID should be able to publish to our Event Grid domain {domain_name} ({rg}): please turn off key-based (local) authentication.",
    ],
    // az eventgrid domain update has no --disable-local-auth; the generic resource update reaches it.
    oracle: [
      "resource update --resource-group {rg} --name {domain_name} --resource-type Microsoft.EventGrid/domains --set properties.disableLocalAuth=true",
    ],
    verify: v.fieldIs(DOMAIN, EG, "properties.disableLocalAuth", "true"),
    setup: async (ctx) => {
      ctx.slots.domain_name = `d${ctx.hex(10)}`;
      await v.azOk(
        ctx.q,
        `eventgrid domain create --name ${String(ctx.slots.domain_name)} --resource-group ${ctx.rg} --location westeurope`
      );
      const body = await v.getOk(ctx.q, v.fill(DOMAIN, ctx.slots), EG, "domain");
      ctx.slots.location = v.dotted(body, "location") || "westeurope";
    },
    sweep: [SWEEP.egDomain],
  });

  // ── Microsoft.EventHub ───────────────────────────────────────────────────

  const RIGHTS = [["Listen"], ["Send"], ["Listen", "Send"], ["Listen", "Send", "Manage"]];
  add({
    id: "eventhub-hub-auth-rule-rights",
    opId: "Microsoft.EventHub/EventHubs_GetAuthorizationRule",
    verb: "read",
    prompts: [
      "Which rights does the authorization rule {auth_rule_name} on the event hub {eventhub_name} (namespace {namespace_name}, resource group {rg}) grant?",
      "What can clients do with the {auth_rule_name} policy of our event hub {eventhub_name} in namespace {namespace_name} ({rg})? Tell me which rights it grants.",
    ],
    oracle: [
      "eventhubs eventhub authorization-rule show --name {auth_rule_name} --eventhub-name {eventhub_name} --namespace-name {namespace_name} --resource-group {rg}",
    ],
    // Verifier defect 1 fixed (verifiers.affirmedRights).
    verify: v.rightsClaim(
      EH_NS + "/eventhubs/{eventhub_name}/authorizationRules/{auth_rule_name}",
      EH
    ),
    setup: async (ctx) => {
      await ehNamespace(ctx);
      const rights = ctx.pick(RIGHTS);
      ctx.slots._rights = rights.join(",");
      await v.putOk(
        ctx.q,
        v.fill(EH_NS + "/eventhubs/{eventhub_name}/authorizationRules/{auth_rule_name}", ctx.slots),
        EH,
        { properties: { rights } },
        "authorization rule"
      );
    },
    sweep: [SWEEP.eh],
  });

  // ── Microsoft.Insights ───────────────────────────────────────────────────

  add({
    id: "insights-activity-log-alert-create",
    opId: "Microsoft.Insights/ActivityLogAlerts_CreateOrUpdate",
    verb: "create",
    prompts: [
      "Create an activity log alert named {name} in resource group {rg} that fires on Administrative events, scoped to the resource group {rg} itself.",
      "Please set up an activity log alert called {name} in {rg}: it should watch the {rg} resource group and trigger on Administrative-category events.",
    ],
    oracle: [
      "monitor activity-log alert create --name {name} --resource-group {rg} --scope /subscriptions/{sub}/resourceGroups/{rg} --condition category=Administrative",
    ],
    verify: v.allOf(
      v.readyWith(ALERT, INS, {}),
      v.listFieldContains(ALERT, INS, "properties.scopes", [
        "/subscriptions/{sub}/resourceGroups/{rg}",
      ]),
      v.fieldIs(ALERT, INS, "properties.condition.allOf[field=category].equals", "Administrative")
    ),
    setup: async (ctx) => {
      ctx.slots.name = `activity${ctx.hex(10)}`;
      ctx.slots.scope = `/subscriptions/${v.SUBSCRIPTION}/resourceGroups/${ctx.rg}`;
    },
    sweep: [SWEEP.alert],
  });

  // ── Microsoft.KeyVault ───────────────────────────────────────────────────

  add({
    id: "kv-sign",
    opId: "Microsoft.KeyVault/Microsoft.KeyVault_Sign",
    verb: "action",
    prompts: [
      "Sign the SHA-256 digest {digest} (base64url) with version {key_version} of the key {key_name} in the key vault {vault_name}, using RS256, and give me the signature.",
      "Please create an RS256 signature with our Key Vault key {key_name} (version {key_version}, vault {vault_name}) over this SHA-256 digest, base64url-encoded: {digest}. I need the signature value.",
    ],
    oracle: [
      "keyvault key sign --vault-name {vault_name} --name {key_name} --version {key_version} --algorithm RS256 --digest {digest_b64}",
    ],
    verify: v.signatureVerifies(),
    setup: async (ctx) => {
      await vaultKey(ctx, { key: true });
      const digest = v.sha256(Buffer.from(ctx.uuid().replace(/-/g, ""), "hex"));
      Object.assign(ctx.slots, {
        crypto_value: v.b64url(digest),
        digest: v.b64url(digest),
        digest_b64: v.b64std(digest),
      });
    },
    kvCrypto: true,
    vaultSlots: ["vault_name"],
    sweep: [SWEEP.vault],
  });

  add({
    id: "kv-decrypt",
    opId: "Microsoft.KeyVault/Microsoft.KeyVault_Decrypt",
    verb: "action",
    prompts: [
      "Decrypt this ciphertext with version {key_version} of the key {key_name} in the key vault {vault_name} (algorithm RSA-OAEP) and tell me the plaintext. Ciphertext (base64url): {crypto_value}",
      "A partner sent us data encrypted with our Key Vault key {key_name} (version {key_version}) in vault {vault_name}, using RSA-OAEP. Please decrypt it and tell me what it says. Ciphertext, base64url-encoded: {crypto_value}",
    ],
    oracle: [
      "keyvault key decrypt --vault-name {vault_name} --name {key_name} --version {key_version} --algorithm RSA-OAEP --value {ciphertext_b64} --data-type plaintext",
    ],
    verify: v.plaintextStated(),
    setup: async (ctx) => {
      await vaultKey(ctx, { key: true });
      const plaintext = `order-${ctx.hex(10)}`;
      const s = ctx.slots as Record<string, string>;
      const enc = await v.azOk(
        ctx.q,
        `keyvault key encrypt --vault-name ${s.vault_name} --name ${s.key_name} --version ${s.key_version} --algorithm RSA-OAEP --value ${v.b64std(plaintext)} --data-type base64`
      );
      const result = v.dotted(enc, "result");
      if (typeof result !== "string" || !result)
        throw new v.FixtureError(`fixture: no ciphertext in ${JSON.stringify(enc).slice(0, 200)}`);
      Object.assign(ctx.slots, {
        crypto_value: v.toB64url(result),
        ciphertext_b64: v.toStdB64(result),
        plaintext,
      });
    },
    kvCrypto: true,
    vaultSlots: ["vault_name"],
    sweep: [SWEEP.vault],
  });

  add({
    id: "kv-rotation-policy",
    opId: "Microsoft.KeyVault/Microsoft.KeyVault_GetKeyRotationPolicy",
    verb: "read",
    prompts: [
      "What rotation policy does the key {key_name} in the key vault {vault_name} (resource group {rg}) have? After how long is it rotated, and when does it expire?",
      "Can you check the automatic rotation settings of the key {key_name} in our vault {vault_name} ({rg}): the rotation interval and the expiry time?",
    ],
    oracle: ["keyvault key rotation-policy show --vault-name {vault_name} --name {key_name}"],
    verify: v.allOf(
      v.textMatches("(?:P{rotate_days}D|\\b{rotate_days}\\s*-?\\s*days?\\b)"),
      v.textMatches("(?:P{expiry_days}D|\\b{expiry_days}\\s*-?\\s*days?\\b)")
    ),
    setup: async (ctx) => {
      await vaultKey(ctx, { key: true });
      const rotate = ctx.pick([45, 60, 75, 120]);
      const expiry = ctx.pick([180, 270, 365]);
      const policy = {
        lifetimeActions: [
          { trigger: { timeAfterCreate: `P${rotate}D` }, action: { type: "Rotate" } },
          { trigger: { timeBeforeExpiry: "P30D" }, action: { type: "Notify" } },
        ],
        attributes: { expiryTime: `P${expiry}D` },
      };
      const s = ctx.slots as Record<string, string>;
      await v.azOk(
        ctx.q,
        `keyvault key rotation-policy update --vault-name ${s.vault_name} --name ${s.key_name} --value '${v.jsonArg(policy)}'`,
        "rotation policy"
      );
      Object.assign(ctx.slots, { rotate_days: rotate, expiry_days: expiry });
    },
    vaultSlots: ["vault_name"],
    sweep: [SWEEP.vault],
  });

  add({
    id: "kv-access-policy-grant",
    opId: "Microsoft.KeyVault/Vaults_UpdateAccessPolicy",
    verb: "update",
    prompts: [
      "Grant the principal with object ID {object_id} permission to get and list secrets in the key vault {vault_name} (resource group {rg}), using the vault's access policies.",
      "Our deployment identity (object ID {object_id}) needs to read secrets from the Key Vault {vault_name} in {rg}: please give it get and list permissions on secrets through an access policy.",
    ],
    oracle: [
      "keyvault set-policy --name {vault_name} --resource-group {rg} --object-id {object_id} --secret-permissions get list",
    ],
    verify: v.accessPolicyGrants(VAULT, VAULT_API, "object_id", "secrets", ["get", "list"]),
    setup: async (ctx) => {
      // _access_policy_vault: the access-policy model (the default vault uses RBAC), no policies yet.
      ctx.slots.vault_name = `kv${ctx.hex(10)}`;
      await v.putOk(
        ctx.q,
        v.fill(VAULT, ctx.slots),
        VAULT_API,
        {
          location: "westeurope",
          properties: {
            tenantId: v.SUBSCRIPTION,
            sku: { family: "A", name: "standard" },
            accessPolicies: [],
            enableRbacAuthorization: false,
          },
        },
        "vault"
      );
      await v.waitReady(ctx.q, v.fill(VAULT, ctx.slots), VAULT_API);
      ctx.slots.object_id = ctx.uuid();
    },
    vaultSlots: ["vault_name"],
    sweep: [SWEEP.vault],
  });

  // ── Microsoft.ManagedIdentity ────────────────────────────────────────────

  add({
    id: "identity-create",
    opId: "Microsoft.ManagedIdentity/UserAssignedIdentities_CreateOrUpdate",
    verb: "create",
    prompts: [
      "Create a user-assigned managed identity named {name} in resource group {rg}, and tell me its client ID.",
      "Please create a new user-assigned managed identity called {name} in {rg}; I'll need its client ID afterwards.",
    ],
    oracle: ["identity create --name {name} --resource-group {rg}"],
    verify: v.allOf(
      v.readyWith(UAI, MSI, {}),
      v.answerHasFields(UAI, MSI, ["properties.clientId"])
    ),
    setup: async (ctx) => {
      ctx.slots.name = `id-${ctx.hex(8)}`;
    },
    sweep: [SWEEP.uai],
  });

  add({
    id: "identity-list",
    opId: "Microsoft.ManagedIdentity/UserAssignedIdentities_ListBySubscription",
    verb: "list",
    prompts: [
      "List the user-assigned managed identities in my subscription.",
      "Which user-assigned managed identities exist across the whole subscription? Tell me their names.",
    ],
    oracle: ["identity list"],
    verify: v.claims("{id1}", "{id2}"),
    setup: async (ctx) => {
      ctx.slots.id1 = ctx.name("id-ci-");
      ctx.slots.id2 = ctx.name("id-backup-");
      for (const n of [ctx.slots.id1, ctx.slots.id2]) {
        await v.putOk(
          ctx.q,
          v.fill(RG + "/Microsoft.ManagedIdentity/userAssignedIdentities/" + String(n), ctx.slots),
          MSI,
          { location: "westeurope" },
          "identity"
        );
      }
    },
    sweep: [SWEEP.uai],
  });

  // ── Microsoft.Network ────────────────────────────────────────────────────

  add({
    id: "route-get",
    opId: "Microsoft.Network/Routes_Get",
    verb: "read",
    prompts: [
      "What address prefix and next hop does the route {route_name} in the route table {route_table_name} (resource group {rg}) have?",
      "Where does the route {route_name} of our route table {route_table_name} ({rg}) send traffic, and for which address prefix?",
    ],
    oracle: [
      "network route-table route show --name {route_name} --route-table-name {route_table_name} --resource-group {rg}",
    ],
    verify: v.claims("{prefix}", "{next_hop}"),
    setup: async (ctx) => {
      const s = ctx.hex(8);
      Object.assign(ctx.slots, { route_table_name: `rt-${s}`, route_name: `r-${s}` });
      await v.azOk(
        ctx.q,
        `network route-table create --name rt-${s} --resource-group ${ctx.rg} --location westeurope`
      );
      const prefix = `10.${ctx.randomInt(20, 200)}.${ctx.randomInt(0, 250)}.0/24`;
      const hop = `10.0.${ctx.randomInt(2, 250)}.4`;
      const path = v.fill(ROUTE_TABLE + "/routes/{route_name}", ctx.slots);
      await v.putOk(
        ctx.q,
        path,
        NET,
        {
          properties: {
            addressPrefix: prefix,
            nextHopType: "VirtualAppliance",
            nextHopIpAddress: hop,
          },
        },
        "route"
      );
      await v.waitReady(ctx.q, path, NET);
      Object.assign(ctx.slots, { prefix, next_hop: hop });
    },
    sweep: [SWEEP.routeTable],
  });

  add({
    id: "private-dns-zones-list",
    opId: "Microsoft.Network/PrivateZones_ListByResourceGroup",
    verb: "list",
    prompts: [
      "List the private DNS zones in resource group {rg}.",
      "Which private DNS zones do we have in {rg}? Tell me their names.",
    ],
    oracle: ["network private-dns zone list --resource-group {rg}"],
    verify: v.claims("{zone1}", "{zone2}"),
    setup: async (ctx) => {
      ctx.slots.zone1 = `${ctx.hex(6)}.internal.contoso.com`;
      ctx.slots.zone2 = `${ctx.hex(6)}.corp.contoso.com`;
      for (const z of [ctx.slots.zone1, ctx.slots.zone2]) {
        const path = v.fill(RG + "/Microsoft.Network/privateDnsZones/" + String(z), ctx.slots);
        await v.putOk(ctx.q, path, PDNS, { location: "global" }, "private DNS zone");
        await v.waitReady(ctx.q, path, PDNS);
      }
    },
    sweep: [SWEEP.pdns],
  });

  add({
    id: "vnet-address-space",
    opId: "Microsoft.Network/VirtualNetworks_Get",
    verb: "read",
    prompts: [
      "What address space does the virtual network {vnet_name} in resource group {rg} use?",
      "Which IP address range is our VNet {vnet_name} ({rg}) configured with?",
    ],
    oracle: ["network vnet show --name {vnet_name} --resource-group {rg}"],
    verify: v.claims("{prefix}"),
    setup: async (ctx) => {
      const name = ctx.name("vnet-core-");
      const prefix = `10.${ctx.randomInt(10, 250)}.0.0/16`;
      Object.assign(ctx.slots, { name, vnet_name: name });
      const path = v.fill(VNET, ctx.slots);
      await v.putOk(
        ctx.q,
        path,
        NET,
        { location: "westeurope", properties: { addressSpace: { addressPrefixes: [prefix] } } },
        "vnet"
      );
      await v.waitReady(ctx.q, path, NET);
      ctx.slots.prefix = prefix;
    },
    sweep: [SWEEP.vnet],
  });

  // ── Microsoft.OperationalInsights ────────────────────────────────────────

  add({
    id: "la-workspace-retention",
    opId: "Microsoft.OperationalInsights/Workspaces_Update",
    verb: "update",
    prompts: [
      "Set the data retention of the Log Analytics workspace {name} in resource group {rg} to {days} days.",
      "Compliance wants {days} days of log retention: please update our Log Analytics workspace {name} ({rg}) accordingly.",
    ],
    oracle: [
      "monitor log-analytics workspace update --resource-group {rg} --workspace-name {name} --retention-time {days}",
    ],
    verify: v.fieldIs(WS, LA, "properties.retentionInDays", "{days}"),
    setup: async (ctx) => {
      ctx.slots.name = `la-${ctx.hex(8)}`;
      await v.azOk(
        ctx.q,
        `monitor log-analytics workspace create --resource-group ${ctx.rg} --workspace-name ${String(ctx.slots.name)} --location westeurope`
      );
      ctx.slots.days = ctx.pick([60, 90, 120, 180]);
    },
    sweep: [SWEEP.la],
  });

  // ── Microsoft.Resources (subscription-scope deployments) ────────────────

  add({
    id: "deployment-sub-validate",
    opId: "Microsoft.Resources/Deployments_ValidateAtSubscriptionScope",
    verb: "action",
    prompts: [
      "Validate, without deploying it, whether this ARM template can be deployed at subscription scope in westeurope as {deployment_name}: {template_json}",
      "Before we roll it out, check whether this subscription-level template would deploy cleanly (as {deployment_name}, westeurope) - validation only, please: {template_json}",
    ],
    // az deployment sub validate needs a template file; the oracle sends it inline with az rest.
    oracle: [
      "rest --method post --url /subscriptions/{sub}/providers/Microsoft.Resources/deployments/{deployment_name}/validate?api-version=2022-09-01 --body '{deploy_body}'",
    ],
    // Verifier defect 2 fixed (verifiers.validationVerdict).
    verify: v.validationClaim(SUB_DEPLOY, DEPLOY_API),
    setup: async (ctx) => {
      ctx.slots.deployment_name = `dep-${ctx.hex(8)}`;
      ctx.slots.template_json = v.pyJson(DEPLOY_TEMPLATE);
      ctx.slots.deploy_body = v.pyJson({
        location: "westeurope",
        properties: { mode: "Incremental", template: DEPLOY_TEMPLATE },
      });
    },
    teardown: async (q, slots) => {
      await v.arm(q, "DELETE", v.fill(SUB_DEPLOY, slots), DEPLOY_API);
    },
    guessable: true,
  });

  // ── Microsoft.ServiceBus ─────────────────────────────────────────────────

  add({
    id: "sb-queue-regenerate-key",
    opId: "Microsoft.ServiceBus/Queues_RegenerateKeys",
    verb: "action",
    prompts: [
      "Regenerate the primary key of the authorization rule {auth_rule_name} on the queue {queue_name} in the Service Bus namespace {namespace_name} (resource group {rg}). Keep the secondary key.",
      "The primary key of the {auth_rule_name} policy on our Service Bus queue {queue_name} (namespace {namespace_name}, {rg}) leaked. Please rotate it and leave the secondary key alone.",
    ],
    oracle: [
      "servicebus queue authorization-rule keys renew --name {auth_rule_name} --queue-name {queue_name} --namespace-name {namespace_name} --resource-group {rg} --key PrimaryKey",
    ],
    verify: v.changedAndKept(
      SB_NS + "/queues/{queue_name}/authorizationRules/{auth_rule_name}/listKeys",
      SB,
      "primaryKey",
      "secondaryKey"
    ),
    setup: async (ctx) => {
      await sbNamespace(ctx, { queueRule: true });
      await v.snapshot(
        ctx.q,
        ctx.slots,
        SB_NS + "/queues/{queue_name}/authorizationRules/{auth_rule_name}/listKeys",
        SB,
        {
          changed: "primaryKey",
          kept: "secondaryKey",
        }
      );
    },
    sweep: [SWEEP.sb],
  });

  add({
    id: "sb-dp-queue-max-delivery",
    opId: "Microsoft.ServiceBus.DataPlane/Entity_Get",
    verb: "read",
    prompts: [
      "What is the maximum delivery count of the Service Bus queue {queue_name} in the namespace {namespace_name} (resource group {rg})?",
      "After how many delivery attempts does our Service Bus queue {queue_name} (namespace {namespace_name}, {rg}) dead-letter a message?",
    ],
    oracle: [
      "servicebus queue show --name {queue_name} --namespace-name {namespace_name} --resource-group {rg}",
    ],
    verify: v.allOf(
      v.fieldIs(
        SB_NS + "/queues/{queue_name}",
        SB,
        "properties.maxDeliveryCount",
        "{max_delivery}"
      ),
      v.textMatches("\\b{max_delivery}\\b")
    ),
    setup: async (ctx) => {
      await sbNamespace(ctx, { queue: true });
      // _max_delivery: re-PUT the queue with a random maxDeliveryCount.
      const count = ctx.pick([3, 5, 7, 12, 15]);
      const path = v.fill(SB_NS + "/queues/{queue_name}", ctx.slots);
      const body = await v.getOk(ctx.q, path, SB, "queue");
      const props = { ...((v.dotted(body, "properties") as Record<string, unknown>) ?? {}) };
      for (const k of [
        "createdAt",
        "updatedAt",
        "accessedAt",
        "countDetails",
        "messageCount",
        "sizeInBytes",
        "status",
        "subscriptionCount",
      ]) {
        delete props[k];
      }
      props.maxDeliveryCount = count;
      await v.putOk(ctx.q, path, SB, { properties: props }, "queue");
      ctx.slots.max_delivery = count;
    },
    sweep: [SWEEP.sb],
  });

  // ── Microsoft.Storage ────────────────────────────────────────────────────

  add({
    id: "storage-regenerate-key",
    opId: "Microsoft.Storage/StorageAccounts_RegenerateKey",
    verb: "action",
    prompts: [
      "Regenerate the first access key (key1) of the storage account {name} in resource group {rg}. Keep key2.",
      "key1 of our storage account {name} ({rg}) was committed to a repository. Please regenerate key1 and leave key2 unchanged.",
    ],
    oracle: [
      "storage account keys renew --account-name {name} --resource-group {rg} --key primary",
    ],
    verify: v.changedAndKept(
      ACCT_N + "/listKeys",
      STORAGE,
      "keys[keyName=key1].value",
      "keys[keyName=key2].value"
    ),
    setup: async (ctx) => {
      // _keyed_storage: a private account, waited until Succeeded (its Azurite starts in 10-30 s).
      ctx.slots.name = `sa${ctx.hex(8)}`;
      await v.azOk(
        ctx.q,
        `storage account create --name ${String(ctx.slots.name)} --resource-group ${ctx.rg} --location westeurope --sku Standard_LRS`
      );
      const state = await v.waitField(
        ctx.q,
        v.fill(ACCT_N, ctx.slots),
        STORAGE,
        "properties.provisioningState",
        "Succeeded",
        180
      );
      if (String(state).toLowerCase() !== "succeeded")
        throw new v.FixtureError(`fixture: storage account still ${String(state)} after 180 s`);
      await v.snapshot(ctx.q, ctx.slots, ACCT_N + "/listKeys", STORAGE, {
        changed: "keys[keyName=key1].value",
        kept: "keys[keyName=key2].value",
      });
    },
    sweep: [SWEEP.storage],
  });

  // ── Microsoft.Compute ────────────────────────────────────────────────────

  add({
    id: "disk-create",
    opId: "Microsoft.Compute/Disks_CreateOrUpdate",
    verb: "create",
    prompts: [
      "Create an empty managed disk named {disk_name} in resource group {rg}: {size_gb} GB, StandardSSD_LRS.",
      "I need a new {size_gb} GB managed disk called {disk_name} in the {rg} resource group, on StandardSSD_LRS storage. Please create it.",
    ],
    oracle: [
      "disk create --name {disk_name} --resource-group {rg} --size-gb {size_gb} --sku StandardSSD_LRS",
    ],
    verify: v.readyWith(DISK, DISKS, {
      "properties.diskSizeGB": "{size_gb}",
      "sku.name": "StandardSSD_LRS",
    }),
    setup: async (ctx) => {
      ctx.slots.disk_name = `disk-${ctx.hex(10)}`;
      ctx.slots.size_gb = ctx.pick([16, 32, 64, 128]);
    },
    sweep: [SWEEP.disk],
  });

  // ── Microsoft.Cdn (classic CDN; needs CDN_CLASSIC_ALLOW_CREATE=1 on the emulator) ──

  add({
    id: "cdn-can-migrate",
    opId: "Microsoft.Cdn/Profiles_CdnCanMigrateToAfd",
    verb: "action",
    prompts: [
      "Can the classic CDN profile {profile_name} in resource group {rg} be migrated to Azure Front Door? If it cannot, tell me what is blocking it.",
      "We want to move our classic CDN profile {profile_name} ({rg}) to Azure Front Door: check whether it is eligible for migration, and if it is not, why not.",
    ],
    oracle: [
      "cdn profile-migration check-compatibility --profile-name {profile_name} --resource-group {rg}",
    ],
    verify: v.migrationVerdict("can_migrate"),
    setup: async (ctx) => {
      const s = ctx.hex(10);
      Object.assign(ctx.slots, {
        profile_name: `cdnp${s}`,
        endpoint_name: `cdne${s}`,
        origin_name: `or${s}`,
      });
      await v.azOk(
        ctx.q,
        `cdn profile create --name cdnp${s} --resource-group ${ctx.rg} --sku Standard_Microsoft`
      );
      // _maybe_endpoint: half the runs give the profile an endpoint (it can migrate).
      if (ctx.random() < 0.5) {
        const path = v.fill(PROFILE + "/endpoints/{endpoint_name}", ctx.slots);
        await v.putOk(
          ctx.q,
          path,
          CDN,
          {
            location: "global",
            properties: {
              origins: [
                { name: "origin1", properties: { hostName: `cdne${s}.origin.example.com` } },
              ],
            },
          },
          "CDN endpoint"
        );
        await v.waitReady(ctx.q, path, CDN);
        ctx.slots.can_migrate = true;
      } else {
        ctx.slots.can_migrate = false;
      }
    },
    guessable: true,
    sweep: [SWEEP.cdn],
  });

  return tasks;
}
