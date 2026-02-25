import { formatTraceSummaryTable, formatDetailedTraceView } from "./inspector-reporter";
import { type SpanPage, type InspectorSpan } from "./application-inspector.client";

function ns(nowMs: number) {
  return nowMs * 1_000_000;
}

describe("Inspector Reporter", () => {
  const baseTimeMs = 1700000000000;

  const spanA: InspectorSpan = {
    span_id: "A",
    trace_id: "T1",
    parent_span_id: null,
    start_time_unix_nano: ns(baseTimeMs),
    end_time_unix_nano: ns(baseTimeMs + 120),
    status_code: 0,
    status_message: null,
    service_name: "apigateway",
    operation_name: "POST /users",
    is_write_operation: true,
    events: [
      {
        event_id: "E1",
        name: "http.request",
        timestamp_unix_nano: ns(baseTimeMs + 10),
        attributes: { path: "/users", method: "POST" },
      },
    ],
    attributes: { http_status: 201 },
  };

  const spanB: InspectorSpan = {
    span_id: "B",
    trace_id: "T1",
    parent_span_id: "A",
    start_time_unix_nano: ns(baseTimeMs + 20),
    end_time_unix_nano: ns(baseTimeMs + 60),
    status_code: 0,
    status_message: null,
    service_name: "lambda",
    operation_name: "InvokeFunction",
    is_write_operation: false,
    events: [],
    attributes: null,
    parent_span: { service_name: "apigateway" },
  };

  const spanCError: InspectorSpan = {
    span_id: "C",
    trace_id: "T2",
    parent_span_id: null,
    start_time_unix_nano: ns(baseTimeMs + 5),
    end_time_unix_nano: ns(baseTimeMs + 8),
    status_code: 2,
    status_message: "Boom",
    service_name: "s3",
    operation_name: "PutObject",
    is_write_operation: true,
    events: [
      {
        event_id: "E2",
        name: "sdk.error",
        timestamp_unix_nano: ns(baseTimeMs + 7),
        attributes: { code: "AccessDenied" },
      },
    ],
    attributes: null,
  };

  test("formatTraceSummaryTable returns table with grouped traces and status", () => {
    const page: SpanPage = {
      spans: [spanA, spanB, spanCError],
      next_token: null,
    };

    const table = formatTraceSummaryTable(page);
    expect(table).toContain(
      "| Trace Start Time | Root Operation | Services | Duration | Status | Trace ID |"
    );
    expect(table).toContain("apigateway:POST /users");
    expect(table).toContain("lambda");
    expect(table).toContain("T1");
    expect(table).toContain("❌");
  });

  test("formatDetailedTraceView snapshot", () => {
    const view = formatDetailedTraceView([spanA, spanB]);
    expect(view).toMatchSnapshot();
  });
});
