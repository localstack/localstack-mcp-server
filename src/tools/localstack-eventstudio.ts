import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { httpClient, HttpError } from "../core/http-client";

export const schema = {
  action: z.enum(["status", "get_spans", "get_spans_human_readable", "delete_spans"]),

  // Span query parameters
  limit: z.number().optional().describe("Maximum number of spans to return"),
  pagination_token: z.string().optional().describe("Token for paginating through results"),
  service_name: z.string().optional().describe("Filter by AWS service (e.g., 's3', 'lambda', 'dynamodb')"),
  operation_name: z.string().optional().describe("Filter by specific API operation (e.g., 'CreateBucket', 'InvokeFunction')"),
  is_write_operation: z.boolean().default(true).describe("Focus on state-changing operations (defaults to true)"),
  errors_only: z.boolean().default(false).describe("Return only spans with error status codes"),
  account_id: z.string().optional().describe("Filter by AWS account ID"),
  region: z.string().optional().describe("Filter by AWS region"),
  status_code: z.number().optional().describe("Filter by HTTP status code for error analysis"),
  trace_id: z.string().optional().describe("Filter by a distributed trace identifier"),
  parent_span_id: z.string().optional().describe("Filter by a parent span identifier"),
  span_id: z.string().optional().describe("Filter by a specific span identifier"),
  arn: z.string().optional().describe("Filter by an Amazon Resource Name (ARN)"),
  resource_name: z.string().optional().describe("Filter by the name of the AWS resource"),
  start_time_unix_nano: z.number().optional().describe("Start of time range in Unix nanoseconds"),
  end_time_unix_nano: z.number().optional().describe("End of time range in Unix nanoseconds"),
  version: z.number().optional().describe("Filter by API version"),

  // Delete parameters
  span_ids: z.array(z.string()).optional().describe("An array of span IDs to delete"),
};

// Define the metadata for the tool
export const metadata: ToolMetadata = {
  name: "localstack-eventstudio",
  description: "Query, analyze, and manage distributed tracing spans from LocalStack's EventStudio service.",
  annotations: {
    title: "LocalStack EventStudio",
  },
};

export default async function localstackEventStudio(params: InferSchema<typeof schema>) {
  const preflightError = await runPreflights([requireLocalStackRunning()]);
  if (preflightError) return preflightError;

  try {
    switch (params.action) {
      case "status":
        return await handleStatus();
      case "get_spans":
        return await handleGetSpans(params);
      case "get_spans_human_readable":
        return await handleGetSpansHumanReadable(params);
      case "delete_spans":
        return await handleDeleteSpans(params);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      return ResponseBuilder.error("EventStudio API Error", `${err.message}\n\n${err.body}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return ResponseBuilder.error("Execution Error", message);
  }
}

async function handleStatus() {
  const response = await httpClient.request<{ status: string }>("/_eventstudio/status");
  return ResponseBuilder.markdown(`EventStudio Status: **${response.status}**`);
}

async function getSpans(params: InferSchema<typeof schema>) {
  const queryParams = new URLSearchParams();

  // Set default limit to 2000 if not specified
  const limit = params.limit ?? 2000;
  queryParams.set("limit", String(limit));

  // Add all optional string/number/boolean parameters to the query
  const paramKeys: (keyof typeof params)[] = [
    "pagination_token",
    "service_name",
    "operation_name",
    "is_write_operation",
    "errors_only",
    "account_id",
    "region",
    "status_code",
    "trace_id",
    "parent_span_id",
    "span_id",
    "arn",
    "resource_name",
    "start_time_unix_nano",
    "end_time_unix_nano",
    "version",
  ];

  for (const key of paramKeys) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      queryParams.set(key as string, String(value));
    }
  }

  // The 'errors_only' parameter is a convenience filter.
  // If true, it finds spans with client or server error status codes.
  // This is not a direct API parameter, so we handle it by adding a custom filter.
  if (params.errors_only) {
    queryParams.set("status_code", "2");
  }

  return await httpClient.request<any>(`/_eventstudio/v1/spans?${queryParams.toString()}`);
}

function formatSpansForDisplay(response: any) {
  if (!response.spans || response.spans.length === 0) {
    return ResponseBuilder.markdown("No spans found matching the criteria.");
  }

  const lines: string[] = [];
  lines.push(`Found **${response.spans.length}** span(s).\n`);

  for (const span of response.spans) {
    const duration = span.end_time_unix_nano
      ? `${((span.end_time_unix_nano - span.start_time_unix_nano) / 1_000_000).toFixed(2)} ms`
      : "In Progress";

    lines.push(`---`);
    lines.push(`### ${span.service_name}: ${span.operation_name}`);
    lines.push("");
    lines.push("| Attribute | Value |");
    lines.push("|---|---|");
    lines.push(`| **Resource** | \`${span.resource_name || "N/A"}\` |`);
    lines.push(`| **Status** | ${`${span.status_code} ${span.status_message || ""}`.trim()} |`);
    lines.push(`| **Duration** | ${duration} |`);
    lines.push(`| **Write Op** | ${span.is_write_operation ? "Yes" : "No"} |`);
    lines.push(`| **Trace ID** | \`${span.trace_id}\` |`);
    lines.push(`| **Span ID** | \`${span.span_id}\` |`);
    lines.push(`| **Parent Span ID** | ${span.parent_span_id ? `\`${span.parent_span_id}\`` : "None"} |`);

    if (span.parent_service_name) {
      lines.push(`| **Parent Service** | ${span.parent_service_name} |`);
    }
    lines.push("");

    if (span.attributes && Object.keys(span.attributes).length > 0) {
      lines.push(`**Attributes**`);
      lines.push(`\`\`\`json\n${JSON.stringify(span.attributes, null, 2)}\n\`\`\``);
      lines.push("");
    }

    if (span.events && span.events.length > 0) {
      lines.push(`**Events**`);
      lines.push(`\`\`\`json\n${JSON.stringify(span.events, null, 2)}\n\`\`\``);
      lines.push("");
    }
  }

  if (response.next_token) {
    lines.push(`---`);
    lines.push(`**Next Page Token:** \`${response.next_token}\``);
  }

  return ResponseBuilder.markdown(lines.join("\n"));
}

async function handleGetSpans(params: InferSchema<typeof schema>) {
  const response = await getSpans(params);
  return ResponseBuilder.json(response);
}

async function handleGetSpansHumanReadable(params: InferSchema<typeof schema>) {
  const response = await getSpans(params);
  return formatSpansForDisplay(response);
}

async function handleDeleteSpans(params: InferSchema<typeof schema>) {
  const { span_ids } = params;
  let response;

  if (span_ids && span_ids.length > 0) {
    // Delete specific spans
    response = await httpClient.request<{ deleted_count: number }>("/_eventstudio/v1/spans", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ span_ids }),
    });
  } else {
    // Delete all spans
    response = await httpClient.request<{ deleted_count: number }>("/_eventstudio/v1/spans", {
      method: "DELETE",
    });
  }

  return ResponseBuilder.markdown(`Successfully deleted ${response.deleted_count} span(s).`);
}
