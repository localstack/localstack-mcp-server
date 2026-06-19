import { requireLocalStackRunning } from "./preflight";
import { getGatewayHealth } from "../lib/localstack/localstack.utils";

jest.mock("../lib/localstack/localstack.utils", () => ({
  getGatewayHealth: jest.fn(),
  ensureLocalStackCli: jest.fn(),
  ensureSnowflakeCli: jest.fn(),
}));

const mockedGetGatewayHealth = getGatewayHealth as jest.MockedFunction<typeof getGatewayHealth>;

describe("requireLocalStackRunning", () => {
  beforeEach(() => mockedGetGatewayHealth.mockReset());

  test("passes for any reachable gateway, regardless of container name or CLI", async () => {
    // e.g. an `lstk`-started container named `localstack-aws` with no Python CLI.
    mockedGetGatewayHealth.mockResolvedValueOnce({
      reachable: true,
      ready: true,
      services: { s3: "available" },
    });

    expect(await requireLocalStackRunning()).toBeNull();
  });

  test("blocks with an error when the gateway is unreachable", async () => {
    mockedGetGatewayHealth.mockResolvedValueOnce({ reachable: false, ready: false });

    const result = await requireLocalStackRunning();
    expect(result).not.toBeNull();
    expect(result?.content[0].text).toMatch(/LocalStack Not Running/i);
  });
});
