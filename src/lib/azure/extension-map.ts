import * as fs from "fs";
import * as path from "path";

/**
 * Which Azure CLI extension adds a command group. With `extension.use_dynamic_install=no`, a
 * command from a missing extension fails like a typo (`'graph' is misspelled or not recognized`)
 * and az never names the extension, so the hint needs this map: each entry is the shortest command
 * path core az 2.90 does not know (`afd` and `cdn` are core up to 2.87, where only the six
 * `afd rule` leaves are missing).
 */
export const EXTENSION_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  acrcssc: ["acr supply-chain"],
  acrquery: ["acr query"],
  acrtransfer: ["acr export-pipeline", "acr import-pipeline", "acr pipeline-run"],
  "application-insights": ["monitor app-insights"],
  "azure-firewall": ["network firewall"],
  bastion: ["network bastion"],
  cdn: [
    "afd",
    "cdn",
    "afd rule action show",
    "afd rule action update",
    "afd rule action wait",
    "afd rule condition show",
    "afd rule condition update",
    "afd rule condition wait",
  ],
  "dns-resolver": ["dns-resolver"],
  documentdb: ["documentdb"],
  "edge-action": ["edge-action"],
  eventgrid: ["eventgrid namespace"],
  "express-route-cross-connection": ["network cross-connection"],
  fleet: ["fleet"],
  "front-door": ["network front-door"],
  "ip-group": ["network ip-group"],
  "k8s-configuration": ["k8s-configuration"],
  "k8s-extension": ["k8s-extension"],
  "monitor-control-service": ["monitor data-collection"],
  nsp: ["network perimeter"],
  "resource-graph": ["graph"],
  "scheduled-query": ["monitor scheduled-query"],
  staticwebapp: ["staticwebapp dbconnection"],
  "virtual-network-manager": ["network manager"],
  "virtual-network-tap": ["network nic vtap-config", "network vnet tap"],
  "virtual-wan": [
    "network p2s-vpn-gateway",
    "network vhub",
    "network vpn-gateway",
    "network vpn-server-config",
    "network vpn-site",
    "network vwan",
  ],
  webapp: ["webapp scan"],
};

const GROUP_TO_EXTENSION: ReadonlyMap<string, string> = new Map(
  Object.entries(EXTENSION_COMMANDS).flatMap(([extension, groups]) =>
    groups.map((group): [string, string] => [group, extension])
  )
);

/** The command words of an argv: the tokens before the first flag. */
export function commandWords(argv: readonly string[]): string[] {
  const end = argv.findIndex((token) => token.startsWith("-"));
  return argv.slice(0, end < 0 ? argv.length : end);
}

/**
 * The extension that adds exactly this command path (up to the word az did not recognise), when
 * it is not installed. Exact on purpose: on az 2.85, in `afd bogus` the unknown word is a typo
 * under the core `afd` group, not a missing extension.
 */
export function extensionFor(
  words: readonly string[],
  installed: ReadonlySet<string>
): string | undefined {
  const extension = GROUP_TO_EXTENSION.get(words.join(" "));
  return extension && !installed.has(extension) ? extension : undefined;
}

export function missingExtensionHint(group: string, extension: string): string {
  return (
    `\`az ${group}\` comes from the \`${extension}\` Azure CLI extension, which is not installed. ` +
    `Install it with your own Azure CLI (\`az extension add --name ${extension}\`): the tool uses ` +
    "your extension directory. Meanwhile `rest` with a relative URL usually works."
  );
}

/**
 * The extensions installed in an extension directory. Like az itself, a subdirectory counts when
 * it holds package metadata (`*.dist-info` or `*.egg-info`); a missing directory means none.
 */
export function listInstalledExtensions(dir: string): Set<string> {
  const installed = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return installed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (fs.readdirSync(path.join(dir, entry.name)).some((name) => /\..+-info$/.test(name))) {
        installed.add(entry.name);
      }
    } catch {
      // unreadable: not installed
    }
  }
  return installed;
}
