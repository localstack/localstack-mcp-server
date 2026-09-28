import path from "path";
import {
  AzResolveError,
  BicepPathError,
  compareVersions,
  listInstalledExtensions,
  localVersionText,
  locateAz,
  locateBicep,
  parseBashLauncher,
  pathEntries,
  probeArgs,
  pythonPrefix,
  resolveAz,
  resolveBicep,
  type AzProbeOutcome,
  type LocatedAz,
  type ResolveAzContext,
  type ResolveBicepContext,
  type ResolveFs,
} from "./resolve-az";

// U5 (plan task 2.2; the ten cases of check C03, plus the launcher texts and Bicep).
// A fake filesystem keeps every case OS-independent.

interface FakeFile {
  text?: string;
  exec?: boolean;
  /** POSIX symlink target. */
  link?: string;
}

function fakeFs(files: Record<string, FakeFile>, platform: NodeJS.Platform): ResolveFs {
  const key = (p: string) =>
    platform === "win32" ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p);
  const table = new Map(Object.entries(files).map(([p, f]) => [key(p), f]));
  const resolve = (p: string): string | undefined => {
    const f = table.get(key(p));
    if (!f) return undefined;
    return f.link ? resolve(f.link) : path.posix.normalize(p);
  };
  return {
    isFile: (p) => table.has(key(p)),
    readText: (p) => {
      const real = platform === "win32" ? p : (resolve(p) ?? p);
      return table.get(key(real))?.text;
    },
    realpath: (p) => (platform === "win32" ? (table.has(key(p)) ? p : undefined) : resolve(p)),
    isExecutable: (p) => {
      const real = platform === "win32" ? p : resolve(p);
      const f = real ? table.get(key(real)) : undefined;
      return Boolean(f) && (platform === "win32" || f!.exec !== false);
    },
    listDir: (dir) => {
      const prefix = key(dir) + (platform === "win32" ? "\\" : "/");
      const names = new Set<string>();
      for (const k of table.keys()) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(/[\\/]/)[0]);
      }
      return [...names];
    },
  };
}

// The launcher texts from check C03 §1.2 and §8, verbatim.
const MSI_CMD = `::\r\n:: Microsoft Azure CLI - Windows Installer - Author file components script\r\n:: Copyright (C) Microsoft Corporation. All Rights Reserved.\r\n::\r\n\r\n@IF EXIST "%~dp0\\..\\python.exe" (\r\n  SET AZ_INSTALLER=MSI\r\n  "%~dp0\\..\\python.exe" -IBm azure.cli %*\r\n) ELSE (\r\n  echo Failed to load python executable.\r\n  exit /b 1\r\n)\r\n`;
const MSI_BASH = `#!/usr/bin/env bash\n\nAZ_INSTALLER=MSI "$(dirname "\${BASH_SOURCE[0]}")/../python.exe" -IBm azure.cli "$@"\n`;
const PIP_BAT = `@echo off\r\nsetlocal\r\n\r\nSET PYTHONPATH=%~dp0\\src;%PYTHONPATH%\r\nSET AZ_INSTALLER=PIP\r\n\r\nIF EXIST "%~dp0\\python.exe" (\r\n  "%~dp0\\python.exe" -m azure.cli %*\r\n) ELSE (\r\n  python -m azure.cli %*\r\n)\r\n`;
const pipScript = (python: string) =>
  `#!${python}\r\n\nimport sys\nimport os\n\nos.execl(sys.executable, sys.executable, '-m', 'azure.cli', *sys.argv[1:])\n`;
const DEB =
  '#!/usr/bin/env bash\nbin_dir=`cd "$(dirname "$BASH_SOURCE[0]")"; pwd`\nAZ_INSTALLER=DEB "$bin_dir"/../../opt/az/bin/python3 -Im azure.cli "$@"\n';

const CLI2 = "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2";
const PY313 = "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313";
const HOST_PREFIX = ["-X", "utf8", "-W", "ignore::SyntaxWarning", "-IBm", "azure.cli"];

const msiFiles: Record<string, FakeFile> = {
  [`${CLI2}\\wbin\\az.cmd`]: { text: MSI_CMD },
  [`${CLI2}\\wbin\\az`]: { text: MSI_BASH },
  [`${CLI2}\\python.exe`]: {},
};
const pipFiles: Record<string, FakeFile> = {
  [`${PY313}\\Scripts\\az.bat`]: { text: PIP_BAT },
  [`${PY313}\\Scripts\\az`]: { text: pipScript(`${PY313}\\python.exe`) },
  [`${PY313}\\python.exe`]: {},
};

function winCtx(files: Record<string, FakeFile>, env: NodeJS.ProcessEnv = {}): ResolveAzContext {
  return { env, platform: "win32", homedir: "C:\\Users\\me", fs: fakeFs(files, "win32") };
}

function posixCtx(
  files: Record<string, FakeFile>,
  env: NodeJS.ProcessEnv = {},
  procVersion?: string
): ResolveAzContext {
  return { env, platform: "linux", homedir: "/home/me", fs: fakeFs(files, "linux"), procVersion };
}

const locateError = (ctx: ResolveAzContext): AzResolveError => {
  try {
    locateAz(ctx);
  } catch (error) {
    return error as AzResolveError;
  }
  throw new Error("expected locateAz to throw");
};

describe("locateAz: LOCALSTACK_AZ_PATH (C03 case 1)", () => {
  test("the MSI az.cmd maps to CLI2\\python.exe with -X utf8 -IBm and AZ_INSTALLER=MSI", () => {
    const exe = locateAz(winCtx(msiFiles, { LOCALSTACK_AZ_PATH: `${CLI2}\\wbin\\az.cmd` }));
    expect(exe).toEqual({
      file: `${CLI2}\\python.exe`.replace("wbin\\..\\", ""),
      prefixArgs: HOST_PREFIX,
      installer: "explicit",
      azInstaller: "MSI",
    });
  });

  test("a python.exe is used as it is", () => {
    const exe = locateAz(winCtx(msiFiles, { LOCALSTACK_AZ_PATH: `${CLI2}\\python.exe` }));
    expect(exe.file).toBe(`${CLI2}\\python.exe`);
    expect(exe.prefixArgs).toEqual(HOST_PREFIX);
    expect(exe.azInstaller).toBe("MSI");
  });

  test.each(["az.cmd", "C:\\nowhere\\az.cmd"])(
    "a relative or missing path is a hard error, with no fallback to PATH: %s",
    (value) => {
      const ctx = winCtx(msiFiles, { LOCALSTACK_AZ_PATH: value, PATH: `${CLI2}\\wbin` });
      expect(locateError(ctx).message).toMatch(/LOCALSTACK_AZ_PATH must be an absolute path/);
    }
  );

  test("an explicit unknown wrapper is a hard error, even with a good az on PATH", () => {
    const files = {
      ...msiFiles,
      "C:\\tools\\az.cmd": { text: "@echo off\r\ncall other.cmd %*\r\n" },
    };
    const ctx = winCtx(files, { LOCALSTACK_AZ_PATH: "C:\\tools\\az.cmd", PATH: `${CLI2}\\wbin` });
    expect(locateError(ctx).message).toMatch(/not a known Azure CLI launcher/);
  });
});

describe("locateAz: PATH order and entry parsing (cases 2 and 3)", () => {
  test("wbin before Python313\\Scripts gives the MSI; reversed gives pip", () => {
    const files = { ...msiFiles, ...pipFiles };
    const msiFirst = locateAz(winCtx(files, { PATH: `${CLI2}\\wbin;${PY313}\\Scripts` }));
    expect(msiFirst).toMatchObject({ file: `${CLI2}\\python.exe`, installer: "msi" });
    const pipFirst = locateAz(winCtx(files, { PATH: `${PY313}\\Scripts;${CLI2}\\wbin` }));
    expect(pipFirst).toMatchObject({
      file: `${PY313}\\python.exe`,
      installer: "pip",
      azInstaller: "PIP",
    });
  });

  test("quoted, empty, trailing-backslash and relative PATH entries are handled", () => {
    expect(pathEntries({ Path: `"${CLI2}\\wbin\\";;.\\bin;relative;C:x;C:\\ok` }, "win32")).toEqual(
      [`${CLI2}\\wbin\\`, "C:\\ok"]
    );
    const exe = locateAz(winCtx(msiFiles, { Path: `;.\\bin;"${CLI2}\\wbin\\"` }));
    expect(exe.file).toBe(`${CLI2}\\python.exe`);
  });

  test("extensions match case-insensitively (AZ.CMD)", () => {
    const files = { [`${CLI2}\\wbin\\AZ.CMD`]: { text: MSI_CMD }, [`${CLI2}\\python.exe`]: {} };
    expect(locateAz(winCtx(files, { PATH: `${CLI2}\\wbin` })).installer).toBe("msi");
  });

  test("a directory holding both az and az.cmd maps once, never to the extensionless file", () => {
    const exe = locateAz(winCtx(msiFiles, { PATH: `${CLI2}\\wbin` }));
    expect(exe.file.toLowerCase().endsWith("python.exe")).toBe(true);
    expect(exe.prefixArgs).toEqual(HOST_PREFIX);
  });

  test("the MSI's Git Bash launcher alone also maps to its python.exe", () => {
    const files = { [`${CLI2}\\wbin\\az`]: { text: MSI_BASH }, [`${CLI2}\\python.exe`]: {} };
    expect(locateAz(winCtx(files, { PATH: `${CLI2}\\wbin` })).file).toBe(`${CLI2}\\python.exe`);
  });
});

describe("locateAz: broken, pip and unknown Windows launchers (cases 4-7)", () => {
  test("an MSI az.cmd without ..\\python.exe is a broken MSI install, with no shell fallback", () => {
    const files = {
      [`${CLI2}\\wbin\\az.cmd`]: { text: MSI_CMD },
      [`${CLI2}\\wbin\\az`]: { text: MSI_BASH },
    };
    const error = locateError(winCtx(files, { PATH: `${CLI2}\\wbin` }));
    expect(error.reasons).toEqual([expect.stringMatching(/broken MSI install/)]);
  });

  test("pip: the venv python.exe comes first", () => {
    const venv = "C:\\proj\\.venv\\Scripts";
    const files = {
      [`${venv}\\az.bat`]: { text: PIP_BAT },
      [`${venv}\\python.exe`]: {},
      "C:\\proj\\.venv\\python.exe": {},
    };
    expect(locateAz(winCtx(files, { PATH: venv })).file).toBe(`${venv}\\python.exe`);
  });

  test("pip: the base install's python.exe when there is no venv python", () => {
    const files = {
      [`${PY313}\\Scripts\\az.bat`]: { text: PIP_BAT },
      [`${PY313}\\python.exe`]: {},
    };
    expect(locateAz(winCtx(files, { PATH: `${PY313}\\Scripts` })).file).toBe(
      `${PY313}\\python.exe`
    );
  });

  test("pip: the sibling az's shebang (CRLF stripped) for a user-site layout", () => {
    const userScripts = "C:\\Users\\me\\AppData\\Roaming\\Python\\Python313\\Scripts";
    const files = {
      [`${userScripts}\\az.bat`]: { text: PIP_BAT },
      [`${userScripts}\\az`]: { text: pipScript(`${PY313}\\python.exe`) },
      [`${PY313}\\python.exe`]: {},
    };
    expect(locateAz(winCtx(files, { PATH: userScripts })).file).toBe(`${PY313}\\python.exe`);
  });

  test("a build-machine shebang that does not exist is rejected; python is never taken from PATH", () => {
    const scripts = "C:\\odd\\Scripts";
    const files = {
      [`${scripts}\\az.bat`]: { text: PIP_BAT },
      [`${scripts}\\az`]: {
        text: pipScript("D:\\a\\_work\\1\\s\\build_scripts\\windows\\artifacts\\cli\\python.exe"),
      },
      "C:\\Windows\\python.exe": {},
    };
    const error = locateError(winCtx(files, { PATH: `${scripts};C:\\Windows` }));
    expect(error.reasons.join("\n")).toMatch(/pip launcher without a usable python\.exe/);
  });

  test.each([
    ["an unknown .cmd wrapper", "C:\\shims\\az.cmd", "@echo off\r\nnode az.js %*\r\n"],
    ["an az.exe shim", "C:\\shims\\az.exe", ""],
  ])("%s is rejected with the LOCALSTACK_AZ_PATH hint", (_label, file, text) => {
    const error = locateError(winCtx({ [file]: { text } }, { PATH: "C:\\shims" }));
    expect(error.reasons.join("\n")).toMatch(/LOCALSTACK_AZ_PATH/);
  });

  test("nothing on PATH falls through to the known MSI location", () => {
    const exe = locateAz(
      winCtx(
        { [`${CLI2}\\python.exe`]: {} },
        { ProgramFiles: "C:\\Program Files", PATH: "C:\\empty" }
      )
    );
    expect(exe).toMatchObject({
      file: `${CLI2}\\python.exe`,
      installer: "msi",
      azInstaller: "MSI",
    });
  });

  test("nothing anywhere gives 'az not found' with install advice", () => {
    const error = locateError(winCtx({}, { PATH: "C:\\empty" }));
    expect(error.message).toMatch(/was not found/);
    expect(error.message).toMatch(/install-azure-cli/);
  });
});

describe("locateAz: POSIX launchers (case 8)", () => {
  test("a symlink is realpath'd, and a pip/venv script is rewritten to its shebang python", () => {
    const files = {
      "/home/me/bin/az": { link: "/home/me/tools/azcli/bin/az" },
      "/home/me/tools/azcli/bin/az": {
        text: pipScript("/home/me/tools/azcli/bin/python").replace(/\r/g, ""),
      },
      "/home/me/tools/azcli/bin/python": {},
    };
    expect(locateAz(posixCtx(files, { PATH: "/home/me/bin:/usr/bin" }))).toEqual({
      file: "/home/me/tools/azcli/bin/python",
      prefixArgs: HOST_PREFIX,
      installer: "pip",
      azInstaller: "PIP",
    });
  });

  test("the deb launcher gives its interpreter /opt/az/bin/python3 with -X utf8 -IBm", () => {
    const files = { "/usr/bin/az": { text: DEB }, "/opt/az/bin/python3": {} };
    expect(locateAz(posixCtx(files, { PATH: "/usr/bin" }))).toEqual({
      file: "/opt/az/bin/python3",
      prefixArgs: HOST_PREFIX,
      installer: "deb",
      azInstaller: "DEB",
    });
  });

  test("an unparseable bash launcher is spawned as-is", () => {
    const text =
      '#!/usr/bin/env bash\nAZ_INSTALLER=RPM PYTHONPATH="$bin_dir/../lib64/az/lib/python3.9/site-packages" python3 -sm azure.cli "$@"\n';
    const exe = locateAz(posixCtx({ "/usr/bin/az": { text } }, { PATH: "/usr/bin" }));
    expect(exe).toEqual({ file: "/usr/bin/az", prefixArgs: [], installer: "launcher-as-is" });
  });

  test("an env-python shebang is refused (it would take python from PATH)", () => {
    const text = "#!/usr/bin/env python3\nimport os\nos.execl('-m', 'azure.cli')\n";
    const error = locateError(
      posixCtx({ "/usr/local/bin/az": { text } }, { PATH: "/usr/local/bin" })
    );
    expect(error.reasons.join("\n")).toMatch(/through env/);
  });

  test("a non-executable az on PATH is ignored", () => {
    const files = { "/usr/bin/az": { text: DEB, exec: false }, "/opt/az/bin/python3": {} };
    const error = locateError(posixCtx(files, { PATH: "/usr/bin" }));
    expect(error.message).toMatch(/was not found/);
  });

  test("known locations are tried when PATH has no az", () => {
    const files = { "/opt/homebrew/bin/az": { text: DEB.replace("DEB", "HOMEBREW") } };
    const exe = locateAz(posixCtx(files, { PATH: "/nothing" }));
    expect(exe.installer).toBe("launcher-as-is"); // its interpreter does not exist here
  });
});

describe("locateAz: without az, the answer says how to install it (as the Snowflake tool does for snow)", () => {
  test("the docs, the minimum version, an install command per platform, then the add-ons", () => {
    const error = locateError(posixCtx({}, { PATH: "/nothing" }));
    expect(error.message).toMatch(/^The Azure CLI \(az\) was not found\./);
    for (const expected of [
      "https://learn.microsoft.com/cli/azure/install-azure-cli",
      "2.85 or newer",
      "winget install --exact --id Microsoft.AzureCLI",
      "brew install azure-cli",
      "curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash",
      "npx -y @localstack/localstack-mcp-server install-azure-addons",
      "LOCALSTACK_AZ_PATH",
    ]) {
      expect(error.message).toContain(expected);
    }
  });
});

describe("locateAz: WSL (case 9)", () => {
  const wslFiles: Record<string, FakeFile> = {
    "/mnt/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az": { text: MSI_BASH },
    "/mnt/c/Users/me/AppData/Local/Programs/Python/Python313/Scripts/az": {
      text: pipScript("C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe"),
    },
  };
  const wslPath =
    "/mnt/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin:/mnt/c/Users/me/AppData/Local/Programs/Python/Python313/Scripts";

  test("Windows candidates are skipped with the reason, and the error explains the real-~/.azure trap", () => {
    const error = locateError(
      posixCtx(wslFiles, { PATH: wslPath, WSL_DISTRO_NAME: "Ubuntu-22.04" })
    );
    expect(error.reasons).toHaveLength(2);
    expect(error.reasons.every((r) => /through WSL/.test(r))).toBe(true);
    expect(error.message).toMatch(/does not forward AZURE_CONFIG_DIR/);
  });

  test("/proc/version alone detects WSL", () => {
    const error = locateError(
      posixCtx(wslFiles, { PATH: wslPath }, "Linux version 5.15 (microsoft-standard-WSL2)")
    );
    expect(error.message).toMatch(/does not forward AZURE_CONFIG_DIR/);
  });

  test("a Linux az later on PATH still wins, without a login-shell PATH", () => {
    const files = {
      ...wslFiles,
      "/home/me/bin/az": { text: pipScript("/home/me/venv/bin/python").replace(/\r/g, "") },
      "/home/me/venv/bin/python": {},
    };
    const exe = locateAz(
      posixCtx(files, { PATH: `${wslPath}:/home/me/bin`, WSL_DISTRO_NAME: "Ubuntu" })
    );
    expect(exe.file).toBe("/home/me/venv/bin/python");
  });

  test("an .exe candidate under WSL is refused even outside /mnt", () => {
    const error = locateError(
      posixCtx(
        { "/usr/local/bin/az": { link: "/opt/win/az.exe" }, "/opt/win/az.exe": { text: "MZ" } },
        {
          PATH: "/usr/local/bin",
          WSL_DISTRO_NAME: "Ubuntu",
        }
      )
    );
    expect(error.reasons.join("\n")).toMatch(/through WSL/);
  });
});

describe("parseBashLauncher and the spawn prefix", () => {
  test("the deb text", () => {
    expect(parseBashLauncher(DEB, "/usr/bin", "linux")).toEqual({
      python: "/opt/az/bin/python3",
      installer: "DEB",
    });
  });

  test("the MSI Git Bash text", () => {
    expect(parseBashLauncher(MSI_BASH, "/c/cli2/wbin", "linux")).toEqual({
      python: "/c/cli2/python.exe",
      installer: "MSI",
    });
  });

  test("a Homebrew-style absolute interpreter", () => {
    const text =
      '#!/usr/bin/env bash\nAZ_INSTALLER=HOMEBREW /opt/homebrew/Cellar/azure-cli/2.90.0/libexec/bin/python -Im azure.cli "$@"\n';
    expect(parseBashLauncher(text, "/opt/homebrew/bin", "darwin")).toEqual({
      python: "/opt/homebrew/Cellar/azure-cli/2.90.0/libexec/bin/python",
      installer: "HOMEBREW",
    });
  });

  test("a PYTHONPATH launcher is not parsed (-I would ignore PYTHONPATH)", () => {
    expect(
      parseBashLauncher('PYTHONPATH=/x python3 -sm azure.cli "$@"', "/usr/bin", "linux")
    ).toBeUndefined();
  });

  test("the image form: a pycache prefix replaces -B (C05)", () => {
    expect(pythonPrefix({ pycacheDir: "/tmp/localstack-az-pycache" })).toEqual([
      "-X",
      "utf8",
      "-W",
      "ignore::SyntaxWarning",
      "-X",
      "pycache_prefix=/tmp/localstack-az-pycache",
      "-Im",
      "azure.cli",
    ]);
    expect(pythonPrefix({})).toEqual(HOST_PREFIX);
    expect(pythonPrefix({ safePathFallback: true })).toEqual([
      "-X",
      "utf8",
      "-W",
      "ignore::SyntaxWarning",
      "-P",
      "-Bm",
      "azure.cli",
    ]);
    expect(probeArgs(false).slice(0, 3)).toEqual(["-X", "utf8", "-IB"]);
    expect(probeArgs(true).slice(0, 4)).toEqual(["-X", "utf8", "-P", "-B"]);
  });
});

describe("resolveAz: the probe (case 10)", () => {
  const ctx = () => winCtx(msiFiles, { PATH: `${CLI2}\\wbin` });

  test("a successful probe gives the version", async () => {
    const probe = jest.fn(async (_exe: LocatedAz, _fallback: boolean): Promise<AzProbeOutcome> => ({
      ok: true,
      python: "3.13.11",
      core: "2.85.0",
    }));
    const exe = await resolveAz(ctx(), probe);
    expect(exe.version).toBe("2.85.0");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][1]).toBe(false);
  });

  test("an import failure under -I retries with -P on Python 3.11+", async () => {
    const probe = jest.fn(async (_exe: LocatedAz, fallback: boolean): Promise<AzProbeOutcome> =>
      fallback
        ? { ok: true, python: "3.12.1", core: "2.87.0" }
        : { ok: false, python: "3.12.1", error: "ModuleNotFoundError" }
    );
    const exe = await resolveAz(ctx(), probe);
    expect(exe.prefixArgs).toEqual([
      "-X",
      "utf8",
      "-W",
      "ignore::SyntaxWarning",
      "-P",
      "-Bm",
      "azure.cli",
    ]);
    expect(exe.version).toBe("2.87.0");
  });

  test("no -P retry below Python 3.11", async () => {
    const probe = jest.fn(async (): Promise<AzProbeOutcome> => ({
      ok: false,
      python: "3.10.12",
      error: "ModuleNotFoundError",
    }));
    await expect(resolveAz(ctx(), probe)).rejects.toThrow(
      /could not be started: ModuleNotFoundError/
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("a version below the minimum is an error", async () => {
    const probe = async (): Promise<AzProbeOutcome> => ({
      ok: true,
      python: "3.11.9",
      core: "2.84.1",
    });
    await expect(resolveAz(ctx(), probe)).rejects.toThrow(/needs 2\.85\.0 or newer/);
  });

  test("compareVersions", () => {
    expect(compareVersions("2.85.0", "2.85.0")).toBe(0);
    expect(compareVersions("2.9.0", "2.85.0")).toBeLessThan(0);
    expect(compareVersions("2.90.0", "2.85.0")).toBeGreaterThan(0);
    expect(compareVersions("0.47.16", "0.14.85")).toBeGreaterThan(0);
  });
});

describe("resolveBicep (C08)", () => {
  const home = "/home/me";
  const bicepCtx = (
    files: Record<string, FakeFile>,
    env: NodeJS.ProcessEnv = {}
  ): ResolveBicepContext => ({
    env,
    platform: "linux",
    homedir: home,
    fs: fakeFs(files, "linux"),
    canonical: (p) => path.posix.resolve(p),
    excludeDirs: [`${home}/.azure`],
  });
  const all = {
    "/opt/bicep/bicep": {},
    [`${home}/.localstack/azure/bin/bicep`]: {},
    "/usr/local/bin/bicep": {},
    [`${home}/.azure/bin/bicep`]: {},
  };

  test("the order: explicit, then the tool's own, then PATH", () => {
    const env = { PATH: `${home}/.azure/bin:/usr/local/bin` };
    expect(
      locateBicep(bicepCtx(all, { ...env, LOCALSTACK_AZ_BICEP_PATH: "/opt/bicep/bicep" }))?.source
    ).toBe("explicit");
    expect(locateBicep(bicepCtx(all, env))).toEqual({
      path: `${home}/.localstack/azure/bin/bicep`,
      dir: `${home}/.localstack/azure/bin`,
      source: "tool",
    });
    const { [`${home}/.localstack/azure/bin/bicep`]: _own, ...rest } = all;
    expect(locateBicep(bicepCtx(rest, env))).toEqual({
      path: "/usr/local/bin/bicep",
      dir: "/usr/local/bin",
      source: "path",
    });
  });

  test("~/.azure/bin/bicep is never chosen, even when that directory is on PATH", () => {
    const files = { [`${home}/.azure/bin/bicep`]: {} };
    expect(locateBicep(bicepCtx(files, { PATH: `${home}/.azure/bin` }))).toBeUndefined();
  });

  test.each(["/opt/bicep/missing/bicep", "/opt/bicep/bicep-cli", "relative/bicep"])(
    "a missing or misnamed LOCALSTACK_AZ_BICEP_PATH is a hard error: %s",
    (value) => {
      const files = { "/opt/bicep/bicep-cli": {}, "relative/bicep": {} };
      expect(() => locateBicep(bicepCtx(files, { LOCALSTACK_AZ_BICEP_PATH: value }))).toThrow(
        BicepPathError
      );
      expect(() => locateBicep(bicepCtx(files, { LOCALSTACK_AZ_BICEP_PATH: value }))).toThrow(
        /must be an existing file named bicep or bicep.exe/
      );
    }
  );

  test("Windows looks for bicep.exe and matches the explicit name case-insensitively", () => {
    const ctx: ResolveBicepContext = {
      env: { LOCALSTACK_AZ_BICEP_PATH: "C:\\tools\\Bicep.EXE" },
      platform: "win32",
      homedir: "C:\\Users\\me",
      fs: fakeFs({ "C:\\tools\\Bicep.EXE": {} }, "win32"),
      canonical: (p) => path.win32.resolve(p).toLowerCase(),
      excludeDirs: [],
    };
    expect(locateBicep(ctx)?.path).toBe("C:\\tools\\Bicep.EXE");
  });

  test("a version below 0.14.85 is flagged for .bicepparam", async () => {
    const files = { "/usr/local/bin/bicep": {} };
    const old = await resolveBicep(
      bicepCtx(files, { PATH: "/usr/local/bin" }),
      async () => "Bicep CLI version 0.13.1 (e3ac80d678)"
    );
    expect(old).toMatchObject({ version: "0.13.1", supportsBicepparam: false });
    const pinned = await resolveBicep(
      bicepCtx(files, { PATH: "/usr/local/bin" }),
      async () => "Bicep CLI version 0.47.16 (8e2a0e3c1a)"
    );
    expect(pinned).toMatchObject({ version: "0.47.16", supportsBicepparam: true });
  });

  test("no Bicep anywhere resolves to undefined", async () => {
    expect(
      await resolveBicep(bicepCtx({}, { PATH: "/usr/bin" }), async () => undefined)
    ).toBeUndefined();
  });
});

describe("version, answered locally", () => {
  test("the installed extensions are read from their METADATA, and the text is JSON plus a note", () => {
    const fs = fakeFs(
      {
        "/ext/resource-graph/resource_graph-2.1.1.dist-info/METADATA": {
          text: "Metadata-Version: 2.1\nName: resource-graph\nVersion: 2.1.1\n",
        },
        "/ext/front-door/front_door-1.3.0.dist-info/METADATA": {
          text: "Name: front-door\nVersion: 1.3.0\n",
        },
        "/ext/broken/readme.txt": { text: "x" },
      },
      "linux"
    );
    const extensions = listInstalledExtensions("/ext", fs, "linux");
    expect(extensions).toEqual([
      { name: "front-door", version: "1.3.0" },
      { name: "resource-graph", version: "2.1.1" },
    ]);
    const text = localVersionText(
      {
        file: "/opt/az/bin/python3",
        prefixArgs: HOST_PREFIX,
        installer: "deb",
        azInstaller: "DEB",
        version: "2.90.0",
      },
      extensions
    );
    expect(JSON.parse(text.split("\n\n")[0])).toEqual({
      "azure-cli": "2.90.0",
      "azure-cli-core": "2.90.0",
      extensions: { "front-door": "1.3.0", "resource-graph": "2.1.1" },
    });
    expect(text).toMatch(/without running `az version`/);
  });
});
