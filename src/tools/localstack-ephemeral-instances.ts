import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runCommand, stripAnsiCodes } from "../core/command-runner";
import { runPreflights, requireLocalStackCli, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";

export const schema = {
  action: z
    .enum(["create", "list", "logs", "delete"])
    .describe("The Ephemeral Instances action to perform."),
  name: z
    .string()
    .optional()
    .describe("Instance name. Required for create, logs, and delete actions."),
  lifetime: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Lifetime in minutes for create action. Defaults to CLI default when omitted."),
  extension: z
    .string()
    .optional()
    .describe(
      "Optional extension package to preload for create action. This is passed as EXTENSION_AUTO_INSTALL."
    ),
  cloudPod: z
    .string()
    .optional()
    .describe(
      "Optional Cloud Pod name to initialize state for create action. This is passed as CLOUD_POD_NAME."
    ),
  envVars: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Additional environment variables to pass to the ephemeral instance (create action only), translated to repeated --env KEY=VALUE flags."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-ephemeral-instances",
  description:
    "Manage cloud-hosted LocalStack Ephemeral Instances: create, list, fetch logs, and delete.",
  annotations: {
    title: "LocalStack Ephemeral Instances",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function localstackEphemeralInstances({
  action,
  name,
  lifetime,
  extension,
  cloudPod,
  envVars,
}: InferSchema<typeof schema>) {
  return withToolAnalytics(
    "localstack-ephemeral-instances",
    {
      action,
      name,
      lifetime,
      extension,
      cloudPod,
      envVarKeys: envVars ? Object.keys(envVars) : [],
    },
    async () => {
      const authError = requireAuthToken();
      if (authError) return authError;

      const preflightError = await runPreflights([requireLocalStackCli()]);
      if (preflightError) return preflightError;

      switch (action) {
        case "create":
          return await handleCreate({ name, lifetime, extension, cloudPod, envVars });
        case "list":
          return await handleList();
        case "logs":
          return await handleLogs({ name });
        case "delete":
          return await handleDelete({ name });
        default:
          return ResponseBuilder.error("Unknown action", `Unsupported action: ${action}`);
      }
    }
  );
}

function cleanOutput(stdout: string, stderr: string): { stdout: string; stderr: string; combined: string } {
  const cleanStdout = stripAnsiCodes(stdout || "").trim();
  const cleanStderr = stripAnsiCodes(stderr || "").trim();
  const combined = [cleanStdout, cleanStderr].filter((part) => part.length > 0).join("\n").trim();
  return { stdout: cleanStdout, stderr: cleanStderr, combined };
}

function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const startObject = trimmed.indexOf("{");
    const endObject = trimmed.lastIndexOf("}");
    if (startObject !== -1 && endObject > startObject) {
      const candidate = trimmed.slice(startObject, endObject + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }
    const startArray = trimmed.indexOf("[");
    const endArray = trimmed.lastIndexOf("]");
    if (startArray !== -1 && endArray > startArray) {
      const candidate = trimmed.slice(startArray, endArray + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }
    return null;
  }
}

function formatCreateResponse(payload: Record<string, unknown>): string {
  const endpoint = String(payload.endpoint_url ?? "N/A");
  const id = String(payload.id ?? "N/A");
  const status = String(payload.status ?? "unknown");
  const creationTime = String(payload.creation_time ?? "N/A");
  const expiryTime = String(payload.expiry_time ?? "N/A");

  return `## Ephemeral Instance Created

- **ID:** ${id}
- **Status:** ${status}
- **Endpoint URL:** ${endpoint}
- **Creation Time:** ${creationTime}
- **Expiry Time:** ${expiryTime}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Use this endpoint with your tools, for example:
\`aws --endpoint-url=${endpoint} s3 ls\``;
}

async function handleCreate({
  name,
  lifetime,
  extension,
  cloudPod,
  envVars,
}: {
  name?: string;
  lifetime?: number;
  extension?: string;
  cloudPod?: string;
  envVars?: Record<string, string>;
}) {
  if (!name?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `create` action requires the `name` parameter."
    );
  }

  const args = ["ephemeral", "create", "--name", name.trim()];
  if (lifetime !== undefined) {
    args.push("--lifetime", String(lifetime));
  }

  const mergedEnvVars: Record<string, string> = { ...(envVars || {}) };
  if (extension) {
    mergedEnvVars.EXTENSION_AUTO_INSTALL = extension;
  }
  if (cloudPod) {
    mergedEnvVars.CLOUD_POD_NAME = cloudPod;
  }

  for (const [key, value] of Object.entries(mergedEnvVars)) {
    if (!key || key.includes("=")) {
      return ResponseBuilder.error(
        "Invalid Environment Variable Key",
        `Invalid env var key '${key}'. Keys must be non-empty and cannot contain '='.`
      );
    }
    args.push("--env", `${key}=${value}`);
  }

  const result = await runCommand("localstack", args, {
    env: { ...process.env },
    timeout: 180000,
  });
  const cleaned = cleanOutput(result.stdout, result.stderr);

  if (result.exitCode !== 0) {
    return ResponseBuilder.error(
      "Create Failed",
      cleaned.combined || "Failed to create ephemeral instance."
    );
  }

  const parsed = parseJsonFromText(cleaned.stdout) || parseJsonFromText(cleaned.combined);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return ResponseBuilder.markdown(formatCreateResponse(parsed as Record<string, unknown>));
  }

  return ResponseBuilder.markdown(
    `## Ephemeral Instance Created\n\n${cleaned.combined || "Instance created successfully."}`
  );
}

async function handleList() {
  const result = await runCommand("localstack", ["ephemeral", "list"], {
    env: { ...process.env },
    timeout: 120000,
  });
  const cleaned = cleanOutput(result.stdout, result.stderr);

  if (result.exitCode !== 0) {
    return ResponseBuilder.error("List Failed", cleaned.combined || "Failed to list ephemeral instances.");
  }

  const parsed = parseJsonFromText(cleaned.stdout) || parseJsonFromText(cleaned.combined);
  if (parsed === null) {
    return ResponseBuilder.markdown(
      `## Ephemeral Instances\n\n\`\`\`\n${cleaned.combined || "No instances found."}\n\`\`\``
    );
  }

  return ResponseBuilder.markdown(
    `## Ephemeral Instances\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
  );
}

async function handleLogs({ name }: { name?: string }) {
  if (!name?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `logs` action requires the `name` parameter."
    );
  }

  const result = await runCommand("localstack", ["ephemeral", "logs", "--name", name.trim()], {
    env: { ...process.env },
    timeout: 180000,
  });
  const cleaned = cleanOutput(result.stdout, result.stderr);

  if (result.exitCode !== 0) {
    return ResponseBuilder.error(
      "Logs Failed",
      cleaned.combined || `Failed to fetch logs for instance '${name}'.`
    );
  }

  if (!cleaned.combined) {
    return ResponseBuilder.markdown(`No logs available for ephemeral instance '${name}'.`);
  }

  return ResponseBuilder.markdown(
    `## Ephemeral Instance Logs: ${name}\n\n\`\`\`\n${cleaned.combined}\n\`\`\``
  );
}

async function handleDelete({ name }: { name?: string }) {
  if (!name?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `delete` action requires the `name` parameter."
    );
  }

  const result = await runCommand("localstack", ["ephemeral", "delete", "--name", name.trim()], {
    env: { ...process.env },
    timeout: 120000,
  });
  const cleaned = cleanOutput(result.stdout, result.stderr);

  if (result.exitCode !== 0) {
    return ResponseBuilder.error(
      "Delete Failed",
      cleaned.combined || `Failed to delete ephemeral instance '${name}'.`
    );
  }

  return ResponseBuilder.markdown(cleaned.combined || `Successfully deleted instance: ${name} ✅`);
}
