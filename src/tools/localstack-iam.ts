import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireAuthToken, requireLocalStackRunning } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature, checkProFeature } from "../lib/localstack/license-checker";
import { AppInspectorApiClient, IamApiClient } from "../lib/localstack/localstack.client";
import { formatEventsError, formatIamConfigError } from "../lib/iam/iam-errors";
import {
  DATA_NOTE,
  codeSpan,
  decodeIamEvent,
  extractEvents,
  renderDenialList,
  renderDerivedPolicies,
  renderExplanation,
} from "../lib/iam/iam-explain.logic";
import {
  APP_INSPECTOR_NOT_LICENSED,
  DEFAULT_DENIALS_LIMIT,
  DEFAULT_SPAN_EVALUATIONS_LIMIT,
  DERIVED_POLICIES_UNAVAILABLE,
  IAM_DENIED_EVENT_NAME,
  IAM_ERROR_EVENT_NAME,
  LICENSE_HIDES_IAM,
  MAX_DENIALS_LIMIT,
  MAX_SPAN_EVALUATIONS_LIMIT,
  NOTHING_RECORDED,
  eventPolicyError,
  iamErrorsSuppressed,
  newestSpanEnd,
  renderErrorBody,
  renderEventPolicy,
  renderIamMode,
  renderNoIamEvaluation,
  spanStoreFull,
} from "../lib/iam/iam-actions.logic";

export const schema = {
  action: z
    .enum([
      "list-denials",
      "explain-denial",
      "get-event-policy",
      "get-derived-policies",
      "get-enforcement",
    ])
    .describe(
      "Read-only IAM diagnosis in LocalStack (AccessDenied, permission errors, a request into another account, least privilege). " +
        "Workflow: list-denials, then explain-denial with an event_id for the policies that decided and LocalStack's suggested fix; fix the project's IaC, redeploy, re-run the workload, then list-denials with newer_than (the token from the first call's footer) to see only new denials. " +
        "get-event-policy fetches a policy an event stored truncated. get-derived-policies lists the least-privilege policies LocalStack derived from the requests it saw. get-enforcement reads the IAM mode. " +
        "Changes (IAM mode, resetting derived policies) are in localstack-iam-management."
    ),
  event_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "explain-denial, get-event-policy: the Event ID of a row of list-denials. explain-denial takes event_id or span_id, not both."
    ),
  span_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "explain-denial only: explain every IAM evaluation of this span (allowed ones too), instead of one event_id."
    ),
  policy_key: z
    .string()
    .trim()
    .optional()
    .describe(
      "get-event-policy only: key of a policy in the event (e.g. p2), as explain-denial names it."
    ),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      "explain-denial only. summary (default): the deciding policies and LocalStack's suggested statements verbatim. full: also the whole event payload as LocalStack sent it."
    ),
  arn: z
    .string()
    .optional()
    .describe(
      "get-derived-policies only: return the policy of exactly this ARN (as listed without arn). This value is not sent to analytics."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `list-denials: rows per page (default ${DEFAULT_DENIALS_LIMIT}, max ${MAX_DENIALS_LIMIT}). explain-denial with span_id: evaluations per page (default ${DEFAULT_SPAN_EVALUATIONS_LIMIT}, max ${MAX_SPAN_EVALUATIONS_LIMIT}).`
    ),
  pagination_token: z
    .string()
    .optional()
    .describe(
      "list-denials: older rows (the token after 'Older rows'). explain-denial with span_id: more evaluations."
    ),
  newer_than: z
    .string()
    .optional()
    .describe(
      "list-denials only: the newer_than token from a first page's footer; returns only denials recorded after that call. Not a time and not a pagination_token. list-denials has no trace or time filter."
    ),
};

export type IamArgs = InferSchema<typeof schema>;

export const metadata: ToolMetadata = {
  name: "localstack-iam",
  description:
    "Why LocalStack denied a request (AccessDenied, permission errors, cross-account access), which policies decided it, LocalStack's suggested least-privilege fix, the policies LocalStack derived from a run, and the IAM mode. Read-only; reads App Inspector's recorded IAM evaluations. Changes go through localstack-iam-management.",
  annotations: {
    title: "LocalStack IAM",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

type Action = IamArgs["action"];
type Param = Exclude<keyof IamArgs, "action">;

/** The parameters each action takes. xmcp drops undeclared keys; declared ones for another action are rejected. */
const ACTION_PARAMS: Record<Action, Param[]> = {
  "list-denials": ["limit", "pagination_token", "newer_than"],
  "explain-denial": ["event_id", "span_id", "detail", "limit", "pagination_token"],
  "get-event-policy": ["event_id", "policy_key"],
  "get-derived-policies": ["arn"],
  "get-enforcement": [],
};

const REQUIRED_FEATURE: Record<Action, ProFeature | undefined> = {
  "list-denials": ProFeature.APP_INSPECTOR,
  "explain-denial": ProFeature.APP_INSPECTOR,
  "get-event-policy": ProFeature.APP_INSPECTOR,
  // Task 1.2: a real license lists `localstack.platform.plugin/iam-stream`, so it gates the derived policies.
  "get-derived-policies": ProFeature.IAM_STREAM,
  "get-enforcement": ProFeature.IAM_ENFORCEMENT,
};

export default async function localstackIam(params: IamArgs) {
  return withToolAnalytics("localstack-iam", buildIamAnalyticsArgs(params), async () => {
    const invalid = validateParams(params);
    if (invalid) return invalid;
    const preflightError = await runPreflights([requireAuthToken(), requireLocalStackRunning()]);
    if (preflightError) return preflightError;
    const feature = REQUIRED_FEATURE[params.action];
    if (feature) {
      const license = await checkProFeature(feature);
      if (!license.isSupported) {
        return ResponseBuilder.error(
          "Feature Not Available",
          feature === ProFeature.APP_INSPECTOR
            ? APP_INSPECTOR_NOT_LICENSED
            : (license.errorMessage ?? "Not licensed.")
        );
      }
    }
    const client = new AppInspectorApiClient();
    switch (params.action) {
      case "list-denials":
        return await handleListDenials(client, params);
      case "explain-denial":
        return await handleExplainDenial(client, params);
      case "get-event-policy":
        return await handleGetEventPolicy(client, params);
      case "get-derived-policies":
        return await handleGetDerivedPolicies(params);
      case "get-enforcement":
        return await handleGetEnforcement();
      default:
        return ResponseBuilder.error("Unknown action", `Unknown action: ${params.action}`);
    }
  });
}

export function validateParams(params: IamArgs) {
  const allowed = new Set<Param>(ACTION_PARAMS[params.action]);
  for (const key of Object.keys(params) as Array<keyof IamArgs>) {
    if (key === "action" || params[key] === undefined) continue;
    if (!allowed.has(key)) {
      const owners = (Object.keys(ACTION_PARAMS) as Action[]).filter((a) =>
        ACTION_PARAMS[a].includes(key)
      );
      return ResponseBuilder.error(
        "Invalid Parameter",
        `\`${key}\` is not a parameter of ${params.action}; it belongs to ${owners.map((a) => `\`${a}\``).join(", ")}.`
      );
    }
  }
  if (params.action === "list-denials") {
    if (params.pagination_token && params.newer_than) {
      return ResponseBuilder.error(
        "Invalid Parameters",
        "Pass `pagination_token` (older rows) or `newer_than` (new denials), not both."
      );
    }
    if (params.limit !== undefined && params.limit > MAX_DENIALS_LIMIT) {
      return ResponseBuilder.error(
        "Invalid Parameter",
        `\`limit\` for list-denials is at most ${MAX_DENIALS_LIMIT}.`
      );
    }
  }
  if (params.action === "explain-denial") {
    if (params.event_id && params.span_id) {
      return ResponseBuilder.error(
        "Invalid Parameters",
        "explain-denial takes `event_id` or `span_id`, not both."
      );
    }
    if (!params.event_id && !params.span_id) {
      return ResponseBuilder.error(
        "Missing Parameter",
        "explain-denial needs `event_id` (from list-denials) or `span_id`."
      );
    }
    if (params.event_id && (params.limit !== undefined || params.pagination_token)) {
      return ResponseBuilder.error(
        "Invalid Parameters",
        "`limit` and `pagination_token` apply to explain-denial with `span_id` only."
      );
    }
    if (params.limit !== undefined && params.limit > MAX_SPAN_EVALUATIONS_LIMIT) {
      return ResponseBuilder.error(
        "Invalid Parameter",
        `\`limit\` for explain-denial is at most ${MAX_SPAN_EVALUATIONS_LIMIT}.`
      );
    }
  }
  if (params.action === "get-event-policy" && (!params.event_id || !params.policy_key)) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`event_id` and `policy_key` are required for get-event-policy (explain-denial names both)."
    );
  }
  return null;
}

// ─── Probes ──────────────────────────────────────────────────────────────────

interface SpanProbe {
  suppressed: boolean;
  recorded: boolean;
  newest?: number | string;
  storeFull: boolean;
}

/** One span from the store: licence suppression, whether anything is recorded, the newest request, store fill */
async function probeSpans(client: AppInspectorApiClient): Promise<SpanProbe | undefined> {
  const spans = await client.listSpans("*", { limit: 1 });
  if (!spans.success) return undefined;
  const list = (spans.data?.spans ?? []) as unknown[];
  return {
    suppressed: iamErrorsSuppressed(spans.data),
    recorded: list.length > 0,
    newest: newestSpanEnd(spans.data),
    storeFull: spanStoreFull(spans.data),
  };
}

/** The IAM mode, or null when the license does not show it (`/_aws/iam/config` needs IAM enforcement) */
async function readIamMode(): Promise<string | null | undefined> {
  const license = await checkProFeature(ProFeature.IAM_ENFORCEMENT);
  if (!license.isSupported) return null;
  const config = await new IamApiClient().getConfig();
  return config.success ? (config.data?.state ?? undefined) : undefined;
}

async function countEvaluationErrors(client: AppInspectorApiClient): Promise<number | undefined> {
  const result = await client.listIamEvents("*", "*", { limit: 1, name: IAM_ERROR_EVENT_NAME });
  if (!result.success) return undefined;
  const total = result.data?.pagination?.total_count;
  return typeof total === "number" ? total : undefined;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function handleListDenials(client: AppInspectorApiClient, params: IamArgs) {
  const result = await client.listIamEvents("*", "*", {
    limit: params.limit ?? DEFAULT_DENIALS_LIMIT,
    pagination_token: params.newer_than ?? params.pagination_token,
    name: IAM_DENIED_EVENT_NAME,
  });
  if (!result.success) return formatEventsError(result);
  const events = extractEvents(result.data).map(decodeIamEvent);
  const [probe, iamMode, evaluationErrors] = await Promise.all([
    probeSpans(client),
    readIamMode(),
    countEvaluationErrors(client),
  ]);
  let response = renderDenialList(events, {
    pagination: result.data?.pagination,
    newerThan: params.newer_than,
    olderPage: Boolean(params.pagination_token),
    iamMode,
    newestRequestNanos: probe?.newest,
    evaluationErrors,
    storeFull: probe?.storeFull,
  });
  if (events.length === 0 && probe?.suppressed) response += `\n\n${LICENSE_HIDES_IAM}`;
  else if (events.length === 0 && probe && !probe.recorded) response += `\n\n${NOTHING_RECORDED}`;
  return ResponseBuilder.markdown(response);
}

async function handleExplainDenial(client: AppInspectorApiClient, params: IamArgs) {
  const spanId = params.span_id ?? "*";
  const query = params.event_id
    ? { event_id: params.event_id }
    : {
        limit: params.limit ?? DEFAULT_SPAN_EVALUATIONS_LIMIT,
        pagination_token: params.pagination_token,
      };
  const result = await client.listIamEvents("*", spanId, query);
  if (!result.success) return formatEventsError(result);
  const events = extractEvents(result.data).map(decodeIamEvent);
  if (events.length === 0) {
    // Licence suppression and an empty store come before "unknown event"
    const probe = await probeSpans(client);
    if (probe?.suppressed)
      return ResponseBuilder.markdown(`## IAM Evaluation\n\n${LICENSE_HIDES_IAM}`);
    if (probe && !probe.recorded) {
      return ResponseBuilder.markdown(`## IAM Evaluation\n\n${NOTHING_RECORDED}`);
    }
    const message = renderNoIamEvaluation({ eventId: params.event_id, spanId: params.span_id });
    return params.event_id
      ? ResponseBuilder.error("IAM Event Not Found", message.replace(/^## IAM Evaluation\n\n/, ""))
      : ResponseBuilder.markdown(message);
  }
  const detail = params.detail ?? "summary";
  const compactPayload = events.length > 1;
  let response = events
    .map((event) => renderExplanation(event, { compactPayload, detail }))
    .join("\n\n---\n\n");
  const pagination = result.data?.pagination;
  if (params.span_id && pagination?.has_next === true && pagination.next_cursor) {
    response += `\n\n**More IAM evaluations in this span** (${events.length} shown): call \`explain-denial\` again with \`pagination_token\` ${codeSpan(pagination.next_cursor)}.`;
  }
  if (detail === "summary") {
    response +=
      "\n\nFor the whole event payload as LocalStack sent it, call again with `detail` `full`.";
  }
  response += `\n\n${DATA_NOTE}`;
  return ResponseBuilder.markdown(response);
}

async function handleGetEventPolicy(client: AppInspectorApiClient, params: IamArgs) {
  const result = await client.getEventPolicy(params.event_id!, params.policy_key!);
  if (!result.success) {
    const known = eventPolicyError(result.message);
    if (known) return ResponseBuilder.error(`Policy Not Available (${known.code})`, known.message);
    return formatEventsError(result);
  }
  return ResponseBuilder.markdown(
    renderEventPolicy(params.event_id!, params.policy_key!, result.data?.documents)
  );
}

async function handleGetDerivedPolicies(params: IamArgs) {
  const result = await new IamApiClient().getPolicySummary();
  if (!result.success) {
    if (result.statusCode === 404) {
      return ResponseBuilder.error(
        "Derived IAM Policies Not Available",
        DERIVED_POLICIES_UNAVAILABLE
      );
    }
    return ResponseBuilder.error(
      result.statusCode ? `HTTP ${result.statusCode}` : "IAM API Error",
      renderErrorBody(result.message)
    );
  }
  let data: unknown = result.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return ResponseBuilder.error(
        "Unexpected Derived IAM Policies",
        "LocalStack returned derived policies that are not JSON."
      );
    }
  }
  const iamMode = Array.isArray(data) && data.length === 0 ? await readIamMode() : undefined;
  return ResponseBuilder.markdown(renderDerivedPolicies(data, { arn: params.arn, iamMode }));
}

async function handleGetEnforcement() {
  const result = await new IamApiClient().getConfig();
  if (!result.success) return formatIamConfigError(result);
  return ResponseBuilder.markdown(renderIamMode(result.data?.state ?? "UNKNOWN"));
}

export function buildIamAnalyticsArgs(params: IamArgs) {
  return {
    action: params.action,
    has_event_id: Boolean(params.event_id),
    has_span_id: Boolean(params.span_id),
    has_policy_key: Boolean(params.policy_key),
    has_arn: Boolean(params.arn),
    detail: params.detail,
    limit: params.limit,
    has_pagination_token: Boolean(params.pagination_token),
    has_newer_than: Boolean(params.newer_than),
  };
}
