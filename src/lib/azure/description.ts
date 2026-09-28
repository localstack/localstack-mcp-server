/**
 * The `localstack-azure-client` tool description (plan task 2.10, Appendix C;
 * decision D7). It is filled once at server start and then static, so clients can
 * cache the tool list. `tools/list` is served before any bootstrap, so the
 * subscription is a constant; DR2 watches the emulator's value.
 */

export const AZURE_SUBSCRIPTION_ID = "00000000-0000-0000-0000-000000000000";

export const AZURE_COMMAND_DESCRIPTION =
  "The Azure CLI command to run, without the leading 'az' (e.g. 'group list').";

export function buildAzureClientDescription(ctx: {
  workdir: string;
  maxOutputChars: number;
}): string {
  const limit = ctx.maxOutputChars.toLocaleString("en-US");
  return [
    "Run an Azure CLI (az) command against the local LocalStack for Azure emulator and return its output.",
    "",
    `- Runs against the local emulator only, never real Azure: the CLI is pre-configured with a "LocalStack" cloud and a dummy login, so all data and secrets are local test data. Subscription: ${AZURE_SUBSCRIPTION_ID}. Default location: westeurope.`,
    "- Give ONE command without the leading `az`. No pipes, redirects, chaining, $(...), backticks or newlines outside quotes. Quote values with spaces, JSON or JMESPath: --query \"[?name=='a'].id | [0]\". Filter with --query and use -o tsv for single values.",
    "- Creates wait until the resource is ready; don't pass --no-wait unless asked. If your client stops waiting after about a minute, use --no-wait and then poll with show.",
    `- No dedicated command? Use \`rest\` with a RELATIVE URL, e.g. rest --method get --url "/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/rg1?api-version=2022-09-01".`,
    "- Unsure of a command or its parameters? Run it with --help first.",
    `- Files must be inside ${ctx.workdir}. Not allowed: login/logout, cloud and config changes, extension installs, upgrade, interactive, and commands that open a browser, shell or tunnel.`,
    `- Output: the CLI's JSON, truncated past ${limit} characters. Errors come back verbatim, with a hint when the emulator does not implement an operation.`,
    "Examples: group create --name rg1 --location westeurope | storage account create --name st1abc --resource-group rg1 --sku Standard_LRS | keyvault secret set --vault-name kv1abc --name pw --value x",
  ].join("\n");
}
