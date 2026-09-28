import { ALL_CLIENT_IDS } from "../lib/wizard/clients/registry";

export const HELP_TEXT = `LocalStack MCP Server

Usage:
  npx -y @localstack/localstack-mcp-server              Start the MCP server (stdio)
  npx -y @localstack/localstack-mcp-server init         Set up the server in your MCP clients
  npx -y @localstack/localstack-mcp-server remove       Remove the server from your MCP clients
  npx -y @localstack/localstack-mcp-server install-azure-addons
                                                        Install the Azure CLI extensions and Bicep
                                                        the Azure tool uses (needs the Azure CLI)

init options:
  --method <npx|docker>   How the MCP server should run (default: npx)
  --client <ids>          MCP clients to configure, comma-separated or repeated.
                          Valid: ${ALL_CLIENT_IDS.join(", ")}
  --token <token>         LocalStack Auth Token (default: $LOCALSTACK_AUTH_TOKEN)
  --config <pairs>        Extra LocalStack config vars, e.g. "DEBUG=1,PERSISTENCE=1"
  --cache-dir <path>      [docker] Deprecated and ignored (state lives in a named Docker volume)
                          (default: ~/.localstack-mcp)
  --workspace <path>      [docker] Workspace dir to mount for IaC deployments
                          (default: current directory; pass "" to skip)
  --image-tag <tag>       [docker] Image tag for localstack/localstack-mcp-server
                          (default: latest)
  --force                 Overwrite an existing "localstack" entry without asking
  -y, --yes               Accept defaults for everything not provided via flags;
                          existing entries are kept unless --force is also given
  -h, --help              Show this help

remove options:
  --client <ids>          Clients to remove "localstack" from (default: all with an entry)
  --force, -y, --yes      Don't ask for confirmation

install-azure-addons options:
  --no-extensions         Skip the 26 pinned Azure CLI extensions
                          (they go into ~/.localstack/azure/mcp-extensions)
  --no-bicep              Skip the pinned Bicep CLI (into ~/.localstack/azure/bin,
                          sha256-checked); a bicep on your PATH works as well
  -h, --help              Show this help
  The Azure CLI itself (az 2.85 or newer) is yours to install, as the README says;
  your own Azure CLI profile is never changed. The Docker image bundles all three.

Examples:
  npx -y @localstack/localstack-mcp-server init
  npx -y @localstack/localstack-mcp-server init --method npx --client cursor,claude-code
  npx -y @localstack/localstack-mcp-server init --method docker --client cursor --yes
  npx -y @localstack/localstack-mcp-server remove --client cursor
  npx -y @localstack/localstack-mcp-server install-azure-addons

The auth token is read from $LOCALSTACK_AUTH_TOKEN when --token is not given.
Get yours at https://app.localstack.cloud/workspace/auth-tokens

The wizard writes and removes only the MCP server entry named "localstack".
`;
