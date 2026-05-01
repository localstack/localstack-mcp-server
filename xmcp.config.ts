import { type XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  stdio: true,
  paths: {
    resources: false,
  },
  typescript: {
    skipTypeCheck: true,
  },
};

export default config;
