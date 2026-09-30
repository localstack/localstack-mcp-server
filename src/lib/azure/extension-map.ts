/**
 * The curated Azure CLI extensions and the command groups they add, for the
 * missing-extension hint.
 *
 * The tool runs `az` with `extension.use_dynamic_install=no`, so a command from an extension that
 * is not installed fails like a typo: `ERROR: 'graph' is misspelled or not recognized by the
 * system.`. az never names the extension, so the hint needs this map.
 *
 * This file is also loaded, unbundled, by `scripts/install-azure-extensions.mjs` through Node's
 * built-in TypeScript type stripping. Keep it free of runtime imports of other local modules and of
 * TypeScript syntax that needs a transform (enums, namespaces, parameter properties).
 */
import * as fs from "fs";
import * as path from "path";

export interface PinnedExtension {
  name: string;
  version: string;
  /** A preview-only build: `az extension add` needs `--allow-preview true`. */
  preview: boolean;
}

/**
 * Parses `docker/azure-extensions.txt`: one `name version [preview]` per line, `#` comment lines
 * and blank lines ignored. The Docker build reads the same file with `while read -r name version
 * flag`, so a trailing comment would land in `flag` there; this parser refuses it instead.
 */
export function parsePinList(text: string): PinnedExtension[] {
  const pins: PinnedExtension[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const where = `line ${index + 1}`;
    const fields = line.split(/\s+/);
    if (fields.length < 2 || fields.length > 3) {
      throw new Error(`${where}: expected "name version [preview]", got "${line}"`);
    }
    const [name, version, flag] = fields;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`${where}: invalid extension name "${name}"`);
    }
    if (!/^\d+(\.\d+)*([a-z]+\d*)?$/.test(version)) {
      throw new Error(`${where}: invalid version "${version}" for ${name}`);
    }
    if (flag !== undefined && flag !== "preview") {
      throw new Error(`${where}: the third field must be "preview", got "${flag}"`);
    }
    if (seen.has(name)) {
      throw new Error(`${where}: ${name} is listed twice`);
    }
    seen.add(name);
    pins.push({ name, version, preview: flag === "preview" });
  });
  return pins;
}

/**
 * The command groups (or commands) each curated extension adds, keyed by extension name.
 *
 * Each entry is the shortest command path that core `az` does not know: the token az reports as
 * "misspelled or not recognized" when the extension is missing. Derived by comparing the
 * command table of azure-cli 2.90.0 with the 26 extensions installed (every command whose
 * source is `ext:<name>`) with the core-only table, then checked against the core tables of
 * az 2.85.0 (MSI) and 2.87.0 (pip), dumped offline on
 * 2026-09-27. The keys agree across the three versions except for `cdn`, see below.
 *
 * `containerapp` is core in 2.85-2.90 (its extension overrides core commands and is not curated),
 * so it is not here. At start the handler builds the set of installed extensions
 * (`listInstalledExtensions`) and passes it to `extensionFor`.
 */
export const EXTENSION_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  acrcssc: ["acr supply-chain"],
  acrquery: ["acr query"],
  acrtransfer: ["acr export-pipeline", "acr import-pipeline", "acr pipeline-run"],
  "application-insights": ["monitor app-insights"],
  "azure-firewall": ["network firewall"],
  bastion: ["network bastion"],
  // `afd` and `cdn` are core (deprecated) in 2.85 and 2.87 and extension-only from 2.90. On the
  // older versions az recognises both groups itself, so only the six leaf commands their core
  // lacks can be reported as missing there; `afd` and `cdn` match only on 2.90 and later.
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

/** The command words of an argv: the leading tokens before the first flag. */
export function commandWords(tokens: readonly string[]): string[] {
  const words: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  return words;
}

/**
 * The curated extension that provides exactly this command path, when it is not installed.
 *
 * `tokens` is the command path up to and including the token az did not recognise, for example
 * `["monitor", "app-insights"]` → `application-insights`. The match is exact on purpose: for
 * `afd bogus` on az 2.85 the unknown token is `bogus` under the core `afd` group, which is a typo,
 * not a missing extension. Returns undefined when the extension is in `installed`; without
 * `installed`, every curated extension counts as missing.
 */
export function extensionFor(
  tokens: readonly string[],
  installed?: ReadonlySet<string>
): string | undefined {
  const words = commandWords(tokens);
  if (words.length === 0) return undefined;
  const extension = GROUP_TO_EXTENSION.get(words.join(" "));
  if (!extension || installed?.has(extension)) return undefined;
  return extension;
}

/**
 * The `extension` hint. On a host (npx) the extensions are installed once, by the user, with the
 * `install-azure-addons` command (spelled out here: this file has no runtime imports); in the
 * image all curated extensions are installed, so a miss there means the extension is not part of
 * the image.
 */
export function missingExtensionHint(group: string, ext: string, inDocker: boolean): string {
  if (inDocker) {
    return `\`${ext}\` is not in this image's curated set; use \`rest\` with a relative URL.`;
  }
  return (
    `\`az ${group}\` comes from the \`${ext}\` Azure CLI extension, which is not installed ` +
    `for this tool (automatic installs are disabled). Install the tool's extensions once with ` +
    "`npx -y @localstack/localstack-mcp-server install-azure-addons`; meanwhile `rest` with a " +
    "relative URL usually works."
  );
}

/**
 * The extensions installed in an `AZURE_EXTENSION_DIR`. Like az itself, a subdirectory counts when
 * it holds package metadata (`*.dist-info` or `*.egg-info`); a missing dir means none.
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
      const inner = fs.readdirSync(path.join(dir, entry.name));
      if (inner.some((name) => /\..+-info$/.test(name))) installed.add(entry.name);
    } catch {
      // unreadable: treat as not installed
    }
  }
  return installed;
}

/** The curated extensions that are not installed, for a start-up warning. */
export function missingCuratedExtensions(installed: ReadonlySet<string>): string[] {
  return Object.keys(EXTENSION_COMMANDS).filter((name) => !installed.has(name));
}
