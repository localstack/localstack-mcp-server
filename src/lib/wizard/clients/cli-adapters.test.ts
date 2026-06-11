import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCommand, CommandResult } from "../../../core/command-runner";
import { buildNpxServerSpec } from "../server-config.logic";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { ClientContext } from "./types";

jest.mock("../../../core/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localstack-mcp-cli-client-"));
}

function testContext(homeDir: string, platform: NodeJS.Platform = "linux"): ClientContext {
  return { platform, homeDir, env: {} };
}

describe("codexAdapter", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  it("detects only the wizard-managed localstack entry from codex mcp list --json", async () => {
    mockedRunCommand.mockResolvedValue(
      result({
        stdout: JSON.stringify([
          { name: "localstack", transport: { command: "docker" } },
          { name: "localstack-mcp-server", transport: { command: "npx" } },
          { name: "other", transport: { command: "node" } },
        ]),
      })
    );

    const existing = await codexAdapter.getExisting(testContext(tempHome()));

    expect(existing.entries).toEqual([{ key: "localstack", method: "docker" }]);
    expect(mockedRunCommand).toHaveBeenCalledWith(
      "codex",
      ["mcp", "list", "--json"],
      expect.objectContaining({ timeout: 60_000, shell: false })
    );
  });

  it("adds the canonical server without mutating localstack-mcp-server", async () => {
    mockedRunCommand.mockResolvedValue(result());

    const home = tempHome();
    const outcome = await codexAdapter.install(buildNpxServerSpec("ls-token"), testContext(home));

    expect(outcome).toEqual({
      status: "installed",
      detail: `added via \`codex mcp add\` (${path.join(home, ".codex", "config.toml")})`,
    });
    expect(mockedRunCommand).toHaveBeenNthCalledWith(
      1,
      "codex",
      [
        "mcp",
        "add",
        "localstack",
        "--env",
        "LOCALSTACK_AUTH_TOKEN=ls-token",
        "--",
        "npx",
        "-y",
        "@localstack/localstack-mcp-server",
      ],
      expect.any(Object)
    );
  });

  it("redacts token values from CLI failure output", async () => {
    mockedRunCommand.mockResolvedValueOnce(result({ exitCode: 1, stderr: "bad token ls-secret" }));

    const outcome = await codexAdapter.install(
      buildNpxServerSpec("ls-secret"),
      testContext(tempHome())
    );

    expect(outcome).toEqual({ status: "failed", detail: "bad token ***" });
  });
});

describe("claudeCodeAdapter", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  it("surfaces project-local entries as warnings without managing them", async () => {
    const home = tempHome();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          localstack: { command: "npx" },
        },
        projects: {
          "/repo": {
            mcpServers: {
              localstack: { command: "docker" },
            },
          },
        },
      })
    );

    const existing = await claudeCodeAdapter.getExisting(testContext(home));

    expect(existing.entries).toEqual([{ key: "localstack", method: "npx" }]);
    expect(existing.warnings?.[0]).toContain("/repo");
    expect(existing.warnings?.[0]).toContain("project-local LocalStack entries");
  });

  it("removes existing user-scope localstack before adding the canonical server", async () => {
    const home = tempHome();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          localstack: { command: "docker" },
          "localstack-mcp-server": { command: "npx" },
        },
      })
    );
    mockedRunCommand.mockResolvedValue(result());

    const outcome = await claudeCodeAdapter.install(
      buildNpxServerSpec("ls-token"),
      testContext(home)
    );

    expect(outcome).toEqual({
      status: "installed",
      detail: `added via \`claude mcp add\` (user scope in ${path.join(home, ".claude.json")})`,
    });
    expect(mockedRunCommand).toHaveBeenNthCalledWith(
      1,
      "claude",
      ["mcp", "remove", "localstack", "--scope", "user"],
      expect.any(Object)
    );
    expect(mockedRunCommand).toHaveBeenNthCalledWith(
      2,
      "claude",
      [
        "mcp",
        "add",
        "localstack",
        "--scope",
        "user",
        "--env",
        "LOCALSTACK_AUTH_TOKEN=ls-token",
        "--",
        "npx",
        "-y",
        "@localstack/localstack-mcp-server",
      ],
      expect.any(Object)
    );
  });

  it("wraps npx for Windows shell-less Claude Code spawns", async () => {
    mockedRunCommand.mockResolvedValue(result());

    await claudeCodeAdapter.install(
      buildNpxServerSpec("ls-token"),
      testContext(tempHome(), "win32")
    );

    expect(mockedRunCommand).toHaveBeenLastCalledWith(
      "claude",
      [
        "mcp",
        "add",
        "localstack",
        "--scope",
        "user",
        "--env",
        "LOCALSTACK_AUTH_TOKEN=ls-token",
        "--",
        "cmd",
        "/c",
        "npx",
        "-y",
        "@localstack/localstack-mcp-server",
      ],
      expect.objectContaining({ shell: true })
    );
  });
});
