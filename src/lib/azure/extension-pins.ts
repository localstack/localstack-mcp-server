import type { PinnedExtension } from "./extension-map";

/**
 * `docker/azure-extensions.txt`, embedded for the `install-azure-addons` command: the npm package
 * ships only `dist/`, so the command cannot read the file at run time. The Docker build and the install
 * script read the file itself; `extension-pins.test.ts` keeps the two equal.
 */
export const AZURE_EXTENSION_PINS: readonly PinnedExtension[] = [
  { name: "acrcssc", version: "1.0.0b8", preview: true },
  { name: "acrquery", version: "1.0.1", preview: false },
  { name: "acrtransfer", version: "2.0.0", preview: false },
  { name: "application-insights", version: "1.2.3", preview: false },
  { name: "azure-firewall", version: "2.2.1", preview: false },
  { name: "bastion", version: "1.4.3", preview: false },
  { name: "cdn", version: "1.0.0b3", preview: true },
  { name: "dns-resolver", version: "1.2.0", preview: false },
  { name: "documentdb", version: "1.0.0", preview: false },
  { name: "edge-action", version: "1.0.0b4", preview: true },
  { name: "eventgrid", version: "1.0.0b2", preview: true },
  { name: "express-route-cross-connection", version: "1.0.0", preview: false },
  { name: "fleet", version: "1.11.1", preview: false },
  { name: "front-door", version: "2.3.0", preview: false },
  { name: "ip-group", version: "1.0.1", preview: false },
  { name: "k8s-configuration", version: "2.3.0", preview: false },
  { name: "k8s-extension", version: "1.9.1", preview: false },
  { name: "monitor-control-service", version: "1.2.0", preview: false },
  { name: "nsp", version: "1.1.0", preview: false },
  { name: "resource-graph", version: "2.1.1", preview: false },
  { name: "scheduled-query", version: "1.0.0b2", preview: true },
  { name: "staticwebapp", version: "1.0.1", preview: false },
  { name: "virtual-network-manager", version: "3.0.2", preview: false },
  { name: "virtual-network-tap", version: "1.0.0b2", preview: true },
  { name: "virtual-wan", version: "1.0.1", preview: false },
  { name: "webapp", version: "0.4.0", preview: false },
];
