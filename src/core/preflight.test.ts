import { requireDockerDaemon, requireLocalStackRunning } from "./preflight";
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
