import {
  buildDockerServerSpec,
  buildNpxServerSpec,
  windowsSpawnSafeSpec,
} from "./server-config.logic";

describe("buildNpxServerSpec", () => {
  it("builds the documented npx config", () => {
    const spec = buildNpxServerSpec("ls-token");
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "@localstack/localstack-mcp-server"]);
    expect(spec.env).toEqual({ LOCALSTACK_AUTH_TOKEN: "ls-token" });
  });

  it("merges extra env vars after the token", () => {
    const spec = buildNpxServerSpec("ls-token", { DEBUG: "1", PERSISTENCE: "1" });
    expect(spec.env).toEqual({
      LOCALSTACK_AUTH_TOKEN: "ls-token",
      DEBUG: "1",
      PERSISTENCE: "1",
    });
  });
});

describe("buildDockerServerSpec", () => {
  const options = {
    cacheDir: "/Users/you/.localstack-mcp",
    workspaceDir: "/Users/you/projects",
    imageTag: "latest",
  };

  it("builds the full docker run recipe", () => {
    const spec = buildDockerServerSpec("ls-token", {}, options);
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      "/Users/you/.localstack-mcp:/Users/you/.localstack-mcp",
      "-e",
      "XDG_CACHE_HOME=/Users/you/.localstack-mcp",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--add-host",
      "s3.host.docker.internal:host-gateway",
      "--add-host",
      "snowflake.localhost.localstack.cloud:host-gateway",
      "-e",
      "LOCALSTACK_AUTH_TOKEN",
      "-e",
      "LOCALSTACK_HOSTNAME=host.docker.internal",
      "-v",
      "/Users/you/projects:/Users/you/projects",
      "localstack/localstack-mcp-server:latest",
    ]);
    expect(spec.env).toEqual({ LOCALSTACK_AUTH_TOKEN: "ls-token" });
  });

  it("omits the workspace mount when not provided", () => {
    const spec = buildDockerServerSpec("t", {}, { ...options, workspaceDir: undefined });
    expect(spec.args).not.toContain("/Users/you/projects:/Users/you/projects");
    expect(spec.args[spec.args.length - 1]).toBe("localstack/localstack-mcp-server:latest");
  });

  it("forwards extra env vars by key only in args, with values in env", () => {
    const spec = buildDockerServerSpec("t", { DEBUG: "1" }, options);
    const debugFlagIndex = spec.args.indexOf("DEBUG");
    expect(debugFlagIndex).toBeGreaterThan(-1);
    expect(spec.args[debugFlagIndex - 1]).toBe("-e");
    expect(spec.args).not.toContain("DEBUG=1");
    expect(spec.env.DEBUG).toBe("1");
  });

  it("respects a custom image tag", () => {
    const spec = buildDockerServerSpec("t", {}, { ...options, imageTag: "0.5.0" });
    expect(spec.args[spec.args.length - 1]).toBe("localstack/localstack-mcp-server:0.5.0");
  });
});

describe("windowsSpawnSafeSpec", () => {
  it("wraps npx in cmd /c for shell-less Windows spawns", () => {
    const spec = windowsSpawnSafeSpec(buildNpxServerSpec("tok"));
    expect(spec.command).toBe("cmd");
    expect(spec.args).toEqual(["/c", "npx", "-y", "@localstack/localstack-mcp-server"]);
    expect(spec.env).toEqual({ LOCALSTACK_AUTH_TOKEN: "tok" });
  });

  it("leaves non-npx commands untouched", () => {
    const docker = buildDockerServerSpec("tok", {}, { cacheDir: "/c", imageTag: "latest" });
    expect(windowsSpawnSafeSpec(docker)).toBe(docker);
  });
});
