import { accessSync, constants, statSync } from "fs";
import path from "path";

/**
 * Finding `az`: LOCALSTACK_AZ_PATH, then PATH in order, then the default install locations. On
 * POSIX the launcher runs as it is. On Windows `az.cmd` and `az.bat` cannot be spawned without a
 * shell, so each is mapped to the CLI's own Python, run as `<python> -X utf8 -IBm azure.cli`:
 * `-I` keeps a planted `azure/cli/__main__.py` in the working directory from running in place of
 * `az`, and `-X utf8` keeps non-ASCII values intact under `-I`.
 */

export const MIN_AZ_VERSION = "2.85.0";

export interface AzExecutable {
  /** The file spawned: the `az` launcher, or the CLI's own Python. */
  file: string;
  /** Arguments before the az argv: the module prefix for a Python, none for a launcher. */
  prefixArgs: string[];
  /** AZ_INSTALLER for a Python spawned directly, which no launcher sets. */
  azInstaller?: "MSI" | "PIP";
  version?: string;
}

export class AzResolveError extends Error {
  constructor(
    message: string,
    public readonly reasons: string[] = []
  ) {
    super(message);
    this.name = "AzResolveError";
  }
}

export const AZURE_CLI_INSTALL_OPTIONS =
  "Install the Azure CLI (2.85 or newer): https://learn.microsoft.com/cli/azure/install-azure-cli\n\n" +
  "- Windows: winget install --exact --id Microsoft.AzureCLI\n" +
  "- macOS: brew install azure-cli\n" +
  "- Debian or Ubuntu: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash\n\n" +
  "If it is installed where this tool does not look, set LOCALSTACK_AZ_PATH to its launcher or its Python.";

// `-W ignore::SyntaxWarning`: some extensions' code warns when compiled, which would end up in
// every answer's stderr.
const PYTHON_PREFIX = ["-X", "utf8", "-W", "ignore::SyntaxWarning", "-IBm", "azure.cli"];
const PYTHON_NAME = /^python(\d+(\.\d+)*)?w?(\.exe)?$/i;

export interface LocateAzContext {
  /** LOCALSTACK_AZ_PATH. */
  azPath?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  isFile(p: string): boolean;
  /** POSIX: a regular file with an execute bit. */
  isExecutable(p: string): boolean;
}

const succeeds = (check: () => boolean) => {
  try {
    return check();
  } catch {
    return false;
  }
};

export const nodeResolveFs: Pick<LocateAzContext, "isFile" | "isExecutable"> = {
  isFile: (p) => succeeds(() => statSync(p).isFile()),
  isExecutable: (p) => succeeds(() => (accessSync(p, constants.X_OK), statSync(p).isFile())),
};

/** An environment variable, ignoring case on Windows, where `Path` and `PATH` are one variable. */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Windows: the Python behind a launcher, or why there is none. */
function mapWindows(file: string, ctx: LocateAzContext): AzExecutable | string {
  const P = path.win32;
  const name = P.basename(file).toLowerCase();
  const dir = P.dirname(file);
  if (PYTHON_NAME.test(name)) {
    const msi = /microsoft sdks[\\/]azure[\\/]cli2/i.test(file);
    return { file, prefixArgs: PYTHON_PREFIX, azInstaller: msi ? "MSI" : "PIP" };
  }
  // The MSI's wbin\az.cmd runs ..\python.exe; pip's Scripts\az.bat the python.exe beside it (a
  // venv) or one level up.
  const candidates =
    name === "az.cmd"
      ? [P.join(dir, "..", "python.exe")]
      : name === "az.bat"
        ? [P.join(dir, "python.exe"), P.join(dir, "..", "python.exe")]
        : [];
  const python = candidates.find((p) => ctx.isFile(p));
  if (python) {
    return {
      file: python,
      prefixArgs: PYTHON_PREFIX,
      azInstaller: name === "az.cmd" ? "MSI" : "PIP",
    };
  }
  return `${file}: no python.exe next to it; set LOCALSTACK_AZ_PATH to the Azure CLI's python.exe`;
}

/** POSIX: a Python gets the module prefix, a launcher runs as it is. */
function mapPosix(file: string): AzExecutable | string {
  // In WSL a Windows az would not receive AZURE_CONFIG_DIR, and the bootstrap would rewrite the
  // user's own Windows profile.
  if (/^\/mnt\/[a-z]\//i.test(file) || /\.(exe|cmd|bat)$/i.test(file)) {
    return `${file}: a Windows Azure CLI, which would use your own Windows profile; install the Linux Azure CLI`;
  }
  return { file, prefixArgs: PYTHON_NAME.test(path.posix.basename(file)) ? PYTHON_PREFIX : [] };
}

export function locateAz(ctx: LocateAzContext): AzExecutable {
  const win = ctx.platform === "win32";
  const P = win ? path.win32 : path.posix;
  const map = (file: string) => (win ? mapWindows(file, ctx) : mapPosix(file));
  if (ctx.azPath) {
    if (!P.isAbsolute(ctx.azPath) || !ctx.isFile(ctx.azPath)) {
      throw new AzResolveError(
        `LOCALSTACK_AZ_PATH must be an absolute path to an existing file (the az launcher or the Azure CLI's Python); got "${ctx.azPath}".`
      );
    }
    const mapped = map(ctx.azPath);
    if (typeof mapped === "string") throw new AzResolveError(`LOCALSTACK_AZ_PATH: ${mapped}.`);
    return mapped;
  }

  const pathDirs = (envValue(ctx.env, "PATH", ctx.platform) ?? "")
    .split(win ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => P.isAbsolute(entry));
  const names = win ? ["az.cmd", "az.bat"] : ["az"];
  const known = win
    ? ["ProgramFiles", "ProgramFiles(x86)"]
        .map((name) => envValue(ctx.env, name.toUpperCase(), ctx.platform))
        .filter((root): root is string => Boolean(root))
        .map((root) => P.join(root, "Microsoft SDKs", "Azure", "CLI2", "python.exe"))
    : [
        "/usr/bin/az",
        "/usr/local/bin/az",
        "/opt/homebrew/bin/az",
        P.join(ctx.homedir, ".local/bin/az"),
      ];
  const reasons: string[] = [];
  for (const file of [...pathDirs.flatMap((dir) => names.map((n) => P.join(dir, n))), ...known]) {
    if (!(win ? ctx.isFile(file) : ctx.isExecutable(file))) continue;
    const mapped = map(file);
    if (typeof mapped !== "string") return mapped;
    if (!reasons.includes(mapped)) reasons.push(mapped);
  }
  throw new AzResolveError(
    `The Azure CLI (az) was not found. ${AZURE_CLI_INSTALL_OPTIONS}`,
    reasons
  );
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The azure-cli-core version from `az version -o json`. */
export function parseAzVersion(stdout: string): string | undefined {
  try {
    const versions = JSON.parse(stdout) as Record<string, unknown>;
    const version = versions["azure-cli-core"] ?? versions["azure-cli"];
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}
