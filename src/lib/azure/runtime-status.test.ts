import { azureStartedCheck, getAzureRuntimeStatus } from "./runtime-status";
import { getAzureEmulatorStatus } from "./emulator";
import { ensureLoopbackForwarder } from "./loopback-forwarder";
import { azureConfig } from "./services";

// Plan tasks 3.1/3.2: localstack-management's view of the Azure emulator.
jest.mock("./emulator", () => ({ getAzureEmulatorStatus: jest.fn() }));
jest.mock("./loopback-forwarder", () => ({
  ensureLoopbackForwarder: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./services", () => ({ azureConfig: jest.fn() }));

const mockedStatus = getAzureEmulatorStatus as jest.MockedFunction<typeof getAzureEmulatorStatus>;
const mockedConfig = azureConfig as jest.MockedFunction<typeof azureConfig>;
const mockedForwarder = ensureLoopbackForwarder as jest.MockedFunction<
  typeof ensureLoopbackForwarder
>;

const config = (inDocker = false) =>
  ({ inDocker, port: 4566, healthBaseUrl: "http://127.0.0.1:4566" }) as never;

describe("getAzureRuntimeStatus", () => {
  beforeEach(() => jest.clearAllMocks());

  test("ready: the emulator answered as Azure, with HTTPS; a single HTTPS probe is asked for", async () => {
    mockedConfig.mockReturnValue(config());
    mockedStatus.mockResolvedValue({
      ok: true,
      edition: "azure-alpha",
      license: true,
      version: "2026.9.0",
    });
    await expect(getAzureRuntimeStatus()).resolves.toMatchObject({
      isRunning: true,
      isReady: true,
      statusOutput: "edition: azure-alpha, license: true, version: 2026.9.0",
    });
    expect(mockedStatus.mock.calls[0][2]).toEqual({ httpsWaitMs: 0 });
    expect(mockedForwarder).not.toHaveBeenCalled();
  });

  test.each(["https-not-ready", "license", "not-responding"] as const)(
    "%s: running but not ready",
    async (problem) => {
      mockedConfig.mockReturnValue(config());
      mockedStatus.mockResolvedValue({ ok: false, problem, edition: "azure-alpha" });
      await expect(getAzureRuntimeStatus()).resolves.toMatchObject({
        isRunning: true,
        isReady: false,
      });
    }
  );

  test("not-responding (an open port, no answer) is marked unresponsive; the others are not", async () => {
    mockedConfig.mockReturnValue(config());
    mockedStatus.mockResolvedValueOnce({ ok: false, problem: "not-responding" });
    await expect(getAzureRuntimeStatus()).resolves.toMatchObject({
      isRunning: true,
      unresponsive: true,
    });
    for (const problem of ["https-not-ready", "license"] as const) {
      mockedStatus.mockResolvedValueOnce({ ok: false, problem, edition: "azure-alpha" });
      await expect(getAzureRuntimeStatus()).resolves.toMatchObject({
        isRunning: true,
        unresponsive: false,
      });
    }
  });

  test.each(["not-running", "wrong-edition"] as const)("%s: not running", async (problem) => {
    mockedConfig.mockReturnValue(config());
    mockedStatus.mockResolvedValue({ ok: false, problem });
    await expect(getAzureRuntimeStatus()).resolves.toMatchObject({
      isRunning: false,
      isReady: false,
    });
  });

  test("in Docker, the loopback forwarder is tried first", async () => {
    mockedConfig.mockReturnValue(config(true));
    mockedStatus.mockResolvedValue({ ok: false, problem: "not-running" });
    await getAzureRuntimeStatus();
    expect(mockedForwarder).toHaveBeenCalled();
  });
});

describe("azureStartedCheck", () => {
  test("an inactive licence is an error; HTTPS still starting is not", async () => {
    mockedConfig.mockReturnValue(config());
    mockedStatus.mockResolvedValueOnce({ ok: false, problem: "license", message: "no licence" });
    expect((await azureStartedCheck())?.content[0].text).toMatch(/License Not Active/);
    mockedStatus.mockResolvedValueOnce({ ok: false, problem: "https-not-ready", message: "later" });
    expect(await azureStartedCheck()).toBeNull();
  });
});
