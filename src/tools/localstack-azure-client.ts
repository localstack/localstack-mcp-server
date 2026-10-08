import { z } from "zod";
import { type InferSchema, type ToolExtraArguments, type ToolMetadata } from "xmcp";
import { requireAuthToken, runPreflights } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { formatAzResult } from "../lib/azure/output";
import { evaluateAzCommand } from "../lib/azure/policy";
import {
  requireAzureCli,
  requireAzureCliConfigured,
  requireAzureConfig,
  requireAzureEmulatorRunning,
} from "../lib/azure/preflight";
import { progressSender } from "../lib/azure/runner";
import { azureConfig, installedExtensionNames, runAzCommand } from "../lib/azure/services";

export const schema = {
  command: z
    .string()
    .trim()
    .min(1, { message: "The command string cannot be empty." })
    .describe(
      "One Azure CLI command, with or without the leading `az`, for example `group create --name demo --location westeurope`. No shell syntax: no pipes, `&&`, redirects or `$(...)`."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-azure-client",
  description:
    "Run Azure CLI (`az`) commands against the LocalStack Azure emulator. The tool keeps its own Azure CLI profile, logged in to the emulator with a dummy account, so your own Azure login is never used or changed. Relative file paths resolve against the server's working directory (LOCALSTACK_AZ_WORKDIR). For an operation without a command, use `rest` with a relative URL; start the emulator with `localstack-management` (service: azure).",
  annotations: {
    title: "LocalStack Azure Client",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export default async function localstackAzureClient(
  { command }: InferSchema<typeof schema>,
  extra?: ToolExtraArguments
) {
  return withToolAnalytics("localstack-azure-client", { command }, async () => {
    try {
      // The token, the settings and the policy first: a refusal needs no emulator.
      const early = requireAuthToken() ?? requireAzureConfig();
      if (early) return early;
      const policy = evaluateAzCommand(command);
      if (!policy.ok) return ResponseBuilder.error(policy.title, policy.message);

      // Both run at once; a missing az is reported first, as the more basic prerequisite.
      const preflightError =
        (await runPreflights([requireAzureCli(), requireAzureEmulatorRunning()])) ??
        (await requireAzureCliConfigured());
      if (preflightError) return preflightError;

      const config = azureConfig();
      const result = await runAzCommand(policy.argv, {
        signal: extra?.signal,
        onProgress: progressSender(extra),
      });
      return formatAzResult(result, {
        argv: policy.argv,
        notes: policy.notes,
        timeoutSeconds: config.timeoutMs / 1000,
        healthBaseUrl: config.healthBaseUrl,
        installedExtensions: installedExtensionNames(),
      });
    } catch (error) {
      return ResponseBuilder.error(
        "Azure Tool Error",
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}
