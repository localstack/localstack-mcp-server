import { AUTH_TOKEN_ENV, DOCKER_IMAGE, DockerOptions, NPM_PACKAGE, ServerSpec } from "./types";

/**
 * Clients that spawn the server without a shell (Claude Code, Codex) can't
 * resolve the npx.cmd shim on native Windows — wrap in `cmd /c` there.
 * File-based clients (Cursor, VS Code, Claude Desktop) resolve npx themselves
 * and must keep the plain command.
 */
export function windowsSpawnSafeSpec(spec: ServerSpec): ServerSpec {
  if (spec.command !== "npx") return spec;
  return { command: "cmd", args: ["/c", spec.command, ...spec.args], env: spec.env };
}

export function buildNpxServerSpec(
  token: string,
  extraEnv: Record<string, string> = {}
): ServerSpec {
  return {
    command: "npx",
    args: ["-y", NPM_PACKAGE],
    env: { [AUTH_TOKEN_ENV]: token, ...extraEnv },
  };
}

export function buildDockerServerSpec(
  token: string,
  extraEnv: Record<string, string>,
  options: DockerOptions
): ServerSpec {
  const args = [
    "run",
    "-i",
    "--rm",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${options.cacheDir}:${options.cacheDir}`,
    "-e",
    `XDG_CACHE_HOME=${options.cacheDir}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--add-host",
    "s3.host.docker.internal:host-gateway",
    "--add-host",
    "snowflake.localhost.localstack.cloud:host-gateway",
    "-e",
    AUTH_TOKEN_ENV,
    "-e",
    "LOCALSTACK_HOSTNAME=host.docker.internal",
  ];

  // Extra config vars are forwarded into the server container from the env
  // block; values stay out of the args so client UIs don't display them.
  for (const key of Object.keys(extraEnv)) {
    args.push("-e", key);
  }

  if (options.workspaceDir) {
    args.push("-v", `${options.workspaceDir}:${options.workspaceDir}`);
  }

  args.push(`${DOCKER_IMAGE}:${options.imageTag}`);

  return {
    command: "docker",
    args,
    env: { [AUTH_TOKEN_ENV]: token, ...extraEnv },
  };
}
