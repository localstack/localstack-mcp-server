// The handler, the preflight precedence and the value-free analytics of
// localstack-azure-client. The real policy, output, preflight
// gates and analytics run; only the edges are mocked: the emulator status, gateway
// health, the resolved az, Bicep, the bootstrap, the runner and PostHog.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { AzRunResult } from "../lib/azure/types";

const mockCapture = jest.fn();
jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    flush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../lib/localstack/localstack.utils", () => ({
  ...jest.requireActual("../lib/localstack/localstack.utils"),
  getGatewayHealth: jest.fn(),
}));

jest.mock("../lib/azure/emulator", () => ({
  ...jest.requireActual("../lib/azure/emulator"),
  getAzureEmulatorStatus: jest.fn(),
}));

jest.mock("../lib/azure/loopback-forwarder", () => ({
  ensureLoopbackForwarder: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/azure/services", () => {
  const actual = jest.requireActual("../lib/azure/services");
  return {
    ...actual,
    azCli: jest.fn(),
    bicep: jest.fn(),
    runAzCommand: jest.fn(),
    ensureProfile: jest.fn(),
    installedExtensions: jest.fn(() => []),
    installedExtensionNames: jest.fn(() => new Set<string>()),
  };
});

const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-tool-"));
const workdir = path.join(root, "work");
mkdirSync(workdir);
process.env.LOCALSTACK_AZ_WORKDIR = workdir;
process.env.LOCALSTACK_AZ_CONFIG_DIR = path.join(root, "azure-config");
process.env.LOCALSTACK_AZURE_PORT = "4566";
process.env.MCP_ANALYTICS_DISTINCT_ID = "azure-client-u11";
delete process.env.MCP_ANALYTICS_DISABLED;
delete process.env.LOCALSTACK_AZ_EGRESS_GUARD;
delete process.env.LOCALSTACK_AZ_TEST_ENVELOPE;

/* eslint-disable @typescript-eslint/no-require-imports */
const tool =
  require("../tools/localstack-azure-client") as typeof import("../tools/localstack-azure-client");
const services = require("../lib/azure/services") as typeof import("../lib/azure/services");
const emulator = require("../lib/azure/emulator") as typeof import("../lib/azure/emulator");
const utils =
  require("../lib/localstack/localstack.utils") as typeof import("../lib/localstack/localstack.utils");
const forwarder =
  require("../lib/azure/loopback-forwarder") as typeof import("../lib/azure/loopback-forwarder");
const { AzResolveError, BicepPathError } =
  require("../lib/azure/resolve-az") as typeof import("../lib/azure/resolve-az");
const { BootstrapError } =
  require("../lib/azure/bootstrap") as typeof import("../lib/azure/bootstrap");
const { resetStackDetectionCache } =
  require("../core/preflight") as typeof import("../core/preflight");
/* eslint-enable @typescript-eslint/no-require-imports */

const azure = tool.default;
const mocked = {
  azCli: services.azCli as jest.MockedFunction<typeof services.azCli>,
  bicep: services.bicep as jest.MockedFunction<typeof services.bicep>,
  runAzCommand: services.runAzCommand as jest.MockedFunction<typeof services.runAzCommand>,
  ensureProfile: services.ensureProfile as jest.MockedFunction<typeof services.ensureProfile>,
  status: emulator.getAzureEmulatorStatus as jest.MockedFunction<
    typeof emulator.getAzureEmulatorStatus
  >,
  health: utils.getGatewayHealth as jest.MockedFunction<typeof utils.getGatewayHealth>,
  forwarder: forwarder.ensureLoopbackForwarder as jest.MockedFunction<
    typeof forwarder.ensureLoopbackForwarder
  >,
};

const AZ = {
  file: "/opt/az/bin/python3",
  prefixArgs: ["-X", "utf8", "-IBm", "azure.cli"],
  installer: "deb" as const,
  version: "2.90.0",
};

const result = (fields: Partial<AzRunResult> = {}): AzRunResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 5,
  egress: { refused: [], upstream: [], housekeeping: [], allowed: 1 },
  ...fields,
});

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  jest.clearAllMocks();
  resetStackDetectionCache();
  process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
  mocked.health.mockResolvedValue({
    reachable: true,
    ready: true,
    edition: "azure-alpha",
  } as never);
  mocked.status.mockResolvedValue({
    ok: true,
    edition: "azure-alpha",
    license: true,
    sessionId: "s-1",
  });
  mocked.azCli.mockResolvedValue(AZ);
  mocked.ensureProfile.mockResolvedValue(undefined);
  mocked.runAzCommand.mockResolvedValue(result({ stdout: '[{"name": "rg1"}]' }));
  mocked.bicep.mockResolvedValue({
    path: "/usr/local/bin/bicep",
    dir: "/usr/local/bin",
    source: "path",
    version: "0.47.16",
    supportsBicepparam: true,
  });
});

describe("the handler", () => {
  test("the happy path runs the policy's argv in the workdir and returns az's output", async () => {
    const answer = await azure({ command: "az group list --query \"[?name=='rg1']\"" });
    expect(text(answer)).toContain("rg1");
    expect(mocked.runAzCommand).toHaveBeenCalledWith(
      ["group", "list", "--query", "[?name=='rg1']"],
      {
        signal: undefined,
        onProgress: undefined,
      }
    );
  });

  test("a policy refusal never spawns and needs no emulator (the real gates)", async () => {
    const answer = await azure({ command: "login" });
    expect(text(answer)).toMatch(/^❌ /);
    expect(mocked.status).not.toHaveBeenCalled();
    expect(mocked.health).not.toHaveBeenCalled();
    expect(mocked.azCli).not.toHaveBeenCalled();
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("version is answered locally: the CLI probe only, no emulator, no az run", async () => {
    const answer = await azure({ command: "version" });
    expect(text(answer)).toContain('"azure-cli-core": "2.90.0"');
    expect(mocked.azCli).toHaveBeenCalled();
    expect(mocked.status).not.toHaveBeenCalled();
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("postgres flexible-server create --version 16 is a normal command", async () => {
    await azure({ command: "postgres flexible-server create -g rg -n pg --version 16" });
    expect(mocked.runAzCommand).toHaveBeenCalled();
  });

  test("a runner timeout gives the timeout class and hint", async () => {
    mocked.runAzCommand.mockResolvedValue(result({ exitCode: 1, timedOut: true }));
    const answer = text(await azure({ command: "group list" }));
    // A killed process's code differs by OS, so the tool reports `none` when it stopped az.
    expect(answer.split("\n")[0]).toMatch(/^❌ \*\*Command Failed\*\* \(exit none, timeout\)$/);
    expect(answer).toMatch(/--no-wait/);
  });

  test("blocked hosts appear in the response, after the first line", async () => {
    mocked.runAzCommand.mockResolvedValue(
      result({
        exitCode: 1,
        failFast: "refused",
        egress: { refused: ["api.loganalytics.io"], upstream: [], housekeeping: [], allowed: 0 },
      })
    );
    const answer = text(
      await azure({ command: "monitor log-analytics query -w x --analytics-query y" })
    );
    const [first, ...rest] = answer.split("\n");
    expect(first).toMatch(/egress-refused/);
    expect(first).not.toContain("loganalytics");
    expect(rest.join("\n")).toContain("api.loganalytics.io");
  });

  test("an aborted signal reaches the runner, and the answer says the call was cancelled", async () => {
    const controller = new AbortController();
    mocked.runAzCommand.mockImplementation(async (_argv, opts) => {
      expect(opts.signal).toBe(controller.signal);
      return result({ exitCode: null, aborted: true });
    });
    const answer = text(
      await azure({ command: "group list" }, { signal: controller.signal } as never)
    );
    expect(answer.split("\n")[0]).toMatch(/cancelled/);
  });

  test("with a progress token, a 25 s run sends 2 progress notifications; none without one", async () => {
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    mocked.runAzCommand.mockImplementation(async (_argv, opts) => {
      opts.onProgress?.(10_000);
      opts.onProgress?.(20_000);
      return result({ stdout: "[]" });
    });
    await azure({ command: "group list" }, {
      signal: new AbortController().signal,
      _meta: { progressToken: 7 },
      sendNotification,
    } as never);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[1][0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: 7, progress: 20 },
    });

    sendNotification.mockClear();
    let sawCallback = true;
    mocked.runAzCommand.mockImplementation(async (_argv, opts) => {
      sawCallback = Boolean(opts.onProgress);
      return result({ stdout: "[]" });
    });
    await azure({ command: "group list" }, {
      signal: new AbortController().signal,
      sendNotification,
    } as never);
    expect(sawCallback).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  test("a bootstrap failure is an az failure with a class id and the setup note", async () => {
    mocked.ensureProfile.mockRejectedValue(
      new BootstrapError(
        "login",
        result({
          exitCode: 1,
          stderr: "ERROR: Unable to get endpoints from the cloud.\nError detail: boom",
        })
      )
    );
    const answer = text(await azure({ command: "group list" }));
    expect(answer.split("\n")[0]).toMatch(/^❌ \*\*Command Failed\*\* \(exit 1, [a-z-]+\)$/);
    expect(answer).toContain("before your command ran");
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("an unexpected exception becomes a constant-titled error, never a thrown message", async () => {
    mocked.runAzCommand.mockRejectedValue(new Error("boom at C:\\Users\\me\\secret-path"));
    const answer = text(await azure({ command: "group list" }));
    expect(answer.split("\n")[0]).toBe("❌ **Azure Tool Error**");
    expect(answer).toContain("secret-path");
  });
});

describe("preflights and their precedence", () => {
  test("the token check comes first", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    const answer = text(await azure({ command: "login" }));
    expect(answer).toMatch(/Auth Token Required/);
    expect(mocked.azCli).not.toHaveBeenCalled();
  });

  test("the emulator not running short-circuits", async () => {
    mocked.status.mockResolvedValue({
      ok: false,
      problem: "not-running",
      message: "The LocalStack Azure emulator is not running at http://127.0.0.1:4566.",
    });
    const answer = text(await azure({ command: "group list" }));
    expect(answer).toMatch(/^❌ \*\*LocalStack Azure Emulator Not Ready\*\*/);
    expect(mocked.ensureProfile).not.toHaveBeenCalled();
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("a missing az short-circuits, listing the skipped candidates", async () => {
    mocked.azCli.mockRejectedValue(
      new AzResolveError("The Azure CLI (az) was not found.", ["C:\\shims\\az.exe: an az.exe shim"])
    );
    const answer = text(await azure({ command: "group list" }));
    expect(answer).toMatch(/Azure CLI Not Available/);
    expect(answer).toContain("az.exe shim");
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("the first failure in array order wins: requireStack before the emulator and the CLI", async () => {
    mocked.health.mockResolvedValue({ reachable: true, ready: true, edition: "pro" } as never);
    mocked.status.mockResolvedValue({ ok: false, problem: "wrong-edition", message: "x" });
    mocked.azCli.mockRejectedValue(new AzResolveError("missing"));
    const answer = text(await azure({ command: "group list" }));
    expect(answer).toMatch(/Wrong emulator for this tool/);
    expect(answer).toContain("http://127.0.0.1:4566");
  });

  test("the stack check reads health on the Azure port's base URL", async () => {
    await azure({ command: "group list" });
    expect(mocked.health).toHaveBeenCalledWith("http://127.0.0.1:4566");
  });

  test("in Docker, the forwarder is awaited before the preflight group", async () => {
    const real = services.azureConfig();
    const spy = jest.spyOn(services, "azureConfig").mockReturnValue({ ...real, inDocker: true });
    const order: string[] = [];
    mocked.forwarder.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("forwarder");
      return undefined;
    });
    mocked.health.mockImplementation(async () => {
      order.push("health");
      return { reachable: true, ready: true, edition: "azure-alpha" } as never;
    });
    try {
      await azure({ command: "group list" });
      expect(order).toEqual(["forwarder", "health"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Bicep", () => {
  test("no Bicep binary: bicep-missing, without spawning az", async () => {
    mocked.bicep.mockResolvedValue(undefined);
    const answer = text(
      await azure({ command: "deployment group create -g rg --template-file main.bicep" })
    );
    expect(answer.split("\n")[0]).toMatch(/bicep-missing/);
    expect(answer).toMatch(/--template-file main\.json/);
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("a bad LOCALSTACK_AZ_BICEP_PATH is its own hard error", async () => {
    mocked.bicep.mockRejectedValue(
      new BicepPathError(
        "LOCALSTACK_AZ_BICEP_PATH must be an existing file named bicep or bicep.exe"
      )
    );
    const answer = text(await azure({ command: "bicep build --file main.bicep" }));
    expect(answer).toMatch(/Bicep CLI Not Usable/);
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("a registry module in the template: bicep-registry, without spawning", async () => {
    writeFileSync(
      path.join(workdir, "reg.bicep"),
      "module st 'br/public:avm/res/storage/storage-account:0.9.0' = {\n  name: 'st'\n}\n"
    );
    const answer = text(
      await azure({ command: "deployment group create -g rg --template-file reg.bicep" })
    );
    expect(answer.split("\n")[0]).toMatch(/bicep-registry/);
    expect(mocked.runAzCommand).not.toHaveBeenCalled();
  });

  test("an old Bicep refuses .bicepparam", async () => {
    mocked.bicep.mockResolvedValue({
      path: "/usr/bin/bicep",
      dir: "/usr/bin",
      source: "path",
      version: "0.13.1",
      supportsBicepparam: false,
    });
    writeFileSync(path.join(workdir, "main.bicep"), "param location string\n");
    const answer = text(
      await azure({
        command:
          "deployment group create -g rg --template-file main.bicep --parameters main.bicepparam",
      })
    );
    expect(answer).toMatch(/Bicep CLI Too Old/);
  });

  test("a compiled ARM template does not need Bicep", async () => {
    await azure({ command: "deployment group create -g rg --template-file main.json" });
    expect(mocked.bicep).not.toHaveBeenCalled();
    expect(mocked.runAzCommand).toHaveBeenCalled();
  });
});

describe("analytics carry no values", () => {
  const events = () =>
    mockCapture.mock.calls.map(
      (c) => c[0] as { event: string; properties: Record<string, unknown> }
    );

  function randomSecret() {
    return `S3cr3t${Math.random().toString(36).slice(2, 12)}X${Date.now().toString(36)}`;
  }

  const shapes: Array<(secret: string) => string> = [
    (s) => `keyvault secret set --vault-name kv1 --name pw --value ${s}`,
    (s) => `vm create -g rg -n vm1 --image Ubuntu2204 --admin-password ${s}`,
    (s) => `vm create -g rg -n vm1 --image Ubuntu2204 --admin-password=${s}`,
    (s) =>
      `storage blob upload --account-name st --container-name c --name b --file f.txt --sas-token ${s}`,
    (s) =>
      `webapp config connection-string set -g rg -n app --settings "Db=Server=tcp:x;Password=${s}"`,
    (s) => `keyvault secret set --vault-name kv1 --name pw --file @${s}.txt`,
    (s) => `rest --method get --url https://${s}.blob.core.windows.net/c`,
    (s) => `login --username ${s}`,
    (s) => `group list; echo ${s}`,
  ];

  test.each(shapes.map((shape, i) => [i, shape] as const))(
    "shape %i: no secret reaches captureToolEvent",
    async (_i, shape) => {
      for (let round = 0; round < 3; round++) {
        mockCapture.mockClear();
        const secret = randomSecret();
        mocked.runAzCommand.mockResolvedValue(
          round === 1
            ? result({ exitCode: 1, stderr: `ERROR: (BadRequest) value ${secret} rejected` })
            : round === 2
              ? result({
                  exitCode: 1,
                  egress: {
                    refused: [`${secret}.blob.core.windows.net`],
                    upstream: [],
                    housekeeping: [],
                    allowed: 0,
                  },
                })
              : result({ stdout: `{"value": "${secret}"}` })
        );
        await azure({ command: shape(secret) });
        const captured = JSON.stringify(events());
        expect(events().length).toBeGreaterThan(0);
        expect(captured).not.toContain(secret);
        expect(captured.toLowerCase()).not.toContain(secret.toLowerCase());
        for (const e of events()) {
          const args = e.properties.args as Record<string, unknown>;
          expect(Object.keys(args).sort()).toEqual(
            ["command_path", "flag_names", "policy_outcome"].filter((k) => k in args).sort()
          );
        }
      }
    }
  );

  test("every failure path records success === false, with a value-free first line", async () => {
    const failures: Array<() => void> = [
      () =>
        mocked.runAzCommand.mockResolvedValue(
          result({
            exitCode: 3,
            stderr: "ERROR: (ResourceNotFound) Resource group 'x' could not be found.",
          })
        ),
      () => mocked.status.mockResolvedValue({ ok: false, problem: "not-running", message: "down" }),
      () => mocked.azCli.mockRejectedValue(new AzResolveError("missing")),
      () => mocked.runAzCommand.mockResolvedValue(result({ exitCode: 1, timedOut: true })),
    ];
    for (const arrange of failures) {
      mockCapture.mockClear();
      mocked.status.mockResolvedValue({ ok: true, sessionId: "s-1" });
      mocked.azCli.mockResolvedValue(AZ);
      arrange();
      await azure({ command: "group show -n x" });
      const executed = events().find((e) => e.event === "mcp_tool_executed");
      expect(executed?.properties.success).toBe(false);
      expect(String(executed?.properties.error_message)).not.toMatch(/'x'/);
    }
    mockCapture.mockClear();
    await azure({ command: "login" });
    expect(events().find((e) => e.event === "mcp_tool_executed")?.properties).toMatchObject({
      success: false,
      args: { command_path: "login", policy_outcome: expect.stringMatching(/^denied:/) },
    });
  });

  test("the recorded fields for a normal command", async () => {
    mockCapture.mockClear();
    await azure({
      command: "storage account create --name st1abc --resource-group rg1 --sku=Standard_LRS",
    });
    expect(events()[0].properties).toMatchObject({
      success: true,
      args: {
        command_path: "storage account create",
        flag_names: "--name,--resource-group,--sku",
        policy_outcome: "ok",
      },
    });
  });
});

describe("configuration warnings reach the user", () => {
  afterEach(async () => {
    delete process.env.LOCALSTACK_AZ_TIMEOUT_SECONDS;
    delete process.env.LOCALSTACK_AZ_RUNNER;
    await services.resetAzureServices();
  });

  test("an invalid setting's fallback is a note in the first answer, not in every answer", async () => {
    process.env.LOCALSTACK_AZ_TIMEOUT_SECONDS = "2";
    process.env.LOCALSTACK_AZ_RUNNER = "fast";
    await services.resetAzureServices();
    const first = text(await azure({ command: "group list" }));
    expect(first).toContain(
      "Note: LOCALSTACK_AZ_TIMEOUT_SECONDS=2 is not a whole number from 5 to 3600; using 300."
    );
    expect(first).toContain("Note: LOCALSTACK_AZ_RUNNER=fast is not a runner");
    const second = text(await azure({ command: "group list" }));
    expect(second).not.toContain("LOCALSTACK_AZ_TIMEOUT_SECONDS");
  });

  test("a refusal can carry them too, and valid settings add nothing", async () => {
    process.env.LOCALSTACK_AZ_TIMEOUT_SECONDS = "abc";
    await services.resetAzureServices();
    expect(text(await azure({ command: "login" }))).toContain(
      "Note: LOCALSTACK_AZ_TIMEOUT_SECONDS=abc is not a whole number"
    );
    delete process.env.LOCALSTACK_AZ_TIMEOUT_SECONDS;
    await services.resetAzureServices();
    expect(text(await azure({ command: "group list" }))).not.toContain("Note:");
  });
});
