import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  azureProtectedDirs,
  canonicalPath,
  getAzureConfig,
  isInsideOrEqual,
  type AzureConfigDeps,
} from "./config";

// U14 (plan task 2.1). Most cases use a fake POSIX home, so they run the same on
// every OS; the real-filesystem cases use a temp dir.
const HOME = "/home/user";
const CWD = "/work/project";
const posix: AzureConfigDeps = {
  homedir: () => HOME,
  cwd: () => CWD,
  platform: "linux",
  inDocker: false,
  realpath: () => undefined,
  isDirectory: (p) => p === CWD || p.startsWith("/work/") || p === HOME || p === "/",
  isFile: (p) => p === "/etc/az-deny.txt",
};

const config = (env: NodeJS.ProcessEnv = {}, deps: AzureConfigDeps = posix) =>
  getAzureConfig(env, deps);

describe("getAzureConfig: defaults", () => {
  test("every value has its Appendix D default", () => {
    const c = config();
    expect(c).toMatchObject({
      port: 4566,
      healthBaseUrl: "http://127.0.0.1:4566",
      endpoint: "https://azure.localhost.localstack.cloud:4566",
      endpointHost: "azure.localhost.localstack.cloud",
      configDir: "/home/user/.localstack/azure/mcp-config-4566",
      homeDir: "/home/user/.localstack/azure/mcp-config-4566/home",
      tmpDir: "/home/user/.localstack/azure/mcp-config-4566/tmp",
      extensionDir: "/home/user/.localstack/azure/mcp-extensions",
      timeoutMs: 300_000,
      maxOutputChars: 30000,
      maxHelpChars: 30000,
      workdir: CWD,
      egressGuard: true,
      runner: "host",
      testEnvelope: false,
      inDocker: false,
      warnings: [],
      errors: [],
    });
    expect(c.azPath).toBeUndefined();
    expect(c.bicepPath).toBeUndefined();
    expect(c.denylistFile).toBeUndefined();
    expect(c.pycacheDir).toBeUndefined();
    expect(c.forwardTarget).toBeUndefined();
  });

  test("LOCALSTACK_AZURE_PORT defaults to LOCALSTACK_PORT", () => {
    const c = config({ LOCALSTACK_PORT: "4567" });
    expect(c.port).toBe(4567);
    expect(c.endpoint).toBe("https://azure.localhost.localstack.cloud:4567");
  });
});

describe("getAzureConfig: overrides", () => {
  test("the port shift (4666) flows into the health URL, the ARM endpoint and the config dir (R15, N5)", () => {
    const c = config({ LOCALSTACK_PORT: "4566", LOCALSTACK_AZURE_PORT: "4666" });
    expect(c.port).toBe(4666);
    expect(c.healthBaseUrl).toBe("http://127.0.0.1:4666");
    expect(c.endpoint).toBe("https://azure.localhost.localstack.cloud:4666");
    expect(c.configDir).toBe("/home/user/.localstack/azure/mcp-config-4666");
  });

  test("two ports get two default config dirs", () => {
    expect(config({ LOCALSTACK_AZURE_PORT: "4566" }).configDir).not.toBe(
      config({ LOCALSTACK_AZURE_PORT: "4666" }).configDir
    );
  });

  test.each([
    ["https://localhost.localstack.cloud:4566", "https://localhost.localstack.cloud:4566"],
    [
      "https://azure.localhost.localstack.cloud:4666/",
      "https://azure.localhost.localstack.cloud:4666",
    ],
    ["https://LOCALHOST:4566", "https://localhost:4566"],
    ["https://127.0.0.1:4566", "https://127.0.0.1:4566"],
    ["https://[::1]:4566", "https://[::1]:4566"],
  ])("a local endpoint override is accepted: %s", (value, expected) => {
    const c = config({ LOCALSTACK_AZURE_ENDPOINT: value });
    expect(c.errors).toEqual([]);
    expect(c.endpoint).toBe(expected);
  });

  test.each([
    "https://management.azure.com",
    "https://my-emulator.example.com:4566",
    "https://localhost.localstack.cloud.evil.com",
    "https://evillocalhost.localstack.cloud",
    "https://10.0.0.5:4566",
  ])("a remote endpoint is refused: %s", (value) => {
    const c = config({ LOCALSTACK_AZURE_ENDPOINT: value });
    expect(c.errors.join("\n")).toMatch(/must point at a local emulator/);
  });

  test.each([
    "http://localhost.localstack.cloud:4566",
    "not a url",
    "https://user:pw@localhost:4566",
  ])("an endpoint that is not a plain https URL is refused: %s", (value) => {
    expect(config({ LOCALSTACK_AZURE_ENDPOINT: value }).errors.join("\n")).toMatch(
      /must be an https URL/
    );
  });

  test("an endpoint with a path is refused", () => {
    expect(
      config({ LOCALSTACK_AZURE_ENDPOINT: "https://localhost:4566/arm" }).errors.join("\n")
    ).toMatch(/bare origin/);
  });

  test("each path and value override", () => {
    const c = config({
      LOCALSTACK_AZ_CONFIG_DIR: "~/lsaz/profile",
      LOCALSTACK_AZ_EXTENSION_DIR: "/opt/az-extensions",
      LOCALSTACK_AZ_PATH: "/usr/bin/az",
      LOCALSTACK_AZ_BICEP_PATH: "/usr/local/bin/bicep",
      LOCALSTACK_AZ_TIMEOUT_SECONDS: "60",
      LOCALSTACK_AZ_MAX_OUTPUT_CHARS: "5000",
      LOCALSTACK_AZ_MAX_HELP_CHARS: "8000",
      LOCALSTACK_AZ_WORKDIR: "/work/other",
      LOCALSTACK_AZ_EGRESS_GUARD: "0",
      LOCALSTACK_AZ_DENYLIST_FILE: "/etc/az-deny.txt",
      LOCALSTACK_AZ_PYCACHE_DIR: "/tmp/localstack-az-pycache",
      LOCALSTACK_AZURE_FORWARD_TARGET: "host.docker.internal",
      LOCALSTACK_AZ_TEST_ENVELOPE: "1",
    });
    expect(c.errors).toEqual([]);
    expect(c).toMatchObject({
      configDir: "/home/user/lsaz/profile",
      homeDir: "/home/user/lsaz/profile/home",
      extensionDir: "/opt/az-extensions",
      azPath: "/usr/bin/az",
      bicepPath: "/usr/local/bin/bicep",
      timeoutMs: 60_000,
      maxOutputChars: 5000,
      maxHelpChars: 8000,
      workdir: "/work/other",
      egressGuard: false,
      denylistFile: "/etc/az-deny.txt",
      pycacheDir: "/tmp/localstack-az-pycache",
      forwardTarget: "host.docker.internal",
      testEnvelope: true,
    });
  });

  test("a relative workdir resolves against the server's cwd", () => {
    expect(config({ LOCALSTACK_AZ_WORKDIR: "sub" }).workdir).toBe("/work/project/sub");
  });
});

describe("getAzureConfig: invalid values fall back with a warning", () => {
  test.each([
    ["LOCALSTACK_AZ_TIMEOUT_SECONDS", "4", "timeoutMs", 300_000],
    ["LOCALSTACK_AZ_TIMEOUT_SECONDS", "3601", "timeoutMs", 300_000],
    ["LOCALSTACK_AZ_TIMEOUT_SECONDS", "ten", "timeoutMs", 300_000],
    ["LOCALSTACK_AZ_TIMEOUT_SECONDS", "1.5", "timeoutMs", 300_000],
    ["LOCALSTACK_AZ_MAX_OUTPUT_CHARS", "999", "maxOutputChars", 30000],
    ["LOCALSTACK_AZ_MAX_HELP_CHARS", "-5", "maxHelpChars", 30000],
    ["LOCALSTACK_AZURE_PORT", "70000", "port", 4566],
    ["LOCALSTACK_AZURE_PORT", "0", "port", 4566],
  ] as const)("%s=%s", (name, value, key, expected) => {
    const c = config({ [name]: value });
    expect(c[key]).toBe(expected);
    expect(c.warnings.join("\n")).toContain(`${name}=${value}`);
    expect(c.errors).toEqual([]);
  });

  test("the timeout bounds themselves are accepted", () => {
    expect(config({ LOCALSTACK_AZ_TIMEOUT_SECONDS: "5" }).timeoutMs).toBe(5000);
    expect(config({ LOCALSTACK_AZ_TIMEOUT_SECONDS: "3600" }).timeoutMs).toBe(3_600_000);
  });

  test("an unknown guard value keeps the guard on", () => {
    const c = config({ LOCALSTACK_AZ_EGRESS_GUARD: "maybe" });
    expect(c.egressGuard).toBe(true);
    expect(c.warnings).toHaveLength(1);
  });

  test("LOCALSTACK_AZ_RUNNER: host by default, worker on request, anything else warns", () => {
    expect(config({}).runner).toBe("host");
    const worker = config({ LOCALSTACK_AZ_RUNNER: "Worker" });
    expect(worker.runner).toBe("worker");
    expect(worker.warnings).toEqual([]);
    const other = config({ LOCALSTACK_AZ_RUNNER: "fast" });
    expect(other.runner).toBe("host");
    expect(other.warnings.join("\n")).toMatch(/not a runner; use host or worker/);
  });

  test("LOCALSTACK_AZ_BICEP_ENV: the variables Bicep may read, none by default", () => {
    expect(config({}).bicepEnv).toEqual([]);
    const c = config({
      LOCALSTACK_AZ_BICEP_ENV: " BACKEND_SECRET, PG_ADMIN_PASSWORD ,BACKEND_SECRET",
    });
    expect(c.bicepEnv).toEqual(["BACKEND_SECRET", "PG_ADMIN_PASSWORD"]);
    expect(c.warnings).toEqual([]);
  });

  test("LOCALSTACK_AZ_BICEP_ENV never passes the token or a variable that steers az, and says so", () => {
    const c = config({
      LOCALSTACK_AZ_BICEP_ENV:
        "LOCALSTACK_AUTH_TOKEN,AZURE_CLIENT_SECRET,ARM_CLIENT_ID,HTTPS_PROXY,https_proxy,PATH," +
        "BICEP_TRACING_ENABLED,not-a-name,OK_VAR",
    });
    expect(c.bicepEnv).toEqual(["OK_VAR"]);
    const warned = c.warnings.join("\n");
    for (const name of [
      "LOCALSTACK_AUTH_TOKEN",
      "AZURE_CLIENT_SECRET",
      "HTTPS_PROXY",
      "not-a-name",
    ]) {
      expect(warned).toContain(name);
    }
  });

  test("an invalid LOCALSTACK_AZURE_PORT falls back to LOCALSTACK_PORT", () => {
    expect(config({ LOCALSTACK_PORT: "4600", LOCALSTACK_AZURE_PORT: "x" }).port).toBe(4600);
  });
});

describe("getAzureConfig: the config dir never touches the real Azure CLI profile (N4)", () => {
  test.each([
    ["~/.azure", /basename \.azure/],
    ["/home/user/.azure/sub", /inside your Azure CLI profile/],
    ["/data/profiles/.azure", /basename \.azure/],
    ["/home/user", /contains your Azure CLI profile/],
    ["/", /contains your Azure CLI profile/],
  ])("LOCALSTACK_AZ_CONFIG_DIR=%s is refused", (value, reason) => {
    const errors = config({ LOCALSTACK_AZ_CONFIG_DIR: value }).errors.join("\n");
    expect(errors).toMatch(reason);
    expect(errors).toContain("LOCALSTACK_AZ_CONFIG_DIR");
  });

  test("a dir inside the parent's AZURE_CONFIG_DIR is refused", () => {
    const errors = config({
      AZURE_CONFIG_DIR: "/srv/azcfg",
      LOCALSTACK_AZ_CONFIG_DIR: "/srv/azcfg/mcp",
    }).errors.join("\n");
    expect(errors).toMatch(/inside AZURE_CONFIG_DIR/);
  });

  test("a dir under ~/.localstack is accepted", () => {
    expect(config({ LOCALSTACK_AZ_CONFIG_DIR: "~/.localstack/azure/x" }).errors).toEqual([]);
  });

  test("the comparison is case-insensitive on Windows", () => {
    const win: AzureConfigDeps = {
      homedir: () => "C:\\Users\\me",
      cwd: () => "C:\\work",
      platform: "win32",
      inDocker: false,
      realpath: () => undefined,
      isDirectory: () => true,
      isFile: () => false,
    };
    const c = getAzureConfig({ LOCALSTACK_AZ_CONFIG_DIR: "c:\\USERS\\ME\\.Azure\\x" }, win);
    expect(c.errors.join("\n")).toMatch(/inside your Azure CLI profile/);
    const ok = getAzureConfig({}, win);
    expect(ok.errors).toEqual([]);
    expect(ok.configDir).toBe("C:\\Users\\me\\.localstack\\azure\\mcp-config-4566");
    expect(ok.homeDir).toBe("C:\\Users\\me\\.localstack\\azure\\mcp-config-4566\\home");
  });

  test("a symlink into ~/.azure is refused (real filesystem)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-cfg-"));
    try {
      const home = path.join(root, "home");
      mkdirSync(path.join(home, ".azure"), { recursive: true });
      const link = path.join(root, "link");
      try {
        symlinkSync(path.join(home, ".azure"), link, "junction");
      } catch {
        return; // no symlink privilege on this machine: covered by the fake-fs cases
      }
      const c = getAzureConfig(
        { LOCALSTACK_AZ_CONFIG_DIR: path.join(link, "profile") },
        { homedir: () => home, cwd: () => root, inDocker: false }
      );
      expect(c.errors.join("\n")).toMatch(/inside your Azure CLI profile/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("getAzureConfig: the workdir", () => {
  test("a missing workdir is an error", () => {
    expect(config({ LOCALSTACK_AZ_WORKDIR: "/nowhere" }).errors.join("\n")).toMatch(
      /not an existing directory/
    );
  });

  test("a workdir inside ~/.azure is an error", () => {
    const deps = { ...posix, isDirectory: () => true };
    expect(config({ LOCALSTACK_AZ_WORKDIR: "/home/user/.azure" }, deps).errors.join("\n")).toMatch(
      /inside an Azure CLI profile/
    );
  });

  test("a workdir that contains the home directory is a warning, not an error", () => {
    const c = config({ LOCALSTACK_AZ_WORKDIR: "/home/user" });
    expect(c.errors).toEqual([]);
    expect(c.warnings.join("\n")).toMatch(/contains your home directory/);
  });

  test("a denylist file that does not exist is an error", () => {
    expect(config({ LOCALSTACK_AZ_DENYLIST_FILE: "/etc/missing.txt" }).errors.join("\n")).toMatch(
      /LOCALSTACK_AZ_DENYLIST_FILE/
    );
  });

  test("a real temp workdir passes with the default filesystem checks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-wd-"));
    try {
      writeFileSync(path.join(root, "deny.txt"), "storage account\n");
      const c = getAzureConfig(
        { LOCALSTACK_AZ_WORKDIR: root, LOCALSTACK_AZ_DENYLIST_FILE: path.join(root, "deny.txt") },
        { homedir: () => path.join(root, "home"), inDocker: false }
      );
      expect(c.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("protected directories and path helpers", () => {
  test("azureProtectedDirs lists the real profile dirs, the parent's AZURE_CONFIG_DIR and the tool's config dir", () => {
    const c = config();
    expect(
      azureProtectedDirs(
        c,
        { AZURE_CONFIG_DIR: "/srv/azcfg" },
        { homedir: () => HOME, cwd: () => CWD, platform: "linux" }
      )
    ).toEqual([
      "/home/user/.azure",
      "/home/user/.ssh",
      "/home/user/.kube",
      "/home/user/.docker",
      "/srv/azcfg",
      "/home/user/.localstack/azure/mcp-config-4566",
    ]);
  });

  test("isInsideOrEqual", () => {
    expect(isInsideOrEqual("/a/b", "/a", "linux")).toBe(true);
    expect(isInsideOrEqual("/a", "/a", "linux")).toBe(true);
    expect(isInsideOrEqual("/ab", "/a", "linux")).toBe(false);
    expect(isInsideOrEqual("/a/../b", "/a", "linux")).toBe(false);
    expect(isInsideOrEqual("d:\\x", "c:\\", "win32")).toBe(false);
  });

  test("canonicalPath resolves the longest existing prefix and lower-cases on win32", () => {
    const realpath = (p: string) => (p === "C:\\Link" ? "C:\\Users\\Me\\.azure" : undefined);
    expect(canonicalPath("C:\\Link\\x\\y", "win32", realpath)).toBe("c:\\users\\me\\.azure\\x\\y");
    expect(canonicalPath("/A/b", "linux", () => undefined)).toBe("/A/b");
  });
});
