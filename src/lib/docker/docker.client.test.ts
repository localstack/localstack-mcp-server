import { DockerApiClient } from "./docker.client";
import { PassThrough } from "stream";

jest.mock("dockerode", () => {
  const listContainers = jest.fn();
  const execInspect = jest.fn();
  const containerInspect = jest.fn();
  const start = jest.fn((opts: any, cb: any) => {
    const stream = new PassThrough();
    setImmediate(() => cb(null, stream));
    return undefined as unknown as NodeJS.ReadableStream;
  });
  const exec = jest.fn(async () => ({ start, inspect: execInspect }));
  const stop = jest.fn();
  const remove = jest.fn();
  const getContainer = jest.fn(() => ({ exec, stop, remove, inspect: containerInspect }));

  const __state = { demuxTarget: "stdout" as "stdout" | "stderr" };

  class DockerMock {
    static __mocks = {
      listContainers,
      getContainer,
      exec,
      start,
      execInspect,
      containerInspect,
      stop,
      remove,
      __state,
    };
    modem: any;
    constructor() {
      this.modem = {
        demuxStream: (
          combined: NodeJS.ReadableStream,
          stdout: PassThrough,
          stderr: PassThrough
        ) => {
          combined.on("data", (d) => {
            if (__state.demuxTarget === "stdout") stdout.write(d);
            else stderr.write(d);
          });
          combined.on("end", () => {
            stdout.end();
            stderr.end();
          });
        },
      };
    }
    listContainers = listContainers;
    getContainer = getContainer;
  }

  return DockerMock as any;
});

const getDockerMocks = () => (require("dockerode") as any).__mocks;

describe("DockerApiClient", () => {
  beforeEach(() => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockReset();
    mocks.getContainer.mockReset();
    mocks.exec.mockReset();
    mocks.start.mockReset();
    mocks.execInspect.mockReset();
    mocks.containerInspect.mockReset();
    mocks.stop.mockReset();
    mocks.remove.mockReset();

    // Restore default implementations after reset
    mocks.getContainer.mockImplementation(() => ({
      exec: mocks.exec,
      stop: mocks.stop,
      remove: mocks.remove,
      inspect: mocks.containerInspect,
    }));
    mocks.exec.mockImplementation(async () => ({ start: mocks.start, inspect: mocks.execInspect }));
    mocks.__state.demuxTarget = "stdout";
    delete process.env.MAIN_CONTAINER_NAME;
    delete process.env.LOCALSTACK_MAIN_CONTAINER_NAME;
    delete process.env.LOCALSTACK_PORT;
  });

  test("findLocalStackContainer throws when none found", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /Could not find a running LocalStack container/i
    );
  });

  test("findLocalStackContainer returns id when found", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "abc123", Names: ["/localstack-main"], Image: "localstack/localstack:latest" },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("abc123");
  });

  test("findLocalStackContainer matches known runtime names for non-standard LocalStack product images", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "snow123", Names: ["/localstack-main"], Image: "localstack/snowflake:latest" },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("snow123");
  });

  test("findLocalStackContainer matches lstk's known runtime name for Azure emulator images", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      {
        Id: "azure123",
        Names: ["/localstack-aws"],
        Image: "localstack/localstack-azure-alpha:latest",
      },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("azure123");
  });

  test("findLocalStackContainer matches MAIN_CONTAINER_NAME when configured", async () => {
    process.env.MAIN_CONTAINER_NAME = "my-custom-localstack";

    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "not-this", Names: ["/localstack-main"] },
      { Id: "xyz999", Names: ["/my-custom-localstack"] },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("xyz999");
  });

  test("findLocalStackContainer detects lstk-managed LocalStack container by image", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "other", Names: ["/redis"], Image: "redis:latest" },
      { Id: "lstk123", Names: ["/localstack-aws"], Image: "localstack/localstack-pro:latest" },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("lstk123");
  });

  test("findLocalStackContainer detects mirrored LocalStack images by gateway port", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      {
        Id: "mirror123",
        Names: ["/gateway-runtime"],
        Image: "registry.example.com/localstack/localstack-pro:latest",
        Ports: [{ PrivatePort: 4566, PublicPort: 4566, Type: "tcp" }],
      },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("mirror123");
  });

  test("findLocalStackContainer prefers the LocalStack image publishing the configured gateway port over other LocalStack images", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      {
        Id: "image123",
        Names: ["/localstack-sidecar"],
        Image: "localstack/localstack-pro:latest",
      },
      {
        Id: "port123",
        Names: ["/gateway-runtime"],
        Image: "localstack/localstack:latest",
        Ports: [{ PrivatePort: 4566, PublicPort: 4566, Type: "tcp" }],
      },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("port123");
  });

  test("findLocalStackContainer does not match a non-LocalStack container by port alone", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      {
        Id: "not-localstack",
        Names: ["/plain-node"],
        Image: "node:22-bookworm-slim",
        Ports: [{ PrivatePort: 4566, PublicPort: 4566, Type: "tcp" }],
      },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /Could not find a running LocalStack container/i
    );
  });

  test("findLocalStackContainer does not match non-runtime LocalStack namespace images", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      {
        Id: "mcp-dev",
        Names: ["/localstack-mcp-dev"],
        Image: "localstack/localstack-mcp-server:latest",
        Ports: [{ PrivatePort: 4566, PublicPort: 4566, Type: "tcp" }],
      },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /Could not find a running LocalStack container/i
    );
  });

  test("findLocalStackContainer honors an explicit LOCALSTACK_PORT before falling back to image-only matches", async () => {
    process.env.LOCALSTACK_PORT = "4567";
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      {
        Id: "default-runtime",
        Names: ["/gateway-runtime"],
        Image: "localstack/localstack-pro:latest",
        Ports: [{ PrivatePort: 4566, PublicPort: 4566, Type: "tcp" }],
      },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /none publishes the configured gateway port 4567/i
    );
  });

  test("findLocalStackContainer rejects ambiguous LocalStack image matches without a port or explicit name", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "ls1", Names: ["/localstack-sidecar-1"], Image: "localstack/localstack:latest" },
      { Id: "ls2", Names: ["/localstack-sidecar-2"], Image: "localstack/localstack-pro:latest" },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /Found multiple running LocalStack containers/i
    );
  });

  test("findLocalStackContainer honors explicit MAIN_CONTAINER_NAME over metadata fallback", async () => {
    process.env.MAIN_CONTAINER_NAME = "my-custom-localstack";

    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "lstk123", Names: ["/localstack-aws"], Image: "localstack/localstack-pro:latest" },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /Could not find a running LocalStack container named "my-custom-localstack"/i
    );
  });

  test("findLocalStackContainer throws when only a compose-prefixed name exists without config", async () => {
    // A container whose name merely contains "localstack" as a substring (and which is
    // neither the LocalStack image nor publishing the gateway port) must not be matched.
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "compose123", Names: ["/project-localstack-1"], Image: "example/app:latest" },
    ]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).rejects.toThrow(
      /Could not find a running LocalStack container named "localstack-main"/i
    );
  });

  test("stopContainer stops the container via the Docker API", async () => {
    const mocks = getDockerMocks();
    mocks.stop.mockResolvedValueOnce(undefined);
    mocks.remove.mockResolvedValueOnce(undefined);

    const client = new DockerApiClient();
    await client.stopContainer("abc123", 5);

    expect(mocks.getContainer).toHaveBeenCalledWith("abc123");
    expect(mocks.stop).toHaveBeenCalledWith({ t: 5 });
    expect(mocks.remove).toHaveBeenCalledWith();
  });

  test("stopContainer ignores remove errors when --rm already removed the container", async () => {
    const mocks = getDockerMocks();
    mocks.stop.mockResolvedValueOnce(undefined);
    mocks.remove.mockRejectedValueOnce(
      Object.assign(new Error("No such container"), { statusCode: 404 })
    );

    const client = new DockerApiClient();
    await expect(client.stopContainer("abc123", 5)).resolves.toBeUndefined();
  });

  test("stopContainer ignores remove conflicts when Docker auto-removal is already in progress", async () => {
    const mocks = getDockerMocks();
    mocks.stop.mockResolvedValueOnce(undefined);
    mocks.remove.mockRejectedValueOnce(
      Object.assign(new Error("removal of container abc123 is already in progress"), {
        statusCode: 409,
      })
    );

    const client = new DockerApiClient();
    await expect(client.stopContainer("abc123", 5)).resolves.toBeUndefined();
  });

  test("inspectContainer returns normalized container metadata", async () => {
    const mocks = getDockerMocks();
    mocks.containerInspect.mockResolvedValueOnce({
      Name: "/localstack-aws",
      Config: {
        Image: "localstack/localstack-pro:latest",
        Env: ["MAIN_CONTAINER_NAME=localstack-aws"],
      },
    });

    const client = new DockerApiClient();
    await expect(client.inspectContainer("abc123")).resolves.toEqual({
      id: "abc123",
      name: "localstack-aws",
      image: "localstack/localstack-pro:latest",
      env: ["MAIN_CONTAINER_NAME=localstack-aws"],
    });
  });

  test("executeInContainer returns stdout on success", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "abc123", Names: ["/localstack-main"], Image: "localstack/localstack:latest" },
    ]);

    // prepare exec.inspect to return 0
    mocks.execInspect.mockResolvedValueOnce({ ExitCode: 0 });

    const client = new DockerApiClient();
    const containerId = await client.findLocalStackContainer();

    // Start call: we must simulate demux writing to stdout, then end the stream
    const stream = new PassThrough();
    mocks.start.mockImplementationOnce((opts: any, cb: any) => {
      setImmediate(() => {
        cb(null, stream);
        setImmediate(() => {});
      });
    });

    const execPromise = client.executeInContainer(containerId, ["echo", "hello"]);
    // After a tick, feed data to combined stream and end it
    setImmediate(() => {
      stream.write("hello-world\n");
      stream.end();
    });

    const res = await execPromise;
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello-world");
  });

  test("executeInContainer returns stderr on failure", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([
      { Id: "abc123", Names: ["/localstack-main"], Image: "localstack/localstack:latest" },
    ]);
    mocks.execInspect.mockResolvedValueOnce({ ExitCode: 2 });

    const client = new DockerApiClient();
    const containerId = await client.findLocalStackContainer();

    const stream = new PassThrough();
    mocks.start.mockImplementationOnce((opts: any, cb: any) => {
      setImmediate(() => cb(null, stream));
    });

    // route combined stream to stderr for this test
    getDockerMocks().__state.demuxTarget = "stderr";

    const execPromise = client.executeInContainer(containerId, ["sh", "-c", "exit 2"]);
    setImmediate(() => {
      // our default demux pipes to stdout; simulate stderr by writing a marker and expect stderr to capture it
      stream.write("something went wrong\n");
      stream.end();
    });
    const res = await execPromise;
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("something went wrong");
  });
});
