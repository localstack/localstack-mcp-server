import { DeploymentEvent } from "./deployment-utils";

export function formatDeploymentReport(baseTitle: string, events: DeploymentEvent[]): string {
  let report = `# ${baseTitle}\n\n`;

  for (const event of events) {
    switch (event.type) {
      case "header":
        report += `## ${event.title}\n\n`;
        break;
      case "command":
        report += `**Executing:** \`${event.content}\`\n\n`;
        break;
      case "output":
        if (event.content.trim()) {
          report += `\`\`\`\n${event.content.trim()}\n\`\`\`\n\n`;
        }
        break;
      case "warning":
        report += `**⚠️ Message:**\n\`\`\`\n${event.content.trim()}\n\`\`\`\n\n`;
        break;
      case "error":
        report += `❌ **${event.title || "Error"}**\n\n\`\`\`\n${event.content.trim()}\n\`\`\`\n`;
        break;
      case "success":
        report += `✅ **${event.content}**\n`;
        break;
    }
  }
  return report;
}
