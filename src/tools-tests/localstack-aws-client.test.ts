// Handler tests for localstack-aws-client. Docker, the gateway health probe and PostHog are
// mocked at the module boundary; analytics and the preflights run for real. The assertions
// are on what leaves the process: the exec sent to the container (argument array and
// environment), the response, and the analytics events.
import localstackAwsClient from "../tools/localstack-aws-client";
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
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError;

function mockContainer(
  env: string[],
  result = { stdout: "ok", stderr: "", exitCode: 0 },
  inspectContainer = jest.fn().mockResolvedValue({ id: "ls-id", env })
) {
  const executeInContainer = jest.fn().mockResolvedValue(result);
  MockedDocker.mockImplementation(
    () =>
      ({
        findLocalStackContainer: jest.fn().mockResolvedValue("ls-id"),
        inspectContainer,
        executeInContainer,
      }) as any
  );
  return { executeInContainer, inspectContainer };
}

describe("localstack-aws-client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MCP_ANALYTICS_DISABLED;
    process.env.LOCALSTACK_AUTH_TOKEN = "ls-test-token";
    mockedHealth.mockResolvedValue({ reachable: true, ready: true } as any);
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
    const { executeInContainer } = mockContainer(env);

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect(isError(result)).toBeFalsy();
    expect(text(result)).toBe("ok");
    expect(executeInContainer).toHaveBeenCalledWith(
      "ls-id",
      ["awslocal", "sqs", "list-queues"],
      undefined,
      { env: [`AWS_ENDPOINT_URL=${endpoint}`] }
    );
  });

  test("s3 presign keeps awslocal's LOCALSTACK_HOST endpoint, so the URL works from the host", async () => {
    const url = "http://localhost.localstack.cloud:4700/b/k?X-Amz-Signature=abc";
    const { executeInContainer } = mockContainer(
      ["LOCALSTACK_HOST=localhost.localstack.cloud:4700"],
      { stdout: url, stderr: "", exitCode: 0 }
    );

    const result = await localstackAwsClient({ command: "s3 presign s3://b/k" });

    expect(isError(result)).toBeFalsy();
    expect(text(result)).toBe(url);
    expect(executeInContainer).toHaveBeenCalledWith(
      "ls-id",
      ["awslocal", "s3", "presign", "s3://b/k"],
      undefined,
      { env: [] }
    );
  });

  test("a failing command returns an error with its stderr", async () => {
    mockContainer([], { stdout: "", stderr: "boom", exitCode: 255 });

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("boom");
  });

  test("a failing container inspect returns an error and runs nothing", async () => {
    const { executeInContainer } = mockContainer(
      [],
      undefined,
      jest.fn().mockRejectedValue(new Error("no such container: ls-id"))
    );

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("no such container: ls-id");
    expect(executeInContainer).not.toHaveBeenCalled();
  });

  test("shell syntax is rejected before anything runs", async () => {
    const { executeInContainer } = mockContainer([]);

    const result = await localstackAwsClient({ command: "s3 ls; cat /etc/passwd" });

    expect(isError(result)).toBe(true);
    expect(executeInContainer).not.toHaveBeenCalled();
  });

  test("without an auth token nothing runs", async () => {
    delete process.env.LOCALSTACK_AUTH_TOKEN;
    const { executeInContainer } = mockContainer([]);

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("LOCALSTACK_AUTH_TOKEN");
    expect(executeInContainer).not.toHaveBeenCalled();
  });

  test("with LocalStack not running nothing runs", async () => {
    mockedHealth.mockResolvedValue({ reachable: false, ready: false } as any);
    const { executeInContainer } = mockContainer([]);

    const result = await localstackAwsClient({ command: "s3 ls" });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("LocalStack Not Running");
    expect(executeInContainer).not.toHaveBeenCalled();
  });

  test("the container's auth token reaches neither the exec env, the response nor analytics", async () => {
    const secret = "ls-FAKE-container-token-0123456789";
    const { executeInContainer } = mockContainer([
      `LOCALSTACK_AUTH_TOKEN=${secret}`,
      "LOCALSTACK_HOST=localhost.localstack.cloud:4700",
    ]);

    const result = await localstackAwsClient({ command: "sqs list-queues" });

    expect(isError(result)).toBeFalsy();
    expect(JSON.stringify(executeInContainer.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(mockCapture).toHaveBeenCalled();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(secret);
  });
});
