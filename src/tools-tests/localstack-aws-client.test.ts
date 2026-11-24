// Handler tests for localstack-aws-client. They live outside src/tools/ because xmcp registers
// every src/tools/*.ts as a tool. The spawned process (runCommand, answered by a fake lstk/aws
// pair), the gateway health probe and PostHog are mocked at the module boundary; analytics and
// the preflights run for real.
import localstackAwsClient from "../tools/localstack-aws-client";
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
const saved = { ...process.env };

describe("localstack-aws-client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetLstkAwsDependencyCheck();
    process.env = { ...saved, LOCALSTACK_AUTH_TOKEN: "ls-test-token" };
    delete process.env.MCP_ANALYTICS_DISABLED;
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.LOCALSTACK_HOSTNAME;
    delete process.env.LOCALSTACK_PORT;
    mockedHealth.mockResolvedValue({ reachable: true, ready: true } as any);
  });

  afterAll(() => {
    process.env = saved;
  });

  test("runs the command through lstk aws, aimed at LocalStack and without a pager", async () => {
    fakeCli(ok("2026-11-19 10:00:00 my-bucket\n"));

    const result = await localstackAwsClient({ command: `s3api list-objects --bucket "a b"` });

    expect(isError(result)).toBeFalsy();
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

  test("returns stderr after the output when the command succeeds", async () => {
    fakeCli({
      stdout: "2026-11-19 my-bucket\n",
      stderr: "warning: ```x``` deprecated\n",
      exitCode: 0,
    });

    const result = await localstackAwsClient({ command: "s3 ls --debug" });

    expect(isError(result)).toBeFalsy();
    expect(text(result)).toBe(
      "2026-11-19 my-bucket\n\n**stderr:**\n\n````\nwarning: ```x``` deprecated\n````"
    );
  });

  test("returns a long stderr with many backtick runs", async () => {
    fakeCli({ stdout: "ok\n", stderr: "`a".repeat(200_000), exitCode: 0 });

    const result = await localstackAwsClient({ command: "s3 ls --debug" });

    expect(isError(result)).toBeFalsy();
    expect(text(result)).toContain("ok\n\n**stderr:**\n\n```\n`a`a");
  });

  test("returns only the output when the command writes nothing to stderr", async () => {
    fakeCli(ok("out\n"));

    expect(text(await localstackAwsClient({ command: "--version" }))).toBe("out\n");
  });

  test("refuses a command that would leave LocalStack, without running anything", async () => {
    fakeCli(ok());

    const result = await localstackAwsClient({
      command: "s3 ls --profile prod --endpoint-url https://s3.amazonaws.com",
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("commands always target LocalStack");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  test("names the AWS CLI install page when aws is missing", async () => {
    fakeCli(ok(), { awsInstalled: false });

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("getting-started-install.html");
    expect(lstkAwsCalls()).toHaveLength(0);
  });

  test("reports lstk's own failure, which it prints on stdout", async () => {
    fakeCli(failed("Error: no LocalStack emulator is running at http://localhost:4566\n"));

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(isError(result)).toBe(true);
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

  test("aims at the gateway's host port, so s3 presign returns a URL the host can open", async () => {
    process.env.LOCALSTACK_PORT = "4700";
    fakeCli(ok("http://localhost.localstack.cloud:4700/b/k?X-Amz-Signature=abc\n"));

    const result = await localstackAwsClient({ command: "s3 presign s3://b/k" });

    expect(isError(result)).toBeFalsy();
    const [[, args, options]] = lstkAwsCalls();
    expect(args).toEqual(["aws", "s3", "presign", "s3://b/k"]);
    expect(options?.env).toMatchObject({
      AWS_ENDPOINT_URL: "http://localhost.localstack.cloud:4700",
    });
  });

  test("without an auth token nothing runs", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    fakeCli(ok());

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("LOCALSTACK_AUTH_TOKEN");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  test("with LocalStack not running nothing runs", async () => {
    mockedHealth.mockResolvedValue({ reachable: false, ready: false } as any);
    fakeCli(ok());

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("LocalStack Not Running");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  test("the auth token reaches neither the CLI's environment, the response nor analytics", async () => {
    const secret = "ls-FAKE-server-token-0123456789";
    process.env.LOCALSTACK_AUTH_TOKEN = secret;
    fakeCli(ok("{}"));

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect(isError(result)).toBeFalsy();
    expect(lstkAwsCalls()).toHaveLength(1);
    expect(JSON.stringify(mockedRun.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(mockCapture).toHaveBeenCalled();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(secret);
  });
});
