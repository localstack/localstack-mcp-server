import { ensureSnowflakeCli, getGatewayHealth } from "../lib/localstack/localstack.utils";
import { DockerApiClient } from "../lib/docker/docker.client";
import { checkProFeature, ProFeature } from "../lib/localstack/license-checker";
import { LOCALSTACK_BASE_URL } from "./config";
import { ResponseBuilder } from "./response-builder";

type ToolResponse = ReturnType<typeof ResponseBuilder.error>;

export const requireSnowflakeCli = async (): Promise<ToolResponse | null> => {
  const cliCheck = await ensureSnowflakeCli();
  return cliCheck ? (cliCheck as ToolResponse) : null;
};

/**
 * Gate for actions that talk to the Docker daemon (container lifecycle, log reads,
 * in-container exec). Surfaces socket/daemon failures as an actionable message
 * instead of a raw ENOENT.
 */
export const requireDockerDaemon = async (): Promise<ToolResponse | null> => {
  try {
    await new DockerApiClient().ping();
    return null;
  } catch (error) {
    return ResponseBuilder.error(
      "Docker Not Available",
      error instanceof Error ? error.message : String(error)
    );
  }
};

export const requireProFeature = async (feature: ProFeature): Promise<ToolResponse | null> => {
  const licenseCheck = await checkProFeature(feature);
  return !licenseCheck.isSupported
    ? ResponseBuilder.error("Feature Not Available", licenseCheck.errorMessage)
    : null;
};

export const requireAuthToken = (): ToolResponse | null => {
  if (!process.env.LOCALSTACK_AUTH_TOKEN?.trim()) {
    return ResponseBuilder.error(
      "Auth Token Required",
      "LOCALSTACK_AUTH_TOKEN is required for this operation."
    );
  }
  return null;
};

export const runPreflights = async (
  checks: Array<ToolResponse | null | Promise<ToolResponse | null>>
): Promise<ToolResponse | null> => {
  const results = await Promise.all(checks.map((check) => Promise.resolve(check)));
  return results.find((r) => r !== null) || null;
};

export const requireLocalStackRunning = async (): Promise<ToolResponse | null> => {
  // Provenance-agnostic gate: probe the gateway directly instead of looking for a
  // specific container, so an externally managed runtime that is healthy and
  // reachable is not falsely reported as "not running".
  const health = await getGatewayHealth();
  if (!health.reachable) {
    return ResponseBuilder.error(
      "LocalStack Not Running",
      `LocalStack is not reachable at ${LOCALSTACK_BASE_URL}. Start it with the localstack-management tool (action: start) and try again. ` +
        `If it is running on a non-default host or port, set LOCALSTACK_HOSTNAME / LOCALSTACK_PORT for the MCP server.`
    );
  }
  return null;
};
