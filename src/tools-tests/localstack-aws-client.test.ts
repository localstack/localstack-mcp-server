// Tool tests live outside src/tools/ because xmcp registers every src/tools/*.ts as a tool.
// The boundary is the spawned process: runCommand is replaced by a fake lstk/aws pair.
import path from "path";
import localstackAwsClient from "../tools/localstack-aws-client";
import localstackDeployer from "../tools/localstack-deployer";
import { runCommand, type CommandResult } from "../core/command-runner";
import { resetLstkAwsDependencyCheck } from "../lib/aws/lstk-aws";

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

jest.mock("../core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../core/preflight", () => ({
  ...jest.requireActual("../core/preflight"),
  requireLocalStackRunning: jest.fn(async () => null),
}));
jest.mock("../core/command-runner", () => ({
  ...jest.requireActual("../core/command-runner"),
  runCommand: jest.fn(),
}));

const mockedRun = jest.mocked(runCommand);
const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
const failed = (stdout: string, stderr = ""): CommandResult => ({
  stdout,
  stderr,
  exitCode: 1,
  error: new Error("Command failed with exit code 1"),
});
const missing = (): CommandResult => ({
  stdout: "",
  stderr: "",
  exitCode: null,
  error: new Error("spawn aws ENOENT"),
});

/** Answers `--version` for both CLIs, and `lstk aws …` with the given result. */
function fakeCli(awsResult: CommandResult, { awsInstalled = true } = {}) {
  mockedRun.mockImplementation(async (command, args) => {
    if (args[0] === "--version") {
      if (command === "aws") return awsInstalled ? ok("aws-cli/2.40.4 Python/3.14.8") : missing();
      return ok("lstk 1.4.4");
    }
    return awsResult;
  });
}

const lstkAwsCalls = () =>
  mockedRun.mock.calls.filter(([command, args]) => command === "lstk" && args[0] === "aws");
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("localstack-aws-client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetLstkAwsDependencyCheck();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.LOCALSTACK_HOSTNAME;
  });

  test("runs the command through lstk aws, aimed at LocalStack and without a pager", async () => {
    fakeCli(ok("2026-11-19 10:00:00 my-bucket\n"));

    const result = await localstackAwsClient({ command: `s3api list-objects --bucket "a b"` });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("my-bucket");
    const [[, args, options]] = lstkAwsCalls();
    expect(args).toEqual(["aws", "s3api", "list-objects", "--bucket", "a b"]);
    expect(options?.env).toMatchObject({
      AWS_ENDPOINT_URL: "http://localhost.localstack.cloud:4566",
      AWS_PAGER: "",
    });
  });

  test("drops lstk's missing-profile note from the AWS CLI output", async () => {
    fakeCli(ok(`> Note: No AWS profile found, run 'lstk setup aws'\n{"QueueUrls": []}\n`));

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect(text(result).trim()).toBe(`{"QueueUrls": []}`);
  });

  test("refuses a command that would leave LocalStack, without running anything", async () => {
    fakeCli(ok());

    const result = await localstackAwsClient({
      command: "s3 ls --profile prod --endpoint-url https://s3.amazonaws.com",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("commands always target LocalStack");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  test("names the AWS CLI install page when aws is missing", async () => {
    fakeCli(ok(), { awsInstalled: false });

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("getting-started-install.html");
    expect(lstkAwsCalls()).toHaveLength(0);
  });

  test("reports lstk's own failure, which it prints on stdout", async () => {
    fakeCli(failed("Error: no LocalStack emulator is running at http://localhost:4566\n"));

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("no LocalStack emulator is running");
  });

  test("links the coverage docs when LocalStack does not emulate an action", async () => {
    fakeCli(
      failed(
        "",
        "An error occurred (InternalFailure): The API action 'CreateThing' for service 'iot' is either not available in your current license plan or has not yet been emulated by LocalStack."
      )
    );

    const result = await localstackAwsClient({ command: "iot create-thing --thing-name t" });

    expect(text(result)).toContain("Service Not Implemented in LocalStack");
    expect(text(result)).toContain("coverage_iot");
  });
});

describe("localstack-deployer CloudFormation actions", () => {
  const template = path.resolve(__dirname, "../../data/sample-cloudformation/template.yaml");

  beforeEach(() => {
    jest.clearAllMocks();
    resetLstkAwsDependencyCheck();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
  });

  test("create-stack hands the AWS CLI the template file by absolute path", async () => {
    fakeCli(ok('{"StackId": "arn:aws:cloudformation:us-east-1:000000000000:stack/s/1"}'));

    const result = await localstackDeployer({
      ...deployerDefaults,
      action: "create-stack",
      stackName: "s",
      directory: path.relative(process.cwd(), path.dirname(template)),
    });

    expect(result.isError).toBeFalsy();
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

    expect(result.isError).toBe(true);
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

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("lstk reads it as a request for the AWS CLI's help");
    expect(lstkAwsCalls()).toHaveLength(0);
  });
});
