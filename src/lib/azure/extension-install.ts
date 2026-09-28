/**
 * Installs the curated Azure CLI extensions (plan task 5.3, Appendix E). One installer for
 * `scripts/install-azure-extensions.mjs` (CI, developers) and the `install-azure-addons` command.
 *
 * Every pin runs `az extension add --name <n> --version <v> [--allow-preview true] --upgrade
 * --yes --only-show-errors` with AZURE_EXTENSION_DIR set to the target dir and AZURE_CONFIG_DIR
 * set to a fresh temporary dir, so the user's own ~/.azure is never read or written. `--upgrade`
 * makes a re-run converge on the pinned version: without it az keeps whatever version is
 * installed and, under --only-show-errors, says nothing. The first failure stops the run.
 *
 * The script loads this file unbundled, through Node's built-in type stripping (Node 22.18+):
 * keep it free of imports of other local modules and of TypeScript syntax that needs a
 * transform (enums, namespaces, parameter properties).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ExtensionPin {
  name: string;
  version: string;
  preview: boolean;
}

/** How to run az: a file and the arguments before az's own (the CLI's Python and `-m azure.cli`). */
export interface AzInvocation {
  file: string;
  prefix: string[];
}

export interface RunResult {
  status: number | null;
  signal?: string | null;
  error?: Error;
  /** stdout and stderr, when the runner captured them. */
  output?: string;
}

export type RunAz = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;

/** The tool's extension dir: LOCALSTACK_AZ_EXTENSION_DIR, else ~/.localstack/azure/mcp-extensions. */
export function defaultExtensionDir(env: NodeJS.ProcessEnv, homedir: string): string {
  return path.resolve(
    env.LOCALSTACK_AZ_EXTENSION_DIR || path.join(homedir, ".localstack", "azure", "mcp-extensions")
  );
}

function foldCase(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

export function isInsideDir(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const rel = path.relative(
    foldCase(path.resolve(parent), platform),
    foldCase(path.resolve(child), platform)
  );
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The path with symlinks resolved as far as it exists: the nearest existing ancestor is
 * resolved and the rest re-appended. (In WSL, ~/.azure can be a link to the Windows profile.)
 */
function realish(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Throws when `dir` lies inside the user's own CLI profile (~/.azure, or their
 * AZURE_CONFIG_DIR): installing there would change their real `az`. Both the paths as
 * written and their symlink-resolved forms are compared.
 */
export function assertNotInProfile(
  dir: string,
  ctx: { homedir: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): void {
  const platform = ctx.platform ?? process.platform;
  const profiles = [path.join(ctx.homedir, ".azure"), ctx.env.AZURE_CONFIG_DIR].filter(
    (p): p is string => Boolean(p)
  );
  for (const profile of profiles) {
    const inside =
      isInsideDir(dir, profile, platform) || isInsideDir(realish(dir), realish(profile), platform);
    if (inside) throw new Error(`refusing to install into ${dir}: it is inside ${profile}`);
  }
}

export function extensionAddArgs(pin: ExtensionPin): string[] {
  return [
    "extension",
    "add",
    "--name",
    pin.name,
    "--version",
    pin.version,
    ...(pin.preview ? ["--allow-preview", "true"] : []),
    "--upgrade",
    "--yes",
    "--only-show-errors",
  ];
}

/** The parent environment with the extension dir and a throwaway config dir forced in. */
export function installerEnv(
  parent: NodeJS.ProcessEnv,
  extensionDir: string,
  configDir: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    const upper = key.toUpperCase();
    if (upper === "AZURE_CONFIG_DIR" || upper === "AZURE_EXTENSION_DIR") continue;
    env[key] = value;
  }
  return {
    ...env,
    AZURE_EXTENSION_DIR: extensionDir,
    AZURE_CONFIG_DIR: configDir,
    AZURE_CORE_COLLECT_TELEMETRY: "no",
    AZURE_CORE_NO_COLOR: "1",
  };
}

/** Spawns az without a shell; `inherit` shows its output, `pipe` keeps it for an error message. */
export function spawnAz(stdio: "inherit" | "pipe"): RunAz {
  return (file, args, env) =>
    new Promise((resolve) => {
      let output = "";
      const child = spawn(file, args, { env, shell: false, stdio, windowsHide: true });
      child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
      child.on("error", (error) => resolve({ status: null, error, output }));
      child.on("close", (status, signal) => resolve({ status, signal, output }));
    });
}

export class ExtensionInstallError extends Error {
  pin: ExtensionPin;
  exitCode: number;
  constructor(message: string, pin: ExtensionPin, exitCode: number) {
    super(message);
    this.pin = pin;
    this.exitCode = exitCode;
  }
}

/** Installs every pin into `dir`, in order; the first failure throws ExtensionInstallError. */
export async function installExtensions(opts: {
  pins: readonly ExtensionPin[];
  dir: string;
  az: AzInvocation;
  run: RunAz;
  env?: NodeJS.ProcessEnv;
  tmpdir?: string;
  onProgress?: (index: number, total: number, pin: ExtensionPin) => void;
}): Promise<{ installed: number; dir: string }> {
  fs.mkdirSync(opts.dir, { recursive: true });
  const configDir = fs.mkdtempSync(
    path.join(opts.tmpdir ?? os.tmpdir(), "localstack-az-ext-config-")
  );
  try {
    const env = installerEnv(opts.env ?? process.env, opts.dir, configDir);
    for (const [index, pin] of opts.pins.entries()) {
      opts.onProgress?.(index, opts.pins.length, pin);
      const run = await opts.run(opts.az.file, [...opts.az.prefix, ...extensionAddArgs(pin)], env);
      const label = `${pin.name} ${pin.version}${pin.preview ? " (preview)" : ""}`;
      if (run.error) {
        throw new ExtensionInstallError(
          `could not run ${opts.az.file}: ${run.error.message}`,
          pin,
          1
        );
      }
      if (run.status !== 0) {
        const how = run.status === null ? `signal ${run.signal}` : `exit ${run.status}`;
        const tail = run.output?.trim().split(/\r?\n/).slice(-5).join("\n");
        throw new ExtensionInstallError(
          `az extension add failed for ${label} (${how})${tail ? `:\n${tail}` : ""}`,
          pin,
          run.status || 1
        );
      }
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
  return { installed: opts.pins.length, dir: opts.dir };
}
