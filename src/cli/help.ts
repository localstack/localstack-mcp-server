import { ALL_CLIENT_IDS } from "../lib/wizard/clients/registry";

export const HELP_TEXT = `LocalStack MCP Server

Usage:
  npx -y @localstack/localstack-mcp-server              Start the MCP server (stdio)
  npx -y @localstack/localstack-mcp-server init         Set up the server in your MCP clients
  npx -y @localstack/localstack-mcp-server remove       Remove the server from your MCP clients

init options:
  --method <npx|docker>   How the MCP server should run (default: npx)
  --client <ids>          MCP clients to configure, comma-separated or repeated.
                          Valid: ${ALL_CLIENT_IDS.join(", ")}
  --token <token>         LocalStack Auth Token (default: $LOCALSTACK_AUTH_TOKEN)
  --config <pairs>        Extra LocalStack config vars, e.g. "DEBUG=1,PERSISTENCE=1"
  --cache-dir <path>      [docker] State/cache dir mounted into the container
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

Examples:
  npx -y @localstack/localstack-mcp-server init
  npx -y @localstack/localstack-mcp-server init --method npx --client cursor,claude-code
  npx -y @localstack/localstack-mcp-server init --method docker --client cursor --yes
  npx -y @localstack/localstack-mcp-server remove --client cursor

The auth token is read from $LOCALSTACK_AUTH_TOKEN when --token is not given.
Get yours at https://app.localstack.cloud/workspace/auth-tokens

The wizard writes and removes only the MCP server entry named "localstack".
`;
