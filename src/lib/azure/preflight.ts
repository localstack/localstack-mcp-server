import { ResponseBuilder } from "../../core/response-builder";
import { isRunningInDocker } from "../localstack/localstack.utils";
import { BootstrapError } from "./bootstrap";
import { getAzureEmulatorStatus } from "./emulator";
import { prepareStderr } from "./output";
import { AzResolveError } from "./resolve-az";
import { azCli, azureConfig, ensureProfile, recordEmulatorSession } from "./services";

type ToolResponse = ReturnType<typeof ResponseBuilder.error>;

/** Settings the tool cannot run with: a remote endpoint, a config dir that overlaps ~/.azure, ... */
export function requireAzureConfig(): ToolResponse | null {
  const { errors } = azureConfig();
  if (errors.length === 0) return null;
  return ResponseBuilder.error(
    "Azure Tool Configuration Error",
    errors.map((error) => `- ${error}`).join("\n")
  );
}

export async function requireAzureEmulatorRunning(): Promise<ToolResponse | null> {
  const status = await getAzureEmulatorStatus(azureConfig());
  recordEmulatorSession(status.sessionId);
  return status.ok
    ? null
    : ResponseBuilder.error("LocalStack Azure Emulator Not Ready", status.message);
}

export async function requireAzureCli(): Promise<ToolResponse | null> {
  try {
    await azCli();
    return null;
  } catch (error) {
    if (error instanceof AzResolveError && isRunningInDocker()) {
      return ResponseBuilder.error(
        "Azure CLI Not Available",
        "This server's Docker image does not include the Azure CLI yet. To use the Azure tool, run the server with npx on a machine with the Azure CLI installed (see the README)."
      );
    }
    const reasons =
      error instanceof AzResolveError && error.reasons.length > 0
        ? `\n\nSkipped:\n${error.reasons.map((reason) => `- ${reason}`).join("\n")}`
        : "";
    const message = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.error("Azure CLI Not Available", message + reasons);
  }
}

/** Points the tool's own CLI profile at the emulator; a failed step comes with az's output. */
export async function requireAzureCliConfigured(): Promise<ToolResponse | null> {
  try {
    await ensureProfile();
    return null;
  } catch (error) {
    const details =
      error instanceof BootstrapError
        ? [error.message, prepareStderr(error.result.stderr), error.result.spawnError]
        : [error instanceof Error ? error.message : String(error)];
    return ResponseBuilder.error(
      "Azure CLI Profile Setup Failed",
      details.filter(Boolean).join("\n\n")
    );
  }
}
