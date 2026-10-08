import { getAzureConfig } from "./config";

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
    expect(config({})).toEqual({
      healthBaseUrl: "http://localhost:4566",
      port: 4566,
      endpoint: "https://azure.localhost.localstack.cloud:4566",
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

  test("the extension dir is the user's own: AZURE_EXTENSION_DIR, else their config dir's", () => {
    expect(config({ AZURE_EXTENSION_DIR: "~/ext" }).extensionDir).toBe("/home/u/ext");
    expect(config({ AZURE_CONFIG_DIR: "/cfg" }).extensionDir).toBe("/cfg/cliextensions");
  });

  test("LOCALSTACK_AZURE_ENDPOINT must be a local https origin", () => {
    expect(config({ LOCALSTACK_AZURE_ENDPOINT: "https://localhost:4566/" }).endpoint).toBe(
      "https://localhost:4566"
    );
    for (const value of [
      "http://localhost:4566",
      "https://example.com",
      "https://localhost.localstack.cloud.evil.example",
      "https://localhost:4566/x",
      "https://user:pw@localhost:4566",
      "not a url",
    ]) {
      expect(config({ LOCALSTACK_AZURE_ENDPOINT: value }).errors).toHaveLength(1);
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
