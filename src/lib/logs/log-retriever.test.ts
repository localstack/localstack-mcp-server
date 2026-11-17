import { LocalStackLogRetriever } from "./log-retriever";
import { DockerApiClient } from "../docker/docker.client";

jest.mock("../docker/docker.client", () => {
  const actual = jest.requireActual("../docker/docker.client");
  return {
    ...actual,
    DockerApiClient: jest.fn(),
  };
});

const MockedDockerApiClient = DockerApiClient as jest.MockedClass<typeof DockerApiClient>;

function mockDocker({
  findLocalStackContainer = jest.fn().mockResolvedValue("container-1"),
  getContainerLogs = jest.fn().mockResolvedValue(""),
}: Record<string, jest.Mock> = {}) {
  MockedDockerApiClient.mockImplementation(
    () => ({ findLocalStackContainer, getContainerLogs }) as any
  );
  return { findLocalStackContainer, getContainerLogs };
}

describe("LocalStackLogRetriever", () => {
  beforeEach(() => MockedDockerApiClient.mockReset());

  test("retrieves and parses container logs via the Docker API", async () => {
    const { getContainerLogs } = mockDocker({
      getContainerLogs: jest
        .fn()
        .mockResolvedValue(
          "2025-07-23T10:58:58.710  INFO --- AWS s3.CreateBucket => 200\n" +
            "2025-07-23T10:58:59.100 ERROR --- AWS s3.PutObject => 404 (NoSuchBucket)\n"
        ),
    });

    const result = await new LocalStackLogRetriever().retrieveLogs(100);
    expect(result.success).toBe(true);
    expect(result.totalLines).toBe(2);
    expect(getContainerLogs).toHaveBeenCalledWith("container-1", { tail: 100 });
    expect(result.logs[1].isError).toBe(true);
    expect(result.logs[1].service).toBe("s3");
    expect(result.logs[1].operation).toBe("PutObject");
    expect(result.logs[1].statusCode).toBe(404);
  });

  test("reports a missing LocalStack container as a retrieval failure", async () => {
    const actual = jest.requireActual("../docker/docker.client");
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(
          new actual.LocalStackContainerNotFoundError(
            'Could not find a running LocalStack container named "localstack-main".'
          )
        ),
    });

    const result = await new LocalStackLogRetriever().retrieveLogs(10);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/no running LocalStack container/i);
  });

  test("surfaces Docker daemon failures without CLI-era wording", async () => {
    mockDocker({
      findLocalStackContainer: jest
        .fn()
        .mockRejectedValue(new Error("connect ENOENT /var/run/docker.sock")),
    });

    const result = await new LocalStackLogRetriever().retrieveLogs(10);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/Docker API/i);
    expect(result.errorMessage).toMatch(/ENOENT/);
    expect(result.errorMessage).not.toMatch(/CLI/);
  });

  test("maps log-read timeouts to the friendly guidance", async () => {
    mockDocker({
      getContainerLogs: jest
        .fn()
        .mockRejectedValue(new Error("Docker container logs timed out after 30000ms")),
    });

    const result = await new LocalStackLogRetriever().retrieveLogs(10);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/timed out/i);
    expect(result.errorMessage).toMatch(/reducing the number of lines/i);
  });

  test("applies the case-insensitive substring filter", async () => {
    mockDocker({
      getContainerLogs: jest
        .fn()
        .mockResolvedValue("line about S3 bucket\nline about lambda\nanother S3 line\n"),
    });

    const result = await new LocalStackLogRetriever().retrieveLogs(10, "s3");
    expect(result.success).toBe(true);
    expect(result.totalLines).toBe(3);
    expect(result.filteredLines).toBe(2);
    expect(result.logs).toHaveLength(2);
  });
});
