import fs from "fs";
import path from "path";
import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { ResponseBuilder } from "../core/response-builder";
import {
  runPreflights,
  requireAuthToken,
  requireLocalStackRunning,
  requireProFeature,
} from "../core/preflight";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature } from "../lib/localstack/license-checker";
import {
  StateManagementApiClient,
  type ApiResult,
  type StateExportResult,
} from "../lib/localstack/localstack.client";

const DEFAULT_EXPORT_PATH = "ls-state-export";

export const schema = {
  action: z
    .enum(["export", "import", "reset", "inspect"])
    .describe(
      "The local LocalStack state action to perform through the LocalStack State REST API. Use this tool for file-based state export/import workflows on disk. Use Cloud Pods instead when the user wants remote cloud-backed state snapshots."
    ),
  file_path: z
    .string()
    .trim()
    .optional()
    .describe(
      "Local file path for state export or import. Required for import. For export, defaults to ls-state-export in the MCP server working directory if omitted."
    ),
  services: z
    .union([z.array(z.string().trim().min(1)), z.string().trim().min(1)])
    .optional()
    .describe(
      "Optional AWS service names for service-level granularity, such as ['s3', 'lambda'] or 's3,lambda'. Supported for export, reset, and inspect. Import restores the services contained in the state file."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-state-management",
  description:
    "Export, import, reset, and inspect LocalStack state using local file-based workflows on disk.",
  annotations: {
    title: "LocalStack State Management",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export type StateManagementArgs = InferSchema<typeof schema>;

interface ValidationResult {
  error?: ReturnType<typeof ResponseBuilder.error>;
  serviceList?: string[];
  outputPath?: string;
}

export default async function localstackStateManagement(args: StateManagementArgs) {
  return withToolAnalytics(
    "localstack-state-management",
    buildStateAnalyticsArgs(args),
    async () => {
      const preflightError = await runPreflights([
        requireAuthToken(),
        requireLocalStackRunning(),
        requireProFeature(ProFeature.STATE_MANAGEMENT),
      ]);
      if (preflightError) return preflightError;

      const validation = validateStateManagementArgs(args);
      if (validation.error) return validation.error;

      const client = new StateManagementApiClient();

      switch (args.action) {
        case "export":
          return await handleExport(client, validation);
        case "import":
          return await handleImport(client, validation);
        case "reset":
          return await handleReset(client, validation);
        case "inspect":
          return await handleInspect(client, validation);
        default:
          return ResponseBuilder.error("Unknown Action", `Unsupported action: ${args.action}`);
      }
    }
  );
}

export function buildStateAnalyticsArgs(args: StateManagementArgs) {
  const services = normalizeServices(args.services);
  return {
    action: args.action,
    has_file_path: Boolean(args.file_path),
    services_count: services.length || undefined,
  };
}

export function normalizeServices(services: StateManagementArgs["services"]): string[] {
  const raw = Array.isArray(services) ? services : services?.split(",");
  return Array.from(new Set((raw ?? []).map((service) => service.trim()).filter(Boolean)));
}

export function validateStateManagementArgs(args: StateManagementArgs): ValidationResult {
  const services = normalizeServices(args.services);
  const filePath = args.file_path?.trim();

  switch (args.action) {
    case "export": {
      const destination = filePath || DEFAULT_EXPORT_PATH;
      const parent = path.dirname(path.resolve(destination));
      if (!fs.existsSync(parent)) {
        return {
          error: ResponseBuilder.error(
            "Export Path Not Found",
            `The parent directory for \`${destination}\` does not exist: \`${parent}\`.`
          ),
        };
      }

      return { serviceList: services, outputPath: destination };
    }

    case "import": {
      if (!filePath) {
        return {
          error: ResponseBuilder.error(
            "Missing File Path",
            "The `import` action requires `file_path` pointing to a file previously created by `localstack state export`."
          ),
        };
      }
      if (!fs.existsSync(filePath)) {
        return {
          error: ResponseBuilder.error(
            "Import File Not Found",
            `The state file \`${filePath}\` does not exist.`
          ),
        };
      }
      if (services.length > 0) {
        return {
          error: ResponseBuilder.error(
            "Unsupported Service Filter",
            "`localstack state import` restores the services contained in the exported state file. Service-level filtering is supported for export, reset, and inspect."
          ),
        };
      }
      return { outputPath: filePath };
    }

    case "reset": {
      if (filePath) {
        return {
          error: ResponseBuilder.error(
            "Unsupported File Path",
            "The `reset` action does not use `file_path`."
          ),
        };
      }
      return { serviceList: services };
    }

    case "inspect": {
      if (filePath) {
        return {
          error: ResponseBuilder.error(
            "Unsupported File Path",
            "The `inspect` action reads state from the running LocalStack instance and does not use `file_path`."
          ),
        };
      }
      return { serviceList: services };
    }

    default:
      return {
        error: ResponseBuilder.error("Unknown Action", `Unsupported action: ${args.action}`),
      };
  }
}

async function handleExport(client: StateManagementApiClient, validation: ValidationResult) {
  const result = await client.exportState(validation.serviceList);
  if (!result.success) return formatStateApiError("export", result);

  const outputPath = validation.outputPath ?? DEFAULT_EXPORT_PATH;
  fs.writeFileSync(outputPath, result.data.content);
  return formatExportSuccess(outputPath, result.data, validation.serviceList ?? []);
}

async function handleImport(client: StateManagementApiClient, validation: ValidationResult) {
  const outputPath = validation.outputPath;
  if (!outputPath) {
    return ResponseBuilder.error("Missing File Path", "The `import` action requires `file_path`.");
  }

  const content = fs.readFileSync(outputPath);
  const result = await client.importState(content);
  if (!result.success) return formatStateApiError("import", result);

  const details = result.data?.trim();
  return ResponseBuilder.markdown(
    `## LocalStack State Imported\n\n**File:** \`${outputPath}\`\n\nImported local state from disk using the LocalStack State REST API. Use Cloud Pods when you need remote cloud-backed state snapshots.${details ? `\n\n${details}` : ""}`
  );
}

async function handleReset(client: StateManagementApiClient, validation: ValidationResult) {
  const result = await client.resetState(validation.serviceList);
  if (!result.success) return formatStateApiError("reset", result);

  const services = formatServiceList(validation.serviceList ?? []);
  return ResponseBuilder.markdown(
    `## LocalStack State Reset\n\n${validation.serviceList?.length ? "Selected service state was reset." : "All LocalStack service state was reset."}${services}`
  );
}

async function handleInspect(client: StateManagementApiClient, validation: ValidationResult) {
  const result = await client.inspectState();
  if (!result.success) return formatStateApiError("inspect", result);

  return formatInspectResult(result.data, validation.serviceList ?? []);
}

function formatExportSuccess(path: string, data: StateExportResult, services: string[]) {
  const exportedServices = data.services.length ? data.services : services;
  return ResponseBuilder.markdown(
    `## LocalStack State Exported\n\n**File:** \`${path}\`\n\n**Bytes written:** ${data.content.length}${formatServiceList(exportedServices)}`
  );
}

function formatServiceList(services: string[]) {
  return services.length
    ? `\n\n**Services:** ${services.map((service) => `\`${service}\``).join(", ")}`
    : "";
}

export function formatInspectResult(data: unknown, services: string[]) {
  if (!data) {
    return ResponseBuilder.markdown("## LocalStack State Inspect\n\nNo state data returned.");
  }

  const filtered = services.length > 0 ? filterInspectServices(data, services) : data;
  const servicesSummary = formatServiceList(services);
  return ResponseBuilder.markdown(
    `## LocalStack State Inspect${servicesSummary}\n\n\`\`\`json\n${JSON.stringify(filtered, null, 2)}\n\`\`\``
  );
}

export function filterInspectServices(data: unknown, services: string[]) {
  const serviceSet = new Set(services);
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;

  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).map(([account, details]) => {
      if (!details || typeof details !== "object" || Array.isArray(details)) {
        return [account, details];
      }
      return [
        account,
        Object.fromEntries(
          Object.entries(details as Record<string, unknown>).filter(([service]) =>
            serviceSet.has(service)
          )
        ),
      ];
    })
  );
}

function formatStateApiError(action: StateManagementArgs["action"], result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected State Management API Result");

  return ResponseBuilder.error(
    "State Management API Error",
    `The \`${action}\` action failed${result.statusCode ? ` with HTTP ${result.statusCode}` : ""}.${result.message ? `\n\n${result.message}` : ""}`
  );
}
