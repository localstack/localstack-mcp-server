/**
 * L3, the ~/.azure home guard (plan sections 5.4, 7 and 11; reviews F33 and R02): the Azure tool
 * keeps its own CLI profile, so a bootstrap and a spread of commands must leave the user's own
 * ~/.azure exactly as it was.
 *
 * - In CI (CI=true), where runners have no ~/.azure: if it does not exist, a sentinel
 *   ~/.azure/config (a comment line only) is written first. Afterwards the sentinel must be
 *   unchanged and nothing else may have appeared; the sentinel is then removed again.
 * - On a developer machine: ~/.azure is never written. Only its metadata is compared.
 *
 * Both compare tests/azure/tools/azure-home-fingerprint.mjs output (relative paths, sizes and
 * mtimes). No file under ~/.azure is ever opened. The "before" fingerprint lives in the harness's
 * temporary directory. Another program that uses ~/.azure while this runs (the user's own az)
 * shows up as a change too: the report names the entries, never their contents.
 *
 *   AZURE_LIVE=1 npx jest -c jest.azure-live.config.js --selectProjects egress --runInBand
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { az as azOnce, describeLive, json, setupLiveEnv, type LiveEnv } from "./live/harness";

// jest.azure-live.config.js sets testTimeout inside `projects`, where Jest ignores it (it is a
// global option), so without this every test and hook would get the 5 s default.
jest.setTimeout(900_000);

const NOT_READY = "❌ **LocalStack Azure Emulator Not Ready**";

/** One command; a "not ready" preflight answer is retried once and logged (plan section 7). */
async function az(command: string) {
  const call = await azOnce(command);
  if (!call.text.startsWith(NOT_READY)) return call;
  console.log(`home guard retry (emulator not ready): ${command}`);
  await new Promise((r) => setTimeout(r, 5_000));
  return azOnce(command);
}

const HOME_AZURE = path.join(os.homedir(), ".azure");
const SENTINEL = path.join(HOME_AZURE, "config");
const SENTINEL_TEXT =
  "# localstack-mcp-server L3 home-guard sentinel (CI only): the Azure tool must never write here.\n";
const FINGERPRINT_TOOL = path.join(__dirname, "tools", "azure-home-fingerprint.mjs");
const IN_CI = process.env.CI === "true";

/** The fingerprint tool's own CLI, in a child Node (it is an ES module). */
function runFingerprint(args: string[]) {
  return spawnSync(process.execPath, [FINGERPRINT_TOOL, ...args], {
    // Only what Node needs: the child has no reason to see the token or the proxy settings.
    env: {
      AZURE_HOME_FINGERPRINT_ROOT: HOME_AZURE,
      PATH: process.env.PATH ?? "",
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

describeLive("L3 home guard: the Azure tool leaves ~/.azure untouched", () => {
  let env: LiveEnv;
  let beforeFile: string;
  let entriesBefore = 0;
  let existedBefore = false;
  const created = { dir: false, sentinel: false };
  let verdict: { unchanged: boolean; report: string } | undefined;

  beforeAll(() => {
    env = setupLiveEnv();
    beforeFile = path.join(env.root, "azure-home-before.json");
    existedBefore = existsSync(HOME_AZURE);
    if (IN_CI && !existedBefore) {
      mkdirSync(HOME_AZURE, { recursive: true });
      created.dir = true;
      writeFileSync(SENTINEL, SENTINEL_TEXT, { flag: "wx" });
      created.sentinel = true;
    }
    const result = runFingerprint([]);
    if (result.status !== 0) throw new Error(`fingerprint failed: ${result.stderr}`);
    writeFileSync(beforeFile, result.stdout);
    const before = JSON.parse(result.stdout) as { exists: boolean; entries: object };
    entriesBefore = Object.keys(before.entries).length;
    console.log(
      `home guard: ${IN_CI ? "CI" : "developer machine"}; ~/.azure ${
        existedBefore ? "existed" : created.sentinel ? "absent, sentinel written" : "absent"
      }; ${entriesBefore} entries fingerprinted`
    );
  });

  afterAll(async () => {
    // CI only, and only what this file created, and only when nothing else appeared: a
    // change is left in place for whoever looks at the runner.
    if (created.sentinel && verdict?.unchanged) {
      rmSync(SENTINEL);
      if (created.dir && readdirSync(HOME_AZURE).length === 0) rmdirSync(HOME_AZURE);
    }
    // The egress guard listens until it is closed, and Jest would never exit.
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const services =
      require("../../src/lib/azure/services") as typeof import("../../src/lib/azure/services");
    await services.resetAzureServices();
  });

  test("the bootstrap and a spread of commands run through the tool", async () => {
    // The first call bootstraps the tool's own profile: cloud register, config set, login.
    const groups = await az("group list -o json");
    expect(groups.exitCode).toBe(0);
    expect(Array.isArray(json(groups))).toBe(true);

    const account = await az("account show -o json");
    expect(json<{ environmentName: string }>(account).environmentName).toBe("LocalStack");

    // `config get` names the file a setting came from: the tool's config dir, never ~/.azure.
    const setting = await az("config get core.output");
    const source = json<{ source: string; value: string }>(setting).source;
    expect(path.relative(env.configDir, source).startsWith("..")).toBe(false);
    expect(path.relative(HOME_AZURE, source).startsWith("..")).toBe(true);

    const rest = await az('rest --method get --url "/subscriptions?api-version=2022-12-01"');
    expect(rest.exitCode).toBe(0);

    expect((await az("group list --help")).exitCode).toBe(0);
    expect((await az("extension list -o json")).exitCode).toBe(0);
    // Loads every command module and writes the command index, into the tool's own dir.
    expect((await az("mcpl3homeguard list")).classId).toBe("unknown-command");
    expect((await az("version")).text).toContain("azure-cli");

    // Refused by the policy before anything is spawned.
    for (const refused of ["login", "account clear", "config set core.output=table"]) {
      expect((await az(refused)).text.startsWith("❌ **Command not allowed**")).toBe(true);
    }
  });

  test("~/.azure is unchanged (metadata only: paths, sizes, mtimes)", () => {
    const result = runFingerprint(["--compare", beforeFile]);
    const report = `${result.stdout}${result.stderr}`.trim();
    if (result.status !== 0 && !report.startsWith("~/.azure changed:")) {
      throw new Error(`fingerprint compare failed: ${report}`);
    }
    verdict = { unchanged: result.status === 0, report };
    console.log(`home guard: ${report}`);
    expect(report).toMatch(/^~\/\.azure unchanged \(\d+ entries\)$/);
    if (created.sentinel) expect(existsSync(SENTINEL)).toBe(true);
  });
});
