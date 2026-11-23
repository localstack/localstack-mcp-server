import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  runPreflights,
  requireAuthToken,
  requireLocalStackRunning,
  requireProFeature,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature } from "../lib/localstack/license-checker";
import {
  AppInspectorApiClient,
  IamApiClient,
  type ApiResult,
  type AppInspectorQuery,
} from "../lib/localstack/localstack.client";
import {
  decodeIamEvent,
  extractEvents,
  renderDenialTable,
  renderExplanation,
  renderAutoDerivedPolicies,
  codeSpan,
} from "../lib/iam/iam-explain.logic";
import {
  DEFAULT_DENIALS_LIMIT,
  IAM_CONFIG_UNAVAILABLE,
  IAM_DENIED_EVENT_NAME,
  AUTO_DERIVED_POLICIES_UNAVAILABLE,
  eventPolicyError,
  iamErrorsSuppressed,
  renderEmptyIamNote,
  renderErrorBody,
  renderEventPolicy,
  renderIamMode,
  renderNoIamEvaluation,
} from "../lib/iam/iam-actions.logic";

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
        "IAM flow (AccessDenied, permission errors): with App Inspector enabled (get-status, set-status), run the workload, then list-iam-denials, then explain-iam with an event_id for the policies that decided and LocalStack's suggested fix; get-iam-policy fetches a policy the event stored truncated. LocalStack records denials while App Inspector is enabled, unless the IAM mode is DISABLED (get-iam-mode; SOFT_MODE records without blocking); set-iam-mode ENFORCED only makes denials fail the request as on AWS. " +
        "Least-privilege policies: reset-auto-derived-iam-policies, run the workload, then get-auto-derived-iam-policies for the policies LocalStack derived from the requests it saw."
    ),
  status: z
    .enum(["enabled", "disabled"])
    .optional()
    .describe(
      "Status to set. Required for set-status. Use enabled before running a workload you want to inspect."
    ),
  trace_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Trace ID. Required for get-trace, list-spans, get-span, delete-spans, list-events, get-event, and list-iam-events. For list-spans/list-events/list-iam-events, use '*' to query across all traces. Optional for list-iam-denials (default '*') and explain-iam (with span_id, instead of event_id)."
    ),
  span_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Span ID. Required for get-span, list-events, get-event, and list-iam-events. For list-events/list-iam-events, use '*' to query across all spans. Optional for list-iam-denials (default '*'); with trace_id, explain-iam explains every IAM evaluation of the span."
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
    .enum(["ENFORCED", "SOFT_MODE", "DISABLED"])
    .optional()
    .describe(
      "IAM enforcement mode, required for set-iam-mode. ENFORCED blocks unauthorized requests and records them as denials; SOFT_MODE lets them through and records them; DISABLED turns the IAM engine off, so nothing is evaluated or recorded, even with App Inspector enabled. To see denials without blocking anything, use SOFT_MODE."
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
    .describe("Maximum number of results to return (1-1000)"),
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
      "Filter traces or spans by resource ARN. For get-auto-derived-iam-policies, show only the entry of exactly this ARN. This value is not sent to analytics."
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

export default async function localstackAppInspector(params: AppInspectorArgs) {
  const { action } = params;
  return withToolAnalytics(
    "localstack-app-inspector",
    buildAppInspectorAnalyticsArgs(params),
    async () => {
      const preflightError = await runPreflights([
        requireAuthToken(),
        requireLocalStackRunning(),
        requireProFeature(requiredFeature(action)),
      ]);
      if (preflightError) return preflightError;

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
          return await handleListIamDenials(client, params);
        case "explain-iam":
          return await handleExplainIam(client, params);
        case "get-iam-policy":
          return await handleGetIamPolicy(client, params);
        case "get-auto-derived-iam-policies":
          return await handleGetAutoDerivedIamPolicies(params);
        case "reset-auto-derived-iam-policies":
          return await handleResetAutoDerivedIamPolicies();
        case "get-iam-mode":
          return await handleGetIamMode();
        case "set-iam-mode":
          return await handleSetIamMode(params);
        default:
          return ResponseBuilder.error("Unknown action", `Unknown action: ${action}`);
      }
    }
  );
}

/**
 * The IAM mode and the auto-derived IAM policies (LocalStack's policy summary) are IAM features (`/_aws/iam`), not App Inspector ones: a license with IAM
 * enforcement but without App Inspector can use them, as it could through the analyzer.
 */
const IAM_ONLY_ACTIONS = new Set([
  "get-iam-mode",
  "set-iam-mode",
  "get-auto-derived-iam-policies",
  "reset-auto-derived-iam-policies",
]);

function requiredFeature(action: AppInspectorArgs["action"]): ProFeature {
  return IAM_ONLY_ACTIONS.has(action) ? ProFeature.IAM_ENFORCEMENT : ProFeature.APP_INSPECTOR;
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

  const changed = result.data.changed ? "Status changed." : "Status was already set.";
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

async function handleListIamDenials(client: AppInspectorApiClient, params: AppInspectorArgs) {
  const traceId = params.trace_id || "*";
  const spanId = params.span_id || "*";
  const result = await client.listIamEvents(traceId, spanId, {
    limit: params.limit ?? DEFAULT_DENIALS_LIMIT,
    pagination_token: params.pagination_token,
    name: IAM_DENIED_EVENT_NAME,
  });
  if (!result.success) return formatAppInspectorApiError(result);
  const events = extractEvents(result.data).map(decodeIamEvent);
  let response = renderDenialTable(events, result.data?.pagination);
  if (events.length === 0) response += await explainEmptyIamResult(client, traceId);
  return ResponseBuilder.markdown(response);
}

async function handleExplainIam(client: AppInspectorApiClient, params: AppInspectorArgs) {
  let query: AppInspectorQuery;
  let traceId = "*";
  let spanId = "*";
  if (params.event_id) {
    query = { event_id: params.event_id };
  } else if (params.trace_id && params.span_id) {
    traceId = params.trace_id;
    spanId = params.span_id;
    query = { limit: params.limit ?? 20, pagination_token: params.pagination_token };
  } else {
    return ResponseBuilder.error(
      "Missing Parameter",
      "explain-iam needs `event_id` (from list-iam-denials), or `trace_id` and `span_id`."
    );
  }
  const result = await client.listIamEvents(traceId, spanId, query);
  if (!result.success) return formatAppInspectorApiError(result);
  const events = extractEvents(result.data).map(decodeIamEvent);
  if (events.length === 0) {
    return ResponseBuilder.markdown(
      renderNoIamEvaluation({ eventId: params.event_id, spanId }) +
        (await explainEmptyIamResult(client, traceId))
    );
  }
  const compactPayload = events.length > 1;
  let response = events
    .map((event) => renderExplanation(event, { compactPayload }))
    .join("\n\n---\n\n");
  const pagination = result.data?.pagination;
  const next = pagination?.next_cursor;
  if (!params.event_id && pagination?.has_next === true && next) {
    response += `\n\n**More IAM evaluations in this span:** call \`explain-iam\` again with \`pagination_token\` ${codeSpan(next)}.`;
  }
  return ResponseBuilder.markdown(response);
}

async function handleGetIamPolicy(client: AppInspectorApiClient, params: AppInspectorArgs) {
  if (!params.event_id || !params.policy_key) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`event_id` and `policy_key` are required for get-iam-policy (explain-iam names both)."
    );
  }
  const result = await client.getEventPolicy(params.event_id, params.policy_key);
  if (!result.success) return formatEventPolicyError(result);
  return ResponseBuilder.markdown(
    renderEventPolicy(params.event_id, params.policy_key, result.data?.documents)
  );
}

async function handleGetAutoDerivedIamPolicies(params: AppInspectorArgs) {
  const result = await new IamApiClient().getPolicySummary();
  if (!result.success) return formatAutoDerivedPoliciesError(result);
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
  return ResponseBuilder.markdown(renderAutoDerivedPolicies(data, params.arn));
}

async function handleResetAutoDerivedIamPolicies() {
  const result = await new IamApiClient().resetPolicySummary();
  if (!result.success) return formatAutoDerivedPoliciesError(result);
  return ResponseBuilder.markdown(
    "## Auto-derived IAM Policies Reset\n\nCleared the auto-derived policies. Run the workload, then use `get-auto-derived-iam-policies`."
  );
}

async function handleGetIamMode() {
  const result = await new IamApiClient().getConfig();
  if (!result.success) return formatIamConfigError(result);
  return ResponseBuilder.markdown(renderIamMode(result.data?.state ?? "UNKNOWN"));
}

async function handleSetIamMode(params: AppInspectorArgs) {
  if (!params.mode) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`mode` is required for set-iam-mode (ENFORCED, SOFT_MODE or DISABLED)."
    );
  }
  const client = new IamApiClient();
  const result = await client.setMode(params.mode);
  if (!result.success) return formatIamConfigError(result);
  // Show the mode LocalStack reports now, not the one requested
  const config = await client.getConfig();
  if (!config.success) {
    return ResponseBuilder.markdown(
      `## IAM Enforcement Updated\n\nLocalStack accepted mode ${codeSpan(params.mode)}, but reading it back failed. Use \`get-iam-mode\` to check.`
    );
  }
  return ResponseBuilder.markdown(renderIamMode(config.data?.state ?? "UNKNOWN", true));
}

/**
 * Why an IAM query came back empty. A license without IAM error visibility hides IAM events without saying so; only
 * spans carry `iam_errors_suppressed`, so one span of the scope tells. Otherwise the IAM mode may be off.
 */
async function explainEmptyIamResult(
  client: AppInspectorApiClient,
  traceId: string
): Promise<string> {
  const spans = await client.listSpans(traceId, { limit: 1 });
  if (spans.success && iamErrorsSuppressed(spans.data)) {
    return renderEmptyIamNote({ suppressed: true });
  }
  const config = await new IamApiClient().getConfig();
  return renderEmptyIamNote({
    suppressed: false,
    iamMode: config.success ? (config.data?.state ?? "UNKNOWN") : undefined,
  });
}

function formatEventPolicyError(result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected App Inspector Result");
  const known = eventPolicyError(result.message);
  if (known) return ResponseBuilder.error(`Policy Not Available (${known.code})`, known.message);
  return formatAppInspectorApiError(result);
}

function formatAutoDerivedPoliciesError(result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected Result");
  if (result.statusCode === 404) {
    return ResponseBuilder.error(
      "Auto-derived IAM Policies Not Available",
      AUTO_DERIVED_POLICIES_UNAVAILABLE
    );
  }
  return ResponseBuilder.error(
    result.statusCode ? `HTTP ${result.statusCode}` : "IAM API Error",
    renderErrorBody(result.message)
  );
}

function formatIamConfigError(result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected Result");
  if (result.statusCode === 404) {
    return ResponseBuilder.error("IAM Enforcement Not Available", IAM_CONFIG_UNAVAILABLE);
  }
  return ResponseBuilder.error(
    result.statusCode ? `HTTP ${result.statusCode}` : "IAM API Error",
    renderErrorBody(result.message)
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
