import { checkNodeVersion, checkPrereqs } from "./prereqs";
import { runCommand } from "../../core/command-runner";

// The wizard's prerequisites: Node and Docker, and nothing else. A tool's own
// CLI, the Snowflake tool's `snow` or the Azure tool's `az`, is the user's to install, as the
// README says, and each tool names what is missing when it is used: the wizard neither checks
// nor installs it. Docker is never run: the command runner is mocked.
jest.mock("../../core/command-runner", () => ({ runCommand: jest.fn() }));
const mockedRun = runCommand as jest.MockedFunction<typeof runCommand>;

describe("checkPrereqs", () => {
  beforeEach(() => {
    mockedRun.mockReset();
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as never);
  });

  test("npx: Node and Docker only, with no tool CLI (neither az nor snow)", async () => {
    const names = (await checkPrereqs("npx")).map((r) => r.name);
    expect(names[0]).toMatch(/^Node\.js /);
    expect(names.slice(1)).toEqual(["Docker CLI", "Docker daemon"]);
    expect(names.join(" ")).not.toMatch(/azure|\baz\b|bicep|snow/i);
  });

  test("docker: Docker only, and it stays fatal", async () => {
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 } as never);
    const results = await checkPrereqs("docker");
    expect(results.map((r) => r.name)).toEqual(["Docker CLI"]);
    expect(results[0]).toMatchObject({ ok: false, fatal: true });
  });

  test("the Node check is unchanged", () => {
    expect(checkNodeVersion("v24.11.1")).toMatchObject({ ok: true, fatal: false });
    expect(checkNodeVersion("v18.0.0").ok).toBe(false);
  });
});
