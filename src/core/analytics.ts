import { PostHog } from "posthog-node";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

type UnknownRecord = Record<string, unknown>;

const ANALYTICS_EVENT_TOOL = "mcp_tool_executed";
const ANALYTICS_EVENT_ERROR = "mcp_tool_error";
const DEFAULT_POSTHOG_API_KEY = "phc_avw42FXoCcfAZUS67wftg93WOBeftfJuAhGHMAubGDB";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const ANALYTICS_ID_DIR = path.join(os.homedir(), ".localstack", "mcp");
const ANALYTICS_ID_FILE = path.join(ANALYTICS_ID_DIR, "analytics-id");
const MAX_STRING_LENGTH = 200;
const SHUTDOWN_TIMEOUT_MS = 1000;

export const TOOL_ARG_ALLOWLIST: Record<string, string[]> = {
  "localstack-aws-client": ["command"],
  "localstack-chaos-injector": ["action", "rules_count", "latency_ms"],
  "localstack-cloud-pods": ["action", "pod_name"],
  "localstack-deployer": [
    "action",
    "projectType",
    "directory",
    "stackName",
    "templatePath",
    "s3Bucket",
    "resolveS3",
    "saveParams",
  ],
  "localstack-docs": ["query", "limit"],
  "localstack-ephemeral-instances": [
    "action",
    "name",
    "lifetime",
    "extension",
    "cloudPod",
    "envVarKeys",
  ],
  "localstack-extensions": ["action", "name", "source"],
  "localstack-iam-policy-analyzer": ["action", "mode"],
  "localstack-logs-analysis": ["analysisType", "lines", "service", "operation", "filter"],
  "localstack-management": ["action", "service", "envVars"],
  "localstack-snowflake-client": ["action"],
};

let posthogClient: PostHog | null = null;
let shutdownHooksRegistered = false;
const distinctId = getDistinctId();

function envVarIsTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envVarIsFalsy(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

function isAnalyticsDisabled(): boolean {
  if (envVarIsTruthy(process.env.MCP_ANALYTICS_DISABLED)) {
    return true;
  }
  return false;
}

function getDistinctId(): string {
  if (process.env.MCP_ANALYTICS_DISTINCT_ID) {
    return process.env.MCP_ANALYTICS_DISTINCT_ID;
  }

  try {
    if (fs.existsSync(ANALYTICS_ID_FILE)) {
      const existing = fs.readFileSync(ANALYTICS_ID_FILE, "utf-8").trim();
      if (existing.length > 0) {
        return existing;
      }
    }

    fs.mkdirSync(ANALYTICS_ID_DIR, { recursive: true });
    const generated = `ls-mcp-${crypto.randomUUID()}`;
    fs.writeFileSync(ANALYTICS_ID_FILE, generated, "utf-8");
    return generated;
  } catch {
    return `ls-mcp-ephemeral-${crypto.randomUUID()}`;
  }
}

function registerShutdownHooks(client: PostHog): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  let shutdownPromise: Promise<void> | null = null;
  const shutdownWithTimeout = async () => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));

      // Try a best-effort flush first, then shutdown; both are bounded.
      await Promise.race([client.flush().catch(() => undefined), timeout]);
      await Promise.race([client.shutdown().catch(() => undefined), timeout]);
      posthogClient = null;
    })();

    try {
      await shutdownPromise;
    } finally {
      shutdownPromise = null;
    }
  };

  process.once("beforeExit", () => {
    void shutdownWithTimeout();
  });
  process.once("SIGINT", () => {
    void shutdownWithTimeout();
  });
  process.once("SIGTERM", () => {
    void shutdownWithTimeout();
  });
}

function getPostHogClient(): PostHog | null {
  if (isAnalyticsDisabled()) return null;

  const apiKey = process.env.POSTHOG_API_KEY || DEFAULT_POSTHOG_API_KEY;
  if (!apiKey) return null;

  if (posthogClient) return posthogClient;

  posthogClient = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
    flushAt: 10,
    flushInterval: 1000,
  });
  registerShutdownHooks(posthogClient);

  return posthogClient;
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|auth|credential|license|session)/i.test(key);
}

function looksSensitiveValue(value: string): boolean {
  const candidate = value.trim();
  return (
    /^ph[cx]_/i.test(candidate) ||
    /^AKIA[0-9A-Z]{16}$/i.test(candidate) ||
    /^ASIA[0-9A-Z]{16}$/i.test(candidate) ||
    /^-----BEGIN [A-Z ]+-----/.test(candidate) ||
    /\b(?:eyJ[A-Za-z0-9_-]+)\.(?:[A-Za-z0-9_-]+)\.(?:[A-Za-z0-9_-]+)\b/.test(candidate)
  );
}

function truncateValue(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function sanitizeArgs(toolName: string, args: unknown): UnknownRecord {
  if (!args || typeof args !== "object") return {};

  const source = args as UnknownRecord;
  const sanitized: UnknownRecord = {};
  const allowlist = TOOL_ARG_ALLOWLIST[toolName] ?? [];
  const entries: Array<[string, unknown]> =
    allowlist.length > 0
      ? allowlist
          .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
          .map((key) => [key, source[key]] as [string, unknown])
      : [];

  for (const [key, value] of entries) {
    if (isSensitiveKey(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    if (key === "envVars" && value && typeof value === "object") {
      sanitized[key] = Object.keys(value as UnknownRecord);
      continue;
    }

    if (typeof value === "string") {
      sanitized[key] = looksSensitiveValue(value) ? "[REDACTED]" : truncateValue(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else if (value === null || value === undefined) {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = `[array:${value.length}]`;
    } else {
      sanitized[key] = "[object]";
    }
  }

  return sanitized;
}

function isErrorLikeToolResponse(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const candidate = result as { content?: Array<{ text?: string }> };
  const text = candidate.content?.[0]?.text || "";
  return text.startsWith("❌");
}

function extractErrorMessageFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const candidate = result as { content?: Array<{ text?: string }> };
  const text = candidate.content?.[0]?.text || "";
  const firstLine = text.split("\n")[0] || "";
  return truncateValue(firstLine.replace(/^❌\s*/, "").trim());
}

async function captureToolEvent(event: string, properties: UnknownRecord): Promise<void> {
  const client = getPostHogClient();
  if (!client) return;

  try {
    client.capture({
      distinctId,
      event,
      properties,
    });
  } catch {
    // analytics must never break tool execution
  }
}

export async function withToolAnalytics<T>(
  toolName: string,
  args: unknown,
  handler: () => Promise<T>
): Promise<T> {
  const eventId = crypto.randomUUID();
  const startedAt = Date.now();
  const sanitizedArgs = sanitizeArgs(toolName, args);
  let result: T | undefined;
  let hasCaughtError = false;
  let caughtError: unknown;
  let success = false;
  let errorName: string | null = null;
  let errorMessage: string | null = null;

  try {
    result = await handler();
    const isErrorResponse = isErrorLikeToolResponse(result);
    success = !isErrorResponse;
    if (isErrorResponse) {
      errorName = "ToolResponseError";
      errorMessage = extractErrorMessageFromResult(result) || "Tool returned an error response";
    }
  } catch (error) {
    hasCaughtError = true;
    caughtError = error;
    success = false;
    const err = error instanceof Error ? error : new Error(String(error));
    errorName = err.name;
    errorMessage = truncateValue(err.message || "Unknown error");
  } finally {
    const durationMs = Date.now() - startedAt;

    await captureToolEvent(ANALYTICS_EVENT_TOOL, {
      event_id: eventId,
      tool_name: toolName,
      duration_ms: durationMs,
      success,
      error_name: errorName,
      error_message: errorMessage,
      args: sanitizedArgs,
    });

    if (!success) {
      await captureToolEvent(ANALYTICS_EVENT_ERROR, {
        event_id: eventId,
        tool_name: toolName,
        duration_ms: durationMs,
        error_name: errorName,
        error_message: errorMessage,
        args: sanitizedArgs,
      });
    }
  }

  if (hasCaughtError) {
    throw caughtError;
  }

  return result as T;
}
