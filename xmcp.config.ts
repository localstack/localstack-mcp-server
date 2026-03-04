import { type XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  stdio: true,
  paths: {
    prompts: false,
    resources: false,
  },
  typescript: {
    skipTypeCheck: true,
  },
};

export default config;
