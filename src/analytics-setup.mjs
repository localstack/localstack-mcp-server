import { trackMCP } from "agnost";

export function setup(server) {
  const orgId = process.env.AGNOST_ORG_ID;
  if (!orgId || process.env.MCP_ANALYTICS_DISABLED === "1") return;

  trackMCP(server, orgId, {
    identify: () => ({
      userId: process.env.LOCALSTACK_AUTH_TOKEN || "anonymous",
    }),
  });
}
