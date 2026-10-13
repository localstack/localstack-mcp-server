import { getAzureConfig, isLocalHost } from "./config";

const HOME = "/home/u";
const deps = {
  homedir: () => HOME,
  cwd: () => "/work",
  platform: "linux" as const,
  isDirectory: (p: string) => p === "/work" || p === "/home/u/proj",
};
const config = (env: NodeJS.ProcessEnv) => getAzureConfig(env, deps);

describe("getAzureConfig", () => {
  test("defaults: the gateway every tool uses, the emulator's ARM host, a per-port profile", () => {
    const servicePorts = Array.from({ length: 51 }, (_, i) => 4510 + i);
    expect(config({})).toEqual({
      healthBaseUrl: "http://localhost:4566",
      port: 4566,
      endpoint: "https://azure.localhost.localstack.cloud:4566",
      emulatorPorts: [4566, 443, ...servicePorts],
      configDir: "/home/u/.localstack/azure/mcp-config-4566",
      homeDir: "/home/u/.localstack/azure/mcp-config-4566/home",
      tmpDir: "/home/u/.localstack/azure/mcp-config-4566/tmp",
      extensionDir: "/home/u/.azure/cliextensions",
      azPath: undefined,
      timeoutMs: 300_000,
      workdir: "/work",
      errors: [],
    });
  });

  test("LOCALSTACK_HOSTNAME and LOCALSTACK_PORT move the gateway and the endpoint's port", () => {
    const c = config({ LOCALSTACK_HOSTNAME: "127.0.0.1", LOCALSTACK_PORT: "4666" });
    expect(c.healthBaseUrl).toBe("http://127.0.0.1:4666");
    expect(c.endpoint).toBe("https://azure.localhost.localstack.cloud:4666");
    expect(config({ LOCALSTACK_PORT: "abc" }).errors[0]).toContain("LOCALSTACK_PORT");
  });

  test("the guard's ports follow LOCALSTACK_PORT and the external-service range the start action uses", () => {
    const ports = (env: NodeJS.ProcessEnv) => config(env).emulatorPorts;
    expect(ports({ LOCALSTACK_PORT: "4666", EXTERNAL_SERVICE_PORTS_START: "5000" })).toEqual([
      4666,
      443,
      ...Array.from({ length: 51 }, (_, i) => 5000 + i),
    ]);
    expect(
      ports({ LOCALSTACK_EXTERNAL_SERVICE_PORTS_START: "6000", EXTERNAL_SERVICE_PORTS_END: "6001" })
    ).toEqual([4566, 443, 6000, 6001]);
    // An invalid range falls back to the default one (the start action reports it).
    expect(
      ports({ EXTERNAL_SERVICE_PORTS_START: "9", EXTERNAL_SERVICE_PORTS_END: "5" })
    ).toHaveLength(53);
  });

  test("the extension dir is the user's own: AZURE_EXTENSION_DIR, else their config dir's", () => {
    expect(config({ AZURE_EXTENSION_DIR: "~/ext" }).extensionDir).toBe("/home/u/ext");
    expect(config({ AZURE_CONFIG_DIR: "/cfg" }).extensionDir).toBe("/cfg/cliextensions");
  });

  test("isLocalHost: LocalStack's names for 127.0.0.1 and the loopback names only", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "Azure.LocalHost.LocalStack.Cloud."]) {
      expect(isLocalHost(host)).toBe(true);
    }
    for (const host of ["example.com", "localhost.localstack.cloud.evil.example", "10.0.0.5"]) {
      expect(isLocalHost(host)).toBe(false);
    }
  });

  test.each(["~/.azure", "~/.azure/sub", "~", "/cfg/inner"])(
    "refuses a config dir that overlaps an Azure CLI profile: %s",
    (dir) => {
      const c = config({ LOCALSTACK_AZ_CONFIG_DIR: dir, AZURE_CONFIG_DIR: "/cfg" });
      expect(c.errors.join(" ")).toContain("overlaps your Azure CLI profile");
    }
  );

  test("the workdir must exist; ~ is expanded", () => {
    expect(config({ LOCALSTACK_AZ_WORKDIR: "~/proj" })).toMatchObject({
      workdir: "/home/u/proj",
      errors: [],
    });
    expect(config({ LOCALSTACK_AZ_WORKDIR: "/nope" }).errors[0]).toContain("LOCALSTACK_AZ_WORKDIR");
  });

  test("the timeout is a whole number of seconds from 5 to 3600", () => {
    expect(config({ LOCALSTACK_AZ_TIMEOUT_SECONDS: "60" }).timeoutMs).toBe(60_000);
    for (const value of ["4", "3601", "1.5", "x"]) {
      expect(config({ LOCALSTACK_AZ_TIMEOUT_SECONDS: value }).errors).toHaveLength(1);
    }
  });
});
