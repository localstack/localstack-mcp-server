import { httpClient, HttpError } from "../../core/http-client";

export interface InspectorEvent {
  event_id: string;
  name: string;
  timestamp_unix_nano: number;
  attributes: Record<string, any> | null;
}

export interface InspectorSpan {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  status_code: number;
  status_message: string | null;
  service_name: string;
  operation_name: string;
  is_write_operation: boolean;
  events: InspectorEvent[];
  attributes: Record<string, any> | null;
  parent_span?: { service_name: string };
}

export interface SpanPage {
  spans: InspectorSpan[];
  next_token: string | null;
}

export interface SpanFilters {
  limit?: number;
  pagination_token?: string;
  service_name?: string;
  operation_name?: string;
  trace_id?: string;
  errors_only?: boolean;
  account_id?: string;
  region?: string;
  status_code?: number;
  parent_span_id?: string;
  span_id?: string;
  arn?: string;
  resource_name?: string;
  start_time_unix_nano?: number;
  end_time_unix_nano?: number;
  version?: number;
}

export class ApplicationInspectorApiClient {
  async getSpans(filters: SpanFilters = {}): Promise<SpanPage> {
    const queryParams = new URLSearchParams();

    if (typeof filters.limit === "number") {
      queryParams.set("limit", String(filters.limit));
    }

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null) continue;
      if (key === "errors_only") continue;
      if (key === "limit") continue;
      queryParams.set(key, String(value as any));
    }

    if (filters.errors_only) {
      queryParams.set("status_code", "2");
    }

    const qs = queryParams.toString();
    const primary = `/_localstack/eventstudio/v1/spans?${qs}`;
    return httpClient.request<SpanPage>(primary, { method: "GET" });
  }

  async clearEvents(spanIds?: string[]): Promise<{ deleted_count: number }> {
    const hasIds = Array.isArray(spanIds) && spanIds.length > 0;
    const options: RequestInit = hasIds
      ? {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ span_ids: spanIds }),
        }
      : { method: "DELETE" };

    return httpClient.request<{ deleted_count: number }>(
      "/_localstack/eventstudio/v1/spans",
      options
    );
  }
}
