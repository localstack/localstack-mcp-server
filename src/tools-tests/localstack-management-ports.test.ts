// Through the tool: with LOCALSTACK_PORT=4666, stop and restart never select a
// container that does not publish 4666, so a test run beside a shared emulator on 4566
// can never stop it. The real DockerApiClient
// runs; only dockerode is mocked.
import localstackManagement from "../tools/localstack-management";

jest.mock("../core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../core/preflight", () => {
  const actual = jest.requireActual("../core/preflight");
  return { ...actual, requireDockerDaemon: jest.fn().mockResolvedValue(null) };
});

jest.mock("../lib/localstack/localstack.utils", () => {
  const actual = jest.requireActual("../lib/localstack/localstack.utils");
  return {
    ...actual,
    getLocalStackStatus: jest.fn().mockResolvedValue({ isRunning: false, isReady: false }),
    launchRuntime: jest.fn().mockResolvedValue({ content: [{ type: "text", text: "launched" }] }),
  };
});

jest.mock("dockerode", () => {
  const listContainers = jest.fn();
  const stop = jest.fn();
  const remove = jest.fn();
  const inspect = jest.fn();
  const getContainer = jest.fn((id: string) => ({
    id,
    stop: () => stop(id),
    remove: () => remove(id),
    inspect: () => inspect(id),
  }));
  class DockerMock {
    static __mocks = { listContainers, getContainer, stop, remove, inspect };
    modem = {};
    listContainers = listContainers;
    getContainer = getContainer;
  }
  return DockerMock as any;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mocks = () => (require("dockerode") as any).__mocks;
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

const sharedAzure = {
  Id: "shared-4566",
  Names: ["/localstack-azure"],
  Image: "f91897f1de85",
  Labels: { description: "LocalStack for Azure" },
  Ports: [{ PrivatePort: 4566, PublicPort: 4566, Type: "tcp" }],
  State: "running",
};
const testContainer = {
  Id: "test-4666",
  Names: ["/localstack-azure-mcp-test"],
  Image: "localstack/localstack-azure:latest",
  Ports: [{ PrivatePort: 4666, PublicPort: 4666, Type: "tcp" }],
  State: "running",
};

describe("stop and restart with LOCALSTACK_PORT=4666, through the tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    process.env.LOCALSTACK_PORT = "4666";
    process.env.MAIN_CONTAINER_NAME = "localstack-azure-mcp-test";
    mocks().stop.mockResolvedValue(undefined);
    mocks().remove.mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.LOCALSTACK_PORT;
    delete process.env.MAIN_CONTAINER_NAME;
  });

  test("stop stops the test container, never the shared emulator", async () => {
    mocks().listContainers.mockResolvedValue([sharedAzure, testContainer]);
    const result = await localstackManagement({ action: "stop", service: "azure" } as any);
    expect(text(result)).toMatch(/stopped successfully/);
    expect(mocks().stop).toHaveBeenCalledWith("test-4666");
    expect(mocks().stop).not.toHaveBeenCalledWith("shared-4566");
  });

  test("with only the shared emulator running, stop touches nothing", async () => {
    mocks().listContainers.mockResolvedValue([sharedAzure]);
    const result = await localstackManagement({ action: "stop", service: "azure" } as any);
    expect(mocks().stop).not.toHaveBeenCalled();
    expect(mocks().remove).not.toHaveBeenCalled();
    expect(text(result)).not.toMatch(/stopped successfully/);
  });

  test("with only the shared emulator running, restart never stops it", async () => {
    mocks().listContainers.mockResolvedValue([sharedAzure]);
    await localstackManagement({ action: "restart", service: "azure" } as any);
    expect(mocks().stop).not.toHaveBeenCalled();
    expect(mocks().remove).not.toHaveBeenCalled();
  });
});
