import { getAzureEmulatorStatus, resetEmulatorStatusCache, type EmulatorDeps } from "./emulator";

const config = {
  healthBaseUrl: "http://localhost:4566",
  endpoint: "https://azure.localhost.localstack.cloud:4566",
};
const AZURE_HEALTH = { edition: "azure-alpha", license: true };

function deps(over: Partial<EmulatorDeps> & { health?: unknown; https?: boolean[] } = {}) {
  const https = [...(over.https ?? [true])];
  let now = 0;
  const fake: EmulatorDeps = {
    getJson: jest.fn(async (url: string) =>
      url.endsWith("/health") ? over.health : { session_id: "s1", version: "4.9.0" }
    ),
    httpsReady: jest.fn(async () => https.shift() ?? false),
    lookup: jest.fn(async () => ["127.0.0.1"]),
    sleep: jest.fn(async (ms: number) => {
      now += ms;
    }),
    now: () => now,
    ...over,
  };
  return fake;
}

describe("getAzureEmulatorStatus", () => {
  beforeEach(() => resetEmulatorStatusCache());

  test("ready: the Azure edition, HTTPS answering, the name on loopback", async () => {
    const d = deps({ health: AZURE_HEALTH });
    expect(await getAzureEmulatorStatus(config, d)).toEqual({
      ok: true,
      edition: "azure-alpha",
      sessionId: "s1",
      version: "4.9.0",
    });
    expect(d.httpsReady).toHaveBeenCalledWith(
      "127.0.0.1",
      4566,
      "azure.localhost.localstack.cloud",
      5000
    );
    expect(d.getJson).toHaveBeenCalledWith("http://localhost:4566/_localstack/health", 5000);
  });

  test("nothing answering, another emulator on the port, or no licence", async () => {
    const status = await getAzureEmulatorStatus(config, deps({ health: undefined }));
    expect(status).toMatchObject({ ok: false, problem: "not-running" });
    expect(status.message).toContain("not running at http://localhost:4566");
    expect(status.message).toContain("service: azure");
    const aws = await getAzureEmulatorStatus(config, deps({ health: { edition: "pro" } }));
    expect(aws).toMatchObject({ problem: "wrong-edition", edition: "pro" });
    const unlicensed = { health: { edition: "azure-alpha", license: false } };
    expect((await getAzureEmulatorStatus(config, deps(unlicensed))).problem).toBe("license");
  });

  test("waits up to 10 s for HTTPS, then says it is still starting", async () => {
    const late = deps({ health: AZURE_HEALTH, https: [false, false, true] });
    expect((await getAzureEmulatorStatus(config, late)).ok).toBe(true);
    resetEmulatorStatusCache(); // session s1 passed: forget it
    const never = deps({ health: AZURE_HEALTH, https: [] });
    const status = await getAzureEmulatorStatus(config, never);
    expect(status).toMatchObject({ ok: false, problem: "https-not-ready" });
    expect(never.sleep).toHaveBeenCalledTimes(20);
    const once = deps({ health: AZURE_HEALTH, https: [] });
    await getAzureEmulatorStatus(config, once, { httpsWaitMs: 0 });
    expect(once.httpsReady).toHaveBeenCalledTimes(1);
  });

  test("the name must resolve to loopback; a session that passed is not checked again", async () => {
    const blocked = deps({ health: AZURE_HEALTH, lookup: jest.fn(async () => []) });
    expect((await getAzureEmulatorStatus(config, blocked)).message).toContain("did not resolve");
    const elsewhere = deps({ health: AZURE_HEALTH, lookup: jest.fn(async () => ["10.0.0.5"]) });
    expect((await getAzureEmulatorStatus(config, elsewhere)).message).toContain(
      "resolved to 10.0.0.5"
    );
    // Once a session has passed, HTTPS and DNS are not checked again.
    const d = deps({ health: AZURE_HEALTH, https: [true, true] });
    await getAzureEmulatorStatus(config, d);
    await getAzureEmulatorStatus(config, d);
    expect(d.httpsReady).toHaveBeenCalledTimes(1);
    expect(d.lookup).toHaveBeenCalledTimes(1);
  });
});
