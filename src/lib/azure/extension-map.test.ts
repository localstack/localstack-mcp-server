import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  EXTENSION_COMMANDS,
  commandWords,
  extensionFor,
  listInstalledExtensions,
  missingCuratedExtensions,
  missingExtensionHint,
  parsePinList,
} from "./extension-map";

const REPO = path.join(__dirname, "../../..");
const PIN_LIST = path.join(REPO, "docker", "azure-extensions.txt");
const SCRIPT = path.join(REPO, "scripts", "install-azure-extensions.mjs");

// Appendix E: the 26 curated extensions, the six preview-only ones among them.
const CURATED = [
  "acrcssc",
  "acrquery",
  "acrtransfer",
  "application-insights",
  "azure-firewall",
  "bastion",
  "cdn",
  "dns-resolver",
  "documentdb",
  "edge-action",
  "eventgrid",
  "express-route-cross-connection",
  "fleet",
  "front-door",
  "ip-group",
  "k8s-configuration",
  "k8s-extension",
  "monitor-control-service",
  "nsp",
  "resource-graph",
  "scheduled-query",
  "staticwebapp",
  "virtual-network-manager",
  "virtual-network-tap",
  "virtual-wan",
  "webapp",
];
const PREVIEW_ONLY = [
  "acrcssc",
  "cdn",
  "edge-action",
  "eventgrid",
  "scheduled-query",
  "virtual-network-tap",
];

describe("the pin list (docker/azure-extensions.txt)", () => {
  const pins = parsePinList(fs.readFileSync(PIN_LIST, "utf8"));

  it("pins exactly the 26 curated extensions", () => {
    expect(pins.map((p) => p.name).sort()).toEqual([...CURATED].sort());
  });

  it("marks the six preview-only builds, and pins application-insights to the stable 1.2.3", () => {
    expect(
      pins
        .filter((p) => p.preview)
        .map((p) => p.name)
        .sort()
    ).toEqual([...PREVIEW_ONLY].sort());
    expect(pins.find((p) => p.name === "application-insights")).toEqual({
      name: "application-insights",
      version: "1.2.3",
      preview: false,
    });
    // A preview flag goes with a pre-release version and nothing else.
    for (const p of pins) expect(p.preview).toBe(/[a-z]/.test(p.version));
  });

  it("uses C05's versions (azure-cli 2.90.0, 2026-09-27)", () => {
    const versions = Object.fromEntries(pins.map((p) => [p.name, p.version]));
    expect(versions).toMatchObject({
      acrcssc: "1.0.0b8",
      cdn: "1.0.0b3",
      fleet: "1.11.1",
      "k8s-extension": "1.9.1",
      "resource-graph": "2.1.1",
      "virtual-network-manager": "3.0.2",
      webapp: "0.4.0",
    });
  });
});

describe("parsePinList", () => {
  it("reads names, versions and the preview flag, skipping comments and blank lines", () => {
    const text =
      "\uFEFF# header\r\n\r\n  fleet 1.11.1  \r\ncdn 1.0.0b3 preview\r\n   # indented comment\n";
    expect(parsePinList(text)).toEqual([
      { name: "fleet", version: "1.11.1", preview: false },
      { name: "cdn", version: "1.0.0b3", preview: true },
    ]);
    expect(parsePinList("")).toEqual([]);
  });

  it.each([
    ["fleet", /line 1: expected "name version \[preview\]"/],
    ["fleet 1.0 preview extra", /line 1: expected/],
    ["fleet 1.0 # pinned", /line 1: expected/],
    ["cdn 1.0.0b3 beta", /the third field must be "preview"/],
    ["fleet latest", /invalid version "latest"/],
    ["-x 1.0", /invalid extension name/],
    ["fleet 1.0\nfleet 1.1", /line 2: fleet is listed twice/],
  ])("refuses %j", (text, message) => {
    expect(() => parsePinList(text)).toThrow(message);
  });
});

describe("EXTENSION_COMMANDS", () => {
  it("maps the same 26 extensions as the pin list", () => {
    const pinned = parsePinList(fs.readFileSync(PIN_LIST, "utf8"))
      .map((p) => p.name)
      .sort();
    expect(Object.keys(EXTENSION_COMMANDS).sort()).toEqual(pinned);
  });

  it("claims no core group", () => {
    const groups = Object.values(EXTENSION_COMMANDS).flat();
    // Core parents (and containerapp, core in 2.85-2.90) are never keys of their own.
    for (const core of [
      "acr",
      "monitor",
      "network",
      "webapp",
      "staticwebapp",
      "eventgrid",
      "containerapp",
      "network vnet",
      "network nic",
    ]) {
      expect(groups).not.toContain(core);
    }
    // Every one-word key is a group that no core version has (cdn and afd from 2.90 on).
    const topLevel = groups.filter((g) => !g.includes(" ")).sort();
    expect(topLevel).toEqual(
      [
        "afd",
        "cdn",
        "dns-resolver",
        "documentdb",
        "edge-action",
        "fleet",
        "graph",
        "k8s-configuration",
        "k8s-extension",
      ].sort()
    );
    expect(new Set(groups).size).toBe(groups.length);
    for (const g of groups) expect(g).toMatch(/^[a-z0-9-]+( [a-z0-9-]+)*$/);
  });
});

describe("extensionFor", () => {
  it("names the extension of the path az did not recognise (Appendix G row 8 examples)", () => {
    expect(extensionFor(["graph"])).toBe("resource-graph");
    expect(extensionFor(["monitor", "app-insights"])).toBe("application-insights");
    expect(extensionFor(["k8s-extension"])).toBe("k8s-extension");
    expect(extensionFor(["network", "front-door"])).toBe("front-door");
    expect(extensionFor(["network", "vnet", "tap"])).toBe("virtual-network-tap");
    expect(extensionFor(["afd", "rule", "action", "show"])).toBe("cdn");
  });

  it("matches the whole path only, so a typo under a known group is not a missing extension", () => {
    expect(extensionFor(["monitor"])).toBeUndefined();
    expect(extensionFor(["afd", "bogus"])).toBeUndefined();
    expect(extensionFor(["graph", "query"])).toBeUndefined();
    expect(extensionFor(["containerapp"])).toBeUndefined();
    expect(extensionFor([])).toBeUndefined();
  });

  it("stops at the first flag", () => {
    expect(commandWords(["graph", "--query", "x", "y"])).toEqual(["graph"]);
    expect(extensionFor(["graph", "-q", "Resources"])).toBe("resource-graph");
  });

  it("is silent when the extension is installed", () => {
    expect(extensionFor(["graph"], new Set(["resource-graph"]))).toBeUndefined();
    expect(extensionFor(["graph"], new Set(["fleet"]))).toBe("resource-graph");
  });
});

describe("missingExtensionHint", () => {
  it("has Appendix G row 8's two texts: the add-ons command on a host, the image's set in Docker", () => {
    expect(missingExtensionHint("graph", "resource-graph", false)).toBe(
      "`az graph` comes from the `resource-graph` Azure CLI extension, which is not installed for " +
        "this tool (automatic installs are disabled). Install the tool's extensions once with " +
        "`npx -y @localstack/localstack-mcp-server install-azure-addons`; meanwhile `rest` with a " +
        "relative URL usually works."
    );
    expect(missingExtensionHint("graph", "resource-graph", false)).not.toMatch(/wizard|\binit\b/);
    expect(missingExtensionHint("graph", "resource-graph", true)).toBe(
      "`resource-graph` is not in this image's curated set; use `rest` with a relative URL."
    );
  });
});

describe("listInstalledExtensions", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-ext-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts a directory with package metadata, like az does", () => {
    fs.mkdirSync(path.join(dir, "resource-graph", "resource_graph-2.1.1.dist-info"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dir, "fleet", "azext_fleet"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".install-cdn.log"), "");
    const installed = listInstalledExtensions(dir);
    expect([...installed]).toEqual(["resource-graph"]);
    expect(missingCuratedExtensions(installed)).toHaveLength(25);
    expect(missingCuratedExtensions(installed)).not.toContain("resource-graph");
  });

  it("returns nothing for a missing directory", () => {
    expect(listInstalledExtensions(path.join(dir, "absent")).size).toBe(0);
  });
});

// The installer imports parsePinList from this module through Node's type stripping (Node 22.18+).
const typeStripping = Boolean((process.features as unknown as Record<string, unknown>).typescript);

(typeStripping ? describe : describe.skip)("scripts/install-azure-extensions.mjs --dry-run", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-ext-dry-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const script = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 30_000 });

  it("prints one fail-fast install per pin and changes nothing", () => {
    const target = path.join(dir, "extensions");
    // Not `python.exe` off Windows: under WSL the script rightly refuses a Windows az.
    const python = path.join(dir, "fake", process.platform === "win32" ? "python.exe" : "python3");
    const result = script(["--dry-run", "--dir", target, "--az-python", python]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines).toContain(`# AZURE_EXTENSION_DIR=${path.resolve(target)}`);
    const commands = lines.filter((line) => !line.startsWith("#"));
    const pins = parsePinList(fs.readFileSync(PIN_LIST, "utf8"));
    expect(commands).toHaveLength(pins.length);
    pins.forEach((pin, i) => {
      const flags = pin.preview ? " --allow-preview true" : "";
      const argv =
        `-X utf8 -IBm azure.cli extension add --name ${pin.name} --version ${pin.version}` +
        `${flags} --upgrade --yes --only-show-errors`;
      expect(commands[i].endsWith(argv)).toBe(true);
      expect(commands[i].startsWith(python.includes(" ") ? `"${python}"` : python)).toBe(true);
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("defaults to LOCALSTACK_AZ_EXTENSION_DIR", () => {
    const target = path.join(dir, "from-env");
    const result = script(["--dry-run", "--az", "az"], {
      ...process.env,
      LOCALSTACK_AZ_EXTENSION_DIR: target,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`# AZURE_EXTENSION_DIR=${path.resolve(target)}`);
  });

  it("refuses a pin list it cannot parse, and a target inside ~/.azure", () => {
    const list = path.join(dir, "pins.txt");
    fs.writeFileSync(list, "fleet 1.11.1 # trailing comment\n");
    const bad = script(["--dry-run", "--list", list, "--az", "az"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("line 1: expected");

    // Only compares paths: nothing under ~/.azure is read or written.
    const inside = script([
      "--dry-run",
      "--dir",
      path.join(os.homedir(), ".azure", "cliextensions"),
      "--az",
      "az",
    ]);
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain("refusing to install into");
  });

  it("rejects unknown arguments", () => {
    const result = script(["--dry-run", "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument --bogus");
  });
});
