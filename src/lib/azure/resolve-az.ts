import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import path from "path";
import type { AzExecutable } from "./types";

/**
 * Finding `az` and Bicep (plan task 2.2; check C03 "Recommended resolve-and-spawn
 * algorithm", check C08). Every launcher is mapped to the CLI's own Python, which is
 * then spawned as `<python> -X utf8 -W ignore::SyntaxWarning -IBm azure.cli`:
 * - `-I` keeps a planted `azure/cli/__main__.py` in the working directory from
 *   running in place of `az` (plain `-m` runs it; verified in C03);
 * - `-X utf8` is the only UTF-8 fix that works under `-I` (PYTHON* variables are
 *   ignored there), and without it non-cp1252 values come back empty with exit 0;
 * - `-W ignore::SyntaxWarning` keeps extensions' compile-time warnings out of stderr.
 * `.cmd`, `.bat` and extensionless launchers are never spawned, and `python` is never
 * taken from PATH.
 */

export const MIN_AZ_VERSION = "2.85.0";
/** `.bicepparam` files need this Bicep release or newer (C08). */
export const MIN_BICEPPARAM_VERSION = "0.14.85";

export interface ResolveFs {
  isFile(p: string): boolean;
  /** The first `maxBytes` of a file as UTF-8; undefined when unreadable. */
  readText(p: string, maxBytes?: number): string | undefined;
  realpath(p: string): string | undefined;
  /** POSIX: a regular file with an execute bit. win32: a regular file. */
  isExecutable(p: string): boolean;
  listDir(p: string): string[];
}

export const nodeResolveFs: ResolveFs = {
  isFile(p) {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText(p, maxBytes = 64 * 1024) {
    try {
      return readFileSync(p).subarray(0, maxBytes).toString("utf8");
    } catch {
      return undefined;
    }
  },
  realpath(p) {
    try {
      return realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
  isExecutable(p) {
    try {
      if (!statSync(p).isFile()) return false;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  listDir(p) {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

export interface ResolveAzContext {
  /** The server's own environment (PATH, ProgramFiles, LOCALSTACK_AZ_PATH, WSL_DISTRO_NAME). */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  fs: ResolveFs;
  /** POSIX only: the text of /proc/version, for WSL detection. */
  procVersion?: string;
  /** LOCALSTACK_AZ_PYCACHE_DIR: write bytecode there instead of `-B` (C05). */
  pycacheDir?: string;
}

/** `az` could not be resolved; `reasons` lists every candidate that was skipped. */
export class AzResolveError extends Error {
  constructor(
    message: string,
    public readonly reasons: string[] = []
  ) {
    super(message);
    this.name = "AzResolveError";
  }
}

export type LocatedAz = Omit<AzExecutable, "version">;

type Mapped = { ok: true; exe: LocatedAz } | { ok: false; reason: string };

/** The command that installs the Azure tool's add-ons: its Azure CLI extensions and Bicep. */
export const AZURE_ADDONS_COMMAND = "npx -y @localstack/localstack-mcp-server install-azure-addons";

/**
 * How to install the Azure CLI, in the form the Snowflake tool gives for `snow`: the official
 * documentation, then one install command per platform. The README lists the same.
 */
export const AZURE_CLI_INSTALL_OPTIONS =
  "Install the Azure CLI (2.85 or newer) by following the official documentation:\n" +
  "https://learn.microsoft.com/cli/azure/install-azure-cli\n\n" +
  "Installation options:\n" +
  "- Windows: winget install --exact --id Microsoft.AzureCLI\n" +
  "- macOS: brew install azure-cli\n" +
  "- Debian or Ubuntu: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash";

const INSTALL_ADVICE =
  `${AZURE_CLI_INSTALL_OPTIONS}\n\n` +
  `After installing it, run \`${AZURE_ADDONS_COMMAND}\` for the Azure CLI extensions and Bicep ` +
  "this tool uses. If your Azure CLI is somewhere this tool does not look, set LOCALSTACK_AZ_PATH " +
  "to its launcher or its Python.";

function api(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Environment lookup that ignores case on Windows, where `Path` and `PATH` are one variable. */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** PATH entries in order: surrounding quotes stripped, empty and relative entries skipped. */
export function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = envValue(env, "PATH", platform) ?? "";
  const pathApi = api(platform);
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry && pathApi.isAbsolute(entry) && !/^[A-Za-z]:(?![\\/])/.test(entry));
}

export function isWsl(ctx: Pick<ResolveAzContext, "env" | "platform" | "procVersion">) {
  return (
    ctx.platform !== "win32" &&
    (Boolean(ctx.env.WSL_DISTRO_NAME) || /microsoft/i.test(ctx.procVersion ?? ""))
  );
}

/**
 * The interpreter flags of a spawn prefix, for a `-c` call (the local-versions probe, the
 * warm worker): `-X utf8 -W ignore::SyntaxWarning -IBm azure.cli` -> `-X utf8 -W ignore::SyntaxWarning -IB`.
 */
export function interpreterFlags(prefixArgs: string[]): string[] {
  const flags = prefixArgs.slice(0, -1);
  const last = flags.pop() ?? "";
  const stripped = last.replace(/m$/, "");
  return stripped === "-" || stripped === "" ? flags : [...flags, stripped];
}

/** The spawn prefix for a mapped Python (C03, C05). */
export function pythonPrefix(opts: { pycacheDir?: string; safePathFallback?: boolean }) {
  const cache = opts.pycacheDir ? ["-X", `pycache_prefix=${opts.pycacheDir}`] : [];
  // With a cache dir the image's stripped .pyc files are rebuilt there once; `-B`
  // would forbid that write even with a prefix set (verified on Python 3.13).
  const isolation = opts.safePathFallback
    ? opts.pycacheDir
      ? ["-P", "-m"]
      : ["-P", "-Bm"]
    : opts.pycacheDir
      ? ["-Im"]
      : ["-IBm"];
  // Extension code is compiled on every run under -B, and some of it (monitor-control-service)
  // has invalid string escapes: without the filter each such call ends with a SyntaxWarning and
  // a source line on stderr, which the answer then carries. -W works under -I.
  return ["-X", "utf8", "-W", "ignore::SyntaxWarning", ...cache, ...isolation, "azure.cli"];
}

function firstLine(text: string) {
  return text.split("\n", 1)[0].replace(/\r$/, "");
}

/** The interpreter of a `#!` line, when it is an absolute path to a Python. */
function shebangPython(text: string, platform: NodeJS.Platform): string | undefined {
  const line = firstLine(text);
  if (!line.startsWith("#!")) return undefined;
  const interpreter = line.slice(2).trim().split(/\s+/)[0] ?? "";
  const base = api(platform).basename(interpreter).toLowerCase();
  if (!api(platform).isAbsolute(interpreter)) return undefined;
  return /^python(\d+(\.\d+)*)?w?(\.exe)?$/.test(base) ? interpreter : undefined;
}

const INSTALLERS: Record<string, AzExecutable["azInstaller"]> = {
  MSI: "MSI",
  PIP: "PIP",
  DEB: "DEB",
  RPM: "RPM",
  HOMEBREW: "HOMEBREW",
};

/**
 * The interpreter a bash launcher execs, e.g. the deb package's
 * `AZ_INSTALLER=DEB "$bin_dir"/../../opt/az/bin/python3 -Im azure.cli "$@"` (C03 §8)
 * or the MSI's Git Bash `wbin/az`. Undefined when the text has another shape, or
 * needs PYTHONPATH (which `-I` ignores); such launchers are spawned as they are.
 */
export function parseBashLauncher(
  text: string,
  launcherDir: string,
  platform: NodeJS.Platform
): { python: string; installer?: AzExecutable["azInstaller"] } | undefined {
  const pathApi = api(platform);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!/\bazure\.cli\b/.test(line) || /PYTHONPATH=/.test(line) || /^\s*#/.test(line)) continue;
    const match =
      /^\s*(?:exec\s+)?(?:AZ_INSTALLER=(\w+)\s+)?(?:exec\s+)?(.+?)\s+-[A-Za-z]*m\s+azure\.cli\b/.exec(
        line
      );
    if (!match) continue;
    const interpreter = match[2]
      .replace(/\$\(dirname\s+"?\$\{?BASH_SOURCE(?:\[0\])?\}?"?\)/g, launcherDir)
      .replace(/\$\{?bin_dir\}?/g, launcherDir)
      .replace(/"/g, "");
    if (interpreter.includes("$") || interpreter.includes("`")) return undefined;
    return {
      python: pathApi.resolve(launcherDir, interpreter),
      installer: match[1] ? INSTALLERS[match[1].toUpperCase()] : undefined,
    };
  }
  return undefined;
}

function msiPython(dir: string, ctx: ResolveAzContext): Mapped {
  const python = api(ctx.platform).join(dir, "..", "python.exe");
  if (!ctx.fs.isFile(python)) {
    return { ok: false, reason: `${dir}: broken MSI install (${python} is missing)` };
  }
  return {
    ok: true,
    exe: {
      file: python,
      prefixArgs: pythonPrefix(ctx),
      installer: "msi",
      azInstaller: "MSI",
    },
  };
}

function pipPython(dir: string, ctx: ResolveAzContext): Mapped {
  const pathApi = api(ctx.platform);
  // The venv layout, then the base install; the sibling `az` script's shebang covers
  // the user-site layout. az.bat's own fallback is "python from PATH": never used.
  const tried = [pathApi.join(dir, "python.exe"), pathApi.join(dir, "..", "python.exe")];
  const sibling = ctx.fs.readText(pathApi.join(dir, "az"), 4096);
  const fromShebang = sibling ? shebangPython(sibling, ctx.platform) : undefined;
  if (fromShebang) tried.push(fromShebang);
  const python = tried.find((p) => ctx.fs.isFile(p));
  if (!python) {
    return {
      ok: false,
      reason: `${dir}: pip launcher without a usable python.exe (tried ${tried.join(", ")})`,
    };
  }
  return {
    ok: true,
    exe: {
      file: pathApi.normalize(python),
      prefixArgs: pythonPrefix(ctx),
      installer: "pip",
      azInstaller: "PIP",
    },
  };
}

/** Map one Windows launcher file to its Python (C03 §1). */
function mapWindowsLauncher(file: string, ctx: ResolveAzContext): Mapped {
  const pathApi = path.win32;
  const dir = pathApi.dirname(file);
  const name = pathApi.basename(file).toLowerCase();
  if (/^python(\d+(\.\d+)*)?w?\.exe$/.test(name)) {
    return {
      ok: true,
      exe: {
        file,
        prefixArgs: pythonPrefix(ctx),
        installer: "explicit",
        azInstaller: /microsoft sdks[\\/]azure[\\/]cli2/i.test(file) ? "MSI" : "PIP",
      },
    };
  }
  if (name === "az.exe") {
    return {
      ok: false,
      reason: `${file}: an az.exe shim cannot be mapped to its Python; set LOCALSTACK_AZ_PATH to the CLI's python.exe`,
    };
  }
  const text = ctx.fs.readText(file, 16 * 1024) ?? "";
  const isMsi = /\.\.[\\/]python\.exe/i.test(text) && /-IBm\s+azure\.cli/.test(text);
  if ((name === "az.cmd" || name === "az") && isMsi) return msiPython(dir, ctx);
  if (name === "az.bat" && /-m\s+azure\.cli/.test(text)) return pipPython(dir, ctx);
  if (name === "az" && shebangPython(text, "win32") && /azure\.cli/.test(text)) {
    return pipPython(dir, ctx);
  }
  return {
    ok: false,
    reason: `${file}: not a known Azure CLI launcher; set LOCALSTACK_AZ_PATH to the CLI's python.exe`,
  };
}

/** Map one POSIX `az` to its Python, or to itself when its shape is unknown (C03 §8). */
function mapPosixLauncher(file: string, ctx: ResolveAzContext): Mapped {
  const pathApi = path.posix;
  const real = ctx.fs.realpath(file) ?? file;
  if (
    isWsl(ctx) &&
    [file, real].some((p) => /^\/mnt\/[a-z]\//i.test(p) || /\.(exe|cmd|bat)$/i.test(p))
  ) {
    // WSL interop does not forward AZURE_CONFIG_DIR, so a Windows az would use the
    // user's real ~/.azure (C03 §8). There is deliberately no escape hatch.
    return {
      ok: false,
      reason: `${file}: a Windows Azure CLI seen through WSL; it would use your real Windows ~/.azure profile, so it is never used`,
    };
  }
  if (/^python(\d+(\.\d+)*)?$/.test(pathApi.basename(real))) {
    return { ok: true, exe: { file: real, prefixArgs: pythonPrefix(ctx), installer: "explicit" } };
  }
  const text = ctx.fs.readText(real, 16 * 1024);
  if (text === undefined) return { ok: false, reason: `${file}: unreadable` };
  const python = shebangPython(text, "linux");
  if (python) {
    if (!ctx.fs.isFile(python))
      return { ok: false, reason: `${file}: its interpreter ${python} is missing` };
    return {
      ok: true,
      exe: { file: python, prefixArgs: pythonPrefix(ctx), installer: "pip", azInstaller: "PIP" },
    };
  }
  const line = firstLine(text);
  if (/^#!\s*\S*env\s+python/.test(line)) {
    return {
      ok: false,
      reason: `${file}: its shebang runs python through env, which would pick python from PATH; set LOCALSTACK_AZ_PATH to the CLI's python`,
    };
  }
  if (!/^#!.*\b(ba)?sh\b/.test(line))
    return { ok: false, reason: `${file}: not a known Azure CLI launcher` };
  // `$BASH_SOURCE` is the path as invoked, so try the unresolved directory first.
  for (const dir of [pathApi.dirname(file), pathApi.dirname(real)]) {
    const parsed = parseBashLauncher(text, dir, "linux");
    if (parsed && ctx.fs.isFile(parsed.python)) {
      const installer = parsed.installer
        ? (parsed.installer.toLowerCase() as AzExecutable["installer"])
        : "script";
      return {
        ok: true,
        exe: {
          file: parsed.python,
          prefixArgs: pythonPrefix(ctx),
          installer,
          azInstaller: parsed.installer,
        },
      };
    }
  }
  // Unknown bash launcher (rpm and Homebrew texts are pinned once CI meets them):
  // spawned as-is, with LC_ALL=C.UTF-8 from the child environment.
  return { ok: true, exe: { file: real, prefixArgs: [], installer: "launcher-as-is" } };
}

function mapCandidate(file: string, ctx: ResolveAzContext): Mapped {
  return ctx.platform === "win32" ? mapWindowsLauncher(file, ctx) : mapPosixLauncher(file, ctx);
}

/**
 * Locate `az` without running it: LOCALSTACK_AZ_PATH, then PATH in order, then the
 * known install locations. Throws AzResolveError with every skipped candidate.
 */
export function locateAz(ctx: ResolveAzContext): LocatedAz {
  const pathApi = api(ctx.platform);
  const reasons: string[] = [];
  const explicit = envValue(ctx.env, "LOCALSTACK_AZ_PATH", ctx.platform)?.trim();
  if (explicit) {
    // No silent fallback: an explicit path that does not work is a hard error.
    if (!pathApi.isAbsolute(explicit) || !ctx.fs.isFile(explicit)) {
      throw new AzResolveError(
        `LOCALSTACK_AZ_PATH must be an absolute path to an existing file (the az launcher or the CLI's Python); got "${explicit}".`
      );
    }
    const mapped = mapCandidate(explicit, ctx);
    if (!mapped.ok)
      throw new AzResolveError(`LOCALSTACK_AZ_PATH: ${mapped.reason}.`, [mapped.reason]);
    return {
      ...mapped.exe,
      installer: mapped.exe.installer === "launcher-as-is" ? "launcher-as-is" : "explicit",
    };
  }

  // One launcher per directory: az and az.cmd side by side map once (C03 case 3),
  // and the first that maps wins, so the extensionless file is never the target.
  const names = ctx.platform === "win32" ? ["az.cmd", "az.bat", "az", "az.exe"] : ["az"];
  for (const dir of pathEntries(ctx.env, ctx.platform)) {
    for (const name of names) {
      const file = pathApi.join(dir, name);
      const present = ctx.platform === "win32" ? ctx.fs.isFile(file) : ctx.fs.isExecutable(file);
      if (!present) continue;
      const mapped = mapCandidate(file, ctx);
      if (mapped.ok) return mapped.exe;
      if (!reasons.includes(mapped.reason)) reasons.push(mapped.reason);
    }
  }

  const known =
    ctx.platform === "win32"
      ? ["ProgramFiles", "ProgramFiles(x86)"]
          .map((v) => envValue(ctx.env, v, ctx.platform))
          .filter((v): v is string => Boolean(v))
          .map((root) => path.win32.join(root, "Microsoft SDKs", "Azure", "CLI2", "python.exe"))
      : [
          "/usr/bin/az",
          "/usr/local/bin/az",
          "/opt/homebrew/bin/az",
          path.posix.join(ctx.homedir, ".local", "bin", "az"),
        ];
  for (const file of known) {
    if (!(ctx.platform === "win32" ? ctx.fs.isFile(file) : ctx.fs.isExecutable(file))) continue;
    const mapped =
      ctx.platform === "win32"
        ? ({
            ok: true,
            exe: { file, prefixArgs: pythonPrefix(ctx), installer: "msi", azInstaller: "MSI" },
          } as Mapped)
        : mapCandidate(file, ctx);
    if (mapped.ok) return mapped.exe;
    reasons.push(mapped.reason);
  }

  const wslNote = reasons.some((r) => r.includes("through WSL"))
    ? " Only a Windows Azure CLI was found, and it cannot be used from WSL: WSL does not forward AZURE_CONFIG_DIR, so it would use your real Windows ~/.azure profile. Install the Linux Azure CLI inside WSL."
    : "";
  throw new AzResolveError(
    `The Azure CLI (az) was not found.${wslNote} ${INSTALL_ADVICE}`,
    reasons
  );
}

/** The result of probing an interpreter or an as-is launcher. */
export interface AzProbeOutcome {
  ok: boolean;
  /** Python version, e.g. "3.13.5" (interpreter probes only). */
  python?: string;
  /** azure-cli-core version. */
  core?: string;
  error?: string;
}

/**
 * Probe code: prints the Python version first, so a failed import still tells the
 * resolver whether the `-P` fallback exists (Python 3.11+). ~0.17 s against ~1.3 s
 * for `az version` (C03 §5).
 */
export const AZ_PROBE_CODE =
  "import sys, json\n" +
  "out = {'python': '%d.%d.%d' % sys.version_info[:3]}\n" +
  "try:\n" +
  "    import azure.cli.core as c\n" +
  "    out['core'] = c.__version__\n" +
  "except Exception as e:\n" +
  "    out['error'] = repr(e)[:300]\n" +
  "print(json.dumps(out))\n";

/** The argv of the interpreter probe, matching the spawn prefix's isolation. */
export function probeArgs(safePathFallback: boolean) {
  return ["-X", "utf8", ...(safePathFallback ? ["-P", "-B"] : ["-IB"]), "-c", AZ_PROBE_CODE];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Locate `az`, then probe it once: `-I` first; if the import fails under `-I` and
 * the interpreter is Python 3.11+, retry with `-P` (a user-site install needs it).
 */
export async function resolveAz(
  ctx: ResolveAzContext,
  probe: (exe: LocatedAz, safePathFallback: boolean) => Promise<AzProbeOutcome>
): Promise<AzExecutable> {
  const located = locateAz(ctx);
  let exe: LocatedAz = located;
  let outcome = await probe(located, false);
  if (!outcome.ok && located.installer !== "launcher-as-is") {
    const python = outcome.python ?? "0";
    if (compareVersions(python, "3.11.0") >= 0) {
      const fallback = {
        ...located,
        prefixArgs: pythonPrefix({ pycacheDir: ctx.pycacheDir, safePathFallback: true }),
      };
      const retry = await probe(fallback, true);
      if (retry.ok) {
        exe = fallback;
        outcome = retry;
      }
    }
  }
  if (!outcome.ok || !outcome.core) {
    throw new AzResolveError(
      `The Azure CLI at ${located.file} could not be started: ${outcome.error ?? "azure-cli is not importable"}. ${INSTALL_ADVICE}`
    );
  }
  if (compareVersions(outcome.core, MIN_AZ_VERSION) < 0) {
    throw new AzResolveError(
      `The Azure CLI at ${located.file} is version ${outcome.core}; the LocalStack Azure tool needs ${MIN_AZ_VERSION} or newer. Upgrade it (https://learn.microsoft.com/cli/azure/update-azure-cli).`
    );
  }
  return { ...exe, version: outcome.core };
}

// ---------------------------------------------------------------------------
// Bicep (C08; plan task 2.2)
// ---------------------------------------------------------------------------

export interface BicepResolution {
  path: string;
  /** Prepended to the child's PATH: az finds Bicep with `shutil.which("bicep")`. */
  dir: string;
  source: "explicit" | "tool" | "path";
  version?: string;
  /** False when the probed version is older than 0.14.85. */
  supportsBicepparam: boolean;
}

export class BicepPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BicepPathError";
  }
}

export interface ResolveBicepContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  fs: ResolveFs;
  /** Canonicalises a path for comparison (see core/config canonicalPath). */
  canonical: (p: string) => string;
  /** Directories never searched: the real ~/.azure and the parent's AZURE_CONFIG_DIR. */
  excludeDirs: string[];
}

/**
 * The Bicep binary, in order: LOCALSTACK_AZ_BICEP_PATH (a hard error when missing or
 * misnamed, review R02 N13), the tool's own ~/.localstack/azure/bin, then PATH. It
 * never picks up `~/.azure/bin/bicep` (where `az bicep install` puts it) on its own.
 */
export function locateBicep(
  ctx: ResolveBicepContext
): Omit<BicepResolution, "version" | "supportsBicepparam"> | undefined {
  const pathApi = api(ctx.platform);
  const exeName = ctx.platform === "win32" ? "bicep.exe" : "bicep";
  const explicit = envValue(ctx.env, "LOCALSTACK_AZ_BICEP_PATH", ctx.platform)?.trim();
  if (explicit) {
    const base = pathApi.basename(explicit);
    const named =
      ctx.platform === "win32" ? /^bicep(\.exe)?$/i.test(base) : /^bicep(\.exe)?$/.test(base);
    if (!pathApi.isAbsolute(explicit) || !named || !ctx.fs.isFile(explicit)) {
      throw new BicepPathError(
        `LOCALSTACK_AZ_BICEP_PATH must be an existing file named bicep or bicep.exe (az looks the binary up by that name); got "${explicit}".`
      );
    }
    return { path: explicit, dir: pathApi.dirname(explicit), source: "explicit" };
  }
  const own = pathApi.join(ctx.homedir, ".localstack", "azure", "bin", exeName);
  if (ctx.fs.isFile(own)) return { path: own, dir: pathApi.dirname(own), source: "tool" };
  const excluded = ctx.excludeDirs.map((d) => ctx.canonical(d));
  for (const dir of pathEntries(ctx.env, ctx.platform)) {
    const canonicalDir = ctx.canonical(dir);
    const inExcluded = excluded.some((ex) => {
      const rel = pathApi.relative(ex, canonicalDir);
      return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
    });
    if (inExcluded) continue;
    const file = pathApi.join(dir, exeName);
    if (ctx.platform === "win32" ? ctx.fs.isFile(file) : ctx.fs.isExecutable(file)) {
      return { path: file, dir, source: "path" };
    }
  }
  return undefined;
}

export function parseBicepVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

export async function resolveBicep(
  ctx: ResolveBicepContext,
  probeVersion: (bicepPath: string) => Promise<string | undefined>
): Promise<BicepResolution | undefined> {
  const located = locateBicep(ctx);
  if (!located) return undefined;
  const version = parseBicepVersion((await probeVersion(located.path)) ?? "");
  return {
    ...located,
    version,
    // An unknown version is given the benefit of the doubt: az reports the real error.
    supportsBicepparam: !version || compareVersions(version, MIN_BICEPPARAM_VERSION) >= 0,
  };
}

// ---------------------------------------------------------------------------
// `version`, answered locally (plan task 2.7/2.12; `az version` calls Microsoft, C02)
// ---------------------------------------------------------------------------

export interface InstalledExtension {
  name: string;
  version: string;
}

/** Extensions in an AZURE_EXTENSION_DIR, read from their `*.dist-info/METADATA`. */
export function listInstalledExtensions(
  extensionDir: string,
  fs: ResolveFs,
  platform: NodeJS.Platform
) {
  const pathApi = api(platform);
  const found: InstalledExtension[] = [];
  for (const entry of fs.listDir(extensionDir).sort()) {
    const dir = pathApi.join(extensionDir, entry);
    const info = fs.listDir(dir).find((d) => /\.(dist|egg)-info$/.test(d));
    if (!info) continue;
    const metadata =
      fs.readText(pathApi.join(dir, info, "METADATA"), 8192) ??
      fs.readText(pathApi.join(dir, info, "PKG-INFO"), 8192);
    const version = metadata && /^Version:\s*(\S+)/m.exec(metadata)?.[1];
    if (version) found.push({ name: entry, version });
  }
  return found;
}

/**
 * `az version -o json`'s shape, from the probe: `azure-cli` and `azure-cli-core` are released
 * in lockstep, and tools such as Terraform's azurerm provider read `azure-cli` (L4 found it).
 */
export function localVersionJson(az: AzExecutable, extensions: InstalledExtension[]): string {
  const version = az.version ?? "unknown";
  const body = {
    "azure-cli": version,
    "azure-cli-core": version,
    extensions: Object.fromEntries(extensions.map((e) => [e.name, e.version])),
  };
  return JSON.stringify(body, null, 2);
}

export function localVersionNote(az: AzExecutable): string {
  return (
    "Answered by the tool without running `az version`, which would call Microsoft's update service. The CLI runs from " +
    `${az.file} (${az.installer}).`
  );
}

export function localVersionText(az: AzExecutable, extensions: InstalledExtension[]): string {
  return `${localVersionJson(az, extensions)}\n\n${localVersionNote(az)}`;
}
