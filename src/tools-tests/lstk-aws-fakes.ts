// Shared by the tool tests that run `lstk aws`. Each test file mocks ../core/command-runner
// itself (jest.mock is hoisted per file); this module drives that mock.
import { runCommand, type CommandResult } from "../core/command-runner";

const mockedRun = jest.mocked(runCommand);

export const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });

export const failed = (stdout: string, stderr = ""): CommandResult => ({
  stdout,
  stderr,
  exitCode: 1,
  error: new Error("Command failed with exit code 1"),
});

const missing = (): CommandResult => ({
  stdout: "",
  stderr: "",
  exitCode: null,
  error: new Error("spawn aws ENOENT"),
});

/** Answers `--version` for both CLIs, and `lstk aws …` with the given result. */
export function fakeCli(awsResult: CommandResult, { awsInstalled = true } = {}) {
  mockedRun.mockImplementation(async (command, args) => {
    if (args[0] === "--version") {
      if (command === "aws") return awsInstalled ? ok("aws-cli/2.40.4 Python/3.14.8") : missing();
      return ok("lstk 1.4.4");
    }
    return awsResult;
  });
}

export const lstkAwsCalls = () =>
  mockedRun.mock.calls.filter(([command, args]) => command === "lstk" && args[0] === "aws");

export const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
export const isError = (r: unknown) => (r as { isError?: boolean }).isError;
