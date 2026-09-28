import { readFileSync } from "fs";
import os from "os";
import { installBicep, isMusl, BICEP_VERSION } from "../azure/bicep-install";
import {
  assertNotInProfile,
  defaultExtensionDir,
  installExtensions,
  spawnAz,
  type ExtensionPin,
  type RunAz,
} from "../azure/extension-install";
import { AZURE_EXTENSION_PINS } from "../azure/extension-pins";
import { locateAz, nodeResolveFs, type LocatedAz } from "../azure/resolve-az";

/**
 * The steps of `install-azure-addons` (plan task 5.3): the curated Azure CLI extensions into
 * the tool's extension dir, and the pinned Bicep CLI into ~/.localstack/azure/bin. The user runs
 * that command, as they install the Snowflake CLI for the Snowflake tool; the setup wizard never
 * installs a tool's CLI. The Docker image bundles both.
 */

/** /proc/version, which tells WSL apart for the Azure CLI lookup (undefined off Linux). */
export function procVersion(): string | undefined {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return undefined;
  }
}

export interface AzureStepResult {
  step: "extensions" | "bicep";
  status: "installed" | "skipped" | "failed";
  detail: string;
}

export interface AzureStepDeps {
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
  env: NodeJS.ProcessEnv;
  /** Throws when no Azure CLI is found (the tool's own lookup, without running az). */
  locate: () => LocatedAz;
  run: RunAz;
  pins: readonly ExtensionPin[];
  musl: boolean;
  installBicep: typeof installBicep;
}

export function defaultAzureStepDeps(): AzureStepDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    homedir: os.homedir(),
    env: process.env,
    locate: () =>
      locateAz({
        env: process.env,
        platform: process.platform,
        homedir: os.homedir(),
        fs: nodeResolveFs,
        procVersion: process.platform === "win32" ? undefined : procVersion(),
      }),
    // Captured, so az's output does not bury the command's progress lines; shown on failure.
    run: spawnAz("pipe"),
    pins: AZURE_EXTENSION_PINS,
    musl: isMusl(),
    installBicep,
  };
}

/** Installs the pinned extensions; a no-op, reported as skipped, when az is missing. */
export async function installAzureExtensionsStep(
  deps: AzureStepDeps,
  onProgress?: (index: number, total: number, pin: ExtensionPin) => void
): Promise<AzureStepResult> {
  let az: LocatedAz;
  try {
    az = deps.locate();
  } catch {
    return {
      step: "extensions",
      status: "skipped",
      detail:
        "no Azure CLI found; install it (az 2.85 or newer), then run install-azure-addons again",
    };
  }
  if (az.prefixArgs.length === 0 && deps.platform === "win32" && /\.(cmd|bat)$/i.test(az.file)) {
    return {
      step: "extensions",
      status: "skipped",
      detail: `${az.file} cannot be run without a shell; set LOCALSTACK_AZ_PATH to the Azure CLI's python.exe and re-run`,
    };
  }
  const dir = defaultExtensionDir(deps.env, deps.homedir);
  try {
    assertNotInProfile(dir, { homedir: deps.homedir, env: deps.env, platform: deps.platform });
    const result = await installExtensions({
      pins: deps.pins,
      dir,
      az: { file: az.file, prefix: az.prefixArgs },
      run: deps.run,
      env: deps.env,
      onProgress,
    });
    return {
      step: "extensions",
      status: "installed",
      detail: `${result.installed} Azure CLI extensions in ${result.dir}`,
    };
  } catch (error) {
    return {
      step: "extensions",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Downloads, checks and installs the pinned Bicep CLI. */
export async function installBicepStep(deps: AzureStepDeps): Promise<AzureStepResult> {
  try {
    const result = await deps.installBicep({
      platform: deps.platform,
      arch: deps.arch,
      homedir: deps.homedir,
      musl: deps.musl,
    });
    return {
      step: "bicep",
      status: "installed",
      detail: `Bicep ${BICEP_VERSION} (${result.asset}, sha256 checked) at ${result.path}`,
    };
  } catch (error) {
    return {
      step: "bicep",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
