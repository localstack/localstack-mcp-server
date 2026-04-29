import {
  buildAppInspectorAnalyticsArgs,
  buildQueryString,
  formatAppInspectorApiError,
  formatEventList,
  formatSpanList,
  formatTraceList,
} from "../../tools/localstack-app-inspector";

describe("localstack-app-inspector", () => {
  describe("buildQueryString", () => {
    it("encodes defined query parameters and skips undefined values", () => {
      expect(
        buildQueryString({
          service_name: "lambda",
          operation_name: "Send Message",
          arn: "arn:aws:sqs:us-east-1:000000000000:queue/name",
          region: undefined,
        })
      ).toBe(
        "?service_name=lambda&operation_name=Send%20Message&arn=arn%3Aaws%3Asqs%3Aus-east-1%3A000000000000%3Aqueue%2Fname"
      );
    });
  });

  describe("buildAppInspectorAnalyticsArgs", () => {
    it("keeps analytics privacy-safe by reporting shape instead of raw IDs", () => {
      const analyticsArgs = buildAppInspectorAnalyticsArgs({
        action: "get-event",
        trace_id: "f".repeat(32),
        span_id: "a".repeat(16),
        event_id: "b".repeat(16),
        account_id: "000000000000",
        arn: "arn:aws:sqs:us-east-1:000000000000:queue/name",
        limit: 25,
        pagination_token: "cursor",
      } as any);

      expect(analyticsArgs).toEqual({
        action: "get-event",
        target_status: undefined,
        has_trace_id: true,
        has_span_id: true,
        has_event_id: true,
        trace_ids_count: undefined,
        span_ids_count: undefined,
        limit: 25,
        has_pagination_token: true,
        filter_keys: "account_id,arn,event_id,limit,pagination_token,span_id,trace_id",
      });
      expect(JSON.stringify(analyticsArgs)).not.toContain("000000000000");
      expect(JSON.stringify(analyticsArgs)).not.toContain("arn:aws:sqs");
    });

    it("tracks delete request cardinality without raw IDs", () => {
      const analyticsArgs = buildAppInspectorAnalyticsArgs({
        action: "delete-spans",
        trace_id: "f".repeat(32),
        span_ids: ["a".repeat(16), "b".repeat(16)],
      } as any);

      expect(analyticsArgs.span_ids_count).toBe(2);
      expect(analyticsArgs.has_trace_id).toBe(true);
      expect(JSON.stringify(analyticsArgs)).not.toContain("aaaaaaaaaaaaaaaa");
    });
  });

  describe("formatTraceList", () => {
    it("formats trace summaries returned by the App Inspector API", () => {
      const formatted = formatTraceList({
        traces: [
          {
            trace_id: "f".repeat(32),
            service_count: 3,
            span_count: 5,
            error_count: 1,
            status_code: 2,
            start_time_unix_nano: "1710000000000000000",
          },
        ],
        pagination: {
          total_count: 1,
          has_next: false,
        },
      });

      expect(formatted).toContain("## Traces (1)");
      expect(formatted).toContain("ffffffffffffffffffffffffffffffff");
      expect(formatted).toContain("Pagination");
    });
  });

  describe("formatAppInspectorApiError", () => {
    it("turns disabled App Inspector responses into actionable guidance", () => {
      const formatted = formatAppInspectorApiError({
        success: false,
        statusCode: 503,
        message: "AppInspector is not enabled",
      });

      expect(formatted.content[0].text).toContain("App Inspector Disabled");
      expect(formatted.content[0].text).toContain("set-status");
      expect(formatted.content[0].text).toContain("enabled");
    });
  });

  describe("formatSpanList", () => {
    it("formats span summaries with service and operation details", () => {
      const formatted = formatSpanList(
        {
          spans: [
            {
              span_id: "a".repeat(16),
              service_name: "lambda",
              operation_name: "Invoke",
              status_code: 1,
              start_time_unix_nano: "1710000000000000000",
            },
          ],
          pagination: { total_count: 1, has_next: false },
        },
        "f".repeat(32)
      );

      expect(formatted).toContain("## Spans for Trace");
      expect(formatted).toContain("lambda");
      expect(formatted).toContain("Invoke");
    });
  });

  describe("formatEventList", () => {
    it("formats event summaries including IAM policy events", () => {
      const formatted = formatEventList(
        {
          events: [
            {
              event_id: "b".repeat(16),
              name: "iam.policy.denied",
              event_type: "iam.policy_evaluation",
              timestamp_unix_nano: "1710000000000000000",
            },
          ],
        },
        "a".repeat(16),
        "IAM Policy Evaluation "
      );

      expect(formatted).toContain("## IAM Policy Evaluation Events");
      expect(formatted).toContain("iam.policy.denied");
      expect(formatted).toContain("iam.policy_evaluation");
    });
  });
});
