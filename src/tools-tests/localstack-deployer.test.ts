// Handler tests for the deployer's CloudFormation actions, which run awslocal in the
// container. Docker is mocked at the module boundary; the assertions are on the execs sent
// to the container: the argument arrays and their environment.
import fs from "fs";
import os from "os";
import path from "path";
import localstackDeployer from "../tools/localstack-deployer";
import { DockerApiClient } from "../lib/docker/docker.client";

jest.mock("../core/analytics", () => ({
  withToolAnalytics: (_name: string, _args: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../core/preflight", () => {
  const actual = jest.requireActual("../core/preflight");
  return { ...actual, requireLocalStackRunning: jest.fn().mockResolvedValue(null) };
});

jest.mock("../lib/docker/docker.client", () => {
  const actual = jest.requireActual("../lib/docker/docker.client");
  return { ...actual, DockerApiClient: jest.fn() };
});

const MockedDocker = DockerApiClient as jest.MockedClass<typeof DockerApiClient>;
const MAPPED_ENV = [
  "GATEWAY_LISTEN=0.0.0.0:4700",
  "LOCALSTACK_HOST=localhost.localstack.cloud:5700",
];

function mockContainer(env: string[]) {
  const executeInContainer = jest.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  MockedDocker.mockImplementation(
    () =>
      ({
        findLocalStackContainer: jest.fn().mockResolvedValue("ls-id"),
        inspectContainer: jest.fn().mockResolvedValue({ id: "ls-id", env }),
        executeInContainer,
      }) as any
  );
  return executeInContainer;
}

const awslocalCalls = (exec: jest.Mock) => exec.mock.calls.filter((c) => c[1][0] === "awslocal");

describe("localstack-deployer CloudFormation actions", () => {
  let dir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-test-"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("create-stack points awslocal at the container-side gateway", async () => {
    const exec = mockContainer(MAPPED_ENV);
    const templatePath = path.join(dir, "template.yaml");
    fs.writeFileSync(templatePath, "Resources: {}\n");

    const result = await localstackDeployer({
      action: "create-stack",
      projectType: "auto",
      stackName: "s1",
      templatePath,
    } as any);

    expect((result as any).isError).toBeFalsy();
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
  });

  test("delete-stack points awslocal at the container-side gateway", async () => {
    const exec = mockContainer(["LOCALSTACK_HOST=localhost.localstack.cloud:4700"]);

    const result = await localstackDeployer({
      action: "delete-stack",
      projectType: "auto",
      stackName: "s1",
    } as any);

    expect((result as any).isError).toBeFalsy();
    expect(exec).toHaveBeenCalledWith(
      "ls-id",
      ["awslocal", "cloudformation", "delete-stack", "--stack-name", "s1"],
      undefined,
      { env: ["AWS_ENDPOINT_URL=http://localhost:4566"] }
    );
  });
});
