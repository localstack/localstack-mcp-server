import { type XmcpConfig } from "xmcp";

const ICON_URL =
  "https://raw.githubusercontent.com/localstack/localstack-mcp-server/main/icon.png";

const config: XmcpConfig = {
  stdio: true,
  paths: {
    resources: false,
  },
  typescript: {
    skipTypeCheck: true,
  },
  template: {
    name: "LocalStack",
    description:
      "Manage and interact with LocalStack for local cloud development and testing",
    homePage: "https://www.localstack.cloud",
    icons: [
      {
        src: ICON_URL,
        mimeType: "image/png",
        sizes: ["256x256"],
      },
    ],
  },
  bundler: (cfg) => ({
    ...cfg,
    externals: [
      ...(Array.isArray(cfg.externals) ? cfg.externals : cfg.externals ? [cfg.externals] : []),
      ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
        if (request === "better-sqlite3") return callback(undefined, `commonjs ${request}`);
        callback();
      },
    ],
  }),
};

export default config;
