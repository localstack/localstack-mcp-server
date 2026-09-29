// Drift gates DR1, DR2, DR5 and DR7: the
// emulator surfaces the tool depends on, checked weekly and on emulator releases.
import { existsSync, readFileSync } from "fs";
import path from "path";
import { describeLive } from "../live/harness";
import { cloudConfigJson } from "../../../src/lib/azure/bootstrap";
import { stackFromEdition } from "../../../src/lib/localstack/container-spec.logic";
import {
  armGet,
  certificateSans,
  ENDPOINT,
  gatewayGet,
  isLocalSuffix,
  REPO,
  writeReport,
} from "./drift-helpers";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/azure/drift", name), "utf8"));

describeLive("DR1: /metadata/endpoints suffixes", () => {
  test("the suffixes equal the snapshot; the non-local ones are L3's watch list", async () => {
    const res = await armGet("/metadata/endpoints?api-version=2022-09-01");
    expect(res.status).toBe(200);
    const live = JSON.parse(res.body);
    const snapshot = fixture("metadata-endpoints.json");
    const watchList = Object.entries(live.suffixes as Record<string, string>)
      .filter(([, value]) => !isLocalSuffix(value))
      .map(([key, value]) => `${key}=${value}`)
      .sort();
    writeReport("dr1-metadata-endpoints", { suffixes: live.suffixes, watchList });
    // A change means: re-check the bootstrap's cloud registration, and put any new
    // real-Azure suffix on L3's watch list.
    expect(live.suffixes).toEqual(snapshot.suffixes);
    expect(live.resourceManager.replace(/\/$/, "")).toBe(ENDPOINT);
  });
});

describeLive("DR2: health edition and license", () => {
  test("health still reports an Azure edition and a boolean license, as the preflight expects", async () => {
    const res = await gatewayGet("/_localstack/health");
    expect(res.status).toBe(200);
    const health = JSON.parse(res.body);
    writeReport("dr2-health", health);
    expect(typeof health.edition).toBe("string");
    expect(stackFromEdition(health.edition)).toBe("azure");
    expect(typeof health.license).toBe("boolean");
    const info = JSON.parse((await gatewayGet("/_localstack/info")).body);
    expect(typeof info.session_id).toBe("string");
  });
});

describeLive("DR5: the cloud-config JSON equals lstk's BuildCloudConfig", () => {
  // The weekly job fetches lstk's source; a local checkout works too.
  const source =
    process.env.LSTK_AZURECONFIG_GO ||
    "https://raw.githubusercontent.com/localstack/lstk/main/internal/azureconfig/azureconfig.go";

  async function lstkSource(): Promise<string> {
    if (existsSync(source)) return readFileSync(source, "utf8");
    const res = await fetch(source);
    if (!res.ok) throw new Error(`could not fetch ${source}: HTTP ${res.status}`);
    return res.text();
  }

  test("same endpoint keys and values for the same endpoint", async () => {
    const go = await lstkSource();
    const body = /func BuildCloudConfig\([\s\S]*?\n}/.exec(go)?.[0];
    expect(body).toBeDefined();
    // "activeDirectory": base,   /   "management": base + "/",
    const lstk: Record<string, string> = {};
    for (const m of body!.matchAll(/"(\w+)":\s*base(\s*\+\s*"\/")?,/g)) {
      lstk[m[1]] = m[2] ? `${ENDPOINT}/` : ENDPOINT;
    }
    const ours = JSON.parse(cloudConfigJson(ENDPOINT)).endpoints;
    writeReport("dr5-cloud-config", { lstk, ours });
    expect(Object.keys(lstk).length).toBeGreaterThanOrEqual(7);
    expect(ours).toEqual(lstk);
  });
});

describeLive("DR7 (informational): certificate SANs and passthrough URLs", () => {
  test("changes are reported, never a failure", async () => {
    const sans = await certificateSans();
    const snapshot: string[] = fixture("certificate-sans.json").sans;
    const added = sans.filter((s) => !snapshot.includes(s));
    const removed = snapshot.filter((s) => !sans.includes(s));
    // PASSTHROUGH_URLS is only visible in the CI emulator container's environment.
    let passthrough: string | undefined;
    const container = process.env.AZURE_CI_EMULATOR_CONTAINER;
    if (container) {
      try {
        const { execFileSync } = await import("child_process");
        passthrough = execFileSync("docker", ["exec", container, "printenv", "PASSTHROUGH_URLS"], {
          encoding: "utf8",
          timeout: 30_000,
        }).trim();
      } catch {
        passthrough = "(not set)";
      }
    }
    const file = writeReport("dr7-emulator-surface", { added, removed, passthrough });
    if (added.length || removed.length) {
      console.warn(
        `DR7: certificate SANs changed (+${added.length} -${removed.length}); see ${file}`
      );
    }
    // The ARM host must stay covered, or az's certificate check would fail.
    expect(sans.some((s) => s === "*.azure.localhost.localstack.cloud")).toBe(true);
  });
});
