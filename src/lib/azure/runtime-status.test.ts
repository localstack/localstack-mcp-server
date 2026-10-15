import { getAzureEmulatorStatus, type AzureEmulatorStatus } from "./emulator";
import { azureStartedCheck, getAzureRuntimeStatus } from "./runtime-status";

jest.mock("./emulator", () => ({ getAzureEmulatorStatus: jest.fn() }));

const status = (over: Partial<AzureEmulatorStatus>) =>
  jest.mocked(getAzureEmulatorStatus).mockResolvedValue({ ok: false, ...over });

describe("getAzureRuntimeStatus", () => {
  test("ready: running and ready, with the edition and version as the status output", async () => {
    status({ ok: true, edition: "azure-alpha", version: "4.9.0" });
    expect(await getAzureRuntimeStatus()).toMatchObject({
      isRunning: true,
      isReady: true,
      statusOutput: "edition: azure-alpha, version: 4.9.0",
    });
    // localstack-management polls on its own: one HTTPS probe per call.
    expect(getAzureEmulatorStatus).toHaveBeenLastCalledWith(expect.anything(), undefined, {
      httpsWaitMs: 0,
    });
  });

  test.each(["https-not-ready", "license"] as const)(
    "%s: the container is running, but not ready",
    async (problem) => {
      status({ problem });
      expect(await getAzureRuntimeStatus()).toMatchObject({ isRunning: true, isReady: false });
    }
  );

  test.each(["not-running", "wrong-edition"] as const)("%s: not running", async (problem) => {
    status({ problem });
    expect(await getAzureRuntimeStatus()).toMatchObject({ isRunning: false, isReady: false });
  });
});

describe("azureStartedCheck", () => {
  test("refuses an emulator without a licence; HTTPS still starting is not a failure", async () => {
    status({ problem: "license", message: "no active license" });
    expect((await azureStartedCheck())?.content[0].text).toContain(
      "LocalStack Azure License Not Active"
    );
    status({ problem: "https-not-ready" });
    expect(await azureStartedCheck()).toBeNull();
  });
});
