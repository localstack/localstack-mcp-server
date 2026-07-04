import {
  buildLocalStackContainerSpec,
  detectAiAgent,
  parseGatewayListen,
  resolveContainerName,
  resolveImage,
  resolveVolume,
  type ContainerSpecInput,
} from "./container-spec.logic";

const baseInput = (overrides: Partial<ContainerSpecInput> = {}): ContainerSpecInput => ({
  stack: "aws",
  hostEnv: {},
  authToken: "ls-test-token",
  isInDocker: false,
  volume: { type: "bind", source: "/home/user/.cache/localstack/volume" },
  serverVersion: "0.5.0",
  ...overrides,
});

const envMap = (spec: ReturnType<typeof buildLocalStackContainerSpec>) =>
  Object.fromEntries(
    spec.Env.map((entry) => [
      entry.slice(0, entry.indexOf("=")),
      entry.slice(entry.indexOf("=") + 1),
    ])
  );

describe("resolveImage", () => {
  test("defaults to the pro image for the aws stack", () => {
    expect(resolveImage("aws", {})).toBe("localstack/localstack-pro:latest");
  });

  test("honors LOCALSTACK_IMAGE_NAME over IMAGE_NAME", () => {
    expect(
      resolveImage("aws", { LOCALSTACK_IMAGE_NAME: "my/img:1", IMAGE_NAME: "other/img:2" })
    ).toBe("my/img:1");
    expect(resolveImage("aws", { IMAGE_NAME: "other/img:2" })).toBe("other/img:2");
  });

  test("snowflake stack always uses the snowflake image (stack wins over IMAGE_NAME)", () => {
    expect(resolveImage("snowflake", { IMAGE_NAME: "other/img:2" })).toBe(
      "localstack/snowflake:latest"
    );
  });
});

describe("resolveContainerName", () => {
  test("defaults to localstack-main and honors MAIN_CONTAINER_NAME", () => {
    expect(resolveContainerName({})).toBe("localstack-main");
    expect(resolveContainerName({ MAIN_CONTAINER_NAME: "my-ls" })).toBe("my-ls");
  });
});

describe("parseGatewayListen", () => {
  test("fills in the default bind IP for host-less entries", () => {
    expect(parseGatewayListen(":4566", "127.0.0.1")).toEqual([{ host: "127.0.0.1", port: 4566 }]);
  });

  test("parses multiple entries with explicit hosts", () => {
    expect(parseGatewayListen("127.0.0.1:4566,0.0.0.0:5000", "127.0.0.1")).toEqual([
      { host: "127.0.0.1", port: 4566 },
      { host: "0.0.0.0", port: 5000 },
    ]);
  });

  test("rejects invalid ports", () => {
    expect(() => parseGatewayListen("abc", "127.0.0.1")).toThrow(/Invalid GATEWAY_LISTEN/);
  });
});

describe("resolveVolume", () => {
  test("host darwin defaults to the CLI-identical caches path", () => {
    expect(
      resolveVolume({ hostEnv: {}, isInDocker: false, platform: "darwin", homedir: "/Users/me" })
    ).toEqual({ type: "bind", source: "/Users/me/Library/Caches/localstack/volume" });
  });

  test("host linux honors XDG_CACHE_HOME when absolute", () => {
    expect(
      resolveVolume({
        hostEnv: { XDG_CACHE_HOME: "/custom/cache" },
        isInDocker: false,
        platform: "linux",
        homedir: "/home/me",
      })
    ).toEqual({ type: "bind", source: "/custom/cache/localstack/volume" });
    expect(
      resolveVolume({ hostEnv: {}, isInDocker: false, platform: "linux", homedir: "/home/me" })
    ).toEqual({ type: "bind", source: "/home/me/.cache/localstack/volume" });
  });

  test("host windows builds a forward-slash LOCALAPPDATA path", () => {
    expect(
      resolveVolume({
        hostEnv: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        isInDocker: false,
        platform: "win32",
        homedir: "C:\\Users\\me",
      })
    ).toEqual({ type: "bind", source: "C:/Users/me/AppData/Local/cache/localstack/volume" });
  });

  test("explicit LOCALSTACK_VOLUME_DIR always wins", () => {
    expect(
      resolveVolume({
        hostEnv: { LOCALSTACK_VOLUME_DIR: "/data/ls" },
        isInDocker: true,
        platform: "linux",
        homedir: "/root",
      })
    ).toEqual({ type: "bind", source: "/data/ls" });
  });

  test("in docker: legacy XDG_CACHE_HOME keeps pre-migration DooD state", () => {
    expect(
      resolveVolume({
        hostEnv: { XDG_CACHE_HOME: "/Users/me/.localstack-mcp" },
        isInDocker: true,
        platform: "linux",
        homedir: "/root",
      })
    ).toEqual({ type: "bind", source: "/Users/me/.localstack-mcp/localstack/volume" });
  });

  test("in docker without hints: named volume (no host-path guessing)", () => {
    expect(
      resolveVolume({ hostEnv: {}, isInDocker: true, platform: "linux", homedir: "/root" })
    ).toEqual({ type: "volume", name: "localstack-mcp" });
  });
});

describe("detectAiAgent", () => {
  test("maps agent marker env vars like the CLI", () => {
    expect(detectAiAgent({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectAiAgent({ CURSOR_TRACE_ID: "x" })).toBe("cursor");
    expect(detectAiAgent({})).toBeUndefined();
  });
});

describe("buildLocalStackContainerSpec", () => {
  test("publishes 4566 + 443 + the 51-port service range (53 total) on 127.0.0.1 by default", () => {
    const spec = buildLocalStackContainerSpec(baseInput());
    const keys = Object.keys(spec.HostConfig.PortBindings);
    expect(keys).toHaveLength(53);
    expect(spec.HostConfig.PortBindings["4566/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "4566" },
    ]);
    expect(spec.HostConfig.PortBindings["443/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "443" },
    ]);
    expect(spec.HostConfig.PortBindings["4510/tcp"]).toBeDefined();
    expect(spec.HostConfig.PortBindings["4560/tcp"]).toBeDefined();
    expect(Object.keys(spec.ExposedPorts)).toHaveLength(53);
  });

  test("binds to 0.0.0.0 when the server runs inside Docker (DooD reachability)", () => {
    const spec = buildLocalStackContainerSpec(baseInput({ isInDocker: true }));
    expect(spec.HostConfig.PortBindings["4566/tcp"][0].HostIp).toBe("0.0.0.0");
    expect(spec.HostConfig.PortBindings["443/tcp"][0].HostIp).toBe("0.0.0.0");
  });

  test("LOCALSTACK_PORT changes only the host side of the gateway mapping", () => {
    const spec = buildLocalStackContainerSpec(baseInput({ hostEnv: { LOCALSTACK_PORT: "4567" } }));
    expect(spec.HostConfig.PortBindings["4566/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "4567" },
    ]);
    expect(envMap(spec).GATEWAY_LISTEN).toBe(":4566,:443");
    expect(envMap(spec).LOCALSTACK_PORT).toBeUndefined();
  });

  test("GATEWAY_LISTEN skips the implicit 443 and strips the default host in container env", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({ hostEnv: { GATEWAY_LISTEN: "127.0.0.1:4566" } })
    );
    expect(spec.HostConfig.PortBindings["443/tcp"]).toBeUndefined();
    expect(spec.HostConfig.PortBindings["4566/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "4566" },
    ]);
    // Forwarding "127.0.0.1:4566" verbatim would make the gateway bind the
    // container's loopback — must be host-stripped exactly like the CLI does.
    expect(envMap(spec).GATEWAY_LISTEN).toBe(":4566");
  });

  test("GATEWAY_LISTEN keeps non-default hosts in the container env (CLI parity)", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({ hostEnv: { GATEWAY_LISTEN: "0.0.0.0:5000" } })
    );
    expect(spec.HostConfig.PortBindings["5000/tcp"]).toEqual([
      { HostIp: "0.0.0.0", HostPort: "5000" },
    ]);
    expect(envMap(spec).GATEWAY_LISTEN).toBe("0.0.0.0:5000");
  });

  test("EXTERNAL_SERVICE_PORTS overrides move both the published range and the env", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({
        hostEnv: { EXTERNAL_SERVICE_PORTS_START: "4600", EXTERNAL_SERVICE_PORTS_END: "4610" },
      })
    );
    expect(spec.HostConfig.PortBindings["4600/tcp"]).toBeDefined();
    expect(spec.HostConfig.PortBindings["4610/tcp"]).toBeDefined();
    expect(spec.HostConfig.PortBindings["4510/tcp"]).toBeUndefined();
    expect(envMap(spec).EXTERNAL_SERVICE_PORTS_START).toBe("4600");
    expect(envMap(spec).EXTERNAL_SERVICE_PORTS_END).toBe("4610");
  });

  test("env layering: shortlist < LOCALSTACK_* < envVars < reserved", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({
        hostEnv: {
          DEBUG: "0",
          LOCALSTACK_DEBUG: "0",
          SERVICES: "s3,sqs",
          LOCALSTACK_HOSTNAME: "host.docker.internal", // client-only: never forwarded
          LOCALSTACK_PORT: "4566", // client-only
          LOCALSTACK_AUTH_TOKEN: "ls-host-env-token", // reserved key wins
          LOCALSTACK_IMAGE_NAME: "custom/image:1", // image selector, not runtime config
          PROVIDER_OVERRIDE_S3: "v2",
          UNRELATED_VAR: "nope",
        },
        envVars: { DEBUG: "1", PERSISTENCE: "1" },
        authToken: "ls-real-token",
      })
    );
    const env = envMap(spec);
    expect(env.DEBUG).toBe("1"); // envVars beat host env
    expect(env.PERSISTENCE).toBe("1");
    expect(env.SERVICES).toBe("s3,sqs");
    expect(env.PROVIDER_OVERRIDE_S3).toBe("v2");
    expect(env.LOCALSTACK_HOSTNAME).toBeUndefined();
    expect(env.LOCALSTACK_PORT).toBeUndefined();
    expect(env.LOCALSTACK_IMAGE_NAME).toBeUndefined();
    expect(env.UNRELATED_VAR).toBeUndefined();
    expect(env.LOCALSTACK_AUTH_TOKEN).toBe("ls-real-token");
    expect(env.MAIN_CONTAINER_NAME).toBe("localstack-main");
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.LOCALSTACK_CLIENT_NAME).toBe("localstack-mcp-server");
    expect(env.LOCALSTACK_CLIENT_VERSION).toBe("0.5.0");
  });

  test("uses structured Mounts (bind + docker socket) — no Binds strings", () => {
    const spec = buildLocalStackContainerSpec(baseInput());
    expect(spec.HostConfig.Mounts).toEqual([
      {
        Type: "bind",
        Source: "/home/user/.cache/localstack/volume",
        Target: "/var/lib/localstack",
      },
      { Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock" },
    ]);
    expect((spec.HostConfig as any).Binds).toBeUndefined();
  });

  test("named volume mount for DooD", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({ isInDocker: true, volume: { type: "volume", name: "localstack-mcp" } })
    );
    expect(spec.HostConfig.Mounts[0]).toEqual({
      Type: "volume",
      Source: "localstack-mcp",
      Target: "/var/lib/localstack",
    });
  });

  test("honors DOCKER_SOCK for the socket mount source", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({ hostEnv: { DOCKER_SOCK: "/run/user/1000/docker.sock" } })
    );
    expect(spec.HostConfig.Mounts[1].Source).toBe("/run/user/1000/docker.sock");
    expect(envMap(spec).DOCKER_HOST).toBe("unix:///var/run/docker.sock");
  });

  test("MAIN_DOCKER_NETWORK becomes NetworkMode and is forwarded as env", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({ hostEnv: { MAIN_DOCKER_NETWORK: "ls-net" } })
    );
    expect(spec.HostConfig.NetworkMode).toBe("ls-net");
    expect(envMap(spec).MAIN_DOCKER_NETWORK).toBe("ls-net");
    const withoutNetwork = buildLocalStackContainerSpec(baseInput());
    expect(withoutNetwork.HostConfig.NetworkMode).toBeUndefined();
  });

  test("AutoRemove is set (CLI --rm parity)", () => {
    expect(buildLocalStackContainerSpec(baseInput()).HostConfig.AutoRemove).toBe(true);
  });

  test("snowflake stack: snowflake image, same container name", () => {
    const spec = buildLocalStackContainerSpec(baseInput({ stack: "snowflake" }));
    expect(spec.Image).toBe("localstack/snowflake:latest");
    expect(spec.name).toBe("localstack-main");
  });

  test("restart recreation can pin the original image and name", () => {
    const spec = buildLocalStackContainerSpec(
      baseInput({
        imageOverride: "localstack/localstack-pro:3.9",
        containerNameOverride: "localstack-aws",
      })
    );
    expect(spec.Image).toBe("localstack/localstack-pro:3.9");
    expect(spec.name).toBe("localstack-aws");
    expect(envMap(spec).MAIN_CONTAINER_NAME).toBe("localstack-aws");
  });

  test("tags agent-driven starts with AI_AGENT like the CLI", () => {
    const spec = buildLocalStackContainerSpec(baseInput({ hostEnv: { CLAUDECODE: "1" } }));
    expect(envMap(spec).AI_AGENT).toBe("claude-code");
  });
});
