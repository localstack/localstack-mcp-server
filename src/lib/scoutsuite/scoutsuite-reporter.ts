function escapeMarkdown(text: string): string {
  return String(text).replace(/[|`*_~]/g, "\\$&");
}

export function formatScanResults(report: any): string {
  if (!report || !report.last_run || !report.last_run.summary) {
    return "No summary data available in report.";
  }

  const lines: string[] = [];
  lines.push("# Scout Suite Scan Summary\n");

  // High-Level Summary Table
  lines.push("| Service | Checked Items | Flagged Items |");
  lines.push("|---|---:|---:|");
  const summary = report.last_run.summary;
  for (const serviceName of Object.keys(summary)) {
    const s = summary[serviceName];
    if (!s || typeof s.checked_items !== "number" || s.checked_items <= 0) continue;
    const checked = s.checked_items ?? 0;
    const flagged = s.flagged_items ?? 0;
    lines.push(`| ${escapeMarkdown(serviceName)} | ${checked} | ${flagged} |`);
  }

  // Detailed Findings
  if (report.services) {
    for (const serviceName of Object.keys(report.services)) {
      const serviceSummary = summary[serviceName];
      const flagged = serviceSummary?.flagged_items ?? 0;
      if (flagged <= 0) continue;

      lines.push("\n");
      lines.push(`## \u26A0\uFE0F ${serviceName.toUpperCase()} Findings`);

      const service = report.services[serviceName];
      const findings = service?.findings || {};
      for (const findingKey of Object.keys(findings)) {
        const f = findings[findingKey];
        if (!f) continue;
        const title = f.description || findingKey;
        const severity = String(f.level || "warning");
        const severityLabel = severity.toLowerCase() === "danger" ? "❌ Danger" : "⚠️ Warning";
        const rationale = f.rationale || "";
        const remediation = f.remediation || "";
        const items = Array.isArray(f.items) ? f.items : [];

        lines.push(`\n### ${escapeMarkdown(title)}`);
        lines.push(`- **Severity**: ${severityLabel}`);
        if (items.length > 0) {
          lines.push("- **Flagged Items**:");
          for (const it of items) {
            lines.push(`  - \`${escapeMarkdown(it)}\``);
          }
        }
        if (rationale) {
          lines.push("- **Rationale**:");
          lines.push(`  ${escapeMarkdown(rationale)}`);
        }
        if (remediation) {
          lines.push("- **Remediation**:");
          lines.push(`  ${escapeMarkdown(remediation)}`);
        }
      }
    }
  }

  return lines.join("\n");
}


