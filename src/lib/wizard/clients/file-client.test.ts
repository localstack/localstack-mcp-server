import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildNpxServerSpec } from "../server-config.logic";
import { ServerSpec } from "../types";
import { createFileClientAdapter } from "./file-client";
import { ClientContext } from "./types";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localstack-mcp-file-client-"));
}

function testContext(homeDir: string): ClientContext {
  return { platform: "linux", homeDir, env: {} };
}

function createAdapter(configPath: string) {
  return createFileClientAdapter({
    id: "cursor",
    label: "Cursor",
    restartNote: "restart",
    configPath: () => configPath,
    detectInstalled: async () => true,
    rootPath: ["mcpServers"],
    buildEntry: (spec: ServerSpec) => ({ command: spec.command, args: spec.args, env: spec.env }),
  });
}

describe("createFileClientAdapter", () => {
  it("creates parent directories and a 0600 config file on fresh install", async () => {
    const home = tempHome();
    const configPath = path.join(home, ".cursor", "mcp.json");
    const adapter = createAdapter(configPath);

    const outcome = await adapter.install(buildNpxServerSpec("ls-token"), testContext(home));

    expect(outcome).toEqual({ status: "installed", detail: configPath });
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.mcpServers.localstack.env.LOCALSTACK_AUTH_TOKEN).toBe("ls-token");
    expect((fs.statSync(configPath).mode & 0o777).toString(8)).toBe("600");
  });

  it("preserves localstack-mcp-server while writing the wizard-managed entry", async () => {
    const home = tempHome();
    const configPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "localstack-mcp-server": { command: "docker" },
          other: { command: "node" },
        },
      })
    );
    const adapter = createAdapter(configPath);

    const existing = await adapter.getExisting(testContext(home));
    const outcome = await adapter.install(buildNpxServerSpec("ls-token"), testContext(home));
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(existing.entries).toEqual([]);
    expect(outcome.status).toBe("installed");
    expect(parsed.mcpServers["localstack-mcp-server"]).toEqual({ command: "docker" });
    expect(parsed.mcpServers.localstack.command).toBe("npx");
    expect(parsed.mcpServers.other).toEqual({ command: "node" });
  });

  it("removes only localstack and leaves localstack-mcp-server alone", async () => {
    const home = tempHome();
    const configPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          localstack: { command: "npx" },
          "localstack-mcp-server": { command: "docker" },
          other: { command: "node" },
        },
      })
    );
    const adapter = createAdapter(configPath);

    const outcome = await adapter.remove(testContext(home));
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(outcome.status).toBe("installed");
    expect(outcome.detail).toContain("removed localstack");
    expect(parsed.mcpServers).toEqual({
      "localstack-mcp-server": { command: "docker" },
      other: { command: "node" },
    });
  });

  it("shows the exact path when remove finds no config file", async () => {
    const home = tempHome();
    const configPath = path.join(home, ".cursor", "mcp.json");
    const adapter = createAdapter(configPath);

    await expect(adapter.remove(testContext(home))).resolves.toEqual({
      status: "skipped",
      detail: `no config file found at ${configPath}`,
    });
  });

  it("reports invalid JSON instead of overwriting the file", async () => {
    const home = tempHome();
    const configPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ nope");
    const adapter = createAdapter(configPath);

    const existing = await adapter.getExisting(testContext(home));
    const outcome = await adapter.install(buildNpxServerSpec("ls-token"), testContext(home));

    expect(existing.error).toContain("invalid JSON");
    expect(outcome).toEqual({
      status: "failed",
      detail: `${configPath}: file contains invalid JSON (InvalidSymbol at offset 2) — fix it manually and re-run`,
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ nope");
  });
});
