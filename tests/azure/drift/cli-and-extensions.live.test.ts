// Drift gates DR3 and DR4: the az version and the curated extensions.
import { readFileSync } from "fs";
import path from "path";
import { az, describeLive, setupLiveEnv } from "../live/harness";
import { EXTENSION_COMMANDS, parsePinList } from "../../../src/lib/azure/extension-map";
import { compareVersions, MIN_AZ_VERSION } from "../../../src/lib/azure/resolve-az";
import { REPO, writeReport } from "./drift-helpers";

describeLive("DR3: the az version", () => {
  test("the resolved az is supported, and the pinned version when the job pins one", async () => {
    setupLiveEnv();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const services =
      require("../../../src/lib/azure/services") as typeof import("../../../src/lib/azure/services");
    const exe = await services.azCli();
    writeReport("dr3-az-version", {
      file: exe.file,
      installer: exe.installer,
      version: exe.version,
    });
    expect(compareVersions(exe.version ?? "0", MIN_AZ_VERSION)).toBeGreaterThanOrEqual(0);
    // The weekly matrix runs this with the minimum and the newest az (AZ_EXPECTED_VERSION).
    if (process.env.AZ_EXPECTED_VERSION) expect(exe.version).toBe(process.env.AZ_EXPECTED_VERSION);
    const listed = await az("group list --query length(@)");
    expect(listed.ok).toBe(true);
  });
});

// Runs after the job installed the pin list (scripts/install-azure-extensions.mjs), so it
// is opt-in: AZURE_DR4=1.
const describeDr4 = process.env.AZURE_DR4 === "1" ? describeLive : describe.skip;

describeDr4("DR4: the curated extensions install and load with the pinned az", () => {
  const pins = parsePinList(readFileSync(path.join(REPO, "docker/azure-extensions.txt"), "utf8"));

  test("every pinned extension is installed at its pinned version", async () => {
    setupLiveEnv();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const services =
      require("../../../src/lib/azure/services") as typeof import("../../../src/lib/azure/services");
    const installed = new Map(services.installedExtensions().map((e) => [e.name, e.version]));
    const wrong = pins
      .filter((p) => installed.get(p.name) !== p.version)
      .map((p) => `${p.name}: pinned ${p.version}, installed ${installed.get(p.name) ?? "none"}`);
    writeReport("dr4-extensions", { pins, installed: Object.fromEntries(installed), wrong });
    expect(wrong).toEqual([]);
  });

  test("one command group of each extension loads (--help)", async () => {
    const failures: string[] = [];
    for (const pin of pins) {
      const group = EXTENSION_COMMANDS[pin.name]?.[0];
      if (!group) {
        failures.push(`${pin.name}: no command group in extension-map.ts`);
        continue;
      }
      const result = await az(`${group} --help`);
      if (!result.ok) failures.push(`${pin.name} (${group}): ${result.text.split("\n")[0]}`);
    }
    expect(failures).toEqual([]);
  });
});
