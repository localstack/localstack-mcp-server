import { type InspectorSpan, type SpanPage } from "./application-inspector.client";

function formatNsToMs(ns: number): string {
  const ms = ns / 1_000_000;
  return `${ms.toFixed(2)} ms`;
}

function formatUnixNanoToIso(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toISOString();
}

export function formatTraceSummaryTable(spanPage: SpanPage): string {
  const spans = spanPage.spans || [];
  if (spans.length === 0) {
    return "No spans found.";
  }

  const byTrace = new Map<string, InspectorSpan[]>();
  for (const s of spans) {
    const arr = byTrace.get(s.trace_id) || [];
    arr.push(s);
    byTrace.set(s.trace_id, arr);
  }

  const lines: string[] = [];
  lines.push("| Trace Start Time | Root Operation | Services | Duration | Status | Trace ID |");
  lines.push("|---|---|---|---|---|---|");

  for (const [traceId, tSpans] of byTrace.entries()) {
    let root = tSpans.find((s) => !s.parent_span_id) || tSpans[0];

    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    let hasError = false;
    const services = new Set<string>();

    for (const s of tSpans) {
      services.add(s.service_name);
      if (s.start_time_unix_nano < earliest) earliest = s.start_time_unix_nano;
      if (s.end_time_unix_nano > latest) latest = s.end_time_unix_nano;
      // OpenTelemetry status codes: 0=UNSET, 1=OK, 2=ERROR
      if (s.status_code === 2) hasError = true;
    }

    const startIso = formatUnixNanoToIso(root.start_time_unix_nano);
    const rootOp = `${root.service_name}:${root.operation_name}`;
    const duration = latest > earliest ? formatNsToMs(latest - earliest) : "0.00 ms";
    const status = hasError ? "❌" : "✅";
    const servicesList = Array.from(services).sort().join(", ");

    lines.push(
      `| ${startIso} | ${rootOp} | ${servicesList} | ${duration} | ${status} | ${traceId} |`
    );
  }

  return lines.join("\n");
}

export function formatDetailedTraceView(traceSpans: InspectorSpan[]): string {
  if (!traceSpans || traceSpans.length === 0) return "No spans for this trace.";

  // Build index
  const nodeById = new Map<string, { span: InspectorSpan; children: InspectorSpan[] }>();
  for (const s of traceSpans) {
    nodeById.set(s.span_id, { span: s, children: [] });
  }
  const roots: InspectorSpan[] = [];
  for (const s of traceSpans) {
    if (s.parent_span_id && nodeById.has(s.parent_span_id)) {
      nodeById.get(s.parent_span_id)!.children.push(s);
    } else {
      roots.push(s);
    }
  }

  for (const node of nodeById.values()) {
    node.children.sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
  }
  roots.sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);

  const lines: string[] = [];

  function renderSpan(span: InspectorSpan, indent: number) {
    const pad = "  ".repeat(indent);
    const ok = span.status_code !== 2;
    const emoji = ok ? "✅" : "❌";
    const durationNs = Math.max(0, span.end_time_unix_nano - span.start_time_unix_nano);
    const duration = formatNsToMs(durationNs);
    const op = `${span.service_name}:${span.operation_name}`;
    const parentInfo = span.parent_span?.service_name
      ? ` (parent: ${span.parent_span.service_name})`
      : "";

    lines.push(`${pad}- [${emoji} ${op}] - ${duration}${parentInfo}`);

    if (span.events && span.events.length > 0) {
      for (const ev of span.events) {
        const evPad = "  ".repeat(indent + 1);
        const evTime = formatUnixNanoToIso(ev.timestamp_unix_nano);
        lines.push(`${evPad}- event: ${ev.name} @ ${evTime}`);
        if (ev.attributes && Object.keys(ev.attributes).length > 0) {
          const json = JSON.stringify(ev.attributes, null, 2);
          lines.push(`${evPad}\n${evPad}\u0060\u0060\u0060json`);
          for (const line of json.split("\n")) {
            lines.push(`${evPad}${line}`);
          }
          lines.push(`${evPad}\u0060\u0060\u0060`);
        }
      }
    }

    const children = nodeById.get(span.span_id)?.children || [];
    for (const child of children) {
      renderSpan(child, indent + 1);
    }
  }

  for (const r of roots) renderSpan(r, 0);

  return lines.join("\n");
}
