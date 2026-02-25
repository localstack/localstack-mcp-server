import { PassThrough } from "stream";

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class DockerApiClient {
  private docker: any;

  constructor() {
    // Dynamic import to avoid bundling native modules
    this.docker = null;
  }

  private async getDocker(): Promise<any> {
    if (!this.docker) {
      // Use string-based import to avoid webpack static analysis
      const dockerodeModule = await import(/* webpackIgnore: true */ "dockerode");
      const Docker = dockerodeModule.default;
      this.docker = new Docker();
    }
    return this.docker;
  }

  async findLocalStackContainer(): Promise<string> {
    const docker = await this.getDocker();
    const running = await docker.listContainers({
      filters: { status: ["running"] },
    });

    const match = (running || []).find((c: any) =>
      (c.Names || []).some((n: any) => {
        const name = (n || "").startsWith("/") ? n.slice(1) : n;
        return name === "localstack-main";
      })
    );

    if (match) return match.Id;

    throw new Error("Could not find a running LocalStack container named 'localstack-main'.");
  }

  async executeInContainer(
    containerId: string,
    command: string[],
    stdin?: string
  ): Promise<ContainerExecResult> {
    const docker = await this.getDocker();
    const container = docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(stdin ? { AttachStdin: true } : {}),
    });

    const stream: NodeJS.ReadWriteStream = await new Promise((resolve, reject) => {
      exec.start({ hijack: true, stdin: Boolean(stdin) }, (err: any, stream: any) => {
        if (err) return reject(err);
        resolve(stream as NodeJS.ReadWriteStream);
      });
    });

    if (stdin) {
      stream.write(stdin);
      stream.end();
    }

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    stdoutStream.on("data", (d) => stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stderrStream.on("data", (d) => stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));

    await new Promise<void>((resolve, reject) => {
      // demux combined docker stream into stdout/stderr
      (docker as any).modem.demuxStream(stream, stdoutStream, stderrStream);
      stream.on("end", () => resolve());
      stream.on("error", (e) => reject(e));
    });

    const inspect = (await exec.inspect()) as { ExitCode: number | null };
    const exitCode = inspect && inspect.ExitCode !== null ? inspect.ExitCode : 1;

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

    return { stdout, stderr, exitCode };
  }
}
