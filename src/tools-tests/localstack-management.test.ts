// Tool tests live outside src/tools/ because xmcp registers every src/tools/*.ts as a
// tool (a *.test.ts there would be bundled into the server). The jest.mock specifiers
// below resolve to the same modules the tool imports (this dir is a sibling of tools/).
import localstackManagement from "../tools/localstack-management";
import { DockerApiClient } from "../lib/docker/docker.client";
import { getLocalStackStatus, launchRuntime } from "../lib/localstack/localstack.utils";
import { azureStartedCheck, getAzureRuntimeStatus } from "../lib/azure/runtime-status";

jest.mock("../core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

// Keep runPreflights + requireAuthToken real; stub the checks that would hit Docker /
// the license API so these tests exercise the handler logic, not the gates.
jest.mock("../core/preflight", () => {
  const actual = jest.requireActual("../core/preflight");
  return {
    ...actual,
    requireDockerDaemon: jest.fn().mockResolvedValue(null),
    requireProFeature: jest.fn().mockResolvedValue(null),
  };
});

jest.mock("../lib/docker/docker.client", () => {
  const actual = jest.requireActual("../lib/docker/docker.client");
  return { ...actual, DockerApiClient: jest.fn() };
});

jest.mock("../lib/localstack/localstack.utils", () => {
  const actual = jest.requireActual("../lib/localstack/localstack.utils");
  return {
    ...actual,
    getLocalStackStatus: jest.fn(),
    getSnowflakeEmulatorStatus: jest.fn(),
    launchRuntime: jest.fn(),
  };
});

jest.mock("../lib/azure/runtime-status", () => ({
  getAzureRuntimeStatus: jest.fn(),
  azureStartedCheck: jest.fn().mockResolvedValue(null),
}));

jest.mock("../lib/azure/loopback-forwarder", () => ({
  ensureLoopbackForwarder: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/azure/services", () => ({
  azureConfig: jest.fn(() => ({ inDocker: false })),
}));

const MockedDocker = DockerApiClient as jest.MockedClass<typeof DockerApiClient>;
const mockedGetStatus = getLocalStackStatus as jest.MockedFunction<typeof getLocalStackStatus>;

function mockDocker(overrides: Record<string, jest.Mock> = {}) {
  MockedDocker.mockImplementation(() => overrides as any);
}

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("localstack-management", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    delete process.env.MAIN_CONTAINER_NAME;
  });

  test("status service=snowflake reports the AWS stack instead of a Snowflake health failure", async () => {
    // requireSnowflakeProIfSnowflakeRunning + handleStatus both inspect the container.
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-aws"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-aws",
        name: "localstack-aws",
        image: "localstack/localstack-pro:latest",
      }),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "gateway reachable",
    });

    const result = await localstackManagement({ action: "status", service: "snowflake" } as any);
    expect(text(result)).toContain("is the AWS stack");
    expect(text(result)).not.toMatch(/Snowflake emulator health check did not pass/);
  });

  test("stop removes a stale stopped container holding the LocalStack name", async () => {
    const { LocalStackContainerNotFoundError } = jest.requireActual("../lib/docker/docker.client");
    const removeContainer = jest.fn().mockResolvedValue(undefined);
    const waitForRemoval = jest.fn().mockResolvedValue(undefined);
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(new LocalStackContainerNotFoundError("none running")),
      findContainerByNameAnyState: jest.fn().mockResolvedValue({
        id: "stale-1",
        name: "localstack-main",
        state: "exited",
        running: false,
      }),
      removeContainer,
      waitForRemoval,
    });

    const result = await localstackManagement({ action: "stop", service: "aws" } as any);
    expect(removeContainer).toHaveBeenCalledWith("stale-1");
    expect(waitForRemoval).toHaveBeenCalledWith("stale-1");
    expect(text(result)).toContain("Removed stopped LocalStack container");
  });

  test("stop reports nothing to do when no container exists and the gateway is down", async () => {
    const { LocalStackContainerNotFoundError } = jest.requireActual("../lib/docker/docker.client");
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(new LocalStackContainerNotFoundError("none running")),
      findContainerByNameAnyState: jest.fn().mockResolvedValue(null),
    });
    mockedGetStatus.mockResolvedValue({ isRunning: false, isReady: false });

    const result = await localstackManagement({ action: "stop", service: "aws" } as any);
    expect(text(result)).toMatch(/not running — no container to stop/);
  });

  test("status service=aws with an Azure container says it is the Azure stack", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-az",
        name: "localstack-azure",
        image: "localstack/localstack-azure:latest",
      }),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: false,
      statusOutput: "gateway reachable",
    });

    const result = await localstackManagement({ action: "status", service: "aws" } as any);
    expect(text(result)).toContain('The running LocalStack container ("localstack-azure"');
    expect(text(result)).toContain("is the Azure stack");
    expect(text(result)).toContain("the AWS emulator is not running");
  });

  test("status recognises a bare-ID container with the Azure label as the Azure stack", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-bare"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-bare",
        name: "localstack-azure",
        image: "f91897f1de85",
        labels: { description: "LocalStack for Azure" },
      }),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: false,
      statusOutput: "gateway reachable",
    });

    const result = await localstackManagement({ action: "status", service: "aws" } as any);
    expect(text(result)).toContain("is the Azure stack");
  });

  test("status service=snowflake with an Azure container names the Azure stack", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-az",
        name: "localstack-azure",
        image: "localstack/localstack-azure:latest",
      }),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: false,
      statusOutput: "gateway reachable",
    });

    const result = await localstackManagement({ action: "status", service: "snowflake" } as any);
    expect(text(result)).toContain("is the Azure stack");
    expect(text(result)).toContain("the Snowflake emulator is not running");
  });

  test("status service=aws with an AWS container is unchanged", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-aws"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-aws",
        name: "localstack-main",
        image: "localstack/localstack-pro:latest",
      }),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "gateway reachable",
    });

    const result = await localstackManagement({ action: "status", service: "aws" } as any);
    expect(text(result)).toContain("currently running and ready");
    expect(text(result)).not.toMatch(/stack —/);
  });

  test("requires the auth token", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    const result = await localstackManagement({ action: "status", service: "aws" } as any);
    expect(text(result)).toContain("LOCALSTACK_AUTH_TOKEN");
  });
});

// Phase 3 (plan tasks 3.1-3.3): service "azure".
describe("localstack-management service=azure", () => {
  const mockedLaunch = launchRuntime as jest.MockedFunction<typeof launchRuntime>;
  const mockedAzureStatus = getAzureRuntimeStatus as jest.MockedFunction<
    typeof getAzureRuntimeStatus
  >;
  const azureContainer = (over: Record<string, unknown> = {}) => ({
    id: "id-az",
    name: "localstack-azure",
    image: "localstack/localstack-azure:latest",
    portBindings: { "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: "4566" }] },
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    delete process.env.MAIN_CONTAINER_NAME;
    delete process.env.LOCALSTACK_PORT;
    delete process.env.LOCALSTACK_AZURE_PORT;
    mockedLaunch.mockResolvedValue({ content: [{ type: "text", text: "launched" }] } as any);
  });

  test("start passes stack azure, the Azure labels and the Azure status function (3.1)", async () => {
    await localstackManagement({ action: "start", service: "azure" } as any);
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        stack: "azure",
        processLabel: "LocalStack Azure emulator",
        successTitle: "🚀 LocalStack Azure emulator started successfully!",
        statusHeading: "Health check",
        getStatus: getAzureRuntimeStatus,
        onReady: azureStartedCheck,
      })
    );
  });

  test("start refuses a LOCALSTACK_AZURE_PORT that differs from the published LOCALSTACK_PORT", async () => {
    process.env.LOCALSTACK_AZURE_PORT = "4666";
    const result = await localstackManagement({ action: "start", service: "azure" } as any);
    expect(text(result)).toMatch(/Conflicting Azure port settings/);
    expect(mockedLaunch).not.toHaveBeenCalled();
  });

  test("status: a healthy Azure emulator passes, and the Container line names it (3.2)", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue(azureContainer()),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "gateway reachable",
    });
    mockedAzureStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "edition: azure-alpha",
      status: { ok: true },
    });
    const result = text(await localstackManagement({ action: "status", service: "azure" } as any));
    expect(result).toContain("Azure emulator health check passed");
    expect(result).toContain(
      'Container: "localstack-azure" (image localstack/localstack-azure:latest, gateway 127.0.0.1:4566)'
    );
  });

  test("status side by side (AWS on LOCALSTACK_PORT=4666, Azure on 4566) reports the Azure emulator", async () => {
    process.env.LOCALSTACK_PORT = "4666";
    process.env.LOCALSTACK_AZURE_PORT = "4566";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { azureConfig } = require("../lib/azure/services");
    (azureConfig as jest.Mock).mockReturnValue({
      inDocker: false,
      port: 4566,
      healthBaseUrl: "http://127.0.0.1:4566",
    });
    const awsContainer = {
      id: "id-aws",
      name: "localstack-uat-aws",
      image: "localstack/localstack-pro:latest",
    };
    // As the real lookup does: it follows LOCALSTACK_PORT (4666, the F01 safety rule), so
    // no Azure container is found there; the AWS one must never be taken for it.
    mockDocker({
      findLocalStackContainer: jest.fn(async (opts?: { stack?: string }) => {
        if (opts?.stack === "azure") throw new Error("no Azure container publishes 4666");
        return "id-aws";
      }),
      inspectContainer: jest.fn(async () => awsContainer),
    });
    mockedGetStatus.mockImplementation(async (baseUrl?: string) => ({
      isRunning: true,
      isReady: true,
      statusOutput: `gateway reachable at ${baseUrl ?? "http://localhost:4666"}`,
    }));
    mockedAzureStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "edition: azure-alpha",
      status: { ok: true },
    });
    const result = text(await localstackManagement({ action: "status", service: "azure" } as any));
    expect(mockedGetStatus).toHaveBeenCalledWith("http://127.0.0.1:4566");
    expect(result).toContain("gateway reachable at http://127.0.0.1:4566");
    expect(result).toContain("Azure emulator health check passed");
    // Neither the AWS gateway nor the AWS container stands in for the Azure emulator.
    expect(result).not.toContain("localhost:4666");
    expect(result).not.toContain("localstack-uat-aws");
    expect(result).not.toContain("is the AWS stack");
    (azureConfig as jest.Mock).mockReturnValue({ inDocker: false });
  });

  test("status: an AWS container is reported as the foreign stack", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-aws"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-aws",
        name: "localstack-main",
        image: "localstack/localstack-pro:latest",
      }),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "gateway reachable",
    });
    const result = text(await localstackManagement({ action: "status", service: "azure" } as any));
    expect(result).toContain("is the AWS stack");
    expect(result).toContain("the Azure emulator is not running");
    expect(result).toContain("start with service: azure");
    expect(mockedAzureStatus).not.toHaveBeenCalled();
  });

  test("status: Azure reachable but unhealthy gives the diagnostics line", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue(azureContainer()),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: false,
      statusOutput: "gateway reachable",
    });
    mockedAzureStatus.mockResolvedValue({
      isRunning: true,
      isReady: false,
      statusOutput: "edition: azure-alpha, license: true",
      status: { ok: false, problem: "https-not-ready", message: "HTTPS did not become ready" },
    });
    const result = text(await localstackManagement({ action: "status", service: "azure" } as any));
    expect(result).toMatch(
      /Azure emulator health check did not pass\. \(edition: azure-alpha, license: true \| HTTPS did not become ready\)/
    );
  });

  test("status: nothing running gives the standard message", async () => {
    mockedGetStatus.mockResolvedValue({ isRunning: false, isReady: false });
    const result = text(await localstackManagement({ action: "status", service: "azure" } as any));
    expect(result).toContain("LocalStack is not currently running");
    expect(result).not.toContain("Container:");
  });

  test("status: a healthy test container on 4666 gets its own Container line", async () => {
    process.env.LOCALSTACK_PORT = "4666";
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-test"),
      inspectContainer: jest.fn().mockResolvedValue(
        azureContainer({
          id: "id-test",
          name: "localstack-azure-mcp-test",
          portBindings: {
            "4666/tcp": [{ HostIp: "", HostPort: "4666" }],
            "4610/tcp": [{ HostIp: "", HostPort: "4610" }],
          },
        })
      ),
    });
    mockedGetStatus.mockResolvedValue({
      isRunning: true,
      isReady: true,
      statusOutput: "gateway reachable",
    });
    mockedAzureStatus.mockResolvedValue({ isRunning: true, isReady: true, status: { ok: true } });
    const result = text(await localstackManagement({ action: "status", service: "azure" } as any));
    expect(result).toContain(
      'Container: "localstack-azure-mcp-test" (image localstack/localstack-azure:latest, gateway 0.0.0.0:4666)'
    );
  });

  test("restart of an lstk-named localstack-azure keeps its name, image and volume (3.3)", async () => {
    const stopContainer = jest.fn().mockResolvedValue(undefined);
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue(
        azureContainer({
          mounts: [
            { type: "volume", name: "localstack-azure-vol", destination: "/var/lib/localstack" },
          ],
        })
      ),
      stopContainer,
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({ action: "restart", service: "azure" } as any);
    expect(stopContainer).toHaveBeenCalledWith("id-az");
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        stack: "azure",
        imageOverride: "localstack/localstack-azure:latest",
        containerNameOverride: "localstack-azure",
        volumeOverride: { type: "volume", name: "localstack-azure-vol" },
      })
    );
  });

  test("restart refuses, before stopping, a container whose state folder this machine cannot mount", async () => {
    // The owner's lstk emulator was started from WSL, so its bind is a WSL path. A Windows
    // server stopped it (--rm deleted it) and then could not recreate it.
    const stopContainer = jest.fn().mockResolvedValue(undefined);
    const source =
      process.platform === "win32"
        ? "/home/dev/.cache/lstk/volume/localstack-azure"
        : "/nonexistent-uat-life02/volume";
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest
        .fn()
        .mockResolvedValue(
          azureContainer({ mounts: [{ type: "bind", source, destination: "/var/lib/localstack" }] })
        ),
      stopContainer,
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    const result = text(await localstackManagement({ action: "restart", service: "azure" } as any));
    expect(stopContainer).not.toHaveBeenCalled();
    expect(mockedLaunch).not.toHaveBeenCalled();
    expect(result).toMatch(/Cannot restart this LocalStack container from here/);
    expect(result).toContain(source);
    expect(result).toMatch(/nothing was stopped/i);
  });

  test("restart still recreates a container whose state folder is on this machine", async () => {
    const stopContainer = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source = require("os").tmpdir();
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest
        .fn()
        .mockResolvedValue(
          azureContainer({ mounts: [{ type: "bind", source, destination: "/var/lib/localstack" }] })
        ),
      stopContainer,
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({ action: "restart", service: "azure" } as any);
    expect(stopContainer).toHaveBeenCalledWith("id-az");
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ volumeOverride: { type: "bind", source } })
    );
  });

  test("restart carries the container's own env flags across, minus image/reserved/token", async () => {
    const stopContainer = jest.fn().mockResolvedValue(undefined);
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue(
        azureContainer({
          env: [
            "MSSQL_ACCEPT_EULA=Y", // operator flag, not in the image → carried
            "DISABLE_EVENTS=1", // operator flag → carried
            "LS_AZURE_PORTAL=1", // operator flag → carried
            "PATH=/usr/local/bin:/usr/bin", // image-baked (same pair) → dropped
            "GATEWAY_LISTEN=0.0.0.0:4566", // launcher-owned reserved key → dropped
            "LOCALSTACK_AUTH_TOKEN=stale-token", // sensitive + reserved → dropped
          ],
        })
      ),
      imageConfigEnv: jest.fn().mockResolvedValue(["PATH=/usr/local/bin:/usr/bin", "LANG=C.UTF-8"]),
      stopContainer,
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });

    const result = text(await localstackManagement({ action: "restart", service: "azure" } as any));
    expect(stopContainer).toHaveBeenCalledWith("id-az");
    const options = mockedLaunch.mock.calls[0][0];
    expect(options.envVars).toMatchObject({
      MSSQL_ACCEPT_EULA: "Y",
      DISABLE_EVENTS: "1",
      LS_AZURE_PORTAL: "1",
    });
    expect(options.envVars).not.toHaveProperty("PATH");
    expect(options.envVars).not.toHaveProperty("GATEWAY_LISTEN");
    expect(options.envVars).not.toHaveProperty("LOCALSTACK_AUTH_TOKEN");
    // The answer names the carried keys, and never the token's value.
    expect(result).toMatch(/MSSQL_ACCEPT_EULA/);
    expect(result).not.toMatch(/stale-token/);
  });

  test("restart: the caller's own envVars win over a carried value", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest
        .fn()
        .mockResolvedValue(azureContainer({ env: ["DISABLE_EVENTS=1", "MSSQL_ACCEPT_EULA=Y"] })),
      imageConfigEnv: jest.fn().mockResolvedValue([]),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({
      action: "restart",
      service: "azure",
      envVars: { DISABLE_EVENTS: "0" },
    } as any);
    const options = mockedLaunch.mock.calls[0][0];
    expect(options.envVars).toMatchObject({ DISABLE_EVENTS: "0", MSSQL_ACCEPT_EULA: "Y" });
  });

  test("restart of a container THIS server started carries nothing: restart applies new config", async () => {
    // Our own starts stamp LOCALSTACK_CLIENT_NAME=localstack-mcp-server; their env came from this
    // server's (previous) config, so the upstream "restart applies new configuration" holds and a
    // restart must still be able to drop a setting. Only externally started containers carry.
    const imageConfigEnv = jest.fn().mockResolvedValue([]);
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest.fn().mockResolvedValue(
        azureContainer({
          env: ["LOCALSTACK_CLIENT_NAME=localstack-mcp-server", "MSSQL_ACCEPT_EULA=Y"],
        })
      ),
      imageConfigEnv,
      stopContainer: jest.fn().mockResolvedValue(undefined),
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    const result = text(await localstackManagement({ action: "restart", service: "azure" } as any));
    const options = mockedLaunch.mock.calls[0][0];
    expect(options.envVars).toBeUndefined();
    expect(result).not.toMatch(/Carried/);
    expect(imageConfigEnv).not.toHaveBeenCalled();
  });

  test("a restart records what it carried, so a SECOND restart keeps carrying it", async () => {
    // Live on 4f: the first MCP restart of the lstk-started emulator kept its six flags, but the new
    // container carries this server's LOCALSTACK_CLIENT_NAME, so the second restart saw a
    // server-started container, carried nothing and lost them all. The carried keys now travel with
    // the container in MCP_CARRIED_ENV.
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest
        .fn()
        .mockResolvedValue(
          azureContainer({ env: ["MSSQL_ACCEPT_EULA=Y", "DISABLE_EVENTS=1", "PATH=/usr/bin"] })
        ),
      imageConfigEnv: jest.fn().mockResolvedValue(["PATH=/usr/bin"]),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({ action: "restart", service: "azure" } as any);
    expect(mockedLaunch.mock.calls[0][0].envVars).toMatchObject({
      MSSQL_ACCEPT_EULA: "Y",
      DISABLE_EVENTS: "1",
      MCP_CARRIED_ENV: "DISABLE_EVENTS,MSSQL_ACCEPT_EULA",
    });

    // The second restart: the container now looks server-started, but it lists what it carries.
    mockedLaunch.mockClear();
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az2"),
      inspectContainer: jest.fn().mockResolvedValue(
        azureContainer({
          id: "id-az2",
          env: [
            "LOCALSTACK_CLIENT_NAME=localstack-mcp-server",
            "MSSQL_ACCEPT_EULA=Y",
            "DISABLE_EVENTS=1",
            "SOME_START_ENV=from-an-earlier-mcp-start",
            "MCP_CARRIED_ENV=DISABLE_EVENTS,MSSQL_ACCEPT_EULA",
          ],
        })
      ),
      imageConfigEnv: jest.fn().mockResolvedValue([]),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({ action: "restart", service: "azure" } as any);
    const second = mockedLaunch.mock.calls[0][0].envVars;
    expect(second).toMatchObject({
      MSSQL_ACCEPT_EULA: "Y",
      DISABLE_EVENTS: "1",
      MCP_CARRIED_ENV: "DISABLE_EVENTS,MSSQL_ACCEPT_EULA",
    });
    // What an earlier MCP start set is still NOT carried: restart applies new configuration there.
    expect(second).not.toHaveProperty("SOME_START_ENV");
  });

  test("restart tolerates an image inspect failure and still carries the operator flags", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-az"),
      inspectContainer: jest
        .fn()
        .mockResolvedValue(
          azureContainer({ env: ["MSSQL_ACCEPT_EULA=Y", "PATH=/usr/bin", "HOME=/root"] })
        ),
      imageConfigEnv: jest.fn().mockRejectedValue(new Error("image gone")),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({ action: "restart", service: "azure" } as any);
    const options = mockedLaunch.mock.calls[0][0];
    // Without the image env, the system-var backstop still keeps PATH/HOME out.
    expect(options.envVars).toMatchObject({ MSSQL_ACCEPT_EULA: "Y" });
    expect(options.envVars).not.toHaveProperty("PATH");
    expect(options.envVars).not.toHaveProperty("HOME");
  });

  test("restart with service azure over an AWS container switches stacks (no overrides)", async () => {
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-aws"),
      inspectContainer: jest.fn().mockResolvedValue({
        id: "id-aws",
        name: "localstack-main",
        image: "localstack/localstack-pro:latest",
      }),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      waitForRemoval: jest.fn().mockResolvedValue(undefined),
    });
    await localstackManagement({ action: "restart", service: "azure" } as any);
    const options = mockedLaunch.mock.calls[0][0];
    expect(options.stack).toBe("azure");
    expect(options.imageOverride).toBeUndefined();
    expect(options.containerNameOverride).toBeUndefined();
  });
});

describe("status in the Docker image", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { ensureLoopbackForwarder } =
    require("../lib/azure/loopback-forwarder") as typeof import("../lib/azure/loopback-forwarder");
  const { azureConfig } =
    require("../lib/azure/services") as typeof import("../lib/azure/services");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const forwarder = ensureLoopbackForwarder as jest.Mock;
  const config = azureConfig as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
  });
  afterEach(() => config.mockReturnValue({ inDocker: false }));

  test("service azure starts the loopback forwarder before the gateway is probed", async () => {
    config.mockReturnValue({ inDocker: true });
    const order: string[] = [];
    forwarder.mockImplementation(async () => {
      order.push("forwarder");
    });
    mockedGetStatus.mockImplementation(async () => {
      order.push("gateway");
      return { isRunning: false, isReady: false, statusOutput: "not reachable" };
    });
    await localstackManagement({ action: "status", service: "azure" } as any);
    expect(order).toEqual(["forwarder", "gateway"]);
  });

  test("outside Docker, or for another stack, no forwarder is started", async () => {
    mockedGetStatus.mockResolvedValue({ isRunning: false, isReady: false, statusOutput: "x" });
    await localstackManagement({ action: "status", service: "azure" } as any);
    config.mockReturnValue({ inDocker: true });
    await localstackManagement({ action: "status", service: "aws" } as any);
    expect(forwarder).not.toHaveBeenCalled();
  });
});
