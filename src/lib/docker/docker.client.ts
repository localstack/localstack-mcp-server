import { PassThrough } from "stream";
import { createRequire } from "node:module";
import { LOCALSTACK_PORT } from "../../core/config";
import type { LocalStackContainerSpec } from "../localstack/container-spec.logic";

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContainerStateInfo {
  id: string;
  name: string;
  state: string;
  image?: string;
  running: boolean;
}

/**
 * Rolling log tail attached to a container from the moment it starts. The buffer
 * survives AutoRemove (the stream stays readable even after the daemon removes the
 * container), and the stream ending doubles as the container-exit signal — the only
 * reliable way to diagnose startup crashes of an AutoRemove container.
 */
export interface LogBufferHandle {
  getBuffered(): string;
  hasExited(): boolean;
  onExit(callback: () => void): void;
  destroy(): void;
}

const LOG_BUFFER_MAX_CHARS = 64 * 1024;

/**
 * Decode a Docker multiplexed log payload (returned as a single Buffer by
 * `container.logs({follow: false})`) into chronologically ordered text. Each frame
 * carries an 8-byte header: [stream_type, 0, 0, 0, size(u32 BE)]. Walking frames in
 * order preserves the stdout/stderr interleaving `docker logs` shows; demuxing into
 * separate sinks would reorder lines and naive toString() leaves binary headers that
 * break line-anchored parsing.
 */
export function decodeDockerLogBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  // A real multiplex header is [stream_type ∈ {0,1,2}, 0, 0, 0, size(u32 BE)]. Requiring
  // bytes 1-3 to be zero avoids mis-reading raw TTY output that merely starts with a
  // low control byte (e.g. "\x01…") as a framed stream and dropping its first 8 bytes.
  const looksFramed = (at: number) =>
    at + 8 <= buffer.length &&
    buffer[at] <= 2 &&
    buffer[at + 1] === 0 &&
    buffer[at + 2] === 0 &&
    buffer[at + 3] === 0;

  if (!looksFramed(0)) return buffer.toString("utf8");

  const chunks: Buffer[] = [];
  let offset = 0;
  while (looksFramed(offset)) {
    const size = buffer.readUInt32BE(offset + 4);
    const end = Math.min(offset + 8 + size, buffer.length);
    chunks.push(buffer.subarray(offset + 8, end));
    offset += 8 + size;
  }
  if (chunks.length === 0) return buffer.toString("utf8");
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Translate raw Docker connectivity failures into an actionable message. Socket-level
 * errors otherwise surface as bare "connect ENOENT /var/run/docker.sock" strings.
 * Only transport-level failures qualify (error codes, or connect-style messages) —
 * daemon API errors that merely MENTION a socket path (e.g. a bad DOCKER_SOCK mount
 * source at container creation) must pass through untouched, since the daemon is fine.
 */
export function describeDockerConnectivityError(error: unknown): string {
  const err = error as { code?: string; message?: string } | undefined;
  const code = err?.code || "";
  const message = err?.message || String(error);
  if (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EACCES" ||
    code === "EPERM" ||
    /connect (ENOENT|ECONNREFUSED)|docker_engine/i.test(message)
  ) {
    return (
      "Docker daemon is not reachable. Start Docker (Desktop) and try again. " +
      "If your daemon uses a non-default socket, set DOCKER_HOST. " +
      `(${message})`
    );
  }
  return message;
}

export interface ContainerMountInfo {
  type?: string;
  name?: string;
  source?: string;
  destination?: string;
}

export interface ContainerMetadata {
  id: string;
  name?: string;
  image?: string;
  env?: string[];
  mounts?: ContainerMountInfo[];
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
    // Keep dockerode external to the rspack bundle while using Node's supported
    // module loader instead of hiding require from static analysis with eval.
    const DockerCtor = createRequire(__filename)("dockerode");
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
      mounts: (inspect?.Mounts || []).map(
        (mount: { Type?: string; Name?: string; Source?: string; Destination?: string }) => ({
          type: mount.Type,
          name: mount.Name,
          source: mount.Source,
          destination: mount.Destination,
        })
      ),
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
    try {
      await this.withDockerRequestTimeout(
        container.stop({ t: timeoutSeconds }),
        requestTimeoutMs,
        "Docker container stop"
      );
    } catch (error) {
      // 304 = already stopped; continue so the remove below still runs.
      if ((error as { statusCode?: number })?.statusCode !== 304) throw error;
    }

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
    stdin?: string,
    options?: { env?: string[]; timeoutMs?: number }
  ): Promise<ContainerExecResult> {
    const container = this.docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(options?.env?.length ? { Env: options.env } : {}),
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
      let timer: NodeJS.Timeout | undefined;
      if (options?.timeoutMs) {
        timer = setTimeout(() => {
          (stream as unknown as { destroy?: () => void }).destroy?.();
          reject(new Error(`Container exec timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }
      stream.on("end", () => {
        if (timer) clearTimeout(timer);
        resolve();
      });
      stream.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });

    const inspect = (await exec.inspect()) as { ExitCode: number | null };
    const exitCode = inspect && inspect.ExitCode !== null ? inspect.ExitCode : 1;

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

    return { stdout, stderr, exitCode };
  }

  /** Docker daemon reachability probe with a friendly error for the common failures. */
  async ping(timeoutMs = 5000): Promise<void> {
    try {
      await this.withDockerRequestTimeout(this.docker.ping(), timeoutMs, "Docker daemon ping");
    } catch (error) {
      throw new Error(describeDockerConnectivityError(error));
    }
  }

  async imageExists(imageName: string, timeoutMs = 15000): Promise<boolean> {
    try {
      await this.inspectImage(imageName, timeoutMs);
      return true;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404) return false;
      throw new Error(describeDockerConnectivityError(error));
    }
  }

  private async inspectImage(imageName: string, timeoutMs: number): Promise<void> {
    await this.withDockerRequestTimeout(
      this.docker.getImage(imageName).inspect(),
      timeoutMs,
      "Docker image inspect"
    );
  }

  /**
   * Pull an image, consuming the progress stream manually. docker-modem's
   * followProgress reports success even when the stream carries an `error` event and
   * throws uncaught on malformed progress lines — both fatal for a stdio MCP process.
   */
  async pullImage(imageName: string, timeoutMs = 600000): Promise<void> {
    const stream: NodeJS.ReadableStream = await new Promise((resolve, reject) => {
      this.docker.pull(imageName, (err: unknown, pullStream: NodeJS.ReadableStream) => {
        if (err) return reject(new Error(describeDockerConnectivityError(err)));
        resolve(pullStream);
      });
    });

    try {
      await this.withDockerRequestTimeout(
        new Promise<void>((resolve, reject) => {
          let pending = "";
          let pullError: string | undefined;
          const scan = (line: string) => {
            if (!line.trim()) return;
            try {
              const event = JSON.parse(line) as {
                error?: string;
                errorDetail?: { message?: string };
              };
              if (event.error || event.errorDetail) {
                pullError = event.error || event.errorDetail?.message || "unknown pull error";
              }
            } catch {
              // Malformed progress lines are ignored; only well-formed error events fail the pull.
            }
          };
          stream.on("data", (chunk: Buffer) => {
            pending += chunk.toString("utf8");
            const lines = pending.split("\n");
            pending = lines.pop() || "";
            for (const line of lines) scan(line);
          });
          stream.on("error", (err: Error) => reject(err));
          stream.on("end", () => {
            // A final event without a trailing newline stays in `pending`; scan it so a
            // late {"error":…} isn't silently dropped (which would surface later as a
            // confusing "no such image" at container creation).
            scan(pending);
            if (pullError) reject(new Error(`Failed to pull image ${imageName}: ${pullError}`));
            else resolve();
          });
        }),
        timeoutMs,
        `Docker image pull (${imageName})`
      );
    } catch (error) {
      // Stop the background pull + its data handler when we give up (e.g. on timeout).
      (stream as unknown as { destroy?: () => void }).destroy?.();
      throw error;
    }
  }

  /** Create a user-defined network when missing (Lambda containers must reach the gateway on it). */
  async ensureNetwork(name: string, requestTimeoutMs = 15000): Promise<void> {
    if (!name || name === "host" || name === "bridge" || name === "none") return;
    const networks = (await this.withDockerRequestTimeout(
      this.docker.listNetworks({ filters: { name: [name] } }),
      requestTimeoutMs,
      "Docker network list"
    )) as Array<{ Name?: string }>;
    if ((networks || []).some((network) => network.Name === name)) return;
    await this.withDockerRequestTimeout(
      this.docker.createNetwork({ Name: name }),
      requestTimeoutMs,
      "Docker network create"
    );
  }

  async createAndStartContainer(
    spec: LocalStackContainerSpec,
    requestTimeoutMs = 30000
  ): Promise<string> {
    const { name, ...createOptions } = spec;
    let container: any;
    try {
      container = await this.withDockerRequestTimeout(
        this.docker.createContainer({ ...createOptions, name }),
        requestTimeoutMs,
        "Docker container create"
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 409) {
        throw new LocalStackContainerConflictError(`A container named "${name}" already exists.`);
      }
      throw new Error(describeDockerConnectivityError(error));
    }
    await this.withDockerRequestTimeout(
      container.start(),
      requestTimeoutMs,
      "Docker container start"
    );
    return container.id as string;
  }

  /**
   * Attach a follow-mode log stream right after start and keep a rolling tail.
   * See LogBufferHandle for why this replaces post-exit `container.logs()` reads.
   */
  async attachLogBuffer(containerId: string, attachTimeoutMs = 15000): Promise<LogBufferHandle> {
    const container = this.docker.getContainer(containerId);
    const stream: NodeJS.ReadableStream = await this.withDockerRequestTimeout(
      container.logs({ follow: true, stdout: true, stderr: true, tail: 200 }),
      attachTimeoutMs,
      "Docker log attach"
    );

    // Demux into a single sink so stdout/stderr keep their chronological interleaving.
    const sink = new PassThrough();
    (this.docker as any).modem.demuxStream(stream, sink, sink);

    let buffered = "";
    let exited = false;
    let degraded = false;
    const exitCallbacks: Array<() => void> = [];
    sink.on("data", (data: Buffer) => {
      buffered += data.toString("utf8");
      if (buffered.length > LOG_BUFFER_MAX_CHARS) {
        buffered = buffered.slice(-LOG_BUFFER_MAX_CHARS);
      }
    });
    const markExited = () => {
      // A stream error (e.g. a TCP reset on a tcp:// DOCKER_HOST) is indistinguishable
      // from a real exit, so once degraded we stop trusting the stream as an exit
      // signal — readiness polling + the launch deadline still catch a genuine exit.
      if (exited || degraded) return;
      exited = true;
      for (const callback of exitCallbacks) callback();
    };
    stream.on("end", markExited);
    stream.on("close", markExited);
    stream.on("error", () => {
      degraded = true;
    });

    return {
      getBuffered: () => buffered,
      hasExited: () => exited,
      onExit: (callback) => {
        if (exited) callback();
        else exitCallbacks.push(callback);
      },
      destroy: () => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      },
    };
  }

  /** One-shot chronologically ordered log fetch (docker logs equivalent). */
  async getContainerLogs(
    containerId: string,
    { tail, timeoutMs = 30000 }: { tail: number; timeoutMs?: number }
  ): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const result: Buffer | string = await this.withDockerRequestTimeout(
      container.logs({ follow: false, stdout: true, stderr: true, tail }),
      timeoutMs,
      "Docker container logs"
    );
    if (typeof result === "string") return result;
    return decodeDockerLogBuffer(result);
  }

  /**
   * Find a container by exact name in ANY state — the pre-start conflict check.
   * `findLocalStackContainer` deliberately sees only running containers.
   */
  async findContainerByNameAnyState(name: string): Promise<ContainerStateInfo | null> {
    const containers = (await this.withDockerRequestTimeout(
      (this.docker.listContainers as any)({ all: true, filters: { name: [name] } }),
      10000,
      "Docker container list"
    )) as Array<{ Id: string; Names?: string[]; State?: string; Image?: string }>;

    const match = (containers || []).find((container) =>
      this.matchesConfiguredContainerName(container, name)
    );
    if (!match) return null;
    return {
      id: match.Id,
      name,
      state: match.State || "unknown",
      image: match.Image,
      running: match.State === "running",
    };
  }

  /** Remove a container, tolerating it already being gone. */
  async removeContainer(containerId: string, requestTimeoutMs = 60000): Promise<void> {
    const container = this.docker.getContainer(containerId);
    try {
      await this.withDockerRequestTimeout(
        container.remove({ force: true }),
        requestTimeoutMs,
        "Docker container remove"
      );
    } catch (error) {
      if (!this.isContainerAlreadyGone(error)) throw error;
    }
  }

  /**
   * Wait until a container is fully removed (AutoRemove removal is asynchronous —
   * recreating the same name too early races a 409).
   */
  async waitForRemoval(containerId: string, timeoutMs = 60000): Promise<void> {
    const container = this.docker.getContainer(containerId);
    try {
      await this.withDockerRequestTimeout(
        container.wait({ condition: "removed" }),
        timeoutMs,
        "Docker container removal wait"
      );
    } catch (error) {
      if (this.isContainerAlreadyGone(error)) return;
      throw error;
    }
  }
}

export class LocalStackContainerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStackContainerConflictError";
  }
}
