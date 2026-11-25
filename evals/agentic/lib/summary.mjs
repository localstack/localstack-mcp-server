// A markdown summary of one evaluation's results.json, for the workflow's job summary and the history issue.
// Only numbers, scenario names, check types and versions: no transcript, final message or check detail, which hold
// the agent's text.
import { readFileSync } from "node:fs";

/** Plain text for a markdown table cell: one line, no pipes, no markup */
function cell(value) {
  return String(value ?? "-")
    .replace(/\r?\n|\r/g, " ")
    .replace(/[\\`*_{}[\]()<>#+!|~]/g, (char) => `\\${char}`);
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const sum = (values) => values.reduce((a, b) => a + b, 0);

/** The markdown summary of a report (the parsed results.json) */
export function summarize(report) {
  const results = report.results ?? [];
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  const rows = scenarios.map((scenario) => {
    const runs = results.filter((r) => r.scenario === scenario);
    const failed = [
      ...new Set(
        runs.flatMap((r) => [
          ...(r.error ? ["error"] : []),
          ...(r.checks ?? []).filter((c) => !c.pass && !c.report).map((c) => c.type),
        ])
      ),
    ];
    return [
      scenario,
      `${runs.filter((r) => r.pass).length}/${runs.length}`,
      `${runs.filter((r) => r.usedExpectedTools).length}/${runs.length}`,
      mean(runs.map((r) => r.turns ?? 0)).toFixed(1),
      `${Math.round(mean(runs.map((r) => r.durationSeconds ?? 0)))} s`,
      `$${sum(runs.map((r) => r.costUsd ?? 0)).toFixed(3)}`,
      failed.join(", ") || "-",
    ];
  });
  const passed = results.filter((r) => r.pass).length;
  const versions = report.versions ?? {};
  const lines = [
    `### Agentic eval: ${passed}/${results.length} passed`,
    "",
    `Started ${cell(report.startedAt)} · provider ${cell(report.provider)} · LocalStack ${cell(versions.localstack)} · ${cell(versions.claudeCode)} · commit ${cell(String(versions.commit ?? "").slice(0, 7))}` +
      (report.withoutAppInspector ? " · without IAM tools" : "") +
      (report.withoutMcp ? " · without MCP" : ""),
    "",
    "| Scenario | Passed | Used the expected tools | Turns | Time | Cost | Failed checks |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
    `Total cost: $${sum(results.map((r) => r.costUsd ?? 0)).toFixed(2)}`,
  ];
  return lines.join("\n");
}

// node evals/agentic/lib/summary.mjs <results.json>...
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node evals/agentic/lib/summary.mjs <results.json>...");
    process.exit(2);
  }
  console.log(files.map((file) => summarize(JSON.parse(readFileSync(file, "utf8")))).join("\n\n"));
}
