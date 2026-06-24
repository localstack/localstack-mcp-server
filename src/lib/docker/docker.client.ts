import { PassThrough } from "stream";
import { LOCALSTACK_PORT } from "../../core/config";

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class DockerApiClient {
  private docker: any;

  constructor() {
    const DockerCtor = (eval("require") as any)("dockerode");
    this.docker = new DockerCtor();
  }

  private normalizeContainerName(name?: string): string {
    if (!name) return "";
    return name.startsWith("/") ? name.slice(1) : name;
  }

  private matchesConfiguredContainerName(
    container: { Names?: string[] },
    configuredName: string
  ): boolean {
    return (container.Names || []).some((n) => this.normalizeContainerName(n) === configuredName);
  }

  private publishesConfiguredGatewayPort(container: {
    Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string }>;
  }): boolean {
    const configuredPort = Number(process.env.LOCALSTACK_PORT || LOCALSTACK_PORT);
    return (container.Ports || []).some(
      (port) =>
        port.Type === "tcp" && port.PrivatePort === 4566 && port.PublicPort === configuredPort
    );
  }

  private hasLocalStackImage(container: { Image?: string }): boolean {
    return /^localstack\/localstack(?:-pro)?(?::|@|$)/.test(container.Image || "");
  }

  async findLocalStackContainer(): Promise<string> {
    const running = (await (this.docker.listContainers as any)({
      filters: { status: ["running"] },
    })) as Array<{
      Id: string;
      Names?: string[];
      Image?: string;
      Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string }>;
    }>;

    const explicitName = (
      process.env.MAIN_CONTAINER_NAME ||
      process.env.LOCALSTACK_MAIN_CONTAINER_NAME ||
      ""
    ).trim();
    const configuredName = explicitName || "localstack-main";

    const byConfiguredName = (running || []).find((c) =>
      this.matchesConfiguredContainerName(c, configuredName)
    );
    if (byConfiguredName) return byConfiguredName.Id as string;

    if (!explicitName) {
      const byGatewayPort = (running || []).find((c) => this.publishesConfiguredGatewayPort(c));
      if (byGatewayPort) return byGatewayPort.Id as string;

      const byLocalStackImage = (running || []).find((c) => this.hasLocalStackImage(c));
      if (byLocalStackImage) return byLocalStackImage.Id as string;
    }

    throw new Error(
      `Could not find a running LocalStack container named "${configuredName}". ` +
        `Set MAIN_CONTAINER_NAME to your container name if it is custom.`
    );
  }

  /**
   * Stop a container via the Docker API (graceful SIGTERM, then SIGKILL after the
   * timeout). Provenance-agnostic — works regardless of which CLI started it (or none)
   * and needs no host-side `localstack`/`lstk` binary. LocalStack containers run with
   * `--rm`, so stopping also removes them, matching `localstack stop`.
   */
  async stopContainer(containerId: string, timeoutSeconds = 10): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: timeoutSeconds });
  }

  async executeInContainer(
    containerId: string,
    command: string[],
    stdin?: string
  ): Promise<ContainerExecResult> {
    const container = this.docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(stdin ? { AttachStdin: true } : {}),
    });

    const stream: NodeJS.ReadWriteStream = await new Promise((resolve, reject) => {
      exec.start({ hijack: true, stdin: Boolean(stdin) } as any, (err: any, stream: any) => {
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
      (this.docker as any).modem.demuxStream(stream as any, stdoutStream, stderrStream);
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
