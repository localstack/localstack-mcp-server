import {
  AzResolveError,
  compareVersions,
  locateAz,
  parseAzVersion,
  type LocateAzContext,
} from "./resolve-az";

const PREFIX = ["-X", "utf8", "-W", "ignore::SyntaxWarning", "-IBm", "azure.cli"];

function locate(files: string[], over: Partial<LocateAzContext> = {}) {
  const present = new Set(files);
  return locateAz({
    env: {},
    platform: "linux",
    homedir: "/home/u",
    isFile: (p) => present.has(p),
    isExecutable: (p) => present.has(p),
    ...over,
  });
}

describe("locateAz", () => {
  test("POSIX: the first az on PATH runs as it is, else a default location", () => {
    const env = { PATH: "rel:/opt/a:/opt/b" };
    expect(locate(["/opt/b/az", "/usr/bin/az"], { env })).toEqual({
      file: "/opt/b/az",
      prefixArgs: [],
    });
    expect(locate(["/opt/homebrew/bin/az"], { env }).file).toBe("/opt/homebrew/bin/az");
  });

  test("LOCALSTACK_AZ_PATH: a Python gets the module prefix; a bad path is an error", () => {
    const azPath = "/opt/az/bin/python3";
    expect(locate([azPath], { azPath })).toEqual({ file: azPath, prefixArgs: PREFIX });
    expect(() => locate([], { azPath: "/missing/az" })).toThrow(
      /absolute path to an existing file/
    );
    expect(() => locate(["az"], { azPath: "az" })).toThrow(/absolute path/);
  });

  test("skips a Windows az seen through WSL, which would use the user's own Windows profile", () => {
    const wbin = "/mnt/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin";
    const error = (() => {
      try {
        locate([`${wbin}/az`], { env: { PATH: wbin } });
      } catch (e) {
        return e as AzResolveError;
      }
    })();
    expect(error).toBeInstanceOf(AzResolveError);
    expect(error?.reasons[0]).toContain("Windows Azure CLI");
    expect(error?.message).toContain("brew install azure-cli");
  });

  test("Windows: az.cmd and az.bat map to their Python; the MSI's location without PATH", () => {
    const cli = "C:\\PF\\Microsoft SDKs\\Azure\\CLI2";
    const win = (files: string[], env: NodeJS.ProcessEnv) =>
      locate(files, { platform: "win32", env });
    expect(win([`${cli}\\wbin\\az.cmd`, `${cli}\\python.exe`], { Path: `"${cli}\\wbin"` })).toEqual(
      {
        file: `${cli}\\python.exe`,
        prefixArgs: PREFIX,
        azInstaller: "MSI",
      }
    );
    const venv = ["C:\\venv\\Scripts\\az.bat", "C:\\venv\\Scripts\\python.exe"];
    expect(win(venv, { PATH: "C:\\venv\\Scripts" })).toMatchObject({
      file: venv[1],
      azInstaller: "PIP",
    });
    expect(win([`${cli}\\python.exe`], { ProgramFiles: "C:\\PF" }).file).toBe(`${cli}\\python.exe`);
    expect(() => win(["C:\\x\\az.cmd"], { PATH: "C:\\x" })).toThrow(AzResolveError);
  });
});

test("compareVersions and parseAzVersion", () => {
  expect(compareVersions("2.9.0", "2.85.0")).toBeLessThan(0);
  expect(compareVersions("2.91.0", "2.85.0")).toBeGreaterThan(0);
  expect(parseAzVersion('{"azure-cli": "2.91.0", "azure-cli-core": "2.91.0"}')).toBe("2.91.0");
  expect(parseAzVersion("not json")).toBeUndefined();
});
