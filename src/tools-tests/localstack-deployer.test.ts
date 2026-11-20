// Handler tests for the deployer's CloudFormation actions, which run awslocal in the
// container. Docker, the gateway health probe and PostHog are mocked at the module boundary;
// analytics and the preflights run for real. The assertions are on the execs sent to the
// container (argument arrays and environment), the response, and the analytics events.
import fs from "fs";
import os from "os";
import path from "path";
import localstackDeployer from "../tools/localstack-deployer";
import { DockerApiClient } from "../lib/docker/docker.client";
import { getGatewayHealth } from "../lib/localstack/localstack.utils";

const mockCapture = jest.fn();
jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    flush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../lib/localstack/localstack.utils", () => {
  const actual = jest.requireActual("../lib/localstack/localstack.utils");
  return { ...actual, getGatewayHealth: jest.fn() };
});

jest.mock("../lib/docker/docker.client", () => {
  const actual = jest.requireActual("../lib/docker/docker.client");
  return { ...actual, DockerApiClient: jest.fn() };
});

const MockedDocker = DockerApiClient as jest.MockedClass<typeof DockerApiClient>;
const mockedHealth = getGatewayHealth as jest.MockedFunction<typeof getGatewayHealth>;
const MAPPED_ENV = [
  "GATEWAY_LISTEN=0.0.0.0:4700",
  "LOCALSTACK_HOST=localhost.localstack.cloud:5700",
];
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError;

type ExecResult = { stdout: string; stderr: string; exitCode: number };
const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

function mockContainer(
  env: string[],
  awslocalResult: ExecResult = OK,
  inspectContainer = jest.fn().mockResolvedValue({ id: "ls-id", env })
) {
  const executeInContainer = jest
    .fn()
    .mockImplementation(async (_id: string, cmd: string[]) =>
      cmd[0] === "awslocal" ? awslocalResult : OK
    );
  MockedDocker.mockImplementation(
    () =>
      ({
        findLocalStackContainer: jest.fn().mockResolvedValue("ls-id"),
        inspectContainer,
        executeInContainer,
      }) as any
  );
  return executeInContainer;
}

const awslocalCalls = (exec: jest.Mock) => exec.mock.calls.filter((c) => c[1][0] === "awslocal");
const shellCalls = (exec: jest.Mock) =>
  exec.mock.calls.filter((c) => c[1][0] === "/bin/sh").map((c) => c[1][2] as string);

describe("localstack-deployer CloudFormation actions", () => {
  let dir: string;
  let templatePath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MCP_ANALYTICS_DISABLED;
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    mockedHealth.mockResolvedValue({ reachable: true, ready: true } as any);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-test-"));
    templatePath = path.join(dir, "template.yaml");
    fs.writeFileSync(templatePath, "Resources: {}\n");
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const createStack = () =>
    localstackDeployer({
      action: "create-stack",
      projectType: "auto",
      stackName: "s1",
      templatePath,
    } as any);
  const deleteStack = () =>
    localstackDeployer({ action: "delete-stack", projectType: "auto", stackName: "s1" } as any);

  test("create-stack points awslocal at the container-side gateway and removes the template", async () => {
    const exec = mockContainer(MAPPED_ENV);

    const result = await createStack();

    expect(isError(result)).toBeFalsy();
    const calls = awslocalCalls(exec);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].slice(0, 5)).toEqual([
      "awslocal",
      "cloudformation",
      "create-stack",
      "--stack-name",
      "s1",
    ]);
    expect(calls[0][3]).toEqual({ env: ["AWS_ENDPOINT_URL=http://localhost:4700"] });
    expect(shellCalls(exec).filter((c) => c.startsWith("rm -f /tmp/ls-cfn-"))).toHaveLength(1);
  });

  test("create-stack failure returns an error with awslocal's stderr", async () => {
    mockContainer(MAPPED_ENV, {
      stdout: "",
      stderr: "ValidationError: bad template",
      exitCode: 255,
    });

    const result = await createStack();

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("CloudFormation create-stack failed");
    expect(text(result)).toContain("ValidationError: bad template");
  });

  test("create-stack with a failing inspect returns an error and still removes the template", async () => {
    const exec = mockContainer(
      [],
      OK,
      jest.fn().mockRejectedValue(new Error("no such container: ls-id"))
    );

    const result = await createStack();

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("no such container: ls-id");
    expect(awslocalCalls(exec)).toHaveLength(0);
    const shell = shellCalls(exec);
    const written = shell.find((c) => c.startsWith("cat > "))!.slice("cat > ".length);
    expect(shell).toContain(`rm -f ${written}`);
  });

  test.each([["create-stack"], ["delete-stack"]])(
    "%s without stackName is rejected before anything runs",
    async (action) => {
      const exec = mockContainer([]);

      const result = await localstackDeployer({ action, projectType: "auto", templatePath } as any);

      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("stackName");
      expect(exec).not.toHaveBeenCalled();
    }
  );

  test("delete-stack points awslocal at the container-side gateway", async () => {
    const exec = mockContainer(["LOCALSTACK_HOST=localhost.localstack.cloud:4700"]);

    const result = await deleteStack();

    expect(isError(result)).toBeFalsy();
    expect(exec).toHaveBeenCalledWith(
      "ls-id",
      ["awslocal", "cloudformation", "delete-stack", "--stack-name", "s1"],
      undefined,
      { env: ["AWS_ENDPOINT_URL=http://localhost:4566"] }
    );
  });

  test("delete-stack failure returns an error with awslocal's stderr", async () => {
    mockContainer([], { stdout: "", stderr: "Stack s1 does not exist", exitCode: 255 });

    const result = await deleteStack();

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("CloudFormation delete-stack failed");
    expect(text(result)).toContain("Stack s1 does not exist");
  });

  test("delete-stack with a failing inspect returns an error and runs nothing", async () => {
    const exec = mockContainer(
      [],
      OK,
      jest.fn().mockRejectedValue(new Error("no such container: ls-id"))
    );

    const result = await deleteStack();

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("no such container: ls-id");
    expect(exec).not.toHaveBeenCalled();
  });

  test("the container's auth token reaches neither the exec env, the response nor analytics", async () => {
    const secret = "ls-FAKE-container-token-0123456789";
    const exec = mockContainer([`LOCALSTACK_AUTH_TOKEN=${secret}`, ...MAPPED_ENV]);

    const created = await createStack();
    const deleted = await deleteStack();

    expect(isError(created)).toBeFalsy();
    expect(isError(deleted)).toBeFalsy();
    expect(JSON.stringify(exec.mock.calls)).not.toContain(secret);
    expect(JSON.stringify([created, deleted])).not.toContain(secret);
    expect(mockCapture).toHaveBeenCalled();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(secret);
  });
});
