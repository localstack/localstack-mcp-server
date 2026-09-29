import {
  requireDockerDaemon,
  requireLocalStackRunning,
  requireStack,
  resetStackDetectionCache,
} from "./preflight";
import { getGatewayHealth } from "../lib/localstack/localstack.utils";
import { DockerApiClient } from "../lib/docker/docker.client";

jest.mock("../lib/localstack/localstack.utils", () => ({
  getGatewayHealth: jest.fn(),
  ensureSnowflakeCli: jest.fn(),
}));

jest.mock("../lib/docker/docker.client", () => ({
  DockerApiClient: jest.fn(),
}));

const mockedGetGatewayHealth = getGatewayHealth as jest.MockedFunction<typeof getGatewayHealth>;
const MockedDockerApiClient = DockerApiClient as jest.MockedClass<typeof DockerApiClient>;

describe("requireLocalStackRunning", () => {
  beforeEach(() => mockedGetGatewayHealth.mockReset());

  test("passes for any reachable gateway, regardless of container name or provenance", async () => {
    // e.g. an externally-started container named `localstack-aws`.
    mockedGetGatewayHealth.mockResolvedValueOnce({
      reachable: true,
      ready: true,
      services: { s3: "available" },
    });

    expect(await requireLocalStackRunning()).toBeNull();
  });

  test("blocks with an error pointing at the management tool when the gateway is unreachable", async () => {
    mockedGetGatewayHealth.mockResolvedValueOnce({ reachable: false, ready: false });

    const result = await requireLocalStackRunning();
    expect(result).not.toBeNull();
    expect(result?.content[0].text).toMatch(/LocalStack Not Running/i);
    expect(result?.content[0].text).toMatch(/localstack-management/);
    // No stale advice to install/run a CLI.
    expect(result?.content[0].text).not.toMatch(/localstack start|lstk/);
  });
});

describe("requireDockerDaemon", () => {
  beforeEach(() => MockedDockerApiClient.mockReset());

  test("passes when the daemon answers the ping", async () => {
    MockedDockerApiClient.mockImplementation(
      () => ({ ping: jest.fn().mockResolvedValue(undefined) }) as any
    );
    expect(await requireDockerDaemon()).toBeNull();
  });

  test("blocks with the friendly daemon message when the ping fails", async () => {
    MockedDockerApiClient.mockImplementation(
      () =>
        ({
          ping: jest.fn().mockRejectedValue(new Error("Docker daemon is not reachable. (ENOENT)")),
        }) as any
    );
    const result = await requireDockerDaemon();
    expect(result).not.toBeNull();
    expect(result?.content[0].text).toMatch(/Docker Not Available/);
    expect(result?.content[0].text).toMatch(/Docker daemon is not reachable/);
  });
});

describe("requireStack", () => {
  const azureHealth = { reachable: true, ready: true, edition: "azure-alpha" };
  const awsHealth = { reachable: true, ready: true, edition: "pro" };

  function mockContainer(container?: { image?: string; labels?: Record<string, string> }) {
    MockedDockerApiClient.mockImplementation(
      () =>
        ({
          findLocalStackContainer: container
            ? jest.fn().mockResolvedValue("id-1")
            : jest.fn().mockRejectedValue(new Error("no container")),
          inspectContainer: jest.fn().mockResolvedValue({ id: "id-1", ...container }),
        }) as any
    );
  }

  beforeEach(() => {
    mockedGetGatewayHealth.mockReset();
    MockedDockerApiClient.mockReset();
    resetStackDetectionCache();
  });

  test("passes when the edition matches", async () => {
    mockedGetGatewayHealth.mockResolvedValue(awsHealth);
    expect(await requireStack("aws", "localstack-aws-client")).toBeNull();
  });

  test("refuses an AWS-only tool on the Azure emulator with the exact title and hint", async () => {
    mockedGetGatewayHealth.mockResolvedValue(azureHealth);
    const result = await requireStack("aws", "localstack-aws-client");
    const text = result?.content[0].text ?? "";
    expect(text).toMatch(/^❌ \*\*Wrong emulator for this tool\*\*/);
    expect(text).toContain("`localstack-aws-client` works with the LocalStack AWS emulator");
    expect(text).toContain("is LocalStack Azure");
    expect(text).toContain("Use `localstack-azure-client`");
    expect(text).toContain("service: aws");
  });

  test("appends a tool-specific hint", async () => {
    mockedGetGatewayHealth.mockResolvedValue(azureHealth);
    const result = await requireStack("aws", "localstack-logs-analysis", {
      hint: "Use analysisType logs.",
    });
    expect(result?.content[0].text).toMatch(/Use analysisType logs\.$/);
  });

  test("falls back to the container when the edition is unknown", async () => {
    mockedGetGatewayHealth.mockResolvedValue({ reachable: true, ready: true, edition: "unknown" });
    mockContainer({ image: "localstack/localstack-azure:latest" });
    const result = await requireStack("aws", "localstack-aws-client");
    expect(result?.content[0].text).toContain("is LocalStack Azure");
  });

  test("uses the container's Azure label for a bare image ID", async () => {
    mockedGetGatewayHealth.mockResolvedValue({ reachable: true, ready: true });
    mockContainer({ image: "f91897f1de85", labels: { description: "LocalStack for Azure" } });
    expect(await requireStack("aws", "localstack-aws-client")).not.toBeNull();
  });

  test("passes (fail-open) when neither the edition nor the container says which stack", async () => {
    mockedGetGatewayHealth.mockResolvedValue({ reachable: true, ready: true });
    mockContainer(undefined);
    expect(await requireStack("aws", "localstack-aws-client")).toBeNull();
  });

  test("passes when the gateway is unreachable (the running-check preflight reports it)", async () => {
    mockedGetGatewayHealth.mockResolvedValue({ reachable: false, ready: false });
    expect(await requireStack("aws", "localstack-aws-client")).toBeNull();
  });

  test("two parallel calls share one health request (2 s cache)", async () => {
    mockedGetGatewayHealth.mockResolvedValue(awsHealth);
    await Promise.all([
      requireStack("aws", "localstack-aws-client"),
      requireStack("aws", "localstack-deployer"),
    ]);
    expect(mockedGetGatewayHealth).toHaveBeenCalledTimes(1);
  });

  test("side by side: the Azure tool reads its own port, so both tools pass", async () => {
    mockedGetGatewayHealth.mockImplementation(async (baseUrl?: string) =>
      baseUrl === "http://127.0.0.1:4666" ? azureHealth : awsHealth
    );
    expect(
      await requireStack("azure", "localstack-azure-client", { baseUrl: "http://127.0.0.1:4666" })
    ).toBeNull();
    expect(await requireStack("aws", "localstack-aws-client")).toBeNull();
  });

  test("side by side with the ports swapped, both tools refuse", async () => {
    mockedGetGatewayHealth.mockImplementation(async (baseUrl?: string) =>
      baseUrl === "http://127.0.0.1:4666" ? awsHealth : azureHealth
    );
    const azure = await requireStack("azure", "localstack-azure-client", {
      baseUrl: "http://127.0.0.1:4666",
    });
    expect(azure?.content[0].text).toContain(
      "the emulator at http://127.0.0.1:4666 is LocalStack AWS"
    );
    expect(await requireStack("aws", "localstack-aws-client")).not.toBeNull();
  });

  test("names the Snowflake emulator, not AWS, when a Snowflake image reports `pro`", async () => {
    // The Snowflake emulator's health reports edition `pro` (checked 2026-09-28),
    // as AWS does, so the Azure tool met it and said "is LocalStack AWS".
    mockedGetGatewayHealth.mockResolvedValue(awsHealth);
    mockContainer({ image: "localstack/snowflake:latest" });
    const text = (await requireStack("azure", "localstack-azure-client"))?.content[0].text ?? "";
    expect(text).toContain("is LocalStack Snowflake");
    expect(text).toContain("Use `localstack-snowflake-client`");
  });

  test("still names AWS when the `pro` container is the AWS image", async () => {
    mockedGetGatewayHealth.mockResolvedValue(awsHealth);
    mockContainer({ image: "localstack/localstack-pro:latest" });
    const text = (await requireStack("azure", "localstack-azure-client"))?.content[0].text ?? "";
    expect(text).toContain("is LocalStack AWS");
    expect(text).toContain("Use `localstack-aws-client`");
  });

  describe("the Snowflake client, whose edition reads like AWS's", () => {
    test("is refused on the Azure emulator", async () => {
      mockedGetGatewayHealth.mockResolvedValue(azureHealth);
      expect(await requireStack("snowflake", "localstack-snowflake-client")).not.toBeNull();
    });

    test("is refused on `pro` when the container is the AWS image", async () => {
      mockedGetGatewayHealth.mockResolvedValue(awsHealth);
      mockContainer({ image: "localstack/localstack-pro:latest" });
      const result = await requireStack("snowflake", "localstack-snowflake-client");
      expect(result?.content[0].text).toContain("is LocalStack AWS");
    });

    test("is NOT refused on `pro` when the container is the Snowflake image", async () => {
      mockedGetGatewayHealth.mockResolvedValue(awsHealth);
      mockContainer({ image: "localstack/snowflake:latest" });
      expect(await requireStack("snowflake", "localstack-snowflake-client")).toBeNull();
    });

    test("is NOT refused on `pro` when the container cannot be inspected", async () => {
      mockedGetGatewayHealth.mockResolvedValue(awsHealth);
      mockContainer(undefined);
      expect(await requireStack("snowflake", "localstack-snowflake-client")).toBeNull();
    });
  });
});
