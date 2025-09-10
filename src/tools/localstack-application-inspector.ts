import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { HttpError } from "../core/http-client";
import {
  ApplicationInspectorApiClient,
  type SpanFilters,
  type InspectorSpan,
} from "../lib/application-inspector/application-inspector.client";
import {
  formatTraceSummaryTable,
  formatDetailedTraceView,
} from "../lib/application-inspector/inspector-reporter";

export const schema = {
  action: z.enum(["list-traces", "get-trace-details", "clear-traces"]),

  // list-traces filters
  serviceName: z.string().optional(),
  operationName: z.string().optional(),
  errorsOnly: z.boolean().optional(),
  limit: z.number().optional(),
  paginationToken: z.string().optional(),
  traceId: z.string().optional(),
  accountId: z.string().optional(),
  region: z.string().optional(),
  startTimeUnixNano: z.number().optional(),
  endTimeUnixNano: z.number().optional(),
  format: z.enum(["table", "json"]).default("table"),

  // get-trace-details
  traceIdRequired: z.string().optional(),

  // clear-traces
  spanIds: z.array(z.string()).optional(),
};

export const metadata: ToolMetadata = {
  name: "localstack-application-inspector",
  description:
    "Inspects and visualizes end-to-end request flows within your application. Use this tool to trace a single request's journey across multiple AWS services, understand performance bottlenecks, and debug complex, distributed workflows.",
  annotations: {
    title: "LocalStack Application Inspector",
  },
};

export default async function localstackApplicationInspector(params: InferSchema<typeof schema>) {
  // const preflightError = await runPreflights([requireLocalStackRunning()]);
  // if (preflightError) return preflightError;

  const client = new ApplicationInspectorApiClient();

  switch (params.action) {
    case "list-traces": {
      const filters: SpanFilters = {
        limit: params.limit,
        pagination_token: params.paginationToken,
        service_name: params.serviceName,
        operation_name: params.operationName,
        errors_only: params.errorsOnly,
        trace_id: params.traceId,
        account_id: params.accountId,
        region: params.region,
        start_time_unix_nano: params.startTimeUnixNano,
        end_time_unix_nano: params.endTimeUnixNano,
      };
      try {
        const page = await client.getSpans(filters);
        if (params.format === "json") {
          return ResponseBuilder.json(page);
        }
        const table = formatTraceSummaryTable(page);
        return ResponseBuilder.markdown(table);
      } catch (err: any) {
        if (err instanceof HttpError) {
          return ResponseBuilder.error(
            "Application Inspector API Error",
            `Status ${err.status}: ${err.statusText}\n\n${err.body}`
          );
        }
        return ResponseBuilder.error(
          "Application Inspector Error",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    case "get-trace-details": {
      const traceId = params.traceIdRequired || params.traceId;
      if (!traceId) {
        return ResponseBuilder.error(
          "Missing Required Parameter",
          "The 'get-trace-details' action requires the 'traceId' parameter."
        );
      }
      try {
        const allSpans: InspectorSpan[] = [];
        let paginationToken: string | undefined = undefined;
        let safetyCounter = 0;
        do {
          const page = await client.getSpans({
            trace_id: traceId,
            limit: 1000,
            pagination_token: paginationToken,
          });
          if (page.spans && page.spans.length > 0) allSpans.push(...page.spans);
          paginationToken = page.next_token || undefined;
          safetyCounter++;
        } while (paginationToken && safetyCounter < 50);

        const view = formatDetailedTraceView(allSpans);
        return ResponseBuilder.markdown(view);
      } catch (err: any) {
        if (err instanceof HttpError) {
          return ResponseBuilder.error(
            "Application Inspector API Error",
            `Status ${err.status}: ${err.statusText}\n\n${err.body}`
          );
        }
        return ResponseBuilder.error(
          "Application Inspector Error",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    case "clear-traces": {
      try {
        const result = await client.clearEvents(params.spanIds);
        return ResponseBuilder.success(`Successfully deleted ${result.deleted_count} event(s).`);
      } catch (err: any) {
        if (err instanceof HttpError) {
          return ResponseBuilder.error(
            "Application Inspector API Error",
            `Status ${err.status}: ${err.statusText}\n\n${err.body}`
          );
        }
        return ResponseBuilder.error(
          "Application Inspector Error",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }
}
