// Handler tests for localstack-aws-client. They live outside src/tools/ because xmcp registers
// every src/tools/*.ts as a tool. The spawned process (runCommand, answered by a fake lstk/aws
// pair), the gateway health probe and PostHog are mocked at the module boundary; analytics and
// the preflights run for real.
import localstackAwsClient from "../tools/localstack-aws-client";
import { runCommand } from "../core/command-runner";
import { getGatewayHealth } from "../lib/localstack/localstack.utils";
import { resetLstkAwsDependencyCheck } from "../lib/aws/lstk-aws";
import { resetPathConsent } from "../lib/aws/path-consent";
import { fakeCli, failed, isError, lstkAwsCalls, ok, text } from "./lstk-aws-fakes";
import fs from "fs";
import os from "os";
import path from "path";

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
    resetPathConsent();
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

  describe("a local path outside the working directory", () => {
    let downloads: string;
    let file: string;
    beforeAll(() => {
      downloads = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "downloads-")));
      file = path.join(downloads, "report.pdf");
      fs.writeFileSync(file, "pdf");
    });
    afterAll(() => fs.rmSync(downloads, { recursive: true, force: true }));

    // The client's side of a multi round-trip call: the first call, then a retry with the answer.
    const firstCall = (command: string) =>
      localstackAwsClient({ command }, { requestState: () => undefined } as any) as Promise<any>;
    const retry = (command: string, requestState: string, answer: unknown) =>
      localstackAwsClient({ command }, {
        requestState: () => requestState,
        inputResponses: { allow_path: answer },
      } as any) as Promise<any>;
    const accept = (scope: string) => ({ action: "accept", content: { scope } });

    test("asks about the resolved path first, and runs once the user allows it", async () => {
      fakeCli(ok("upload: done\n"));
      const command = `s3 cp ${file} s3://b/report.pdf`;

      const asked = await firstCall(command);
      expect(asked.resultType).toBe("input_required");
      expect(asked.inputRequests.allow_path.params.message).toContain(file);
      expect(lstkAwsCalls()).toHaveLength(0);

      const result = await retry(command, asked.requestState, accept("once"));
      expect(isError(result)).toBeFalsy();
      expect(lstkAwsCalls()).toHaveLength(1);
    });

    test("asks again next time when allowed once, not when the folder is allowed", async () => {
      fakeCli(ok("upload: done\n"));
      const command = `s3 cp ${file} s3://b/a`;
      const once = await firstCall(command);
      await retry(command, once.requestState, accept("once"));
      expect((await firstCall(command)).resultType).toBe("input_required");

      const folder = await firstCall(command);
      await retry(command, folder.requestState, accept("folder"));
      // Runs without asking: the retry allowed once, the retry allowing the folder, and this.
      expect(isError(await firstCall(command))).toBeFalsy();
      expect(lstkAwsCalls()).toHaveLength(3);
    });

    test.each([
      ["declines", { action: "decline" }],
      ["cancels", { action: "cancel" }],
    ])("is refused, with nothing run, when the user %s", async (_label, answer) => {
      fakeCli(ok());
      const command = `s3 cp ${file} s3://b/report.pdf`;

      const asked = await firstCall(command);
      const result = await retry(command, asked.requestState, answer);

      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("Local Path Not Allowed");
      expect(text(result)).toContain(`did not allow the AWS client to use ${file}`);
      expect(lstkAwsCalls()).toHaveLength(0);
    });

    test("an answer sent with another command's state allows nothing", async () => {
      fakeCli(ok());
      const asked = await firstCall(`s3 cp ${file} s3://b/a`);

      const result = await retry(`s3 cp ${file} s3://b/other`, asked.requestState, accept("once"));

      expect(result.resultType).toBe("input_required");
      expect(lstkAwsCalls()).toHaveLength(0);
    });

    test("is refused without asking when the server has no client to ask", async () => {
      fakeCli(ok());

      const result = await localstackAwsClient({ command: `s3 cp ${file} s3://b/report.pdf` });

      expect(text(result)).toContain("Local Path Not Allowed");
      expect(lstkAwsCalls()).toHaveLength(0);
    });

    test("never asks about ~, which is the CLI's private home, not the user's", async () => {
      fakeCli(ok());

      const result = await firstCall("s3 cp ~/Downloads/report.pdf s3://b/report.pdf");

      expect(result.resultType).toBeUndefined();
      expect(text(result)).toContain("write the absolute path");
      expect(lstkAwsCalls()).toHaveLength(0);
    });
  });
});
