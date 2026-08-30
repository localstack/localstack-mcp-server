import localstackDeployer from "../tools/localstack-deployer";
import { requireLocalStackRunning, runPreflights } from "../core/preflight";

jest.mock("../core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../core/preflight", () => ({
  requireAuthToken: jest.fn().mockReturnValue(null),
  requireLocalStackRunning: jest.fn().mockResolvedValue(null),
  runPreflights: jest.fn().mockResolvedValue({ content: [] }),
}));

const mockedRequireLocalStackRunning = requireLocalStackRunning as jest.MockedFunction<
  typeof requireLocalStackRunning
>;
const mockedRunPreflights = runPreflights as jest.MockedFunction<typeof runPreflights>;

describe("localstack-deployer preflight", () => {
  const originalEndpoint = process.env.AWS_ENDPOINT_URL;

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.AWS_ENDPOINT_URL;
    } else {
      process.env.AWS_ENDPOINT_URL = originalEndpoint;
    }
    jest.clearAllMocks();
  });

  test("checks the configured deployment endpoint", async () => {
    process.env.AWS_ENDPOINT_URL = "https://ls-example.sandbox.localstack.cloud/";

    await localstackDeployer({
      action: "deploy",
      projectType: "terraform",
      directory: undefined,
      variables: undefined,
      stackName: undefined,
      templatePath: undefined,
      s3Bucket: undefined,
      resolveS3: undefined,
      saveParams: undefined,
    });

    expect(mockedRequireLocalStackRunning).toHaveBeenCalledWith(
      "https://ls-example.sandbox.localstack.cloud"
    );
    expect(mockedRunPreflights).toHaveBeenCalledTimes(1);
  });

  test("keeps container-based CloudFormation actions on the local gateway", async () => {
    process.env.AWS_ENDPOINT_URL = "https://ls-example.sandbox.localstack.cloud";

    await localstackDeployer({
      action: "create-stack",
      projectType: "auto",
      directory: undefined,
      variables: undefined,
      stackName: undefined,
      templatePath: undefined,
      s3Bucket: undefined,
      resolveS3: undefined,
      saveParams: undefined,
    });

    expect(mockedRequireLocalStackRunning).toHaveBeenCalledWith(undefined);
  });
});
