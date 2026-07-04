import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import {
  PlatformApiClient,
  describePlatformError,
  type EphemeralInstance,
} from "../lib/localstack/platform.client";

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
    .describe("Lifetime in minutes for create action. Defaults to the platform default when omitted."),
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
      "Additional environment variables to pass to the ephemeral instance (create action only)."
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

      // Ephemeral instances are cloud-hosted: everything goes through the LocalStack
      // platform API — no local container, CLI, or Docker daemon involved.
      const client = new PlatformApiClient(process.env.LOCALSTACK_AUTH_TOKEN!.trim());

      switch (action) {
        case "create":
          return await handleCreate(client, { name, lifetime, extension, cloudPod, envVars });
        case "list":
          return await handleList(client);
        case "logs":
          return await handleLogs(client, { name });
        case "delete":
          return await handleDelete(client, { name });
        default:
          return ResponseBuilder.error("Unknown action", `Unsupported action: ${action}`);
      }
    }
  );
}

function formatCreateResponse(payload: EphemeralInstance): string {
  const endpoint = String(payload.endpoint_url ?? "N/A");
  const id = String(payload.id ?? payload.instance_name ?? "N/A");
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

async function handleCreate(
  client: PlatformApiClient,
  {
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
  }
) {
  if (!name?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `create` action requires the `name` parameter."
    );
  }

  const mergedEnvVars: Record<string, string> = { ...(envVars || {}) };
  if (extension) {
    mergedEnvVars.EXTENSION_AUTO_INSTALL = extension;
  }
  if (cloudPod) {
    mergedEnvVars.CLOUD_POD_NAME = cloudPod;
  }

  for (const key of Object.keys(mergedEnvVars)) {
    if (!key || key.includes("=")) {
      return ResponseBuilder.error(
        "Invalid Environment Variable Key",
        `Invalid env var key '${key}'. Keys must be non-empty and cannot contain '='.`
      );
    }
  }

  try {
    const instance = await client.createEphemeralInstance({
      name: name.trim(),
      lifetime,
      envVars: mergedEnvVars,
    });
    return ResponseBuilder.markdown(formatCreateResponse(instance));
  } catch (error) {
    return ResponseBuilder.error(
      "Create Failed",
      describePlatformError(error, `ephemeral instance '${name}'`)
    );
  }
}

async function handleList(client: PlatformApiClient) {
  try {
    const instances = await client.listEphemeralInstances();
    if (instances.length === 0) {
      return ResponseBuilder.markdown(
        "## Ephemeral Instances\n\nNo ephemeral instances found in your LocalStack Cloud workspace."
      );
    }
    return ResponseBuilder.markdown(
      `## Ephemeral Instances\n\n\`\`\`json\n${JSON.stringify(instances, null, 2)}\n\`\`\``
    );
  } catch (error) {
    return ResponseBuilder.error(
      "List Failed",
      describePlatformError(error, "ephemeral instances")
    );
  }
}

async function handleLogs(client: PlatformApiClient, { name }: { name?: string }) {
  if (!name?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `logs` action requires the `name` parameter."
    );
  }

  try {
    const logs = await client.getEphemeralInstanceLogs(name.trim());
    if (!logs.trim()) {
      return ResponseBuilder.markdown(`No logs available for ephemeral instance '${name}'.`);
    }
    return ResponseBuilder.markdown(
      `## Ephemeral Instance Logs: ${name}\n\n\`\`\`\n${logs}\n\`\`\``
    );
  } catch (error) {
    return ResponseBuilder.error(
      "Logs Failed",
      describePlatformError(error, `ephemeral instance '${name}'`)
    );
  }
}

async function handleDelete(client: PlatformApiClient, { name }: { name?: string }) {
  if (!name?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `delete` action requires the `name` parameter."
    );
  }

  try {
    await client.deleteEphemeralInstance(name.trim());
    return ResponseBuilder.markdown(`Successfully deleted instance: ${name} ✅`);
  } catch (error) {
    return ResponseBuilder.error(
      "Delete Failed",
      describePlatformError(error, `ephemeral instance '${name}'`)
    );
  }
}
