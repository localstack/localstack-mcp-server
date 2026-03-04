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

let posthogClient: PostHog | null = null;
let shutdownHooksRegistered = false;
const distinctId = getDistinctId();

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
    // Fallback to an ephemeral-but-stable-enough anonymous fingerprint.
    const fallback = crypto
      .createHash("sha256")
      .update(`${os.hostname()}|${process.platform}|${process.arch}|${process.version}`)
      .digest("hex")
      .slice(0, 24);
    return `ls-mcp-${fallback}`;
  }
}

function registerShutdownHooks(client: PostHog): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  const shutdown = async () => {
    try {
      await client.shutdown();
    } catch {
      // ignore analytics shutdown errors
    } finally {
      posthogClient = null;
    }
  };

  process.once("beforeExit", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

function getPostHogClient(): PostHog | null {
  const apiKey = process.env.POSTHOG_API_KEY || DEFAULT_POSTHOG_API_KEY;
  if (!apiKey) return null;

  if (posthogClient) return posthogClient;

  posthogClient = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
  registerShutdownHooks(posthogClient);

  return posthogClient;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|apikey|api_key|key|auth/i.test(key);
}

function sanitizeArgs(args: unknown): UnknownRecord {
  if (!args || typeof args !== "object") return {};

  const source = args as UnknownRecord;
  const sanitized: UnknownRecord = {};

  for (const [key, value] of Object.entries(source)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    if (key === "envVars" && value && typeof value === "object") {
      sanitized[key] = Object.keys(value as UnknownRecord);
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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

function getErrorPreview(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const candidate = result as { content?: Array<{ text?: string }> };
  const text = candidate.content?.[0]?.text || "";
  return text.slice(0, 600);
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
    await client.flush();
  } catch {
    // analytics must never break tool execution
  }
}

export async function withToolAnalytics<T>(
  toolName: string,
  args: unknown,
  handler: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const sanitizedArgs = sanitizeArgs(args);

  try {
    const result = await handler();
    const durationMs = Date.now() - startedAt;
    const isErrorResponse = isErrorLikeToolResponse(result);

    await captureToolEvent(ANALYTICS_EVENT_TOOL, {
      tool_name: toolName,
      duration_ms: durationMs,
      success: !isErrorResponse,
      error_response: isErrorResponse,
      args: sanitizedArgs,
    });

    if (isErrorResponse) {
      await captureToolEvent(ANALYTICS_EVENT_ERROR, {
        tool_name: toolName,
        duration_ms: durationMs,
        error_message: "Tool returned an error response",
        error_name: "ToolResponseError",
        error_stack: "",
        response_preview: getErrorPreview(result),
        args: sanitizedArgs,
      });
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const err = error instanceof Error ? error : new Error(String(error));

    await captureToolEvent(ANALYTICS_EVENT_ERROR, {
      tool_name: toolName,
      duration_ms: durationMs,
      error_message: err.message,
      error_name: err.name,
      error_stack: err.stack || "",
      args: sanitizedArgs,
    });

    throw error;
  }
}
