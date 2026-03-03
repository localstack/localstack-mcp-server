import { getLocalStackStatus, getSnowflakeEmulatorStatus } from "./localstack.utils";
import { runCommand } from "../../core/command-runner";

jest.mock("../../core/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

describe("localstack.utils", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  test("getLocalStackStatus marks instance as running and ready", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      stdout: "Runtime status: running (Ready)",
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await getLocalStackStatus();
    expect(result.isRunning).toBe(true);
    expect(result.isReady).toBe(true);
  });

  test("getSnowflakeEmulatorStatus marks emulator healthy on success payload", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      stdout: '{"success": true}',
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await getSnowflakeEmulatorStatus();
    expect(result.isRunning).toBe(true);
    expect(result.isReady).toBe(true);
    expect(result.statusOutput).toContain('"success": true');
  });

  test("getSnowflakeEmulatorStatus reports unhealthy response", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      stdout: '{"success": false}',
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await getSnowflakeEmulatorStatus();
    expect(result.isRunning).toBe(false);
    expect(result.isReady).toBe(false);
  });
});
