// Tool tests live outside src/tools/ because xmcp registers every src/tools/*.ts as a
// tool. These tests exercise the real tools with the real runPreflights/requireStack;
// only the network, Docker and CLI edges are stubbed.
import { readFileSync } from "fs";
import { join } from "path";
import localstackAwsClient from "../tools/localstack-aws-client";
import localstackChaosInjector from "../tools/localstack-chaos-injector";
import localstackLogsAnalysis from "../tools/localstack-logs-analysis";
import localstackSnowflakeClient from "../tools/localstack-snowflake-client";
import { DockerApiClient } from "../lib/docker/docker.client";
import { getGatewayHealth } from "../lib/localstack/localstack.utils";
import { checkProFeature } from "../lib/localstack/license-checker";
import { LocalStackLogRetriever } from "../lib/logs/log-retriever";
import { resetStackDetectionCache } from "../core/preflight";

jest.mock("../core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../lib/localstack/localstack.utils", () => {
  const actual = jest.requireActual("../lib/localstack/localstack.utils");
  return {
    ...actual,
    getGatewayHealth: jest.fn(),
    ensureSnowflakeCli: jest.fn().mockResolvedValue(null),
  };
});

jest.mock("../lib/localstack/license-checker", () => {
  const actual = jest.requireActual("../lib/localstack/license-checker");
  return { ...actual, checkProFeature: jest.fn() };
});

jest.mock("../lib/docker/docker.client", () => {
  const actual = jest.requireActual("../lib/docker/docker.client");
  return { ...actual, DockerApiClient: jest.fn() };
});

jest.mock("../lib/logs/log-retriever", () => ({ LocalStackLogRetriever: jest.fn() }));

jest.mock("../core/command-runner", () => ({
  runCommand: jest
    .fn()
    .mockResolvedValue({ stdout: "localstack connected", stderr: "", exitCode: 0 }),
}));

const mockedHealth = getGatewayHealth as jest.MockedFunction<typeof getGatewayHealth>;
const mockedProFeature = checkProFeature as jest.MockedFunction<typeof checkProFeature>;
const MockedDocker = DockerApiClient as jest.MockedClass<typeof DockerApiClient>;
const MockedRetriever = LocalStackLogRetriever as jest.MockedClass<typeof LocalStackLogRetriever>;

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

const AZURE = { reachable: true, ready: true, edition: "azure-alpha" };
const PRO = { reachable: true, ready: true, edition: "pro", services: { s3: "available" } };

function mockDocker(image?: string) {
  const docker = {
    findLocalStackContainer: jest.fn().mockResolvedValue("id-1"),
    inspectContainer: jest.fn().mockResolvedValue({ id: "id-1", image }),
    executeInContainer: jest.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
  };
  MockedDocker.mockImplementation(() => docker as any);
  return docker;
}

describe("stack guards in the AWS-only tools, logs analysis and the Snowflake client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStackDetectionCache();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    mockedProFeature.mockResolvedValue({ isSupported: true } as any);
  });

  test("localstack-aws-client on the Azure emulator is refused and never execs in the container", async () => {
    mockedHealth.mockResolvedValue(AZURE);
    const docker = mockDocker("localstack/localstack-azure:latest");

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(text(result)).toMatch(/Wrong emulator for this tool/);
    expect(text(result)).toContain("Use `localstack-azure-client`");
    expect(docker.executeInContainer).not.toHaveBeenCalled();
  });

  test("localstack-aws-client on AWS looks up only an AWS container", async () => {
    mockedHealth.mockResolvedValue(PRO);
    const docker = mockDocker("localstack/localstack-pro:latest");

    await localstackAwsClient({ command: "s3 ls" });

    expect(docker.findLocalStackContainer).toHaveBeenCalledWith({ stack: "aws" });
    expect(docker.executeInContainer).toHaveBeenCalled();
  });

  test("a Pro-feature tool on Azure: the stack guard's error wins over requireProFeature", async () => {
    mockedHealth.mockResolvedValue(AZURE);
    mockDocker("localstack/localstack-azure:latest");
    mockedProFeature.mockResolvedValue({
      isSupported: false,
      errorMessage: "license does not include chaos",
    } as any);

    const result = await localstackChaosInjector({ action: "get-faults" } as any);

    expect(text(result)).toMatch(/Wrong emulator for this tool/);
    expect(text(result)).not.toMatch(/Feature Not Available/);
  });

  test("logs analysis in `logs` mode reaches the log retriever on the Azure emulator", async () => {
    mockedHealth.mockResolvedValue(AZURE);
    const retrieveLogs = jest
      .fn()
      .mockResolvedValue({ success: true, logs: [], totalLines: 0, filteredLines: 0 });
    MockedRetriever.mockImplementation(() => ({ retrieveLogs }) as any);

    const result = await localstackLogsAnalysis({ analysisType: "logs", lines: 100 } as any);

    expect(retrieveLogs).toHaveBeenCalled();
    expect(text(result)).not.toMatch(/Wrong emulator/);
  });

  test("logs analysis in `errors` mode is refused on Azure with the analysisType: logs hint", async () => {
    mockedHealth.mockResolvedValue(AZURE);
    const retrieveLogs = jest.fn();
    MockedRetriever.mockImplementation(() => ({ retrieveLogs }) as any);

    const result = await localstackLogsAnalysis({ analysisType: "errors", lines: 100 } as any);

    expect(text(result)).toMatch(/Wrong emulator for this tool/);
    expect(text(result)).toContain("use analysisType: logs");
    expect(retrieveLogs).not.toHaveBeenCalled();
  });

  test("the Snowflake client is refused on the Azure emulator before requireProFeature", async () => {
    mockedHealth.mockResolvedValue(AZURE);
    mockDocker("localstack/localstack-azure:latest");
    mockedProFeature.mockResolvedValue({ isSupported: false, errorMessage: "no snowflake" } as any);

    const result = await localstackSnowflakeClient({ action: "check-connection" } as any);

    expect(text(result)).toMatch(/Wrong emulator for this tool/);
    expect(text(result)).toContain("is LocalStack Azure");
  });

  test("the Snowflake client is refused on `pro` when the running container is the AWS image", async () => {
    mockedHealth.mockResolvedValue(PRO);
    mockDocker("localstack/localstack-pro:latest");

    const result = await localstackSnowflakeClient({ action: "check-connection" } as any);

    expect(text(result)).toMatch(/Wrong emulator for this tool/);
    expect(text(result)).toContain("is LocalStack AWS");
  });

  test("the Snowflake client is NOT refused on `pro` when the container is the Snowflake image (fail-open)", async () => {
    mockedHealth.mockResolvedValue(PRO);
    mockDocker("localstack/snowflake:latest");

    const result = await localstackSnowflakeClient({ action: "check-connection" } as any);

    expect(text(result)).not.toMatch(/Wrong emulator/);
  });

  test.each(["localstack-docs.ts", "localstack-ephemeral-instances.ts"])(
    "%s never calls requireStack (it does not talk to a local emulator)",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "tools", file), "utf8");
      expect(source).not.toContain("requireStack");
    }
  );
});
