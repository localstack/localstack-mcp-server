import { ResponseBuilder } from "../../core/response-builder";
import { getAzureEmulatorStatus, type AzureEmulatorStatus } from "./emulator";
import { ensureLoopbackForwarder } from "./loopback-forwarder";
import { azureConfig } from "./services";

/**
 * `localstack-management`'s view of the Azure emulator (plan tasks 3.1 and 3.2). It
 * is "running" once the gateway answers as the Azure edition, and "ready" once the
 * ARM endpoint's HTTPS listener answers too, which comes a few seconds later.
 */
export interface AzureRuntimeStatus {
  isRunning: boolean;
  isReady: boolean;
  /** The port accepts connections but the health check gets no answer (RuntimeStatus). */
  unresponsive?: boolean;
  statusOutput?: string;
  status: AzureEmulatorStatus;
}

export async function getAzureRuntimeStatus(): Promise<AzureRuntimeStatus> {
  const config = azureConfig();
  // In the Docker image the emulator is reached through the loopback forwarder,
  // which retries its targets on every call until the emulator is up.
  if (config.inDocker) await ensureLoopbackForwarder().catch(() => undefined);
  const status = await getAzureEmulatorStatus(config, undefined, { httpsWaitMs: 0 });
  // A busy emulator that does not answer its health check still runs: `start` must not
  // launch a second one beside it.
  const isRunning =
    status.ok ||
    status.problem === "https-not-ready" ||
    status.problem === "license" ||
    status.problem === "not-responding";
  const details = [
    status.edition && `edition: ${status.edition}`,
    status.license !== undefined && `license: ${status.license}`,
    status.version && `version: ${status.version}`,
  ].filter(Boolean);
  return {
    isRunning,
    isReady: status.ok,
    // Running for the pre-start check, but a start waiting for its own container keeps
    // polling: a just-started container looks exactly like this.
    unresponsive: status.problem === "not-responding",
    statusOutput: details.length ? details.join(", ") : undefined,
    status,
  };
}

/**
 * The start action's last step: wait for HTTPS (up to 10 s) and refuse an emulator
 * without a licence. HTTPS that is still starting is not a failure: the Azure tool
 * waits for it on its first call.
 */
export async function azureStartedCheck(): Promise<ReturnType<
  typeof ResponseBuilder.error
> | null> {
  const status = await getAzureEmulatorStatus(azureConfig());
  if (status.problem === "license") {
    return ResponseBuilder.error("LocalStack Azure License Not Active", status.message);
  }
  return null;
}
