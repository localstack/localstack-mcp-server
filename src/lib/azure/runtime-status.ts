import { ResponseBuilder } from "../../core/response-builder";
import { getAzureEmulatorStatus, type AzureEmulatorStatus } from "./emulator";
// The config, not services.ts: the management tool must not bundle the az runner and bootstrap.
import { getAzureConfig } from "./config";

/**
 * `localstack-management`'s view of the Azure emulator: running once the gateway answers as the
 * Azure edition, ready once the ARM endpoint answers over HTTPS too, a few seconds later.
 */
export interface AzureRuntimeStatus {
  isRunning: boolean;
  isReady: boolean;
  statusOutput?: string;
  status: AzureEmulatorStatus;
}

export async function getAzureRuntimeStatus(): Promise<AzureRuntimeStatus> {
  const status = await getAzureEmulatorStatus(getAzureConfig(), undefined, {
    httpsWaitMs: 0,
  });
  const isRunning =
    status.ok || ["https-not-ready", "license", "dns"].includes(status.problem ?? "");
  const details = [
    status.edition && `edition: ${status.edition}`,
    status.version && `version: ${status.version}`,
  ];
  return {
    isRunning,
    isReady: status.ok,
    statusOutput: details.filter(Boolean).join(", ") || undefined,
    status,
  };
}

/**
 * The start action's last step: refuse an emulator without a licence. HTTPS that is still
 * starting is not a failure: the Azure tool waits for it on its first call.
 */
export async function azureStartedCheck(): Promise<ReturnType<
  typeof ResponseBuilder.error
> | null> {
  const status = await getAzureEmulatorStatus(getAzureConfig());
  return status.problem === "license"
    ? ResponseBuilder.error("LocalStack Azure License Not Active", status.message)
    : null;
}
