import { accessSync, constants, mkdtempSync, rmSync, statSync } from "fs";
import os from "os";
import path from "path";
import { buildAzChildEnv, ensurePrivateDirs, privateDirs, type ChildEnvOptions } from "./child-env";

const winConfig = {
  configDir: "C:\\Users\\me\\.localstack\\azure\\mcp-config-4566",
  homeDir: "C:\\Users\\me\\.localstack\\azure\\mcp-config-4566\\home",
  tmpDir: "C:\\Users\\me\\.localstack\\azure\\mcp-config-4566\\tmp",
  extensionDir: "C:\\Users\\me\\.localstack\\azure\\mcp-extensions",
  egressGuard: true,
  inDocker: false,
};
const posixConfig = {
  configDir: "/home/me/.localstack/azure/mcp-config-4566",
  homeDir: "/home/me/.localstack/azure/mcp-config-4566/home",
  tmpDir: "/home/me/.localstack/azure/mcp-config-4566/tmp",
  extensionDir: "/home/me/.localstack/azure/mcp-extensions",
  egressGuard: true,
  inDocker: false,
};
const win = (over: Partial<ChildEnvOptions> = {}): ChildEnvOptions => ({
  platform: "win32",
  config: winConfig,
  az: { installer: "msi", azInstaller: "MSI" },
  ...over,
});
const posix = (over: Partial<ChildEnvOptions> = {}): ChildEnvOptions => ({
  platform: "linux",
  config: posixConfig,
  az: { installer: "deb", azInstaller: "DEB" },
  ...over,
});

// The parent a user's shell could plausibly have: Azure logins, proxies, CA bundles
// and tools that change what az or Bicep does.
const POLLUTED: NodeJS.ProcessEnv = {
  Path: "C:\\Windows\\system32;C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin",
  SystemRoot: "C:\\Windows",
  SystemDrive: "C:",
  windir: "C:\\Windows",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  USERNAME: "me",
  COMPUTERNAME: "BOX",
  NUMBER_OF_PROCESSORS: "8",
  PROCESSOR_ARCHITECTURE: "AMD64",
  USERPROFILE: "C:\\Users\\me",
  HOME: "C:\\Users\\me",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  AZURE_CONFIG_DIR: "C:\\Users\\x\\.azure",
  AZURE_EXTENSION_DIR: "C:\\Users\\x\\.azure\\cliextensions",
  AZURE_CLIENT_ID: "real-client",
  AZURE_CLIENT_SECRET: "real-secret",
  AZURE_TENANT_ID: "real-tenant",
  AZURE_SUBSCRIPTION_ID: "real-sub",
  ARM_CLIENT_ID: "tf-client",
  ARM_CLIENT_SECRET: "tf-secret",
  MSI_ENDPOINT: "http://169.254.169.254/metadata/identity",
  IDENTITY_ENDPOINT: "http://localhost:42356/msi/token",
  IDENTITY_HEADER: "secret-header",
  HTTPS_PROXY: "http://corp-proxy:8080",
  HTTP_PROXY: "http://corp-proxy:8080",
  NO_PROXY: "*",
  REQUESTS_CA_BUNDLE: "C:\\certs\\corp.pem",
  SSL_CERT_FILE: "C:\\certs\\corp.pem",
  PYTHONPATH: "C:\\evil",
  PYTHONSTARTUP: "C:\\evil\\startup.py",
  LOCALSTACK_AUTH_TOKEN: "ls-secret-token",
};

describe("buildAzChildEnv: the allow-list", () => {
  test("a polluted parent yields a child with none of the polluting variables", () => {
    const env = buildAzChildEnv(POLLUTED, win());
    for (const name of [
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "AZURE_SUBSCRIPTION_ID",
      "ARM_CLIENT_ID",
      "ARM_CLIENT_SECRET",
      "MSI_ENDPOINT",
      "IDENTITY_ENDPOINT",
      "IDENTITY_HEADER",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_FILE",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "LOCALSTACK_AUTH_TOKEN",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(Object.values(env).join("\n")).not.toMatch(
      /real-secret|tf-secret|ls-secret-token|corp-proxy/
    );
  });

  test("the required variables are set, and AZURE_CONFIG_DIR is always the isolated dir", () => {
    const env = buildAzChildEnv(POLLUTED, win());
    expect(env).toMatchObject({
      AZURE_CONFIG_DIR: winConfig.configDir,
      AZURE_EXTENSION_DIR: winConfig.extensionDir,
      AZURE_CORE_COLLECT_TELEMETRY: "no",
      AZURE_CORE_NO_COLOR: "1",
      AZ_INSTALLER: "MSI",
      SYSTEMROOT: "C:\\Windows",
      SYSTEMDRIVE: "C:",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERNAME: "me",
      COMPUTERNAME: "BOX",
      NUMBER_OF_PROCESSORS: "8",
      PROCESSOR_ARCHITECTURE: "AMD64",
    });
    expect(env.PATH).toBe(POLLUTED.Path);
    expect(env.AZURE_CONFIG_DIR).not.toBe(POLLUTED.AZURE_CONFIG_DIR);
  });

  test("with LOCALSTACK_AZ_EXTENSION_DIR set, the child's AZURE_EXTENSION_DIR equals it", () => {
    const env = buildAzChildEnv(
      POLLUTED,
      win({ config: { ...winConfig, extensionDir: "D:\\az-ext" } })
    );
    expect(env.AZURE_EXTENSION_DIR).toBe("D:\\az-ext");
  });

  test.each([
    "KUBECONFIG",
    "DOCKER_COMMAND",
    "GITHUB_ACTIONS",
    "TF_BUILD",
    "AZURE_EXTENSION_SYS_DIR",
    "BICEP_TRACING_ENABLED",
    "BICEP_TRUSTED_REGISTRIES",
    "AZURE_BICEP_USE_BINARY_FROM_PATH",
    "AZURE_BICEP_CHECK_VERSION",
    "BROWSER",
  ])("%s in the parent is absent from the child", (name) => {
    expect(buildAzChildEnv({ ...POLLUTED, [name]: "x" }, win())).not.toHaveProperty(name);
    expect(buildAzChildEnv({ PATH: "/usr/bin", [name]: "x" }, posix())).not.toHaveProperty(name);
  });

  test("no proxy variables are set by the env builder (the runner adds the guard's per call)", () => {
    const env = buildAzChildEnv(POLLUTED, win({ config: { ...winConfig, egressGuard: false } }));
    expect(Object.keys(env).filter((k) => /proxy/i.test(k))).toEqual([]);
  });

  test("LANG and LC_* are inherited on POSIX", () => {
    const env = buildAzChildEnv(
      { PATH: "/usr/bin", LANG: "de_DE.UTF-8", LC_TIME: "C", LC_ALL: "C.UTF-8" },
      posix()
    );
    expect(env).toMatchObject({ LANG: "de_DE.UTF-8", LC_TIME: "C", LC_ALL: "C.UTF-8" });
  });
});

describe("buildAzChildEnv: the private home and temp", () => {
  test("Windows: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and TMP are the private ones", () => {
    const env = buildAzChildEnv(POLLUTED, win());
    expect(env).toMatchObject({
      HOME: winConfig.homeDir,
      USERPROFILE: winConfig.homeDir,
      APPDATA: `${winConfig.homeDir}\\AppData\\Roaming`,
      LOCALAPPDATA: `${winConfig.homeDir}\\AppData\\Local`,
      TEMP: winConfig.tmpDir,
      TMP: winConfig.tmpDir,
    });
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
      expect(env[name]).not.toBe(POLLUTED[name]);
    }
  });

  test("Windows: HOMEDRIVE and HOMEPATH are split from the private home", () => {
    const env = buildAzChildEnv(POLLUTED, win());
    expect(env.HOMEDRIVE).toBe("C:");
    expect(env.HOMEPATH).toBe("\\Users\\me\\.localstack\\azure\\mcp-config-4566\\home");
    expect(env.HOMEDRIVE + env.HOMEPATH).toBe(winConfig.homeDir);
  });

  test("Windows: a UNC home splits at the share", () => {
    const home = "\\\\server\\share\\me\\cfg\\home";
    const env = buildAzChildEnv(POLLUTED, win({ config: { ...winConfig, homeDir: home } }));
    expect(env.HOMEDRIVE).toBe("\\\\server\\share");
    expect(env.HOMEPATH).toBe("\\me\\cfg\\home");
  });

  test("POSIX: HOME and TMPDIR are the private ones, and no Windows-only variables are set", () => {
    const env = buildAzChildEnv({ PATH: "/usr/bin", HOME: "/home/me", TMPDIR: "/tmp" }, posix());
    expect(env).toMatchObject({
      HOME: posixConfig.homeDir,
      TMPDIR: posixConfig.tmpDir,
      TEMP: posixConfig.tmpDir,
    });
    expect(env).not.toHaveProperty("APPDATA");
    expect(env).not.toHaveProperty("HOMEDRIVE");
    expect(env).not.toHaveProperty("PATHEXT");
  });

  test("ensurePrivateDirs creates the dirs, writable (real filesystem)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-env-"));
    try {
      const configDir = path.join(root, "mcp-config-4566");
      const opts = {
        platform: process.platform,
        config: {
          ...posixConfig,
          configDir,
          homeDir: path.join(configDir, "home"),
          tmpDir: path.join(configDir, "tmp"),
        },
      };
      ensurePrivateDirs(opts);
      const dirs = privateDirs(opts);
      const expected = [
        dirs.home,
        dirs.tmp,
        ...(process.platform === "win32" ? [dirs.appData, dirs.localAppData] : []),
      ];
      for (const dir of expected) {
        expect(statSync(dir).isDirectory()).toBe(true);
        accessSync(dir, constants.W_OK);
      }
      if (process.platform !== "win32") expect(statSync(dirs.home).mode & 0o077).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAzChildEnv: Bicep, Docker and launchers spawned as-is", () => {
  test("the Bicep binary's directory comes first on PATH", () => {
    const env = buildAzChildEnv(
      POLLUTED,
      win({ bicepDir: "C:\\Users\\me\\.localstack\\azure\\bin" })
    );
    expect(env.PATH.split(";")[0]).toBe("C:\\Users\\me\\.localstack\\azure\\bin");
    const posixEnv = buildAzChildEnv({ PATH: "/usr/bin" }, posix({ bicepDir: "/usr/local/bin" }));
    expect(posixEnv.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  test("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 is set in Docker only", () => {
    expect(buildAzChildEnv({ PATH: "/usr/bin" }, posix())).not.toHaveProperty(
      "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"
    );
    expect(
      buildAzChildEnv({ PATH: "/usr/bin" }, posix({ config: { ...posixConfig, inDocker: true } }))
        .DOTNET_SYSTEM_GLOBALIZATION_INVARIANT
    ).toBe("1");
  });

  test("a launcher spawned as-is gets LC_ALL=C.UTF-8 when no UTF-8 locale is inherited", () => {
    const asIs = posix({ az: { installer: "launcher-as-is" } });
    expect(buildAzChildEnv({ PATH: "/usr/bin", LANG: "C" }, asIs)).toMatchObject({
      LC_ALL: "C.UTF-8",
      PYTHONIOENCODING: "utf-8",
    });
    expect(buildAzChildEnv({ PATH: "/usr/bin", LANG: "en_US.UTF-8" }, asIs).LC_ALL).toBeUndefined();
    expect(buildAzChildEnv({ PATH: "/usr/bin", LANG: "C" }, posix())).not.toHaveProperty(
      "PYTHONIOENCODING"
    );
  });
});

describe("buildAzChildEnv: the variables Bicep may read", () => {
  // A .bicepparam reads `readEnvironmentVariable('X')` from az's environment. It is built from an
  // allow-list, so only the names listed in LOCALSTACK_AZ_BICEP_ENV may pass (config.bicepEnv).
  const withBicepEnv = (names: string[]) =>
    win({ config: { ...winConfig, bicepEnv: names } as ChildEnvOptions["config"] });

  test("a listed variable passes through from the server's environment", () => {
    const env = buildAzChildEnv(
      { ...POLLUTED, BACKEND_SECRET: "s3cret" },
      withBicepEnv(["BACKEND_SECRET"])
    );
    expect(env.BACKEND_SECRET).toBe("s3cret");
  });

  test("an unlisted variable does not, and a listed one that is unset is simply absent", () => {
    const env = buildAzChildEnv(
      { ...POLLUTED, BACKEND_SECRET: "s3cret", OTHER_SECRET: "nope" },
      withBicepEnv(["BACKEND_SECRET", "MISSING_ONE"])
    );
    expect(env).not.toHaveProperty("OTHER_SECRET");
    expect(env).not.toHaveProperty("MISSING_ONE");
  });

  test("the tool's own settings still win over a listed name", () => {
    const env = buildAzChildEnv(
      { ...POLLUTED, AZURE_CONFIG_DIR: "C:\\Users\\x\\.azure" },
      withBicepEnv(["AZURE_CONFIG_DIR"])
    );
    expect(env.AZURE_CONFIG_DIR).toBe(winConfig.configDir);
  });
});
