// Handler tests for the deployer's CloudFormation actions, which run the AWS CLI through
// `lstk aws`. The spawned process (runCommand, answered by a fake lstk/aws pair), the gateway
// health probe and PostHog are mocked at the module boundary; analytics and the preflights run
// for real.
import path from "path";
import localstackDeployer from "../tools/localstack-deployer";
import { runCommand } from "../core/command-runner";
import { getGatewayHealth } from "../lib/localstack/localstack.utils";
import { resetLstkAwsDependencyCheck } from "../lib/aws/lstk-aws";
import { fakeCli, failed, isError, lstkAwsCalls, ok, text } from "./lstk-aws-fakes";

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
jest.mock("../core/command-runner", () => ({
  ...jest.requireActual("../core/command-runner"),
  runCommand: jest.fn(),
}));

const mockedRun = jest.mocked(runCommand);
const mockedHealth = jest.mocked(getGatewayHealth);

// The deployer's other parameters, which the CloudFormation actions ignore.
const deployerDefaults = {
  projectType: "auto" as const,
  directory: undefined,
  variables: undefined,
  stackName: undefined,
  templatePath: undefined,
  s3Bucket: undefined,
  resolveS3: undefined,
  saveParams: undefined,
};

describe("localstack-deployer CloudFormation actions", () => {
  const template = path.resolve(__dirname, "../../data/sample-cloudformation/template.yaml");

  beforeEach(() => {
    jest.clearAllMocks();
    resetLstkAwsDependencyCheck();
    delete process.env.MCP_ANALYTICS_DISABLED;
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    mockedHealth.mockResolvedValue({ reachable: true, ready: true } as any);
  });

  const createStack = () =>
    localstackDeployer({
      ...deployerDefaults,
      action: "create-stack",
      stackName: "s",
      directory: path.relative(process.cwd(), path.dirname(template)),
    });
  const deleteStack = () =>
    localstackDeployer({ ...deployerDefaults, action: "delete-stack", stackName: "s" });

  test("create-stack hands the AWS CLI the template file by absolute path", async () => {
    fakeCli(ok('{"StackId": "arn:aws:cloudformation:us-east-1:000000000000:stack/s/1"}'));

    const result = await localstackDeployer({
      ...deployerDefaults,
      action: "create-stack",
      stackName: "s",
      directory: path.relative(process.cwd(), path.dirname(template)),
    });

    expect(isError(result)).toBeFalsy();
    expect(text(result)).toContain("StackId");
    expect(lstkAwsCalls()[0][1]).toEqual([
      "aws",
      "cloudformation",
      "create-stack",
      "--stack-name",
      "s",
      "--template-body",
      `file://${template}`,
    ]);
  });

  test("delete-stack reports the AWS CLI's error", async () => {
    fakeCli(failed("", "An error occurred (ValidationError): Stack s does not exist"));

    const result = await localstackDeployer({
      ...deployerDefaults,
      action: "delete-stack",
      stackName: "s",
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("CloudFormation delete-stack failed");
    expect(text(result)).toContain("Stack s does not exist");
    expect(lstkAwsCalls()[0][1]).toEqual([
      "aws",
      "cloudformation",
      "delete-stack",
      "--stack-name",
      "s",
    ]);
  });

  test.each([
    "--endpoint-url=https://cloudformation.us-east-1.amazonaws.com",
    "my_stack",
    "1stack",
  ])("refuses a stack name that is not one, without running the CLI: %s", async (stackName) => {
    fakeCli(ok());

    const result = await localstackDeployer({
      ...deployerDefaults,
      action: "delete-stack",
      stackName,
    });

    expect(text(result)).toContain("Invalid Stack Name");
    expect(lstkAwsCalls()).toHaveLength(0);
  });

  // A valid name, but lstk would read it as a help request and skip its endpoint handling.
  test.each(["help"])("refuses the stack name '%s', without running the CLI", async (stackName) => {
    fakeCli(ok());

    const result = await localstackDeployer({
      ...deployerDefaults,
      action: "delete-stack",
      stackName,
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("lstk reads it as a request for the AWS CLI's help");
    expect(lstkAwsCalls()).toHaveLength(0);
  });

  test("create-stack reports the AWS CLI's error", async () => {
    fakeCli(failed("", "An error occurred (ValidationError): Template format error"));

    const result = await createStack();

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("CloudFormation create-stack failed");
    expect(text(result)).toContain("Template format error");
  });

  test.each(["create-stack", "delete-stack"] as const)(
    "%s without stackName is rejected before anything runs",
    async (action) => {
      fakeCli(ok());

      const result = await localstackDeployer({ ...deployerDefaults, action });

      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("stackName");
      expect(mockedRun).not.toHaveBeenCalled();
    }
  );

  test("the auth token reaches neither the CLI's environment, the responses nor analytics", async () => {
    const secret = "ls-FAKE-server-token-0123456789";
    process.env.LOCALSTACK_AUTH_TOKEN = secret;
    fakeCli(ok("{}"));

    const created = await createStack();
    const deleted = await deleteStack();

    expect(isError(created)).toBeFalsy();
    expect(isError(deleted)).toBeFalsy();
    expect(lstkAwsCalls()).toHaveLength(2);
    expect(JSON.stringify(mockedRun.mock.calls)).not.toContain(secret);
    expect(JSON.stringify([created, deleted])).not.toContain(secret);
    expect(mockCapture).toHaveBeenCalled();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(secret);
  });
});
