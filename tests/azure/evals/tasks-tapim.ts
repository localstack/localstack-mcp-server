/**
 * E2 tasks drawn from the benchmark's T-APIM tier (benchmark/harness/tapim.py): API
 * Management operations, one phrasing. Each run gets its own APIM service (created in about
 * a second, no backing container) in the run's group. Most operations have no dedicated
 * CLI command, so the benchmark's oracles use `az rest`; an XML policy body travels
 * JSON-escaped (\u003c, \u003e), as the benchmark sent it.
 *
 * The verifier library arrives as a parameter (see verifiers.ts).
 */
import type * as V from "./verifiers";
import type { SetupContext, Task } from "./types";

/**
 * The typed server's static self-signed PFX (CN=mcp-t2-cert.contoso.com, no password,
 * valid 2026-2036), from its tests/coverage_mapping.py. The emulator parses the material,
 * so it must be a genuine PKCS#12 archive.
 */
export const STATIC_TEST_PFX_B64 =
  "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";

export function tapimTasks(v: typeof V): Task[] {
  const APIM = "2024-05-01";
  const SVC =
    "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiManagement/service/{service_name}";
  const SVC_ID =
    "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiManagement/service/{service_name}";

  /** The benchmark's _rest: an `az rest` call on a path of the run's service. */
  const rest = (method: string, path: string, body?: string) =>
    `rest --method ${method} --url ${SVC_ID}${path}?api-version=${APIM}` +
    (body ? ` --body '${body}'` : "");

  /** _service: a Developer-tier service in the run's group, waited until ready. */
  async function service(ctx: SetupContext) {
    const svc = ctx.name("apim");
    Object.assign(ctx.slots, { service_name: svc, name: svc });
    const path = v.fill(SVC, ctx.slots);
    await v.putOk(
      ctx.q,
      path,
      APIM,
      {
        location: "westeurope",
        sku: { name: "Developer", capacity: 1 },
        properties: { publisherEmail: "ops@contoso.com", publisherName: "Contoso" },
      },
      "APIM"
    );
    await v.waitReady(ctx.q, path, APIM);
  }

  /** _random: random values per slot; `{r}` is 6 random hex characters. */
  function random(ctx: SetupContext, values: Record<string, string>) {
    const r = ctx.hex(6);
    for (const [k, tpl] of Object.entries(values)) ctx.slots[k] = tpl.replace(/\{r\}/g, r);
  }

  /**
   * _children: PUT child resources of the service in order (paths and string values may
   * name slots); `{rand:x}` picks a fresh random name for slot x (the benchmark's
   * `_name(x.split("_")[0][:6])`).
   */
  async function children(ctx: SetupContext, items: Array<[string, unknown]>) {
    const fillRand = (s: string): string => {
      const withSlots = s.replace(/\{rand:([a-z0-9_]+)\}/g, (_m, slot: string) => {
        if (!(slot in ctx.slots)) ctx.slots[slot] = ctx.name(slot.split("_")[0].slice(0, 6));
        return `{${slot}}`;
      });
      return v.fmt(withSlots, ctx.slots);
    };
    const deep = (x: unknown): unknown => {
      if (typeof x === "string") return fillRand(x);
      if (Array.isArray(x)) return x.map(deep);
      if (x && typeof x === "object")
        return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, deep(y)]));
      return x;
    };
    for (const [path, body] of items) {
      const p = fillRand(path);
      await v.putOk(ctx.q, v.fill(SVC, ctx.slots) + p, APIM, deep(body), path);
    }
  }

  /** _api_operation: an API with one GET operation, and a random rate limit. */
  async function apiOperation(ctx: SetupContext) {
    const api = ctx.name("orders");
    const op = ctx.name("getorder");
    const base = v.fill(SVC, ctx.slots);
    await v.putOk(
      ctx.q,
      `${base}/apis/${api}`,
      APIM,
      { properties: { displayName: api, path: api, protocols: ["https"] } },
      "API"
    );
    await v.putOk(
      ctx.q,
      `${base}/apis/${api}/operations/${op}`,
      APIM,
      {
        properties: {
          displayName: "Get order",
          method: "GET",
          urlTemplate: "/orders/{id}",
          templateParameters: [{ name: "id", type: "string", required: true }],
        },
      },
      "operation"
    );
    Object.assign(ctx.slots, { api, operation: op, calls: ctx.pick([12, 17, 25, 40, 75]) });
  }

  const POLICY =
    '<policies><inbound><base /><rate-limit calls="{calls}" renewal-period="60" /></inbound><backend><base />' +
    "</backend><outbound><base /></outbound><on-error><base /></on-error></policies>";
  // The same XML with < > " written as JSON escapes, as the benchmark sent it.
  const POLICY_JSON = POLICY.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/"/g, '\\"');

  const tasks: Task[] = [];
  const add = (t: Omit<Task, "tier" | "caps">) =>
    tasks.push({
      tier: "T-APIM",
      caps: "T-A",
      apimSlots: ["service_name"],
      sweep: [`Microsoft.ApiManagement/service@${APIM}`],
      ...t,
    });

  // ── membership check (GroupUser_CheckEntityExists) ──────────────────────

  add({
    id: "apim-group-user-check",
    opId: "Microsoft.ApiManagement/GroupUser_CheckEntityExists",
    verb: "check",
    prompts: [
      "In the API Management service {service_name} (resource group {rg}), are the users {user1} and {user2} members of the group {group}? Check each one.",
    ],
    oracle: [
      rest("head", "/groups/{group}/users/{user1}"),
      rest("head", "/groups/{group}/users/{user2}"),
    ],
    // Verifier defect 6 fixed (verifiers.membershipVerdicts).
    verify: v.membershipStated(),
    setup: async (ctx) => {
      await service(ctx);
      const group = ctx.name("devs");
      const u1 = ctx.name("alice");
      const u2 = ctx.name("bob");
      const base = v.fill(SVC, ctx.slots);
      await v.putOk(
        ctx.q,
        `${base}/groups/${group}`,
        APIM,
        { properties: { displayName: group } },
        "group"
      );
      for (const u of [u1, u2]) {
        await v.putOk(
          ctx.q,
          `${base}/users/${u}`,
          APIM,
          { properties: { email: `${u}@contoso.com`, firstName: u, lastName: "Test" } },
          "user"
        );
      }
      const member = ctx.pick([u1, u2]);
      const put = await v.arm(ctx.q, "PUT", `${base}/groups/${group}/users/${member}`, APIM);
      if (put.status === 0 || put.status >= 300)
        throw new v.FixtureError(`fixture: group membership PUT ${put.status}`);
      Object.assign(ctx.slots, { group, user1: u1, user2: u2, member });
    },
  });

  // ── workspaces: product update ──────────────────────────────────────────

  add({
    id: "apim-workspace-product-update",
    opId: "Microsoft.ApiManagement/WorkspaceProduct_Update",
    verb: "update",
    prompts: [
      "Set the description of the product {product} in the workspace {workspace} of the API Management service {service_name} (resource group {rg}) to: {description}",
    ],
    oracle: [
      rest(
        "patch",
        "/workspaces/{workspace}/products/{product}",
        '{{"properties": {{"description": "{description}"}}}}'
      ),
    ],
    verify: v.fieldIs(
      SVC + "/workspaces/{workspace}/products/{product}",
      APIM,
      "properties.description",
      "{description}"
    ),
    setup: async (ctx) => {
      await service(ctx);
      random(ctx, { description: "Partner tier, reviewed {r}" });
      await children(ctx, [
        ["/workspaces/{rand:workspace}", { properties: { displayName: "{workspace}" } }],
        [
          "/workspaces/{workspace}/products/{rand:product}",
          { properties: { displayName: "{product}", state: "notPublished" } },
        ],
      ]);
    },
  });

  // ── tenant access and Git access ────────────────────────────────────────

  add({
    id: "apim-tenant-access",
    opId: "Microsoft.ApiManagement/TenantAccess_ListByService",
    verb: "list",
    prompts: [
      "Is direct management API access enabled on the API Management service {service_name} (resource group {rg})? Check its tenant access settings.",
    ],
    oracle: [rest("get", "/tenant")],
    // Verifier defect 7 fixed (verifiers.tenantAccessVerdict).
    verify: v.accessStated(),
    setup: async (ctx) => {
      await service(ctx);
      const enabled = ctx.pick([true, false]);
      const r = await v.arm(ctx.q, "PATCH", v.fill(SVC + "/tenant/access", ctx.slots), APIM, {
        properties: { enabled },
      });
      if (r.status === 0 || r.status >= 300)
        throw new v.FixtureError(`fixture: tenant access PATCH ${r.status}`);
      ctx.slots.access_enabled = enabled;
    },
    guessable: true,
  });

  add({
    id: "apim-git-regenerate-primary",
    opId: "Microsoft.ApiManagement/TenantAccessGit_RegeneratePrimaryKey",
    verb: "action",
    prompts: [
      "Regenerate the primary key of the Git access configuration of the API Management service {service_name} (resource group {rg}). Leave the secondary key as it is.",
    ],
    oracle: [rest("post", "/tenant/gitAccess/regeneratePrimaryKey")],
    verify: v.changedAndKept(
      SVC + "/tenant/gitAccess/listSecrets",
      APIM,
      "primaryKey",
      "secondaryKey"
    ),
    setup: async (ctx) => {
      await service(ctx);
      await v.snapshot(ctx.q, ctx.slots, SVC + "/tenant/gitAccess/listSecrets", APIM, {
        changed: "primaryKey",
        kept: "secondaryKey",
      });
    },
  });

  // ── APIs, operations, tags, tag descriptions, policies, resolvers ───────

  add({
    id: "apim-api-create",
    opId: "Microsoft.ApiManagement/Api_CreateOrUpdate",
    verb: "create",
    prompts: [
      "In the API Management service {service_name} (resource group {rg}), create an API {api} served under the path {api_path} with the display name {display}.",
    ],
    oracle: [
      "apim api create --service-name {service_name} --resource-group {rg} --api-id {api} --path {api_path} --display-name {display}",
    ],
    verify: v.fieldIs(SVC + "/apis/{api}", APIM, "properties.path", "{api_path}"),
    setup: async (ctx) => {
      await service(ctx);
      random(ctx, { api: "inventory-{r}", api_path: "v2/stock-{r}", display: "Inventory{r}" });
    },
  });

  add({
    id: "apim-operation-delete",
    opId: "Microsoft.ApiManagement/ApiOperation_Delete",
    verb: "delete",
    prompts: [
      "Delete the operation {operation} from the API {api} in the API Management service {service_name} (resource group {rg}).",
    ],
    oracle: [
      "apim api operation delete --service-name {service_name} --resource-group {rg} --api-id {api} --operation-id {operation}",
    ],
    verify: v.gone(SVC + "/apis/{api}/operations/{operation}", APIM),
    setup: async (ctx) => {
      await service(ctx);
      await apiOperation(ctx);
    },
  });

  add({
    id: "apim-operation-policy",
    opId: "Microsoft.ApiManagement/ApiOperationsPolicy_CreateOrUpdate",
    verb: "create",
    prompts: [
      "Put a policy on the operation {operation} of the API {api} in the API Management service {service_name} (resource group {rg}) that rate-limits each caller to {calls} calls per 60 seconds.",
    ],
    oracle: [
      rest(
        "put",
        "/apis/{api}/operations/{operation}/policies/policy",
        '{{"properties": {{"format": "rawxml", "value": "' + POLICY_JSON + '"}}}}'
      ),
    ],
    verify: v.policyRateLimit(SVC + "/apis/{api}/operations/{operation}/policies/policy", APIM),
    setup: async (ctx) => {
      await service(ctx);
      await apiOperation(ctx);
    },
  });

  add({
    id: "apim-tag-assign-api",
    opId: "Microsoft.ApiManagement/Tag_AssignToApi",
    verb: "action",
    prompts: [
      "Assign the tag {tag} to the API {api} in the API Management service {service_name} (resource group {rg}).",
    ],
    oracle: [rest("put", "/apis/{api}/tags/{tag}")],
    verify: v.exists(SVC + "/apis/{api}/tags/{tag}", APIM),
    setup: async (ctx) => {
      await service(ctx);
      await children(ctx, [
        [
          "/apis/{rand:api}",
          { properties: { displayName: "{api}", path: "{api}", protocols: ["https"] } },
        ],
        ["/tags/{rand:tag}", { properties: { displayName: "{tag}" } }],
      ]);
    },
  });

  add({
    id: "apim-tag-detach-product",
    opId: "Microsoft.ApiManagement/Tag_DetachFromProduct",
    verb: "action",
    prompts: [
      "Remove the tag {tag} from the product {product} in the API Management service {service_name} (resource group {rg}). Keep the tag itself.",
    ],
    oracle: [rest("delete", "/products/{product}/tags/{tag}")],
    verify: v.allOf(
      v.gone(SVC + "/products/{product}/tags/{tag}", APIM),
      v.exists(SVC + "/tags/{tag}", APIM)
    ),
    setup: async (ctx) => {
      await service(ctx);
      await children(ctx, [
        [
          "/products/{rand:product}",
          {
            properties: {
              displayName: "{product}",
              state: "published",
              subscriptionRequired: false,
            },
          },
        ],
        ["/tags/{rand:tag}", { properties: { displayName: "{tag}" } }],
        ["/products/{product}/tags/{tag}", {}],
      ]);
    },
  });

  add({
    id: "apim-api-tag-descriptions",
    opId: "Microsoft.ApiManagement/ApiTagDescription_ListByService",
    verb: "list",
    prompts: [
      "List the tag descriptions of the API {api} in the API Management service {service_name} (resource group {rg}), with each description's text.",
    ],
    oracle: [rest("get", "/apis/{api}/tagDescriptions")],
    verify: v.claims("{desc1}", "{desc2}"),
    setup: async (ctx) => {
      await service(ctx);
      random(ctx, { desc1: "Owned by payments {r}", desc2: "Deprecated in 2027 {r}" });
      await children(ctx, [
        [
          "/apis/{rand:api}",
          { properties: { displayName: "{api}", path: "{api}", protocols: ["https"] } },
        ],
        ["/tags/{rand:tag1}", { properties: { displayName: "{tag1}" } }],
        ["/tags/{rand:tag2}", { properties: { displayName: "{tag2}" } }],
        ["/apis/{api}/tagDescriptions/{tag1}", { properties: { description: "{desc1}" } }],
        ["/apis/{api}/tagDescriptions/{tag2}", { properties: { description: "{desc2}" } }],
      ]);
    },
  });

  add({
    id: "apim-graphql-resolver",
    opId: "Microsoft.ApiManagement/GraphqlApiResolver_CreateOrUpdate",
    verb: "create",
    prompts: [
      "Create a resolver {resolver} on the GraphQL API {api} of the API Management service {service_name} (resource group {rg}) for the field Query.{field}.",
    ],
    oracle: [
      "apim graphql resolver create --service-name {service_name} --resource-group {rg} --api-id {api} --resolver-id {resolver} --display-name {resolver} --path Query/{field}",
    ],
    verify: v.fieldIs(
      SVC + "/apis/{api}/resolvers/{resolver}",
      APIM,
      "properties.path",
      "Query/{field}"
    ),
    setup: async (ctx) => {
      await service(ctx);
      random(ctx, { field: "orders{r}", resolver: "orders-resolver-{r}" });
      await children(ctx, [
        [
          "/apis/{rand:api}",
          {
            properties: {
              displayName: "{api}",
              path: "{api}",
              type: "graphql",
              protocols: ["https"],
            },
          },
        ],
      ]);
    },
  });

  // ── certificates, OpenID Connect providers ──────────────────────────────

  add({
    id: "apim-certificate-create",
    opId: "Microsoft.ApiManagement/Certificate_CreateOrUpdate",
    verb: "create",
    prompts: [
      "Upload a certificate named {cert} to the API Management service {service_name} (resource group {rg}). It is a PFX, base64-encoded, with an empty password: {pfx}",
    ],
    oracle: [
      rest(
        "put",
        "/certificates/{cert}",
        '{{"properties": {{"data": "{pfx}", "password": "{pfx_password}"}}}}'
      ),
    ],
    verify: v.fieldIs(
      SVC + "/certificates/{cert}",
      APIM,
      "properties.subject",
      "CN=mcp-t2-cert.contoso.com"
    ),
    setup: async (ctx) => {
      await service(ctx);
      Object.assign(ctx.slots, {
        pfx: STATIC_TEST_PFX_B64,
        pfx_password: "",
        cert: ctx.name("tls"),
      });
    },
  });

  add({
    id: "apim-oidc-secret",
    opId: "Microsoft.ApiManagement/OpenIdConnectProvider_ListSecrets",
    verb: "list",
    prompts: [
      "What is the client secret of the OpenID Connect provider {oidc} in the API Management service {service_name} (resource group {rg})?",
    ],
    oracle: [rest("post", "/openidConnectProviders/{oidc}/listSecrets")],
    verify: v.claims("{secret}"),
    setup: async (ctx) => {
      await service(ctx);
      random(ctx, { secret: "oidc-{r}-s3cr3t" });
      await children(ctx, [
        [
          "/openidConnectProviders/{rand:oidc}",
          {
            properties: {
              displayName: "{oidc}",
              clientId: "portal-client",
              metadataEndpoint: "https://login.contoso.com/.well-known/openid-configuration",
              clientSecret: "{secret}",
            },
          },
        ],
      ]);
    },
  });

  // ── the service itself ──────────────────────────────────────────────────

  add({
    id: "apim-migrate-stv2",
    opId: "Microsoft.ApiManagement/ApiManagementService_MigrateToStv2",
    verb: "action",
    // Not "Migrate ... to the stv2 compute platform": the emulator creates services on stv2.1, so a
    // careful agent read that, rightly said "already on stv2" and did nothing (0 of 3 runs). The
    // request now asks for the migration run itself, which is what the task measures.
    prompts: [
      "Run the stv2 platform migration on the API Management service {service_name} (resource group {rg}), keeping its IP addresses. Our runbook requires the migration step even when the service already reports an stv2 version.",
    ],
    oracle: [rest("post", "/migrateToStv2", '{{"mode": "PreserveIp"}}')],
    // The emulator creates services on stv2.1, and migrating sets stv2: the only observable change.
    verify: v.fieldIs(SVC, APIM, "properties.platformVersion", "stv2"),
    setup: service,
  });

  return tasks;
}
