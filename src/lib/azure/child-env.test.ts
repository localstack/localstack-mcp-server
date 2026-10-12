import { buildAzChildEnv } from "./child-env";

const config = {
  configDir: "/cfg",
  homeDir: "/cfg/home",
  tmpDir: "/cfg/tmp",
  extensionDir: "/home/u/.azure/cliextensions",
};
const launcher = { file: "/usr/bin/az", prefixArgs: [] };

describe("buildAzChildEnv", () => {
  test("an allow-list: nothing that points az elsewhere reaches it", () => {
    const parent = {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_TIME: "C",
      HOME: "/home/u",
      AZURE_CONFIG_DIR: "/home/u/.azure",
      AZURE_CLIENT_SECRET: "s",
      ARM_SUBSCRIPTION_ID: "x",
      HTTPS_PROXY: "http://proxy:3128",
      LOCALSTACK_AUTH_TOKEN: "ls-secret",
    };
    expect(buildAzChildEnv(parent, "linux", config, launcher)).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_TIME: "C",
      HOME: "/cfg/home",
      USERPROFILE: "/cfg/home",
      TEMP: "/cfg/tmp",
      TMP: "/cfg/tmp",
      TMPDIR: "/cfg/tmp",
      AZURE_CONFIG_DIR: "/cfg",
      AZURE_EXTENSION_DIR: "/home/u/.azure/cliextensions",
      AZURE_CORE_COLLECT_TELEMETRY: "no",
      AZURE_CORE_NO_COLOR: "1",
    });
  });

  test("a launcher without a UTF-8 locale gets C.UTF-8", () => {
    expect(buildAzChildEnv({}, "linux", config, launcher).LC_ALL).toBe("C.UTF-8");
    const python = { file: "/opt/az/bin/python3", prefixArgs: ["-IBm"] };
    expect(buildAzChildEnv({}, "linux", config, python).LC_ALL).toBeUndefined();
  });

  test("az found off PATH: its directory is added, so bicep beside it is found", () => {
    const brew = { file: "/opt/homebrew/bin/az", prefixArgs: [] };
    expect(buildAzChildEnv({ PATH: "/usr/bin:/bin" }, "darwin", config, brew).PATH).toBe(
      "/usr/bin:/bin:/opt/homebrew/bin"
    );
    expect(buildAzChildEnv({}, "darwin", config, brew).PATH).toBe("/opt/homebrew/bin");
  });

  test("Windows: case-insensitive names, the whole private home set, and AZ_INSTALLER", () => {
    const home = "C:\\cfg\\home";
    const env = buildAzChildEnv(
      { Path: "C:\\Windows", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\u\\AppData" },
      "win32",
      { ...config, homeDir: home, tmpDir: "C:\\cfg\\tmp" },
      { file: "C:\\az\\python.exe", prefixArgs: ["-IBm", "azure.cli"], azInstaller: "MSI" }
    );
    expect(env).toMatchObject({
      PATH: "C:\\Windows",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: home,
      HOMEDRIVE: "C:",
      HOMEPATH: "\\cfg\\home",
      APPDATA: `${home}\\AppData\\Roaming`,
      AZ_INSTALLER: "MSI",
    });
  });
});
