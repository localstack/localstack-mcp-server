import { DockerApiClient } from "./docker.client";
import { PassThrough } from "stream";

jest.mock("dockerode", () => {
  const listContainers = jest.fn();
  const execInspect = jest.fn();
  const start = jest.fn((opts: any, cb: any) => {
    const stream = new PassThrough();
    setImmediate(() => cb(null, stream));
    return undefined as unknown as NodeJS.ReadableStream;
  });
  const exec = jest.fn(async () => ({ start, inspect: execInspect }));
  const getContainer = jest.fn(() => ({ exec }));

  const __state = { demuxTarget: "stdout" as "stdout" | "stderr" };

  class DockerMock {
    static __mocks = { listContainers, getContainer, exec, start, execInspect, __state };
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

    // Restore default implementations after reset
    mocks.getContainer.mockImplementation(() => ({ exec: mocks.exec }));
    mocks.exec.mockImplementation(async () => ({ start: mocks.start, inspect: mocks.execInspect }));
    mocks.__state.demuxTarget = "stdout";
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
    mocks.listContainers.mockResolvedValueOnce([{ Id: "abc123", Names: ["/localstack-main"] }]);

    const client = new DockerApiClient();
    await expect(client.findLocalStackContainer()).resolves.toBe("abc123");
  });

  test("executeInContainer returns stdout on success", async () => {
    const mocks = getDockerMocks();
    mocks.listContainers.mockResolvedValueOnce([{ Id: "abc123", Names: ["/localstack-main"] }]);

    // prepare exec.inspect to return 0
    mocks.execInspect.mockResolvedValueOnce({ ExitCode: 0 });

    const client = new DockerApiClient();
    const containerId = await client.findLocalStackContainer();

    // Start call: we must simulate demux writing to stdout, then end the stream
    const stream = new PassThrough();
    mocks.start.mockImplementationOnce((opts: any, cb: any) => {
      setImmediate(() => {
        cb(null, stream);
        setImmediate(() => {
        });
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
    mocks.listContainers.mockResolvedValueOnce([{ Id: "abc123", Names: ["/localstack-main"] }]);
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
