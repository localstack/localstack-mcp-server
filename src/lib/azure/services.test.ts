import net from "net";
import { ensureProfile as ensureBootstrapped } from "./bootstrap";
import { AzResolveError } from "./resolve-az";
import { runAz, type AzRunOptions, type AzRunResult } from "./runner";
import {
  AzCancelledError,
  azCli,
  azureConfig,
  ensureProfile,
  recordEmulatorSession,
  resetAzureServices,
  runAzCommand,
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

  test("an az that prints no version, or does not answer, is told apart from one that fails", async () => {
    const failure = async (answer: AzRunResult) => {
      jest.mocked(runAz).mockResolvedValueOnce(answer);
      return (await azCli().catch((error) => error)).message;
    };
    expect(await failure(result({ stdout: "Welcome to az!\n" }))).toContain(
      "started but did not print its version; set LOCALSTACK_AZ_PATH"
    );
    expect(await failure(result({ exitCode: null, timedOut: true }))).toContain(
      "did not answer `az version` within 120 s"
    );
  });
});

test("runAzCommand runs the argv in the workdir, with the command timeout and the signal", async () => {
  resetAzureServices();
  jest.mocked(runAz).mockResolvedValue(version("2.91.0"));
  const signal = new AbortController().signal;
  await runAzCommand(["group", "list"], { signal });
  const { timeoutMs, workdir } = azureConfig();
  expect(runAz).toHaveBeenLastCalledWith(
    expect.objectContaining({ file: "/usr/bin/az" }),
    expect.any(Object),
    ["group", "list"],
    { signal, timeoutMs, cwd: workdir }
  );
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

test("each az run gets an egress guard of its own, closed after it; its refusals come back", async () => {
  resetAzureServices();
  jest.mocked(runAz).mockResolvedValueOnce(version("2.91.0"));
  // The stand-in az asks the guard for a host outside the emulator, as a --blob-endpoint would.
  jest.mocked(runAz).mockImplementationOnce(async (_az, env) => {
    const { port } = new URL(env.HTTPS_PROXY);
    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1", () =>
        socket.write("CONNECT storage.evil.example:443 HTTP/1.1\r\n\r\n")
      );
      socket.once("data", () => (socket.destroy(), resolve()));
    });
    return result({ exitCode: 1 });
  });
  const answer = await runAzCommand(["storage", "blob", "upload"], {});
  const env = jest.mocked(runAz).mock.lastCall![1];
  expect(env).toMatchObject({ AZURE_CONFIG_DIR: "/cfg", HTTP_PROXY: env.HTTPS_PROXY });
  expect(answer.refused).toEqual(["storage.evil.example"]);
  const closed = await new Promise((resolve) =>
    net
      .connect(Number(new URL(env.HTTPS_PROXY).port), "127.0.0.1")
      .once("connect", () => resolve(false))
      .once("error", () => resolve(true))
  );
  expect(closed).toBe(true);
});
