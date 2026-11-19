// Tool tests live outside src/tools/ because xmcp registers every src/tools/*.ts as a
// tool (a *.test.ts there would be bundled into the server). The jest.mock specifiers
// below resolve to the same modules the tool imports (this dir is a sibling of tools/).
import localstackManagement from "../tools/localstack-management";
import { DockerApiClient } from "../lib/docker/docker.client";
import { getLocalStackStatus, launchRuntime } from "../lib/localstack/localstack.utils";
import { azureStartedCheck, getAzureRuntimeStatus } from "../lib/azure/runtime-status";

jest.mock("../lib/azure/runtime-status", () => ({
  getAzureRuntimeStatus: jest.fn(),
  azureStartedCheck: jest.fn(),
}));

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

  test("stop removes stale stopped containers holding this stack's names", async () => {
    const { LocalStackContainerNotFoundError } = jest.requireActual("../lib/docker/docker.client");
    const removeContainer = jest.fn().mockResolvedValue(undefined);
    const waitForRemoval = jest.fn().mockResolvedValue(undefined);
    const stopped = (id: string, name: string) => ({
      id,
      name,
      state: "exited",
      running: false,
      publicPorts: [],
      labels: name === "localstack-main" ? undefined : { "cloud.localstack.lstk": "true" },
    });
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(new LocalStackContainerNotFoundError("none running")),
      listKnownLocalStackContainers: jest.fn().mockResolvedValue([
        stopped("stale-main", "localstack-main"),
        stopped("stale-aws", "localstack-aws"),
        stopped("stale-snow", "localstack-snowflake"),
        stopped("stale-snow-tag", "localstack-snowflake-1.4"),
        // A Lambda container LocalStack named after its own container: no lstk label.
        { ...stopped("fn", "localstack-snowflake-1.4-lambda-fn-1"), labels: undefined },
      ]),
      removeContainer,
      waitForRemoval,
    });

    const result = await localstackManagement({ action: "stop", service: "snowflake" } as any);
    expect(removeContainer.mock.calls.map(([id]) => id)).toEqual([
      "stale-main",
      "stale-snow",
      "stale-snow-tag",
    ]);
    expect(waitForRemoval).toHaveBeenCalledWith("stale-snow-tag");
    expect(text(result)).toContain(
      'Removed stopped LocalStack containers "localstack-main", "localstack-snowflake", "localstack-snowflake-1.4"'
    );
  });

  test("stop leaves running containers and other stacks' stopped containers alone", async () => {
    const { LocalStackContainerNotFoundError } = jest.requireActual("../lib/docker/docker.client");
    const removeContainer = jest.fn().mockResolvedValue(undefined);
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(new LocalStackContainerNotFoundError("none running")),
      listKnownLocalStackContainers: jest.fn().mockResolvedValue([
        {
          id: "snow",
          name: "localstack-snowflake",
          state: "exited",
          running: false,
          publicPorts: [],
        },
        {
          id: "aws",
          name: "localstack-aws-2026.4",
          state: "running",
          running: true,
          publicPorts: [5566],
        },
      ]),
      removeContainer,
    });
    mockedGetStatus.mockResolvedValue({ isRunning: false, isReady: false });

    await localstackManagement({ action: "stop", service: "aws" } as any);
    expect(removeContainer).not.toHaveBeenCalled();
  });

  test("stop looks only under MAIN_CONTAINER_NAME when it is set", async () => {
    process.env.MAIN_CONTAINER_NAME = "my-ls";
    const { LocalStackContainerNotFoundError } = jest.requireActual("../lib/docker/docker.client");
    const findContainerByNameAnyState = jest.fn().mockResolvedValue(null);
    const listKnownLocalStackContainers = jest.fn().mockResolvedValue([]);
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(new LocalStackContainerNotFoundError("none running")),
      findContainerByNameAnyState,
      listKnownLocalStackContainers,
    });
    mockedGetStatus.mockResolvedValue({ isRunning: false, isReady: false });

    await localstackManagement({ action: "stop", service: "aws" } as any);
    expect(findContainerByNameAnyState).toHaveBeenCalledTimes(1);
    expect(findContainerByNameAnyState).toHaveBeenCalledWith("my-ls");
    expect(listKnownLocalStackContainers).not.toHaveBeenCalled();
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

  test.each(["stop", "restart"])(
    "%s reports a container off LOCALSTACK_PORT instead of 'not running'",
    async (action) => {
      const { GatewayPortMismatchError } = jest.requireActual("../lib/docker/docker.client");
      const removeContainer = jest.fn();
      mockDocker({
        findLocalStackContainer: jest
          .fn()
          .mockRejectedValue(
            new GatewayPortMismatchError(
              'Found running LocalStack containers ("localstack-main" (gateway on 4566)), but none publishes the configured gateway port 4567.'
            )
          ),
        listKnownLocalStackContainers: jest.fn().mockResolvedValue([]),
        removeContainer,
      });
      mockedGetStatus.mockResolvedValue({ isRunning: false, isReady: false });

      const result = await localstackManagement({ action, service: "aws" } as any);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/gateway on 4566.*configured gateway port 4567/);
      expect(removeContainer).not.toHaveBeenCalled();
      expect(launchRuntime).not.toHaveBeenCalled();
    }
  );

  test("requires the auth token", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    const result = await localstackManagement({ action: "status", service: "aws" } as any);
    expect(text(result)).toContain("LOCALSTACK_AUTH_TOKEN");
  });

  test("start service=azure launches the Azure stack with its own health and licence checks", async () => {
    jest.mocked(launchRuntime).mockResolvedValue({ content: [{ type: "text", text: "started" }] });
    await localstackManagement({ action: "start", service: "azure" } as any);
    expect(launchRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        stack: "azure",
        getStatus: getAzureRuntimeStatus,
        onReady: azureStartedCheck,
      })
    );
  });

  const runningImage = (image: string) =>
    mockDocker({
      findLocalStackContainer: jest.fn().mockResolvedValue("id-1"),
      inspectContainer: jest.fn().mockResolvedValue({ id: "id-1", name: "localstack-main", image }),
    });

  test("status names another stack's running container, both ways", async () => {
    mockedGetStatus.mockResolvedValue({ isRunning: true, isReady: true });
    runningImage("localstack/localstack-pro:latest");
    const azure = await localstackManagement({ action: "status", service: "azure" } as any);
    expect(text(azure)).toContain("is the AWS stack — the Azure emulator is not running");
    runningImage("localstack/localstack-azure:latest");
    const snowflake = await localstackManagement({ action: "status", service: "snowflake" } as any);
    expect(text(snowflake)).toContain("is the Azure stack — the Snowflake emulator is not running");
  });

  test("status service=azure reports the Azure health check", async () => {
    mockedGetStatus.mockResolvedValue({ isRunning: true, isReady: true });
    runningImage("localstack/localstack-azure:latest");
    jest.mocked(getAzureRuntimeStatus).mockResolvedValue({
      isRunning: true,
      isReady: false,
      status: { ok: false, problem: "https-not-ready", message: "HTTPS is still starting" },
    });
    const result = await localstackManagement({ action: "status", service: "azure" } as any);
    expect(text(result)).toContain(
      "Azure emulator health check did not pass. (HTTPS is still starting)"
    );
  });
});
