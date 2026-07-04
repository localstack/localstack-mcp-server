import { PassThrough } from "stream";
import { LOCALSTACK_PORT } from "../../core/config";

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContainerMetadata {
  id: string;
  name?: string;
  image?: string;
  env?: string[];
}

export class LocalStackContainerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStackContainerNotFoundError";
  }
}

export function isLocalStackContainerNotFoundError(error: unknown): boolean {
  return (
    error instanceof LocalStackContainerNotFoundError ||
    (error instanceof Error && error.name === "LocalStackContainerNotFoundError")
  );
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
    return /^(?:[^/]+\/)?localstack\/(?:localstack(?:-pro)?|snowflake|localstack-azure-alpha)(?::|@|$)/.test(
      container.Image || ""
    );
  }

  private async withDockerRequestTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    description: string
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private isContainerAlreadyGone(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const dockerError = error as { statusCode?: number; reason?: string; message?: string };
    const text = `${dockerError.reason || ""} ${dockerError.message || ""}`.toLowerCase();
    return (
      dockerError.statusCode === 404 ||
      text.includes("no such container") ||
      ((dockerError.statusCode === 409 || text.includes("removal of container")) &&
        text.includes("already in progress"))
    );
  }

  private findByKnownLocalStackName<T extends { Names?: string[] }>(
    containers: T[]
  ): T | undefined {
    return ["localstack-main", "localstack-aws"]
      .map((name) => containers.find((c) => this.matchesConfiguredContainerName(c, name)))
      .find(Boolean);
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

    if (explicitName) {
      const byConfiguredName = (running || []).find((c) =>
        this.matchesConfiguredContainerName(c, configuredName)
      );
      if (byConfiguredName) return byConfiguredName.Id as string;
    }

    if (!explicitName) {
      const byKnownName = this.findByKnownLocalStackName(running || []);
      if (byKnownName) return byKnownName.Id as string;

      const localstackImages = (running || []).filter((c) => this.hasLocalStackImage(c));
      const byGatewayPort = localstackImages.find((c) => this.publishesConfiguredGatewayPort(c));
      if (byGatewayPort) return byGatewayPort.Id as string;

      const explicitPort = Boolean(process.env.LOCALSTACK_PORT?.trim());
      if (explicitPort && localstackImages.length > 0) {
        throw new LocalStackContainerNotFoundError(
          `Found running LocalStack containers, but none publishes the configured gateway port ${process.env.LOCALSTACK_PORT}. ` +
            `Set MAIN_CONTAINER_NAME to the container name to use.`
        );
      }

      if (localstackImages.length === 1) return localstackImages[0].Id as string;
      if (localstackImages.length > 1) {
        throw new LocalStackContainerNotFoundError(
          `Found multiple running LocalStack containers but none publishes the configured gateway port ${process.env.LOCALSTACK_PORT || LOCALSTACK_PORT}. ` +
            `Set MAIN_CONTAINER_NAME to the container name to use.`
        );
      }
    }

    throw new LocalStackContainerNotFoundError(
      `Could not find a running LocalStack container named "${configuredName}". ` +
        `Set MAIN_CONTAINER_NAME to your container name if it is custom.`
    );
  }

  async inspectContainer(containerId: string): Promise<ContainerMetadata> {
    const container = this.docker.getContainer(containerId);
    const inspect = await container.inspect();
    return {
      id: containerId,
      name: this.normalizeContainerName(inspect?.Name),
      image: inspect?.Config?.Image,
      env: inspect?.Config?.Env,
    };
  }

  /**
   * Stop a container via the Docker API (graceful SIGTERM, then SIGKILL after the
   * timeout). Provenance-agnostic — works regardless of which CLI started it (or none)
   * and needs no host-side `localstack`/`lstk` binary. Remove after stop so `lstk`
   * containers, which are not started with `--rm`, do not linger.
   */
  async stopContainer(
    containerId: string,
    timeoutSeconds = 10,
    requestTimeoutMs = 60000
  ): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await this.withDockerRequestTimeout(
      container.stop({ t: timeoutSeconds }),
      requestTimeoutMs,
      "Docker container stop"
    );

    try {
      await this.withDockerRequestTimeout(
        container.remove(),
        requestTimeoutMs,
        "Docker container remove"
      );
    } catch (error) {
      if (!this.isContainerAlreadyGone(error)) throw error;
    }
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
