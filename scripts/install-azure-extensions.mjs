#!/usr/bin/env node
// Installs the curated Azure CLI extensions of docker/azure-extensions.txt into
// the extension dir the localstack-azure-client tool uses. One installer for CI, the init wizard
// and developers.
//
//   node scripts/install-azure-extensions.mjs [--dir <path>] [--az <path> | --az-python <python>]
//                                             [--list <file>] [--dry-run]
//
//   --dir        target dir; default LOCALSTACK_AZ_EXTENSION_DIR, else ~/.localstack/azure/mcp-extensions
//   --az         the az executable to run (default: az on PATH). It is spawned without a shell, so on
//                Windows a .cmd/.bat launcher is mapped to its Python (<launcher dir>\..\python.exe)
//   --az-python  run `<python> -X utf8 -IBm azure.cli` instead (the MSI layout on Windows:
//                "C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe")
//   --list       another pin list (default: docker/azure-extensions.txt)
//   --dry-run    print the commands and change nothing
//
// Every entry runs `az extension add --name <n> --version <v> [--allow-preview true] --upgrade
// --yes --only-show-errors` with AZURE_EXTENSION_DIR set to the target dir and AZURE_CONFIG_DIR set
// to a fresh temporary dir, so the user's own ~/.azure is never read or written. `--upgrade` makes
// a re-run converge on the pinned version: without it az keeps whatever version is installed and,
// under --only-show-errors, says nothing. The first failure stops the run.
//
// The pin-list parser and the installer are shared with the server, whose init wizard uses the
// same code: they are imported from src/lib/azure/extension-map.ts and extension-install.ts,
// which needs Node.js 22.18 or newer (built-in type stripping).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PREFIX = ["-X", "utf8", "-IBm", "azure.cli"];

class ScriptError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    dir: undefined,
    az: undefined,
    azPython: undefined,
    list: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--"))
        throw new ScriptError(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--dir":
        opts.dir = value();
        break;
      case "--az":
        opts.az = value();
        break;
      case "--az-python":
        opts.azPython = value();
        break;
      case "--list":
        opts.list = value();
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new ScriptError(`unknown argument ${arg} (see --help)`);
    }
  }
  if (opts.az && opts.azPython) throw new ScriptError("pass --az or --az-python, not both");
  return opts;
}

async function loadModules() {
  try {
    const map = await import("../src/lib/azure/extension-map.ts");
    const install = await import("../src/lib/azure/extension-install.ts");
    return { parsePinList: map.parsePinList, install };
  } catch (error) {
    throw new ScriptError(
      `cannot load src/lib/azure/extension-map.ts and extension-install.ts (${error.message}). ` +
        "This script needs Node.js 22.18 or newer, which runs TypeScript files directly."
    );
  }
}

function targetDir(opts, install) {
  const dir = opts.dir
    ? path.resolve(opts.dir)
    : install.defaultExtensionDir(process.env, os.homedir());
  // Never install into the user's own CLI profile: that would change their real `az`.
  try {
    install.assertNotInProfile(dir, { homedir: os.homedir(), env: process.env });
  } catch (error) {
    throw new ScriptError(error.message);
  }
  return dir;
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function findOnPath(names) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

// A .cmd/.bat launcher cannot be spawned without a shell (EINVAL), so run the Python it wraps.
// Both the MSI (CLI2\wbin\az.cmd) and pip (Scripts\az.cmd) keep python.exe one level up.
function pythonOfLauncher(launcher, dryRun) {
  const python = path.join(path.dirname(launcher), "..", "python.exe");
  if (!dryRun && !fs.existsSync(python)) {
    throw new ScriptError(`no python.exe next to ${launcher}; pass --az-python <python.exe>`);
  }
  return { file: path.normalize(python), prefix: CLI_PREFIX };
}

function resolveAz(opts) {
  let az;
  if (opts.azPython) {
    az = { file: opts.azPython, prefix: CLI_PREFIX };
  } else if (opts.az) {
    az =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(opts.az)
        ? pythonOfLauncher(opts.az, opts.dryRun)
        : { file: opts.az, prefix: [] };
  } else if (process.platform === "win32") {
    const launcher = findOnPath(["az.cmd", "az.bat"]);
    if (launcher) {
      az = pythonOfLauncher(launcher, opts.dryRun);
    } else {
      for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
        const python = base && path.join(base, "Microsoft SDKs", "Azure", "CLI2", "python.exe");
        if (python && fs.existsSync(python)) {
          az = { file: python, prefix: CLI_PREFIX };
          break;
        }
      }
    }
  } else {
    const found = findOnPath(["az"]);
    if (found) az = { file: found, prefix: [] };
  }
  if (!az) {
    if (!opts.dryRun) {
      throw new ScriptError("no Azure CLI found on PATH; pass --az <path> or --az-python <python>");
    }
    console.log('# warning: no Azure CLI found on PATH; the commands below show "az"');
    return { file: "az", prefix: [] };
  }
  // Under WSL a Windows az ignores AZURE_CONFIG_DIR and AZURE_EXTENSION_DIR (WSL does not
  // forward them) and would install into the Windows user's real ~/.azure.
  if (isWsl() && (az.file.startsWith("/mnt/") || /\.(exe|cmd|bat)$/i.test(az.file))) {
    throw new ScriptError(`refusing ${az.file}: under WSL this is a Windows az; install az in WSL`);
  }
  return az;
}

const quote = (arg) => (/[\s"']/.test(arg) || arg === "" ? `"${arg.replace(/"/g, '\\"')}"` : arg);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // The usage is the comment block at the top of this file.
    const lines = fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split(/\r?\n/)
      .slice(1);
    const end = lines.findIndex((line) => !line.startsWith("//"));
    console.log(
      lines
        .slice(0, end)
        .map((line) => line.replace(/^\/\/ ?/, ""))
        .join("\n")
    );
    return 0;
  }
  const listFile = path.resolve(
    opts.list || path.join(REPO_ROOT, "docker", "azure-extensions.txt")
  );
  const { parsePinList, install } = await loadModules();
  let pins;
  try {
    pins = parsePinList(fs.readFileSync(listFile, "utf8"));
  } catch (error) {
    throw new ScriptError(`${listFile}: ${error.message}`);
  }
  if (pins.length === 0) throw new ScriptError(`${listFile}: no extensions listed`);
  const dir = targetDir(opts, install);
  const az = resolveAz(opts);

  if (opts.dryRun) {
    console.log(`# dry run: ${pins.length} extensions from ${listFile}`);
    console.log(`# AZURE_EXTENSION_DIR=${dir}`);
    console.log("# AZURE_CONFIG_DIR=<a fresh temporary dir, removed afterwards>");
    for (const pin of pins) {
      console.log([az.file, ...az.prefix, ...install.extensionAddArgs(pin)].map(quote).join(" "));
    }
    return 0;
  }

  try {
    await install.installExtensions({
      pins,
      dir,
      az,
      run: install.spawnAz("inherit"),
      onProgress: (index, total, pin) =>
        console.log(
          `[${index + 1}/${total}] ${pin.name} ${pin.version}${pin.preview ? " (preview)" : ""}`
        ),
    });
  } catch (error) {
    throw new ScriptError(error.message, error.exitCode ?? 1);
  }
  console.log(`installed ${pins.length} extensions into ${dir}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`install-azure-extensions: ${error.message}`);
    process.exitCode = error instanceof ScriptError ? error.exitCode : 1;
  }
);
