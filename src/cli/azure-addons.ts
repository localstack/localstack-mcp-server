import { parseArgs } from "util";
import { AZURE_CLI_INSTALL_OPTIONS } from "../lib/azure/resolve-az";
import {
  defaultAzureStepDeps,
  installAzureExtensionsStep,
  installBicepStep,
  type AzureStepDeps,
  type AzureStepResult,
} from "../lib/wizard/azure-steps";
import { HELP_TEXT } from "./help";

/**
 * `install-azure-addons`: what the Azure tool uses beside the Azure CLI itself, installed when the
 * user runs it. The setup wizard never installs a tool's CLI (it does not install the Snowflake
 * CLI either): the README and the Azure tool's own answers name this command. It installs the
 * pinned Azure CLI extensions into the tool's own extension dir and the pinned Bicep CLI into
 * ~/.localstack/azure/bin; the user's own Azure CLI profile is never changed.
 */

export interface AzureAddonsIo {
  deps?: AzureStepDeps;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const LABEL = { extensions: "Azure CLI extensions", bicep: "Bicep" } as const;

function resultLine(result: AzureStepResult): string {
  if (result.status === "installed") return `✓ ${result.detail}`;
  return `${result.status === "skipped" ? "−" : "✗"} ${LABEL[result.step]}: ${result.detail}`;
}

export async function runInstallAzureAddons(
  argv: string[],
  io: AzureAddonsIo = {}
): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));

  let values: { "no-extensions"?: boolean; "no-bicep"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        "no-extensions": { type: "boolean" },
        "no-bicep": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    err('Run "install-azure-addons --help" for usage.');
    return 1;
  }
  if (values.help) {
    out(HELP_TEXT);
    return 0;
  }
  const wantExtensions = !values["no-extensions"];
  const wantBicep = !values["no-bicep"];
  if (!wantExtensions && !wantBicep) {
    out("Nothing to install (--no-extensions and --no-bicep).");
    return 0;
  }

  const deps = io.deps ?? defaultAzureStepDeps();
  try {
    deps.locate();
  } catch {
    err(
      "The Azure CLI (az) was not found. The Azure tool runs it against the LocalStack Azure " +
        `emulator, so install it first.\n\n${AZURE_CLI_INSTALL_OPTIONS}\n\nThen run this command again.`
    );
    return 1;
  }

  const results: AzureStepResult[] = [];
  if (wantExtensions) {
    out(`Installing the ${deps.pins.length} pinned Azure CLI extensions the Azure tool uses...`);
    const result = await installAzureExtensionsStep(deps, (index, total, pin) =>
      out(`  (${index + 1}/${total}) ${pin.name} ${pin.version}${pin.preview ? " (preview)" : ""}`)
    );
    results.push(result);
    out(resultLine(result));
  }
  if (wantBicep) {
    out("Downloading the pinned Bicep CLI...");
    const result = await installBicepStep(deps);
    results.push(result);
    out(resultLine(result));
  }

  const notDone = results.filter((result) => result.status !== "installed");
  if (notDone.length > 0) {
    err(`Done with errors: ${notDone.map((r) => LABEL[r.step]).join(" and ")} (see above).`);
    return 1;
  }
  out("Done. The Azure tool uses them from its next call.");
  return 0;
}
