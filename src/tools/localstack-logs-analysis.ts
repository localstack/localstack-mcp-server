import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { ensureLocalStackCli } from "../lib/localstack-utils";
import { LocalStackLogRetriever, type LogEntry } from "../lib/log-retriever";

export const schema = {
  analysisType: z.enum(['summary', 'errors', 'requests', 'logs'])
    .default('summary')
    .describe("The analysis to perform: 'summary' (default), 'errors', 'requests', or 'logs' for raw output."),
  lines: z.number().int().positive().default(2000)
    .describe("Number of recent log lines to fetch and analyze."),
  service: z.string().optional()
    .describe("Filter by AWS service (e.g., 's3', 'lambda'). Used with 'errors' and 'requests' modes."),
  operation: z.string().optional()
    .describe("Filter by a specific API operation (e.g., 'CreateBucket'). Requires 'service'. Used with 'requests' mode."),
  filter: z.string().optional()
    .describe("Raw keyword filter. Only used with 'logs' mode."),
};

export const metadata: ToolMetadata = {
  name: "localstack-logs-analysis",
  description: "LocalStack log analyzer that helps developers quickly diagnose issues and understand their LocalStack interactions",
  annotations: {
    title: "LocalStack Logs Analysis",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function localstackLogsAnalysis({ analysisType, lines, service, operation, filter }: InferSchema<typeof schema>) {
  const cliError = await ensureLocalStackCli();
  if (cliError) return cliError;

  const retriever = new LocalStackLogRetriever();
  const retrievalFilter = analysisType === 'logs' ? filter : undefined;
  const logResult = await retriever.retrieveLogs(lines, retrievalFilter);
  
  if (!logResult.success) {
    return {
      content: [{ type: "text", text: `❌ ${logResult.errorMessage}` }],
    };
  }

  switch (analysisType) {
    case 'summary':
      return await handleSummaryAnalysis(logResult.logs, logResult.totalLines);
    case 'errors':
      return await handleErrorAnalysis(retriever, logResult.logs, service);
    case 'requests':
      return await handleRequestAnalysis(retriever, logResult.logs, service, operation);
    case 'logs':
      return await handleRawLogsAnalysis(logResult.logs, logResult.totalLines, logResult.filteredLines, filter);
    default:
      return {
        content: [{ type: "text", text: `❌ Unknown analysis type: ${analysisType}` }],
      };
  }
}

/**
 * Handle summary analysis mode - high-level dashboard
 */
async function handleSummaryAnalysis(logs: LogEntry[], totalLines: number) {
  const errors = logs.filter(log => log.isError);
  const warnings = logs.filter(log => log.isWarning);
  const apiStats = new LocalStackLogRetriever().analyzeApiCalls(logs);
  
  let result = `# 📊 LocalStack Summary\n\n`;
  result += `**Lines Analyzed:** ${totalLines}\n`;
  result += `**API Calls:** ${apiStats.totalCalls}\n`;
  result += `**Errors:** ${errors.length} | **Warnings:** ${warnings.length}\n\n`;
  
  // Quick health check
  if (apiStats.failedCalls > 0) {
    result += `## ❌ Recent Failures (${apiStats.failedCalls})\n\n`;
    
    const recentFailures = apiStats.failedCallDetails.slice(-5).reverse();
    for (const call of recentFailures) {
      const service = call.service || 'unknown';
      const operation = call.operation || 'unknown';
      const status = call.statusCode || 'N/A';
      result += `- **${service}.${operation}** → ${status} ${call.message}\n`;
    }
    result += `\n💡 Use \`errors\` mode for detailed analysis\n\n`;
  }
  
  // Service breakdown if there are API calls
  if (apiStats.callsByService.size > 0) {
    result += `## 🔧 Service Activity\n\n`;
    
    for (const [svc, count] of Array.from(apiStats.callsByService.entries()).sort((a, b) => b[1] - a[1])) {
      const serviceErrors = apiStats.failedCallDetails.filter(call => call.service === svc).length;
      const status = serviceErrors === 0 ? '✅' : '❌';
      result += `- **${svc}**: ${count} calls ${status}`;
      if (serviceErrors > 0) result += ` (${serviceErrors} failed)`;
      result += `\n`;
    }
    result += `\n`;
  }
  
  if (errors.length === 0 && apiStats.failedCalls === 0) {
    result += `## ✅ All Clear\n\nNo errors detected in recent LocalStack activity.\n\n`;
  }
  
  result += `**Drill down:** \`errors\` | \`requests\` | \`logs\`\n`;
  
  return {
    content: [{ type: "text", text: result }],
  };
}

/**
 * Handle error analysis mode - detailed error examination
 */
async function handleErrorAnalysis(retriever: LocalStackLogRetriever, logs: LogEntry[], serviceFilter?: string) {
  let errorLogs = logs.filter(log => log.isError || log.isWarning);
  
  // Apply service filter if provided
  if (serviceFilter) {
    errorLogs = errorLogs.filter(log => log.service?.toLowerCase() === serviceFilter.toLowerCase());
  }
  
  if (errorLogs.length === 0) {
    const filterMsg = serviceFilter ? ` for ${serviceFilter}` : '';
    return {
      content: [{ type: "text", text: `✅ No errors found${filterMsg} in the analyzed logs.` }],
    };
  }
  
  const errorGroups = retriever.groupLogsByError(errorLogs);
  const serviceMsg = serviceFilter ? ` (${serviceFilter})` : '';
  
  let result = `# 🚨 LocalStack Errors${serviceMsg}\n\n`;
  result += `**Found:** ${errorLogs.length} issues (${errorGroups.size} unique types)\n\n`;
  
  // Sort error groups by frequency (most common first)
  const sortedErrorGroups = Array.from(errorGroups.entries())
    .sort((a, b) => b[1].length - a[1].length);
  
  for (const [errorPattern, instances] of sortedErrorGroups) {
    const count = instances.length;
    const firstInstance = instances[0];
    const isApiError = firstInstance.isApiCall && firstInstance.statusCode;
    
    result += `## ${isApiError ? '🔴' : '⚠️'} ${errorPattern}\n`;
    result += `**Occurrences:** ${count}\n\n`;
    
    // Show recent examples
    const recentInstances = instances.slice(-2);
    for (const instance of recentInstances) {
      if (instance.timestamp) result += `**${instance.timestamp}**\n`;
      result += `\`\`\`\n${instance.fullLine}\n\`\`\`\n\n`;
    }
    
    if (count > 2) {
      result += `*... and ${count - 2} more occurrences*\n\n`;
    }
  }
  
  // Quick suggestions
  const hasApiErrors = errorLogs.some(log => log.isApiCall);
  if (hasApiErrors) {
    result += `💡 **Next:** Use \`requests\` mode to analyze API call patterns\n`;
  }
  
  return {
    content: [{ type: "text", text: result }],
  };
}

/**
 * Handle request analysis mode - API call examination
 */
async function handleRequestAnalysis(retriever: LocalStackLogRetriever, logs: LogEntry[], serviceFilter?: string, operationFilter?: string) {
  const apiStats = retriever.analyzeApiCalls(logs);
  
  if (apiStats.totalCalls === 0) {
    return {
      content: [{ type: "text", text: `🔍 No API calls detected in the analyzed logs.` }],
    };
  }
  
  // Case 1: Both service and operation specified - show detailed call traces
  if (serviceFilter && operationFilter) {
    const matchingCalls = logs.filter(log => 
      log.isApiCall && 
      log.service?.toLowerCase() === serviceFilter.toLowerCase() &&
      log.operation?.toLowerCase() === operationFilter.toLowerCase()
    );
    
    if (matchingCalls.length === 0) {
      return {
        content: [{ type: "text", text: `🔍 No calls found for ${serviceFilter}.${operationFilter}` }],
      };
    }
    
    let result = `# 🔍 ${serviceFilter}.${operationFilter} Calls\n\n`;
    result += `**Total:** ${matchingCalls.length}\n\n`;
    
    for (let i = 0; i < Math.min(matchingCalls.length, 10); i++) {
      const call = matchingCalls[i];
      const status = call.statusCode ? `${call.statusCode}` : 'N/A';
      const statusEmoji = call.statusCode && call.statusCode >= 400 ? '❌' : '✅';
      
      result += `### ${statusEmoji} Call ${i + 1}\n`;
      if (call.timestamp) result += `**${call.timestamp}**\n`;
      result += `**Status:** ${status}\n`;
      result += `\`\`\`\n${call.fullLine}\n\`\`\`\n\n`;
    }
    
    if (matchingCalls.length > 10) {
      result += `*... and ${matchingCalls.length - 10} more calls*\n`;
    }
    
    return {
      content: [{ type: "text", text: result }],
    };
  }
  
  // Case 2: Only service specified - show operations for that service
  if (serviceFilter) {
    const serviceCalls = logs.filter(log => 
      log.isApiCall && log.service?.toLowerCase() === serviceFilter.toLowerCase()
    );
    
    if (serviceCalls.length === 0) {
      return {
        content: [{ type: "text", text: `🔍 No ${serviceFilter} API calls found.` }],
      };
    }
    
    const operationStats = new Map<string, { total: number; failed: number }>();
    
    for (const call of serviceCalls) {
      const op = call.operation || 'Unknown';
      if (!operationStats.has(op)) {
        operationStats.set(op, { total: 0, failed: 0 });
      }
      
      const stats = operationStats.get(op)!;
      stats.total++;
      if (call.statusCode && call.statusCode >= 400) {
        stats.failed++;
      }
    }
    
    let result = `# 🔧 ${serviceFilter.toUpperCase()} API Calls\n\n`;
    result += `**Total:** ${serviceCalls.length}\n\n`;
    
    const sortedOps = Array.from(operationStats.entries())
      .sort((a, b) => b[1].total - a[1].total);
    
    for (const [operation, stats] of sortedOps) {
      const status = stats.failed === 0 ? '✅' : '❌';
      result += `- **${operation}** ${status} (${stats.total} calls`;
      if (stats.failed > 0) result += `, ${stats.failed} failed`;
      result += `)\n`;
    }
    
    result += `\n💡 Add \`operation\` parameter to see detailed traces\n`;
    
    return {
      content: [{ type: "text", text: result }],
    };
  }
  
  // Case 3: No filters - show service overview
  let result = `# 🌐 API Activity\n\n`;
  result += `**Total:** ${apiStats.totalCalls} calls\n`;
  result += `**Failed:** ${apiStats.failedCalls}\n`;
  result += `**Success Rate:** ${(apiStats.successfulCalls / apiStats.totalCalls * 100).toFixed(1)}%\n\n`;
  
  if (apiStats.callsByService.size > 0) {
    result += `## Services\n\n`;
    
    const sortedServices = Array.from(apiStats.callsByService.entries())
      .sort((a, b) => b[1] - a[1]);
    
    for (const [service, totalCalls] of sortedServices) {
      const failedCalls = apiStats.failedCallDetails.filter(call => call.service === service).length;
      const status = failedCalls === 0 ? '✅' : '❌';
      result += `- **${service}** ${status} (${totalCalls} calls`;
      if (failedCalls > 0) result += `, ${failedCalls} failed`;
      result += `)\n`;
    }
    
    result += `\n💡 Add \`service\` parameter to focus on specific service\n`;
  }
  
  return {
    content: [{ type: "text", text: result }],
  };
}

/**
 * Handle raw logs analysis mode - direct log inspection
 */
async function handleRawLogsAnalysis(logs: LogEntry[], totalLines: number, filteredLines?: number, filter?: string) {
  const displayLines = filteredLines || logs.length;
  
  let result = `# 📜 Raw Logs\n\n`;
  
  if (filter) {
    result += `**Filter:** "${filter}" → ${displayLines}/${totalLines} lines\n\n`;
  } else {
    result += `**Lines:** ${displayLines}\n\n`;
  }
  
  if (logs.length === 0) {
    result += `No matching logs found.\n`;
    return {
      content: [{ type: "text", text: result }],
    };
  }
  
  result += `\`\`\`\n`;
  for (const log of logs) {
    result += `${log.fullLine}\n`;
  }
  result += `\`\`\`\n\n`;
  
  // Quick stats
  const errors = logs.filter(log => log.isError).length;
  const apiCalls = logs.filter(log => log.isApiCall).length;
  
  if (errors > 0 || apiCalls > 0) {
    result += `**Quick stats:** ${errors} errors, ${apiCalls} API calls\n`;
  }
  
  return {
    content: [{ type: "text", text: result }],
  };
} 
