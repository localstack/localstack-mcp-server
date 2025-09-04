import { runCommand } from "../../core/command-runner";

export interface LogEntry {
  timestamp?: string;
  level?: string;
  service?: string;
  operation?: string;
  statusCode?: number;
  message: string;
  fullLine: string;
  isApiCall: boolean;
  isError: boolean;
  isWarning: boolean;
  requestId?: string;
  isIamDenial?: boolean;
  iamPrincipal?: string;
  iamAction?: string;
  iamResource?: string;
}

export interface LogRetrievalResult {
  success: boolean;
  logs: LogEntry[];
  totalLines: number;
  errorMessage?: string;
  filteredLines?: number;
}

/**
 * Retrieve and parse LocalStack logs with intelligent analysis
 */
export class LocalStackLogRetriever {
  /**
   * Retrieve logs from LocalStack
   */
  async retrieveLogs(lines: number = 10000, filter?: string): Promise<LogRetrievalResult> {
    try {
      const cmd = await runCommand("localstack", ["logs", "--tail", String(lines)], {
        timeout: 30000,
      });

      if (!cmd.stdout && cmd.stderr) {
        return {
          success: false,
          logs: [],
          totalLines: 0,
          errorMessage: `Failed to retrieve logs: ${cmd.stderr}`,
        };
      }

      const rawLines = (cmd.stdout || "").split("\n").filter((line) => line.trim());
      let filteredLines = rawLines;

      if (filter) {
        filteredLines = rawLines.filter((line) =>
          line.toLowerCase().includes(filter.toLowerCase())
        );
      }

      const logs = filteredLines.map((line) => this.parseLogLine(line));

      return {
        success: true,
        logs,
        totalLines: rawLines.length,
        filteredLines: filter ? filteredLines.length : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("timeout")) {
        return {
          success: false,
          logs: [],
          totalLines: 0,
          errorMessage:
            "Log retrieval timed out. LocalStack may be generating large amounts of logs. Try reducing the number of lines or check if LocalStack is experiencing issues.",
        };
      }

      if (errorMessage.includes("Command failed") || errorMessage.includes("not found")) {
        return {
          success: false,
          logs: [],
          totalLines: 0,
          errorMessage:
            "Unable to execute 'localstack logs' command. Please ensure LocalStack CLI is installed and LocalStack is running.",
        };
      }

      return {
        success: false,
        logs: [],
        totalLines: 0,
        errorMessage: `Failed to retrieve logs: ${errorMessage}`,
      };
    }
  }

  /**
   * Parse a single log line to extract structured information
   */
  private parseLogLine(line: string): LogEntry {
    const entry: LogEntry = {
      message: line,
      fullLine: line,
      isApiCall: false,
      isError: false,
      isWarning: false,
    };

    // Extract timestamp (LocalStack format: 2025-07-23T10:58:58.710)
    const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (timestampMatch) {
      entry.timestamp = timestampMatch[1];
    }

    const levelMatch = line.match(/\s+(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE)\s+/);
    if (levelMatch) {
      entry.level = levelMatch[1];
      entry.isError = ["ERROR", "FATAL"].includes(levelMatch[1]);
      entry.isWarning = ["WARN", "WARNING"].includes(levelMatch[1]);
    }

    // Detect LocalStack AWS API format: "AWS s3.PutObject => 404 (NoSuchBucket)"
    const localstackApiMatch = line.match(
      /AWS\s+([a-z0-9_-]+)\.([A-Za-z]+)\s*=>\s*(\d{3})\s*(?:\(([^)]+)\))?/
    );
    if (localstackApiMatch) {
      entry.isApiCall = true;
      entry.service = localstackApiMatch[1].toLowerCase();
      entry.operation = localstackApiMatch[2];
      entry.statusCode = parseInt(localstackApiMatch[3]);
      entry.isError = entry.isError || entry.statusCode >= 400;

      // Extract error details from parentheses
      if (localstackApiMatch[4]) {
        entry.message = `${localstackApiMatch[2]} failed: ${localstackApiMatch[4]} (${entry.statusCode})`;
      }
    }

    // Detect other API call patterns as fallback
    const otherApiPatterns = [
      // HTTP method patterns
      /(GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS)\s+[^\s]+\s+(\d{3})/,
      // Status code with description
      /(\d{3})\s+(OK|Created|Accepted|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Internal Server Error|Bad Gateway|Service Unavailable)/i,
    ];

    if (!entry.isApiCall) {
      for (const pattern of otherApiPatterns) {
        const match = line.match(pattern);
        if (match) {
          entry.isApiCall = true;
          const statusCode = parseInt(match[match.length - 1] || match[1]);
          if (!isNaN(statusCode)) {
            entry.statusCode = statusCode;
            entry.isError = entry.isError || statusCode >= 400;
          }
          break;
        }
      }
    }

    // Extract AWS service name if not already found
    if (!entry.service) {
      const servicePatterns = [
        // LocalStack service mentions in logs
        /localstack\.services\.([a-z0-9_]+)/i,
        /localstack\.request\.aws.*?([a-z0-9_]+)\./i,
        // Direct service mentions
        /\b(s3|lambda|dynamodb|sqs|sns|apigateway|cloudformation|iam|sts|ec2|rds|kinesis|elasticsearch|cloudwatch|logs|events|secretsmanager|ssm|kms|route53|cloudfront|acm|cognito|stepfunctions|batch|ecs|eks|fargate)\b/i,
      ];

      for (const pattern of servicePatterns) {
        const match = line.match(pattern);
        if (match) {
          entry.service = match[1].toLowerCase().replace(/_/g, "");
          break;
        }
      }
    }

    // Extract operation names if not already found
    if (!entry.operation) {
      const operationPatterns = [
        // AWS API operation format
        /\b([A-Z][a-z]+[A-Z][a-zA-Z]*)\b/,
        // Action parameter
        /[?&]Action=([A-Za-z]+)/,
        // Operation in logs
        /operation[:\s=]+([A-Za-z]+)/i,
      ];

      for (const pattern of operationPatterns) {
        const match = line.match(pattern);
        if (
          match &&
          match[1].length > 2 &&
          !["INFO", "WARN", "ERROR", "DEBUG", "TRACE"].includes(match[1])
        ) {
          entry.operation = match[1];
          break;
        }
      }
    }

    // For LocalStack, also check for errors based on status codes, not just log levels
    if (entry.statusCode && entry.statusCode >= 400) {
      entry.isError = true;
    }

    // Detect IAM denial patterns for policy analysis
    const iamDenialPattern =
      /Request for service '([^']*)' by principal '([^']*)' for operation '([^']*)' denied\./;
    const iamMatch = line.match(iamDenialPattern);
    if (iamMatch) {
      entry.isIamDenial = true;
      entry.service = iamMatch[1].toLowerCase();
      entry.iamPrincipal = iamMatch[2];
      entry.iamAction = `${iamMatch[1].toLowerCase()}:${iamMatch[3]}`;
      entry.isError = true;
    }

    const iamResourcePattern = /Action '([^']*)' for '([^']*)'/g;
    let resourceMatch;
    while ((resourceMatch = iamResourcePattern.exec(line)) !== null) {
      entry.iamAction = resourceMatch[1];
      entry.iamResource = resourceMatch[2];
    }

    let cleanMessage = line;
    if (entry.timestamp) {
      cleanMessage = cleanMessage.replace(entry.timestamp, "").trim();
    }
    if (entry.level) {
      cleanMessage = cleanMessage.replace(new RegExp(`\\s+${entry.level}\\s+`), " ").trim();
    }

    cleanMessage = cleanMessage.replace(/^[:\-\s]*/, "").trim();
    cleanMessage = cleanMessage.replace(/^\[.*?\]\s*/, "").trim();

    if (!cleanMessage || cleanMessage === line) {
      entry.message = line; // Keep original if cleaning didn't work
    } else {
      entry.message = cleanMessage;
    }

    return entry;
  }

  /**
   * Group log entries by error message to reduce noise
   */
  groupLogsByError(logs: LogEntry[]): Map<string, LogEntry[]> {
    const groups = new Map<string, LogEntry[]>();

    for (const log of logs) {
      if (!log.isError && !log.isWarning) continue;

      let groupKey = log.message;

      // For LocalStack API errors, use a more specific grouping
      if (log.isApiCall && log.service && log.operation && log.statusCode) {
        groupKey = `${log.service}.${log.operation} => ${log.statusCode}`;
      } else {
        groupKey = groupKey
          .replace(/\b[a-fA-F0-9-]{8,}\b/g, "[ID]") // Replace UUIDs/IDs
          .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\b/g, "[TIMESTAMP]") // Replace timestamps
          .replace(/\b\d+\.\d+\.\d+\.\d+\b/g, "[IP]") // Replace IP addresses
          .replace(/\bport\s+\d+\b/g, "port [PORT]") // Replace port numbers
          .replace(/\b\d{3,}\b/g, "[NUMBER]"); // Replace large numbers
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(log);
    }

    return groups;
  }

  /**
   * Extract API call statistics
   */
  analyzeApiCalls(logs: LogEntry[]): {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    callsByService: Map<string, number>;
    callsByOperation: Map<string, number>;
    callsByStatus: Map<number, number>;
    failedCallDetails: LogEntry[];
  } {
    const apiLogs = logs.filter((log) => log.isApiCall);

    const callsByService = new Map<string, number>();
    const callsByOperation = new Map<string, number>();
    const callsByStatus = new Map<number, number>();
    const failedCallDetails: LogEntry[] = [];

    let successfulCalls = 0;
    let failedCalls = 0;

    for (const log of apiLogs) {
      if (log.service) {
        callsByService.set(log.service, (callsByService.get(log.service) || 0) + 1);
      }

      if (log.operation) {
        callsByOperation.set(log.operation, (callsByOperation.get(log.operation) || 0) + 1);
      }

      if (log.statusCode) {
        callsByStatus.set(log.statusCode, (callsByStatus.get(log.statusCode) || 0) + 1);

        if (log.statusCode >= 400) {
          failedCalls++;
          failedCallDetails.push(log);
        } else {
          successfulCalls++;
        }
      }
    }

    return {
      totalCalls: apiLogs.length,
      successfulCalls,
      failedCalls,
      callsByService,
      callsByOperation,
      callsByStatus,
      failedCallDetails,
    };
  }
}
