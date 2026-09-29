/**
 * The tool definitions E2 sends to Claude, per variant. A variant changes only what the
 * runner sends to the Messages API, never the server: the server's own `tools/list` entry is
 * the base, and a variant whose anchor text is missing from it fails loudly instead of
 * silently testing the default.
 *
 *   compact       the server's description as listed (the shipped default)
 *   long          a longer description in sections (Context, Input, Output, Rules,
 *                 Examples)
 *   help-tool     compact, with --help replaced by a separate `az_help` tool
 *   no-test-data  compact without the "local test data" wording
 *
 * No runtime imports of local modules (run.mjs loads this file with type stripping).
 */
import type { ToolDef } from "./types";

export const AZURE_TOOL = "localstack-azure-client";
export const HELP_TOOL = "az_help";
export const VARIANTS = ["compact", "long", "help-tool", "no-test-data"] as const;
export type Variant = (typeof VARIANTS)[number];

/** Tools never offered with --all-tools: `localstack-management` can stop the emulator
 * the evals run on. */
export const WITHHELD_TOOLS = ["localstack-management"];

export const HELP_SENTENCE = "- Unsure of a command or its parameters? Run it with --help first.";
export const HELP_TOOL_SENTENCE =
  '- Unsure of a command or its parameters? Call `az_help` with the command or group (for example "containerapp env create") instead of guessing.';
export const TEST_DATA_CLAUSE = ", so all data and secrets are local test data";

/** The `az_help` tool of the help-tool variant. */
export const AZ_HELP_DESCRIPTION =
  "Show the Azure CLI help for a command group or command (`az <prefix> --help`): " +
  "its subcommands, or its parameters with descriptions and examples. Call this " +
  "before running a command whose name or parameters you are unsure of. Examples " +
  'of `prefix`: "storage account create", "containerapp env", "afd route create".';

export const AZ_HELP_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prefix: {
      type: "string",
      description:
        "The command group or command, without the leading 'az' (e.g. \"storage account create\").",
    },
  },
  required: ["prefix"],
  additionalProperties: false,
};

/**
 * The long description: the same rules as compact, in sections. It states what this tool
 * does: one command per call, the CLI's JSON text as output, `rest` with a relative URL (an
 * absolute management.azure.com URL is rewritten onto the emulator), and --help for a command
 * the model is unsure of.
 */
export const LONG_DESCRIPTION = [
  "Run Azure CLI (`az`) commands against the local LocalStack for Azure emulator and return their output.",
  "",
  "Context",
  '- The CLI is already configured for the emulator: a "LocalStack" cloud is active and a service principal is logged in, so every command reaches only the local emulator, never real Azure. Do not run `az login`, `az logout` or `az cloud ...`: they are rejected because they would break that routing.',
  "- Subscription: 00000000-0000-0000-0000-000000000000. There is no default location: pass --location (for example westeurope) wherever a command needs one.",
  "- Write the command without the leading `az` (a leading `az` is accepted and ignored).",
  "- Extensions that commands need (cdn/afd, graph, k8s-configuration, k8s-extension, fleet, monitor app-insights and others) are pre-installed. Installing or updating extensions is not possible.",
  "",
  "Input",
  "- `command`: one command as a string.",
  "",
  "Output",
  '- On success: the command\'s JSON output. Use `--query` (JMESPath) to return only the fields you need, e.g. --query "{name:name, state:provisioningState}", and `-o tsv` for a single value.',
  "- On failure: the CLI's error message, verbatim. Read it: it usually names the missing or invalid argument.",
  "",
  "Rules",
  "- One CLI command per string: no pipes (|), redirects (>, <), chaining (&&, ||, ;), command substitution ($(...) or backticks), variables or newlines. Filter with --query instead of grep or jq.",
  '- Quote values that contain spaces or JSON, e.g. --tags "env=dev team=a" or --set properties.x=\'{"a":1}\'.',
  "- Long-running creates wait until the resource is ready unless you pass --no-wait. Don't pass --no-wait unless asked, so the next step can see the resource.",
  "- For an operation with no dedicated command, `rest` calls the ARM REST API directly. Use a relative URL, which stays on the emulator, e.g. rest --method put --url \"/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg1/providers/<Provider>/<type>/<name>?api-version=<version>\" --body '{...}'.",
  "- If you are unsure of a command's name or parameters, run it with --help first.",
  "",
  "Examples",
  "- group create --name rg1 --location westeurope",
  "- keyvault create --name kv1abc --resource-group rg1 --location westeurope",
  "- keyvault secret set --vault-name kv1abc --name db-password --value s3cret",
  "- network vnet create --resource-group rg1 --name vnet1 --address-prefix 10.0.0.0/16 --subnet-name default --subnet-prefix 10.0.1.0/24",
  "- servicebus queue create --resource-group rg1 --namespace-name sb1abc --name orders",
  '- storage account show --name st1abc --resource-group rg1 --query "{sku:sku.name, location:location}"',
].join("\n");

/** An MCP tools/list entry (the fields used here). */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface VariantTools {
  variant: Variant;
  tools: ToolDef[];
  /** The variant offers the synthetic az_help tool, which the runner implements. */
  helpTool: boolean;
  /** The Azure tool's description as sent. */
  azureDescription: string;
}

/** A Messages API tool from an MCP entry (the `$schema` line is dropped). */
export function toToolDef(t: ListedTool, description?: string): ToolDef {
  const schema = { ...(t.inputSchema ?? { type: "object", properties: {} }) };
  delete schema.$schema;
  return { name: t.name, description: description ?? t.description ?? "", input_schema: schema };
}

export function isVariant(name: string): name is Variant {
  return (VARIANTS as readonly string[]).includes(name);
}

/** The Azure tool's description for a variant, from the server's own description. */
export function variantDescription(variant: Variant, listed: string): string {
  switch (variant) {
    case "compact":
      return listed;
    case "long":
      return LONG_DESCRIPTION;
    case "help-tool":
      if (!listed.includes(HELP_SENTENCE)) {
        throw new Error(
          `variant help-tool: the server's description no longer contains "${HELP_SENTENCE}"`
        );
      }
      return listed.replace(HELP_SENTENCE, HELP_TOOL_SENTENCE);
    case "no-test-data":
      if (!listed.includes(TEST_DATA_CLAUSE)) {
        throw new Error(
          `variant no-test-data: the server's description no longer contains "${TEST_DATA_CLAUSE}"`
        );
      }
      return listed.replace(TEST_DATA_CLAUSE, "");
  }
}

/**
 * The tool list a variant sends: the Azure tool (with the variant's description), the
 * synthetic az_help for help-tool, and with `allTools` every other listed tool but the
 * withheld ones. Sorted by name, so the prompt-cache prefix stays byte-stable.
 */
export function buildVariantTools(
  variant: Variant,
  listed: ListedTool[],
  allTools = false
): VariantTools {
  const azure = listed.find((t) => t.name === AZURE_TOOL);
  if (!azure) throw new Error(`the server does not list ${AZURE_TOOL}`);
  const azureDescription = variantDescription(variant, azure.description ?? "");
  const tools: ToolDef[] = [toToolDef(azure, azureDescription)];
  const helpTool = variant === "help-tool";
  if (helpTool)
    tools.push({ name: HELP_TOOL, description: AZ_HELP_DESCRIPTION, input_schema: AZ_HELP_SCHEMA });
  if (allTools) {
    for (const t of listed) {
      if (t.name === AZURE_TOOL || WITHHELD_TOOLS.includes(t.name)) continue;
      tools.push(toToolDef(t));
    }
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { variant, tools, helpTool, azureDescription };
}

/** The Azure command a synthetic az_help call runs: `<prefix> --help`. */
export function helpCommand(prefix: string): string {
  const p = String(prefix ?? "")
    .trim()
    .replace(/^az\s+/, "");
  return /(^|\s)(--help|-h)(\s|$)/.test(p) ? p : `${p} --help`.trim();
}
