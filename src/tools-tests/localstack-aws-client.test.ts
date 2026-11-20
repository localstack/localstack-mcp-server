// Handler tests for localstack-aws-client. Docker is mocked at the module boundary; the
// assertions are on the exec sent to the container: the argument array and its environment.
import localstackAwsClient from "../tools/localstack-aws-client";
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
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

function mockContainer(env: string[], result = { stdout: "ok", stderr: "", exitCode: 0 }) {
  const executeInContainer = jest.fn().mockResolvedValue(result);
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

describe("localstack-aws-client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
  });

  test.each([
    ["the default gateway", [], "http://localhost:4566"],
    [
      "a gateway published on another host port",
      ["LOCALSTACK_HOST=localhost.localstack.cloud:4700"],
      "http://localhost:4566",
    ],
    [
      "a gateway moved by GATEWAY_LISTEN",
      ["GATEWAY_LISTEN=0.0.0.0:4700", "LOCALSTACK_HOST=localhost.localstack.cloud:5700"],
      "http://localhost:4700",
    ],
  ])("points awslocal at the container-side gateway for %s", async (_label, env, endpoint) => {
    const exec = mockContainer(env);

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect((result as any).isError).toBeFalsy();
    expect(text(result as any)).toBe("ok");
    expect(exec).toHaveBeenCalledWith("ls-id", ["awslocal", "sqs", "list-queues"], undefined, {
      env: [`AWS_ENDPOINT_URL=${endpoint}`],
    });
  });

  test("a failing command returns an error with its stderr", async () => {
    mockContainer([], { stdout: "", stderr: "boom", exitCode: 255 });

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect((result as any).isError).toBe(true);
    expect(text(result as any)).toContain("boom");
  });

  test("shell syntax is rejected before anything runs", async () => {
    const exec = mockContainer([]);

    const result = await localstackAwsClient({ command: "s3 ls; cat /etc/passwd" });

    expect((result as any).isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  test("without an auth token nothing runs", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    const exec = mockContainer([]);

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect((result as any).isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});
