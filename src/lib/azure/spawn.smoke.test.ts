// SM: the runner's real `az`, no emulator (plan section 8; review F13, R02 N6/N21).
// Opt-in with AZ_SMOKE=1: it spawns the installed Azure CLI. Everything runs in a
// temporary config dir, behind the egress guard, after the versionCheck.json seed, and
// the test asserts that nothing but the housekeeping hosts was refused, so the smoke
// itself never calls Microsoft from a developer's machine.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { AzExecutable, AzRunResult } from "./types";

const SMOKE = process.env.AZ_SMOKE === "1";
const describeSmoke = SMOKE ? describe : describe.skip;
jest.setTimeout(300_000);

const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-smoke-"));
const configDir = path.join(root, "mcp-config-smoke");
const workdir = path.join(root, "work");
mkdirSync(workdir, { recursive: true });
process.env.LOCALSTACK_AZ_CONFIG_DIR = configDir;
process.env.LOCALSTACK_AZ_WORKDIR = workdir;
process.env.LOCALSTACK_AZ_EXTENSION_DIR = path.join(root, "extensions");
delete process.env.LOCALSTACK_AZ_EGRESS_GUARD;

/* eslint-disable @typescript-eslint/no-require-imports */
const services = require("./services") as typeof import("./services");
const { versionCheckSeed, CLI_CONFIG, VERSION_CHECK_FILE } =
  require("./bootstrap") as typeof import("./bootstrap");
const { formatAzResult } = require("./output") as typeof import("./output");
const { localVersionText } = require("./resolve-az") as typeof import("./resolve-az");
/* eslint-enable @typescript-eslint/no-require-imports */

const results: Array<{ argv: string[]; result: AzRunResult }> = [];
let az: AzExecutable;

async function run(argv: string[], timeoutMs = 120_000): Promise<AzRunResult> {
  const runner = await services.azRunner();
  const result = await runner.run(argv, { timeoutMs, cwd: workdir });
  results.push({ argv, result });
  return result;
}

const format = (result: AzRunResult, argv: string[], isHelp = false) =>
  formatAzResult(result, {
    argv,
    notes: [],
    isHelp,
    guardOn: true,
    port: 4566,
    timeoutSeconds: 120,
    maxOutputChars: 30000,
    maxHelpChars: 30000,
    envelope: false,
    inDocker: false,
  }).content[0].text;

afterAll(async () => {
  await services.resetAzureServices();
  rmSync(root, { recursive: true, force: true });
});

describeSmoke("the real az (AZ_SMOKE=1)", () => {
  test("resolves and probes: the CLI's own Python with -X utf8 and -I (or the -P fallback)", async () => {
    az = await services.azCli();
    console.log(`az: ${az.file} ${az.prefixArgs.join(" ")} (${az.installer}, ${az.version})`);
    expect(az.version).toMatch(/^\d+\.\d+\.\d+/);
    if (az.installer !== "launcher-as-is") {
      expect(az.prefixArgs.slice(0, 2)).toEqual(["-X", "utf8"]);
      expect(az.prefixArgs.join(" ")).toMatch(/-I|-P/);
    }
  });

  test("the seed is written before the first az call, then B.5's config set line runs once", async () => {
    mkdirSync(configDir, { recursive: true });
    const seed = versionCheckSeed(await services.readLocalVersions(az), az.version);
    writeFileSync(path.join(configDir, VERSION_CHECK_FILE), JSON.stringify(seed));
    expect(seed.versions.core.local).toBe(az.version);

    const set = await run(["config", "set", ...CLI_CONFIG, "--only-show-errors"]);
    expect(set.exitCode).toBe(0);
    const got = await run(["config", "get", "--only-show-errors", "-o", "json"]);
    expect(got.exitCode).toBe(0);
    const sections = JSON.parse(got.stdout) as Record<
      string,
      Array<{ name: string; value: string; source: string }>
    >;
    for (const entry of CLI_CONFIG) {
      const [key, value] = entry.split("=");
      const [section, name] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
      const found = sections[section]?.find((e) => e.name === name);
      // `config get` shows effective values: the child's AZURE_CORE_COLLECT_TELEMETRY=no
      // (task 2.3) wins over the file's `false`, with the same effect.
      if (found?.source === "AZURE_CORE_COLLECT_TELEMETRY") expect(found.value).toBe("no");
      else expect(found?.value).toBe(value);
    }
  });

  test("UTF-8 round trip (-X utf8)", async () => {
    const result = await run(["cloud", "list", "--query", "'ü✓é'", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("ü✓é");
  });

  test("--help comes back, re-flowed", async () => {
    const argv = ["group", "--help"];
    const result = await run(argv);
    expect(result.exitCode).toBe(0);
    const text = format(result, argv, true);
    expect(text).toMatch(/resource groups/i);
    expect(text.split("\n").some((line) => /\S {3,}\S/.test(line))).toBe(false);
  });

  test("the local version answer", async () => {
    const text = localVersionText(az, services.installedExtensions());
    expect(JSON.parse(text.split("\n\n")[0])["azure-cli-core"]).toBe(az.version);
  });

  test("group list fails offline with Appendix G row 1 (not logged in)", async () => {
    const argv = ["group", "list"];
    const result = await run(argv);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Please run 'az login' to setup account\./);
    expect(format(result, argv).split("\n")[0]).toMatch(/\(exit \d+, login\)$/);
  });

  test("az accepts abbreviated long flags (so the policy matches prefixes)", async () => {
    const result = await run(["cloud", "list", "--out", "tsv", "--que", "[0].name"]);
    console.log(`abbreviated flags: exit ${result.exitCode}`);
    expect(result.exitCode).toBe(0);
  });

  test("@~/ expands into the private home, not the user's", async () => {
    const privateHome = services.azureConfig().homeDir;
    mkdirSync(privateHome, { recursive: true });
    writeFileSync(path.join(privateHome, "marker.txt"), "'marker-ok'");
    const result = await run(["cloud", "list", "--query", "@~/marker.txt", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("marker-ok");
  });

  test("bicep build through the runner and the guard, when a Bicep binary resolves", async () => {
    const bicep = await services.bicep();
    if (!bicep) {
      console.log("no Bicep binary resolved: the Bicep case is skipped");
      return;
    }
    copyFileSync(
      path.resolve(__dirname, "../../../tests/fixtures/azure/bicep/storage.bicep"),
      path.join(workdir, "storage.bicep")
    );
    const result = await run(["bicep", "build", "--file", "storage.bicep", "--stdout"], 240_000);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resources).toBeDefined();
    // Bicep writes nothing next to its input with --stdout.
    expect(() => readFileSync(path.join(workdir, "storage.json"))).toThrow();
  });

  test("nothing but the housekeeping hosts was refused during the smoke", () => {
    const refused = results.flatMap((r) =>
      r.result.egress.refused.map((h) => `${r.argv.join(" ")} -> ${h}`)
    );
    const housekeeping = [...new Set(results.flatMap((r) => r.result.egress.housekeeping))];
    console.log(`housekeeping refusals: ${housekeeping.join(", ") || "none"}`);
    expect(refused).toEqual([]);
    expect(results.every((r) => r.result.egress.upstream.length === 0)).toBe(true);
  });
});
