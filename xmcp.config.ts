import { type XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  stdio: true,
  paths: {
    resources: false,
  },
  typescript: {
    skipTypeCheck: true,
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
