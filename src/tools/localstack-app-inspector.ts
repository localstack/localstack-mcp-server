import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { httpClient, HttpError } from "../core/http-client";
import {
  runPreflights,
  requireAuthToken,
  requireLocalStackRunning,
  requireProFeature,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature } from "../lib/localstack/license-checker";

const API_PREFIX = "/_localstack/appinspector";
const API_V1 = `${API_PREFIX}/v1`;

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
    ])
    .describe(
      "The App Inspector action to perform. Typical debugging flow: get-status, set-status to enabled if needed, run AWS workload, list-traces, list-spans for a trace, then list-events or list-iam-events for a span."
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
      "Trace ID. Required for get-trace, list-spans, get-span, delete-spans, list-events, get-event, and list-iam-events. For list-spans/list-events/list-iam-events, use '*' to query across all traces."
    ),
  span_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Span ID. Required for get-span, list-events, get-event, and list-iam-events. For list-events/list-iam-events, use '*' to query across all spans."
    ),
  event_id: z.string().trim().optional().describe("Event ID. Required for get-event."),
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
    .describe("Filter traces or spans by resource ARN. This value is not sent to analytics."),
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

export const metadata: ToolMetadata = {
  name: "localstack-app-inspector",
  description:
    "Query and manage App Inspector traces, spans, and events to review deployed LocalStack applications",
  annotations: {
    title: "LocalStack App Inspector",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function localstackAppInspector(params: InferSchema<typeof schema>) {
  const { action } = params;
  return withToolAnalytics(
    "localstack-app-inspector",
    buildAppInspectorAnalyticsArgs(params),
    async () => {
      const preflightError = await runPreflights([
        requireAuthToken(),
        requireLocalStackRunning(),
        requireProFeature(ProFeature.APP_INSPECTOR),
      ]);
      if (preflightError) return preflightError;

      try {
        switch (action) {
          case "get-status":
            return await handleGetStatus();
          case "set-status":
            return await handleSetStatus(params);
          case "list-traces":
            return await handleListTraces(params);
          case "get-trace":
            return await handleGetTrace(params);
          case "delete-traces":
            return await handleDeleteTraces(params);
          case "list-spans":
            return await handleListSpans(params);
          case "get-span":
            return await handleGetSpan(params);
          case "delete-spans":
            return await handleDeleteSpans(params);
          case "list-events":
            return await handleListEvents(params);
          case "get-event":
            return await handleGetEvent(params);
          case "list-iam-events":
            return await handleListIamEvents(params);
          default:
            return ResponseBuilder.error("Unknown action", `Unknown action: ${action}`);
        }
      } catch (err) {
        if (err instanceof HttpError) {
          return formatAppInspectorHttpError(err);
        }
        throw err;
      }
    }
  );
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function handleGetStatus() {
  const data = await httpClient.request<{ status: string; note?: string }>(`${API_PREFIX}/status`);
  let result = `## App Inspector Status\n\n**Status:** ${data.status}`;
  if (data.note) result += `\n\n${data.note}`;
  return ResponseBuilder.markdown(result);
}

async function handleSetStatus(params: InferSchema<typeof schema>) {
  if (!params.status) {
    return ResponseBuilder.error(
      "Missing Parameter",
      '`status` is required for set-status ("enabled" or "disabled")'
    );
  }
  const data = await httpClient.request<{ status: string; changed: boolean }>(
    `${API_PREFIX}/status`,
    {
      method: "PUT",
      body: JSON.stringify({ status: params.status }),
      headers: { "Content-Type": "application/json" },
    }
  );
  const changed = data.changed ? "Status changed." : "Status was already set.";
  return ResponseBuilder.markdown(
    `## App Inspector Status Updated\n\n**Status:** ${data.status}\n\n${changed}`
  );
}

// ─── Traces ──────────────────────────────────────────────────────────────────

async function handleListTraces(params: InferSchema<typeof schema>) {
  const qs = buildQueryString(buildTraceFilters(params));
  const data = await httpClient.request<any>(`${API_V1}/traces${qs}`);
  return ResponseBuilder.markdown(formatTraceList(data));
}

async function handleGetTrace(params: InferSchema<typeof schema>) {
  if (!params.trace_id) {
    return ResponseBuilder.error("Missing Parameter", "`trace_id` is required for get-trace");
  }
  const data = await httpClient.request<any>(`${API_V1}/traces/${params.trace_id}`);
  return ResponseBuilder.markdown(
    `## Trace: ${params.trace_id}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
  );
}

async function handleDeleteTraces(params: InferSchema<typeof schema>) {
  const body = params.trace_ids ? { trace_ids: params.trace_ids } : {};
  const data = await httpClient.request<{ deleted_count: number }>(`${API_V1}/traces`, {
    method: "DELETE",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const scope = params.trace_ids ? `${params.trace_ids.length} trace(s)` : "all traces";
  return ResponseBuilder.markdown(
    `## Traces Deleted\n\nDeleted ${data.deleted_count} trace(s) (requested: ${scope}).`
  );
}

// ─── Spans ───────────────────────────────────────────────────────────────────

async function handleListSpans(params: InferSchema<typeof schema>) {
  if (!params.trace_id) {
    return ResponseBuilder.error("Missing Parameter", "`trace_id` is required for list-spans");
  }
  const qs = buildQueryString(buildSpanFilters(params));
  const data = await httpClient.request<any>(`${API_V1}/traces/${params.trace_id}/spans${qs}`);
  return ResponseBuilder.markdown(formatSpanList(data, params.trace_id));
}

async function handleGetSpan(params: InferSchema<typeof schema>) {
  if (!params.trace_id || !params.span_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id` and `span_id` are required for get-span"
    );
  }
  const data = await httpClient.request<any>(
    `${API_V1}/traces/${params.trace_id}/spans/${params.span_id}`
  );
  return ResponseBuilder.markdown(
    `## Span: ${params.span_id}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
  );
}

async function handleDeleteSpans(params: InferSchema<typeof schema>) {
  if (!params.trace_id) {
    return ResponseBuilder.error("Missing Parameter", "`trace_id` is required for delete-spans");
  }
  const body = params.span_ids ? { span_ids: params.span_ids } : {};
  const data = await httpClient.request<{ deleted_count: number }>(
    `${API_V1}/traces/${params.trace_id}/spans`,
    {
      method: "DELETE",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  );
  const scope = params.span_ids ? `${params.span_ids.length} span(s)` : "all spans in trace";
  return ResponseBuilder.markdown(
    `## Spans Deleted\n\nDeleted ${data.deleted_count} span(s) (requested: ${scope}).`
  );
}

// ─── Events ──────────────────────────────────────────────────────────────────

async function handleListEvents(params: InferSchema<typeof schema>) {
  if (!params.trace_id || !params.span_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id` and `span_id` are required for list-events"
    );
  }
  const qs = buildQueryString(buildEventFilters(params));
  const data = await httpClient.request<any>(
    `${API_V1}/traces/${params.trace_id}/spans/${params.span_id}/events${qs}`
  );
  return ResponseBuilder.markdown(formatEventList(data, params.span_id));
}

async function handleGetEvent(params: InferSchema<typeof schema>) {
  if (!params.trace_id || !params.span_id || !params.event_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id`, `span_id`, and `event_id` are required for get-event"
    );
  }
  const data = await httpClient.request<any>(
    `${API_V1}/traces/${params.trace_id}/spans/${params.span_id}/events/${params.event_id}`
  );
  return ResponseBuilder.markdown(
    `## Event: ${params.event_id}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
  );
}

async function handleListIamEvents(params: InferSchema<typeof schema>) {
  if (!params.trace_id || !params.span_id) {
    return ResponseBuilder.error(
      "Missing Parameter",
      "`trace_id` and `span_id` are required for list-iam-events"
    );
  }
  const qs = buildQueryString(buildEventFilters(params));
  const data = await httpClient.request<any>(
    `${API_V1}/traces/${params.trace_id}/spans/${params.span_id}/events/iam${qs}`
  );
  return ResponseBuilder.markdown(formatEventList(data, params.span_id, "IAM Policy Evaluation "));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function buildAppInspectorAnalyticsArgs(params: InferSchema<typeof schema>) {
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
    trace_ids_count: params.trace_ids?.length,
    span_ids_count: params.span_ids?.length,
    limit: params.limit,
    has_pagination_token: Boolean(params.pagination_token),
    filter_keys: filterKeys.length ? filterKeys.join(",") : undefined,
  };
}

export function formatAppInspectorHttpError(err: HttpError) {
  if (err.status === 403 || err.status === 503) {
    return ResponseBuilder.error(
      "App Inspector Disabled",
      'App Inspector is not enabled. Use the `set-status` action with `status: "enabled"` to turn it on.'
    );
  }
  return ResponseBuilder.error(`HTTP ${err.status}`, err.body || err.message);
}

function buildFilters(
  params: InferSchema<typeof schema>
): Record<string, string | number | undefined> {
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

function buildTraceFilters(
  params: InferSchema<typeof schema>
): Record<string, string | number | undefined> {
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

function buildSpanFilters(
  params: InferSchema<typeof schema>
): Record<string, string | number | undefined> {
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

function buildEventFilters(
  params: InferSchema<typeof schema>
): Record<string, string | number | undefined> {
  return {
    limit: params.limit,
    pagination_token: params.pagination_token,
    timestamp_unix_nano: params.start_time_unix_nano,
    name: params.event_name,
    event_type: params.event_type,
  };
}

export function buildQueryString(params: Record<string, string | number | undefined>): string {
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
