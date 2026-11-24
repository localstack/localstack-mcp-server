import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireAuthToken, requireLocalStackRunning } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature, checkProFeature } from "../lib/localstack/license-checker";
import {
  AppInspectorApiClient,
  IamApiClient,
  type ApiResult,
  type AppInspectorQuery,
} from "../lib/localstack/localstack.client";
import {
  DATA_NOTE,
  NEWER_THAN_PREFIX,
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
  IAM_MODES,
  LICENSE_HIDES_IAM,
  MAX_DENIALS_LIMIT,
  MAX_SPAN_EVALUATIONS_LIMIT,
  NOTHING_RECORDED,
  eventPolicyError,
  iamErrorsSuppressed,
  newestSpanEnd,
  renderEnforcementChange,
  renderEnforcementUnchanged,
  renderErrorBody,
  renderEventPolicy,
  renderIamMode,
  renderNoIamEvaluation,
  spanStoreFull,
} from "../lib/iam/iam-actions.logic";
import { formatEventsError, formatIamConfigError } from "../lib/iam/iam-errors";

export const schema = {
  action: z
    .enum([
      "get-status",
      "set-status",
      "list-traces",
      "get-trace",
      "delete-traces",
      "list-spans",
      "get-span",
      "delete-spans",
      "list-events",
      "get-event",
      "list-iam-events",
      "list-iam-denials",
      "explain-iam",
      "get-iam-policy",
      "get-auto-derived-iam-policies",
      "reset-auto-derived-iam-policies",
      "get-iam-mode",
      "set-iam-mode",
    ])
    .describe(
      "The App Inspector action to perform. Debugging flow: get-status, set-status to enabled if needed, run the AWS workload, list-traces, list-spans for a trace, then list-events for a span. " +
        "IAM flow (AccessDenied, permission errors, a request into another account): list-iam-denials, then explain-iam with an event_id for the policies that decided and LocalStack's suggested fix; fix the project's IaC, redeploy, re-run the workload, then list-iam-denials with newer_than (from the first call's footer) for new denials only. get-iam-policy fetches a policy an event stored truncated. get-iam-mode / set-iam-mode read and set the IAM mode (set-iam-mode reports the previous mode and how to restore it). " +
        "Least-privilege policies: reset-auto-derived-iam-policies (clears the auto-derived policies of every principal in this LocalStack; cannot be undone), run the workload, then get-auto-derived-iam-policies (without arn: the ARNs; with arn: that policy). " +
        "Actions that change LocalStack: set-status, delete-traces, delete-spans, set-iam-mode, reset-auto-derived-iam-policies; all others only read."
    ),
  status: z
    .enum(["enabled", "disabled"])
    .optional()
    .describe(
      "Status to set. Required for set-status. Use enabled before running a workload you want to inspect. Disabling App Inspector and enabling it again deletes the recorded traces and denials, unless LocalStack's persistence is on."
    ),
  trace_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Trace ID. Required for get-trace, list-spans, get-span, delete-spans, list-events, get-event, and list-iam-events. For list-spans/list-events/list-iam-events, use '*' to query across all traces. Not used by the IAM actions: list-iam-denials has no trace or time filter (use newer_than)."
    ),
  span_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Span ID. Required for get-span, list-events, get-event, and list-iam-events. For list-events/list-iam-events, use '*' to query across all spans. For explain-iam, instead of event_id: every IAM evaluation of the span."
    ),
  event_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Event ID. Required for get-event and get-iam-policy. For explain-iam, the event_id of a row of list-iam-denials."
    ),
  policy_key: z
    .string()
    .trim()
    .optional()
    .describe(
      "Key of a policy in an IAM event's `policies` (e.g. p2), as explain-iam names it. Required for get-iam-policy."
    ),
  mode: z
    .enum(IAM_MODES)
    .optional()
    .describe(
      "IAM enforcement mode, required for set-iam-mode. ENFORCED: denied requests fail, as on AWS. SOFT_MODE: they are allowed and logged. ENGINE_ONLY: evaluated without rejecting or logging; App Inspector still records denials. DISABLED: nothing is evaluated or recorded. Lowering the mode fixes no policy."
    ),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      "explain-iam only. summary (default): the deciding policies and LocalStack's suggested statements verbatim. full: also the whole event payload as LocalStack sent it."
    ),
  newer_than: z
    .string()
    .optional()
    .describe(
      "list-iam-denials only: the newer_than token from a first page's footer; returns only denials recorded after that call. Not a time and not a pagination_token."
    ),
  trace_ids: z
    .array(z.string())
    .optional()
    .describe("Trace IDs to delete for delete-traces. Omit to delete all traces."),
  span_ids: z
    .array(z.string())
    .optional()
    .describe("Span IDs to delete for delete-spans. Omit to delete all spans in the trace scope."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      `Maximum number of results to return (1-1000). list-iam-denials: default ${DEFAULT_DENIALS_LIMIT}, max ${MAX_DENIALS_LIMIT}. explain-iam with span_id: default ${DEFAULT_SPAN_EVALUATIONS_LIMIT}, max ${MAX_SPAN_EVALUATIONS_LIMIT}.`
    ),
  pagination_token: z.string().optional().describe("Pagination cursor from a previous response"),
  service_name: z
    .string()
    .optional()
    .describe("Filter traces or spans by AWS service name, e.g. lambda, s3, sqs."),
  region: z.string().optional().describe("Filter by AWS region (e.g., 'us-east-1')"),
  account_id: z
    .string()
    .optional()
    .describe("Filter traces or spans by LocalStack AWS account ID."),
  operation_name: z.string().optional().describe("Filter by operation name (e.g., 'CreateBucket')"),
  resource_name: z.string().optional().describe("Filter by resource name"),
  arn: z
    .string()
    .optional()
    .describe(
      "Filter traces or spans by resource ARN. For get-auto-derived-iam-policies, return the policy of exactly this ARN (as listed without arn). This value is not sent to analytics."
    ),
  parent_span_id: z.string().optional().describe("Filter traces or spans by parent span ID."),
  status_code: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Filter traces or spans by status code."),
  start_time_unix_nano: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Filter traces or spans by start timestamp in Unix nanoseconds."),
  end_time_unix_nano: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Filter traces or spans by end timestamp in Unix nanoseconds."),
  version: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Filter traces or spans by App Inspector schema version."),
  event_name: z.string().optional().describe("Filter events by event name."),
  event_type: z
    .string()
    .optional()
    .describe("Filter events by event type, e.g. iam.policy_evaluation."),
};

export type AppInspectorArgs = InferSchema<typeof schema>;

export const metadata: ToolMetadata = {
  name: "localstack-app-inspector",
  description:
    "Query and manage App Inspector traces, spans, and events to review deployed LocalStack applications. Also the place for IAM: why a request was denied, which policies decided it, LocalStack's suggested fix, the least-privilege policies derived from a run, and the IAM enforcement mode.",
  annotations: {
    title: "LocalStack App Inspector",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function localstackAppInspector(raw: AppInspectorArgs) {
  const { action } = raw;
  // Empty strings and lists count as absent for the IAM actions, so every check, handler and analytics see one value
  const params = IAM_ACTIONS.has(action) ? withoutEmptyValues(raw) : raw;
  return withToolAnalytics(
    "localstack-app-inspector",
    buildAppInspectorAnalyticsArgs(params),
    async () => {
      const invalid = validateIamParams(params);
      if (invalid) return invalid;
      const preflightError = await runPreflights([requireAuthToken(), requireLocalStackRunning()]);
      if (preflightError) return preflightError;
      const feature = requiredFeature(action);
      const license = await checkProFeature(feature);
      if (!license.isSupported) {
        return ResponseBuilder.error(
          "Feature Not Available",
          feature === ProFeature.APP_INSPECTOR && IAM_ACTIONS.has(action)
            ? APP_INSPECTOR_NOT_LICENSED
            : (license.errorMessage ?? "Not licensed.")
        );
      }

      const client = new AppInspectorApiClient();

      switch (action) {
        case "get-status":
          return await handleGetStatus(client);
        case "set-status":
          return await handleSetStatus(client, params);
        case "list-traces":
          return await handleListTraces(client, params);
        case "get-trace":
          return await handleGetTrace(client, params);
        case "delete-traces":
          return await handleDeleteTraces(client, params);
        case "list-spans":
          return await handleListSpans(client, params);
        case "get-span":
          return await handleGetSpan(client, params);
        case "delete-spans":
          return await handleDeleteSpans(client, params);
        case "list-events":
          return await handleListEvents(client, params);
        case "get-event":
          return await handleGetEvent(client, params);
        case "list-iam-events":
          return await handleListIamEvents(client, params);
        case "list-iam-denials":
          return await handleListDenials(client, params);
        case "explain-iam":
          return await handleExplainDenial(client, params);
        case "get-iam-policy":
          return await handleGetEventPolicy(client, params);
        case "get-auto-derived-iam-policies":
          return await handleGetDerivedPolicies(params);
        case "reset-auto-derived-iam-policies":
          return await handleResetDerivedPolicies();
        case "get-iam-mode":
          return await handleGetEnforcement();
        case "set-iam-mode":
          return await handleSetEnforcement(params);
        default:
          return ResponseBuilder.error("Unknown action", `Unknown action: ${action}`);
      }
    }
  );
}

/** The IAM actions and the parameters each takes. A declared parameter of another action is rejected (xmcp drops undeclared ones). */
const IAM_ACTION_PARAMS: Record<string, Array<keyof AppInspectorArgs>> = {
  "list-iam-denials": ["limit", "pagination_token", "newer_than"],
  "explain-iam": ["event_id", "span_id", "detail", "limit", "pagination_token"],
  "get-iam-policy": ["event_id", "policy_key"],
  "get-auto-derived-iam-policies": ["arn"],
  "reset-auto-derived-iam-policies": [],
  "get-iam-mode": [],
  "set-iam-mode": ["mode"],
};
const IAM_ACTIONS = new Set(Object.keys(IAM_ACTION_PARAMS));

/**
 * The IAM mode is an IAM enforcement feature and the auto-derived policies an IAM Policy Stream one (`/_aws/iam`), not
 * App Inspector ones: a license without App Inspector can use them, as it could through the analyzer.
 */
function requiredFeature(action: AppInspectorArgs["action"]): ProFeature {
  switch (action) {
    case "get-iam-mode":
    case "set-iam-mode":
      return ProFeature.IAM_ENFORCEMENT;
    case "get-auto-derived-iam-policies":
    case "reset-auto-derived-iam-policies":
      return ProFeature.IAM_STREAM;
    default:
      return ProFeature.APP_INSPECTOR;
  }
}

/** The parameters without empty strings and empty lists, which some clients send for unset optional fields */
export function withoutEmptyValues(params: AppInspectorArgs): AppInspectorArgs {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== "" && !(Array.isArray(value) && value.length === 0)
    )
  ) as AppInspectorArgs;
}

export function validateIamParams(params: AppInspectorArgs) {
  const allowed = IAM_ACTION_PARAMS[params.action];
  if (!allowed) return null;
  for (const key of Object.keys(params) as Array<keyof AppInspectorArgs>) {
    const value = params[key];
    // Empty values are also skipped here for direct callers; the handler has already removed them
    if (
      key === "action" ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      allowed.includes(key)
    )
      continue;
    const owners = Object.entries(IAM_ACTION_PARAMS)
      .filter(([, keys]) => keys.includes(key))
      .map(([name]) => `\`${name}\``);
    return ResponseBuilder.error(
      "Invalid Parameter",
      `\`${key}\` is not a parameter of ${params.action}${owners.length ? `; it belongs to ${owners.join(", ")}` : ""}.`
    );
  }
  switch (params.action) {
    case "list-iam-denials":
      if (params.pagination_token && params.newer_than) {
        return ResponseBuilder.error(
          "Invalid Parameters",
          "Pass `pagination_token` (older rows) or `newer_than` (new denials), not both."
        );
      }
      // A swapped cursor would list older denials as new: LocalStack encodes the direction inside it
      if (
        params.newer_than !== undefined &&
        (!params.newer_than.startsWith(NEWER_THAN_PREFIX) ||
          params.newer_than.length === NEWER_THAN_PREFIX.length)
      ) {
        return ResponseBuilder.error(
          "Cursor Not Usable",
          `\`newer_than\` takes the value printed after "newer_than" in a first page's footer (it starts with \`${NEWER_THAN_PREFIX}\`), not a \`pagination_token\` or a time.`
        );
      }
      if (params.pagination_token?.startsWith(NEWER_THAN_PREFIX)) {
        return ResponseBuilder.error(
          "Cursor Not Usable",
          "This is a `newer_than` value: pass it as `newer_than`, not as `pagination_token`."
        );
      }
      if (params.limit !== undefined && params.limit > MAX_DENIALS_LIMIT) {
        return ResponseBuilder.error(
          "Invalid Parameter",
          `\`limit\` for list-iam-denials is at most ${MAX_DENIALS_LIMIT}.`
        );
      }
      break;
    case "explain-iam":
      if (params.pagination_token?.startsWith(NEWER_THAN_PREFIX)) {
        return ResponseBuilder.error(
          "Cursor Not Usable",
          "This is a `newer_than` value of list-iam-denials, not a `pagination_token` of explain-iam."
        );
      }
      if (params.event_id && params.span_id) {
        return ResponseBuilder.error(
          "Invalid Parameters",
          "explain-iam takes `event_id` or `span_id`, not both."
        );
      }
      if (!params.event_id && !params.span_id) {
        return ResponseBuilder.error(
          "Missing Parameter",
          "explain-iam needs `event_id` (from list-iam-denials) or `span_id`."
        );
      }
      if (params.event_id && (params.limit !== undefined || params.pagination_token)) {
        return ResponseBuilder.error(
          "Invalid Parameters",
          "`limit` and `pagination_token` apply to explain-iam with `span_id` only."
        );
      }
      if (params.limit !== undefined && params.limit > MAX_SPAN_EVALUATIONS_LIMIT) {
        return ResponseBuilder.error(
          "Invalid Parameter",
          `\`limit\` for explain-iam is at most ${MAX_SPAN_EVALUATIONS_LIMIT}.`
        );
      }
      break;
    case "get-iam-policy":
      if (!params.event_id || !params.policy_key) {
        return ResponseBuilder.error(
          "Missing Parameter",
          "`event_id` and `policy_key` are required for get-iam-policy (explain-iam names both)."
        );
      }
      break;
    case "set-iam-mode":
      if (!params.mode) {
        return ResponseBuilder.error(
          "Missing Parameter",
          `\`mode\` is required for set-iam-mode (${IAM_MODES.join(", ")}).`
        );
      }
      break;
  }
  return null;
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function handleGetStatus(client: AppInspectorApiClient) {
  const result = await client.getStatus();
  if (!result.success) return formatAppInspectorApiError(result);

  let response = `## App Inspector Status\n\n**Status:** ${result.data.status}`;
  if (result.data.note) response += `\n\n${result.data.note}`;
  return ResponseBuilder.markdown(response);
}

async function handleSetStatus(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.status) {
    return ResponseBuilder.error(
      "Missing Parameter",
      '`status` is required for set-status ("enabled" or "disabled")'
    );
  }
  const result = await client.setStatus(params.status);
  if (!result.success) return formatAppInspectorApiError(result);

  let changed = result.data.changed ? "Status changed." : "Status was already set.";
  if (result.data.changed && params.status === "disabled") {
    changed +=
      " Enabling App Inspector again deletes what it recorded so far, unless LocalStack's persistence is on.";
  }
  return ResponseBuilder.markdown(
    `## App Inspector Status Updated\n\n**Status:** ${result.data.status}\n\n${changed}`
  );
}

// ─── Traces ──────────────────────────────────────────────────────────────────

async function handleListTraces(client: AppInspectorApiClient, params: AppInspectorArgs) {
  const result = await client.listTraces(buildTraceFilters(params));
  if (!result.success) return formatAppInspectorApiError(result);
  return ResponseBuilder.markdown(formatTraceList(result.data));
}

async function handleGetTrace(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id) {
    return ResponseBuilder.error("Missing Parameter", "`trace_id` is required for get-trace");
  }
  const result = await client.getTrace(params.trace_id);
  if (!result.success) return formatAppInspectorApiError(result);

  return ResponseBuilder.markdown(
    `## Trace: ${params.trace_id}\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
  );
}

async function handleDeleteTraces(client: AppInspectorApiClient, params: AppInspectorArgs) {
  const result = await client.deleteTraces(params.trace_ids);
  if (!result.success) return formatAppInspectorApiError(result);

  const scope = params.trace_ids ? `${params.trace_ids.length} trace(s)` : "all traces";
  return ResponseBuilder.markdown(
    `## Traces Deleted\n\nDeleted ${result.data.deleted_count} trace(s) (requested: ${scope}).`
  );
}

// ─── Spans ───────────────────────────────────────────────────────────────────

async function handleListSpans(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id) {
    return ResponseBuilder.error("Missing Parameter", "`trace_id` is required for list-spans");
  }
  const result = await client.listSpans(params.trace_id, buildSpanFilters(params));
  if (!result.success) return formatAppInspectorApiError(result);
  return ResponseBuilder.markdown(formatSpanList(result.data, params.trace_id));
}

async function handleGetSpan(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id || !params.span_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id` and `span_id` are required for get-span"
    );
  }
  const result = await client.getSpan(params.trace_id, params.span_id);
  if (!result.success) return formatAppInspectorApiError(result);

  return ResponseBuilder.markdown(
    `## Span: ${params.span_id}\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
  );
}

async function handleDeleteSpans(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id) {
    return ResponseBuilder.error("Missing Parameter", "`trace_id` is required for delete-spans");
  }
  const result = await client.deleteSpans(params.trace_id, params.span_ids);
  if (!result.success) return formatAppInspectorApiError(result);

  const scope = params.span_ids ? `${params.span_ids.length} span(s)` : "all spans in trace";
  return ResponseBuilder.markdown(
    `## Spans Deleted\n\nDeleted ${result.data.deleted_count} span(s) (requested: ${scope}).`
  );
}

// ─── Events ──────────────────────────────────────────────────────────────────

async function handleListEvents(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id || !params.span_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id` and `span_id` are required for list-events"
    );
  }
  const result = await client.listEvents(
    params.trace_id,
    params.span_id,
    buildEventFilters(params)
  );
  if (!result.success) return formatAppInspectorApiError(result);
  return ResponseBuilder.markdown(formatEventList(result.data, params.span_id));
}

async function handleGetEvent(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id || !params.span_id || !params.event_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id`, `span_id`, and `event_id` are required for get-event"
    );
  }
  const result = await client.getEvent(params.trace_id, params.span_id, params.event_id);
  if (!result.success) return formatAppInspectorApiError(result);

  return ResponseBuilder.markdown(
    `## Event: ${params.event_id}\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
  );
}

async function handleListIamEvents(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.trace_id || !params.span_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id` and `span_id` are required for list-iam-events"
    );
  }
  const result = await client.listIamEvents(
    params.trace_id,
    params.span_id,
    buildEventFilters(params)
  );
  if (!result.success) return formatAppInspectorApiError(result);
  return ResponseBuilder.markdown(
    formatEventList(result.data, params.span_id, "IAM Policy Evaluation ")
  );
}

// ─── IAM ─────────────────────────────────────────────────────────────────────

// IAM probes ──────────────────────────────────────────────────────────────────

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

async function handleListDenials(client: AppInspectorApiClient, params: AppInspectorArgs) {
  const result = await client.listIamEvents("*", "*", {
    limit: params.limit ?? DEFAULT_DENIALS_LIMIT,
    pagination_token:
      params.newer_than !== undefined
        ? params.newer_than.slice(NEWER_THAN_PREFIX.length)
        : params.pagination_token,
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

async function handleExplainDenial(client: AppInspectorApiClient, params: AppInspectorArgs) {
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
    response += `\n\n**More IAM evaluations in this span** (${events.length} shown): call \`explain-iam\` again with \`pagination_token\` ${codeSpan(pagination.next_cursor)}.`;
  }
  if (detail === "summary") {
    response +=
      "\n\nFor the whole event payload as LocalStack sent it, call again with `detail` `full`.";
  }
  response += `\n\n${DATA_NOTE}`;
  return ResponseBuilder.markdown(response);
}

async function handleGetEventPolicy(client: AppInspectorApiClient, params: AppInspectorArgs) {
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

async function handleGetDerivedPolicies(params: AppInspectorArgs) {
  const result = await new IamApiClient().getPolicySummary();
  if (!result.success) {
    if (result.statusCode === 404) {
      return ResponseBuilder.error(
        "Auto-derived IAM Policies Not Available",
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
        "Unexpected Auto-derived IAM Policies",
        "LocalStack returned auto-derived policies that are not JSON."
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

async function handleSetEnforcement(params: AppInspectorArgs) {
  const client = new IamApiClient();
  const before = await client.getConfig();
  if (!before.success) return formatIamConfigError(before);
  const old = before.data?.state ?? "UNKNOWN";
  if (old.toUpperCase() === params.mode!) {
    return ResponseBuilder.markdown(renderEnforcementUnchanged(old));
  }
  const result = await client.setMode(params.mode!);
  if (!result.success) return formatIamConfigError(result);
  // Report the mode LocalStack reports now, not the one requested
  const after = await client.getConfig();
  if (!after.success) {
    return ResponseBuilder.markdown(
      `## IAM Enforcement Updated\n\nLocalStack accepted mode ${codeSpan(params.mode)}, but reading it back failed. Use \`get-iam-mode\` to check. To restore: \`set-iam-mode\` with mode ${codeSpan(old)}.`
    );
  }
  return ResponseBuilder.markdown(
    renderEnforcementChange({
      before: old,
      requested: params.mode!,
      after: after.data?.state ?? "UNKNOWN",
    })
  );
}

async function handleResetDerivedPolicies() {
  const result = await new IamApiClient().resetPolicySummary();
  if (!result.success) {
    if (result.statusCode === 404) {
      return ResponseBuilder.error(
        "Auto-derived IAM Policies Not Available",
        DERIVED_POLICIES_UNAVAILABLE
      );
    }
    return ResponseBuilder.error(
      result.statusCode ? `HTTP ${result.statusCode}` : "IAM API Error",
      renderErrorBody(result.message)
    );
  }
  return ResponseBuilder.markdown(
    "## Auto-derived IAM Policies Reset\n\nCleared the auto-derived policies of every principal in this LocalStack. This cannot be undone; they come back only by re-running the workload.\n\n**Next step:** re-run the workload, then `get-auto-derived-iam-policies`."
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function buildAppInspectorAnalyticsArgs(params: AppInspectorArgs) {
  const filterKeys = Object.entries(buildFilters(params))
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
  return {
    action: params.action,
    target_status: params.action === "set-status" ? params.status : undefined,
    has_trace_id: Boolean(params.trace_id),
    has_span_id: Boolean(params.span_id),
    has_event_id: Boolean(params.event_id),
    has_policy_key: Boolean(params.policy_key),
    mode: params.action === "set-iam-mode" ? params.mode : undefined,
    detail: params.detail,
    has_newer_than: Boolean(params.newer_than),
    trace_ids_count: params.trace_ids?.length,
    span_ids_count: params.span_ids?.length,
    limit: params.limit,
    has_pagination_token: Boolean(params.pagination_token),
    filter_keys: filterKeys.length ? filterKeys.join(",") : undefined,
  };
}

export function formatAppInspectorApiError(result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected App Inspector Result");

  if (result.statusCode === 403 || result.statusCode === 503) {
    return ResponseBuilder.error(
      "App Inspector Disabled",
      'App Inspector is not enabled. Use the `set-status` action with `status: "enabled"` to turn it on.'
    );
  }
  return ResponseBuilder.error(
    result.statusCode ? `HTTP ${result.statusCode}` : "App Inspector API Error",
    renderErrorBody(result.message)
  );
}

function buildFilters(params: AppInspectorArgs): AppInspectorQuery {
  return {
    limit: params.limit,
    pagination_token: params.pagination_token,
    trace_id: params.trace_id,
    span_id: params.span_id,
    event_id: params.event_id,
    service_name: params.service_name,
    region: params.region,
    account_id: params.account_id,
    operation_name: params.operation_name,
    resource_name: params.resource_name,
    arn: params.arn,
    parent_span_id: params.parent_span_id,
    status_code: params.status_code,
    start_time_unix_nano: params.start_time_unix_nano,
    end_time_unix_nano: params.end_time_unix_nano,
    version: params.version,
    name: params.event_name,
    event_type: params.event_type,
  };
}

function buildTraceFilters(params: AppInspectorArgs): AppInspectorQuery {
  return {
    limit: params.limit,
    pagination_token: params.pagination_token,
    trace_id: params.trace_id,
    parent_span_id: params.parent_span_id,
    service_name: params.service_name,
    region: params.region,
    account_id: params.account_id,
    operation_name: params.operation_name,
    resource_name: params.resource_name,
    arn: params.arn,
    status_code: params.status_code,
    start_time_unix_nano: params.start_time_unix_nano,
    end_time_unix_nano: params.end_time_unix_nano,
    version: params.version,
  };
}

function buildSpanFilters(params: AppInspectorArgs): AppInspectorQuery {
  return {
    limit: params.limit,
    pagination_token: params.pagination_token,
    span_id: params.span_id,
    parent_span_id: params.parent_span_id,
    service_name: params.service_name,
    region: params.region,
    account_id: params.account_id,
    operation_name: params.operation_name,
    resource_name: params.resource_name,
    arn: params.arn,
    status_code: params.status_code,
    start_time_unix_nano: params.start_time_unix_nano,
    end_time_unix_nano: params.end_time_unix_nano,
    version: params.version,
  };
}

function buildEventFilters(params: AppInspectorArgs): AppInspectorQuery {
  return {
    limit: params.limit,
    pagination_token: params.pagination_token,
    timestamp_unix_nano: params.start_time_unix_nano,
    name: params.event_name,
    event_type: params.event_type,
  };
}

export function buildQueryString(params: AppInspectorQuery): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export function formatTraceList(data: any): string {
  const traces: any[] = data?.traces ?? data ?? [];
  if (!Array.isArray(traces) || traces.length === 0) {
    return "## Traces\n\nNo traces found.";
  }
  const rows = traces
    .map((t: any) => {
      const id = t.trace_id ?? t.id ?? "-";
      const services = t.service_count ?? "-";
      const spans = t.span_count ?? "-";
      const errors = t.error_count ?? "-";
      const status = t.status_code ?? "-";
      const start = t.start_time_unix_nano ? formatNanoTime(t.start_time_unix_nano) : "-";
      return `| ${id} | ${services} | ${spans} | ${errors} | ${status} | ${start} |`;
    })
    .join("\n");

  let result = `## Traces (${traces.length})\n\n`;
  result += `| Trace ID | Services | Spans | Errors | Status | Start Time |\n`;
  result += `|---|---|---|---|---|---|\n`;
  result += rows;

  if (data?.pagination) {
    const p = data.pagination;
    result += `\n\n**Pagination:** Total: ${p.total_count ?? "?"} | Has next: ${p.has_next}`;
    if (p.next_cursor) result += ` | Next cursor: \`${p.next_cursor}\``;
  }
  return result;
}

export function formatSpanList(data: any, traceId: string): string {
  const spans: any[] = data?.spans ?? data ?? [];
  if (!Array.isArray(spans) || spans.length === 0) {
    return `## Spans for Trace \`${traceId}\`\n\nNo spans found.`;
  }
  const rows = spans
    .map((s: any) => {
      const id = s.span_id ?? s.id ?? "-";
      const service = s.service_name ?? "-";
      const operation = s.operation_name ?? "-";
      const status = s.status_code ?? "-";
      const start = s.start_time_unix_nano ? formatNanoTime(s.start_time_unix_nano) : "-";
      return `| ${id} | ${service} | ${operation} | ${status} | ${start} |`;
    })
    .join("\n");

  let result = `## Spans for Trace \`${traceId}\` (${spans.length})\n\n`;
  result += `| Span ID | Service | Operation | Status | Start Time |\n`;
  result += `|---|---|---|---|---|\n`;
  result += rows;

  if (data?.pagination) {
    const p = data.pagination;
    result += `\n\n**Pagination:** Total: ${p.total_count ?? "?"} | Has next: ${p.has_next}`;
    if (p.next_cursor) result += ` | Next cursor: \`${p.next_cursor}\``;
  }
  return result;
}

export function formatEventList(data: any, spanId: string, prefix = ""): string {
  const events: any[] = data?.events ?? data ?? [];
  if (!Array.isArray(events) || events.length === 0) {
    return `## ${prefix}Events for Span \`${spanId}\`\n\nNo events found.`;
  }
  const rows = events
    .map((e: any) => {
      const id = e.event_id ?? e.id ?? "-";
      const name = e.name ?? "-";
      const type = e.event_type ?? "-";
      const ts = e.timestamp_unix_nano ? formatNanoTime(e.timestamp_unix_nano) : "-";
      return `| ${id} | ${name} | ${type} | ${ts} |`;
    })
    .join("\n");

  let result = `## ${prefix}Events for Span \`${spanId}\` (${events.length})\n\n`;
  result += `| Event ID | Name | Type | Timestamp |\n`;
  result += `|---|---|---|---|\n`;
  result += rows;
  return result;
}

function formatNanoTime(nanos: number | string): string {
  const ms = Number(nanos) / 1_000_000;
  return new Date(ms).toISOString();
}
