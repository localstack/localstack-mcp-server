import { ensureProfile as ensureBootstrapped } from "./bootstrap";
import { AzResolveError } from "./resolve-az";
import { runAz, type AzRunOptions, type AzRunResult } from "./runner";
import {
  AzCancelledError,
  azCli,
  ensureProfile,
  recordEmulatorSession,
  resetAzureServices,
} from "./services";

jest.mock("./resolve-az", () => ({
  ...jest.requireActual("./resolve-az"),
  locateAz: jest.fn(() => ({ file: "/usr/bin/az", prefixArgs: [] })),
}));
jest.mock("./runner", () => ({ runAz: jest.fn() }));
// No private dirs under the real home.
jest.mock("./child-env", () => ({
  ensurePrivateDirs: jest.fn(),
  buildAzChildEnv: jest.fn(() => ({ AZURE_CONFIG_DIR: "/cfg" })),
}));
jest.mock("./bootstrap", () => ({ ensureProfile: jest.fn(async () => undefined) }));

const result = (over: Partial<AzRunResult>): AzRunResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  truncated: false,
  ...over,
});
const version = (v: string) => result({ stdout: JSON.stringify({ "azure-cli-core": v }) });

describe("azCli", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAzureServices();
  });

  test("checks az once; a failed check is reported and retried on the next call", async () => {
    jest
      .mocked(runAz)
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: "ModuleNotFoundError: azure" }))
      .mockResolvedValueOnce(version("2.70.0"));
    const failed = await azCli().catch((error) => error);
    expect(failed).toBeInstanceOf(AzResolveError);
    expect(failed.message).toContain("could not be started: ModuleNotFoundError: azure");
    // Any version that runs is accepted.
    expect(await azCli()).toMatchObject({ file: "/usr/bin/az", version: "2.70.0" });
    await azCli();
    expect(runAz).toHaveBeenCalledTimes(2);
    expect(jest.mocked(runAz).mock.calls[0][2]).toEqual(["version", "-o", "json"]);
  });

  test("a cancelled check stops; a call sharing it that did not cancel checks again", async () => {
    const cancel = new AbortController();
    jest.mocked(runAz).mockImplementation(async (_az, _env, _argv, opts: AzRunOptions) => {
      if (opts.signal !== cancel.signal) return version("2.91.0");
      cancel.abort();
      return result({ exitCode: null, aborted: true });
    });
    const first = azCli(cancel.signal).catch((error) => error);
    const second = azCli();
    expect(await first).toBeInstanceOf(AzCancelledError);
    expect((await second).version).toBe("2.91.0");
    expect(runAz).toHaveBeenCalledTimes(2);
  });
});

test("ensureProfile keys the profile on the az version and the emulator session, and passes the signal", async () => {
  resetAzureServices();
  jest.mocked(runAz).mockResolvedValue(version("2.91.0"));
  recordEmulatorSession("session-1");
  const signal = new AbortController().signal;
  await ensureProfile(signal);
  expect(ensureBootstrapped).toHaveBeenCalledWith(
    expect.objectContaining({ azVersion: "2.91.0", sessionId: "session-1" }),
    expect.any(Function),
    signal
  );
});
