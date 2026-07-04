import { runCommand } from "../../core/command-runner";
import { LocalStackLogRetriever } from "./log-retriever";

jest.mock("../../core/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

describe("LocalStackLogRetriever", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  test("reports command failures instead of parsing empty output as clean logs", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: null,
      error: new Error("spawn localstack ENOENT"),
    } as never);

    const result = await new LocalStackLogRetriever().retrieveLogs(10);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/Failed to retrieve logs/i);
    expect(result.errorMessage).toMatch(/ENOENT/i);
  });
});
