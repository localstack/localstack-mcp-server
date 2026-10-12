import { isRunningInDocker } from "../localstack/localstack.utils";
import { BootstrapError } from "./bootstrap";
import { getAzureEmulatorStatus } from "./emulator";
import {
  requireAzureCli,
  requireAzureCliConfigured,
  requireAzureConfig,
  requireAzureEmulatorRunning,
} from "./preflight";
import { AzResolveError } from "./resolve-az";
import type { AzRunResult } from "./runner";
import {
  AzCancelledError,
  azCli,
  azureConfig,
  ensureProfile,
  recordEmulatorSession,
} from "./services";

jest.mock("../localstack/localstack.utils", () => ({ isRunningInDocker: jest.fn(() => false) }));
jest.mock("./emulator", () => ({ getAzureEmulatorStatus: jest.fn() }));
jest.mock("./services", () => ({
  ...jest.requireActual("./services"),
  azCli: jest.fn(),
  azureConfig: jest.fn(() => ({ errors: [] })),
  ensureProfile: jest.fn(),
  recordEmulatorSession: jest.fn(),
}));

const text = (r: { content: Array<{ text?: string }> } | null) => r?.content[0].text ?? "";
const failed = (over: Partial<AzRunResult>): AzRunResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  truncated: false,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

test("requireAzureConfig lists every setting the tool cannot run with", () => {
  expect(requireAzureConfig()).toBeNull();
  jest.mocked(azureConfig).mockReturnValueOnce({ errors: ["A is bad.", "B is bad."] } as never);
  expect(text(requireAzureConfig())).toContain("- A is bad.\n- B is bad.");
});

test("requireAzureEmulatorRunning records the session and passes the emulator's explanation on", async () => {
  jest.mocked(getAzureEmulatorStatus).mockResolvedValueOnce({ ok: true, sessionId: "s1" });
  expect(await requireAzureEmulatorRunning()).toBeNull();
  expect(recordEmulatorSession).toHaveBeenCalledWith("s1");
  jest
    .mocked(getAzureEmulatorStatus)
    .mockResolvedValueOnce({ ok: false, problem: "not-running", message: "Start it." });
  const answer = text(await requireAzureEmulatorRunning());
  expect(answer).toContain("LocalStack Azure Emulator Not Ready");
  expect(answer).toContain("Start it.");
});

describe("requireAzureCli", () => {
  test("an az that runs: no answer, the call goes on", async () => {
    jest.mocked(azCli).mockResolvedValueOnce({ file: "/usr/bin/az", prefixArgs: [] });
    expect(await requireAzureCli()).toBeNull();
  });

  test("a missing az: the install advice and what was skipped; in Docker, the image's limit", async () => {
    const missing = new AzResolveError("The Azure CLI (az) was not found.", ["/mnt/c/az: Windows"]);
    jest.mocked(azCli).mockRejectedValue(missing);
    const answer = text(await requireAzureCli());
    expect(answer).toContain("Azure CLI Not Available");
    expect(answer).toContain("Skipped:\n- /mnt/c/az: Windows");
    jest.mocked(isRunningInDocker).mockReturnValueOnce(true);
    expect(text(await requireAzureCli())).toContain("Docker image does not include the Azure CLI");
  });

  test("passes the signal on; a cancelled check is a cancelled call", async () => {
    const signal = new AbortController().signal;
    jest.mocked(azCli).mockRejectedValueOnce(new AzCancelledError());
    expect(text(await requireAzureCli(signal))).toContain("Command Cancelled");
    expect(azCli).toHaveBeenCalledWith(signal);
  });
});

describe("requireAzureCliConfigured", () => {
  test("a profile that is set up: no answer, the call goes on", async () => {
    jest.mocked(ensureProfile).mockResolvedValueOnce(undefined);
    expect(await requireAzureCliConfigured()).toBeNull();
  });

  test("a failed step names it and shows az's error", async () => {
    const error = new BootstrapError("login", failed({ stderr: "ERROR: AADSTS7000215" }));
    jest.mocked(ensureProfile).mockRejectedValueOnce(error);
    const answer = text(await requireAzureCliConfigured());
    expect(answer).toContain("Azure CLI Profile Setup Failed");
    expect(answer).toContain("failed at `az login`");
    expect(answer).toContain("ERROR: AADSTS7000215");
  });

  test("a cancelled setup is a cancelled call", async () => {
    const error = new BootstrapError("cloud register", failed({ exitCode: null, aborted: true }));
    jest.mocked(ensureProfile).mockRejectedValueOnce(error);
    const signal = new AbortController().signal;
    expect(text(await requireAzureCliConfigured(signal))).toContain("Command Cancelled");
    expect(ensureProfile).toHaveBeenCalledWith(signal);
  });
});
