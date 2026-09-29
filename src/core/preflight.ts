import { ensureSnowflakeCli, getGatewayHealth } from "../lib/localstack/localstack.utils";
import { DockerApiClient } from "../lib/docker/docker.client";
import { checkProFeature, ProFeature } from "../lib/localstack/license-checker";
import {
  stackFromEdition,
  stackFromImage,
  type LocalStackStack,
} from "../lib/localstack/container-spec.logic";
import { LOCALSTACK_BASE_URL } from "./config";
import { ResponseBuilder } from "./response-builder";
import { BootstrapError, ConfigDirInUseError } from "../lib/azure/bootstrap";
import { getAzureEmulatorStatus } from "../lib/azure/emulator";
import { AzResolveError } from "../lib/azure/resolve-az";
import { azCli, azureConfig, ensureProfile, recordEmulatorSession } from "../lib/azure/services";

type ToolResponse = ReturnType<typeof ResponseBuilder.error>;

const STACK_LABELS: Record<LocalStackStack, string> = {
  aws: "AWS",
  snowflake: "Snowflake",
  azure: "Azure",
};

const STACK_CLIENT_TOOLS: Record<LocalStackStack, string> = {
  aws: "localstack-aws-client",
  snowflake: "localstack-snowflake-client",
  azure: "localstack-azure-client",
};

/**
 * Whether the Snowflake emulator's health `edition` tells it apart from AWS.
 * It does not: localstack/snowflake:latest reports `pro`, as AWS does (checked 2026-09-28).
 * So the Snowflake client's guard refuses only on clear evidence (a Snowflake image that
 * reports `pro` is never turned away), and requireStack names the stack from the image.
 */
const SNOWFLAKE_EDITION_CONFIRMED = false;

const STACK_DETECTION_CACHE_MS = 2000;
const detectionCache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Reset the 2 s stack-detection cache (tests). */
export function resetStackDetectionCache(): void {
  detectionCache.clear();
}

/** Share one detection between the parallel preflights of a call. */
function cachedDetection<T>(key: string, detect: () => Promise<T>): Promise<T> {
  const hit = detectionCache.get(key);
  if (hit && Date.now() - hit.at < STACK_DETECTION_CACHE_MS) return hit.value as Promise<T>;
  const value = detect();
  detectionCache.set(key, { at: Date.now(), value });
  return value;
}

interface ContainerStack {
  stack?: LocalStackStack;
  image?: string;
}

/** The running container's stack from its image and labels (empty when unknown). */
function detectContainerStack(): Promise<ContainerStack> {
  return cachedDetection("container", async () => {
    try {
      const docker = new DockerApiClient();
      const metadata = await docker.inspectContainer(await docker.findLocalStackContainer());
      return { stack: stackFromImage(metadata.image, metadata.labels), image: metadata.image };
    } catch {
      return {};
    }
  });
}

/**
 * Refuse a tool that meets the wrong emulator.
 *
 * The stack comes from the gateway's health `edition`, then from the running
 * container's image and labels. When it is still unknown, the check passes
 * (fail-open), so externally managed or remote setups keep working. An unreachable
 * gateway also passes: `requireLocalStackRunning()` reports that case.
 */
export const requireStack = async (
  expected: LocalStackStack,
  toolName: string,
  opts: { baseUrl?: string; hint?: string } = {}
): Promise<ToolResponse | null> => {
  const baseUrl = opts.baseUrl ?? LOCALSTACK_BASE_URL;
  const health = await cachedDetection(`health:${baseUrl}`, () => getGatewayHealth(opts.baseUrl));
  if (!health.reachable) return null;

  let actual = stackFromEdition(health.edition);
  let container: ContainerStack | undefined;
  if (!actual) {
    container = await detectContainerStack();
    actual = container.stack;
  }
  // The Snowflake emulator's health reports edition `pro` too, so an
  // AWS reading is checked against the running container's image before it is named.
  if (actual === "aws" && expected !== "aws") {
    container = container ?? (await detectContainerStack());
    if (container.stack === "snowflake") actual = "snowflake";
  }
  if (!actual || actual === expected) return null;

  if (expected === "snowflake" && !SNOWFLAKE_EDITION_CONFIRMED && actual === "aws") {
    container = container ?? (await detectContainerStack());
    if (!container.image || /\/snowflake(:|@|$)/.test(container.image)) return null;
  }

  return ResponseBuilder.error(
    "Wrong emulator for this tool",
    `\`${toolName}\` works with the LocalStack ${STACK_LABELS[expected]} emulator, but the emulator at ` +
      `${baseUrl} is LocalStack ${STACK_LABELS[actual]}. Use \`${STACK_CLIENT_TOOLS[actual]}\`, or stop it ` +
      `and start the ${STACK_LABELS[expected]} emulator with \`localstack-management\` ` +
      `(action: start, service: ${expected}).` +
      (opts.hint ? `\n\n${opts.hint}` : "")
  );
};

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
  /**
   * Probe the gateway directly instead of looking for a
   * specific container, so an externally managed runtime that is healthy and
   * reachable is not falsely reported as "not running".
   */
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

// ---------------------------------------------------------------------------
// The Azure client. The handler runs them in the order of plan
// section 5.2: the config and the policy first (no emulator needed), then
// requireStack("azure"), requireAzureEmulatorRunning() and requireAzureCli() as one
// group, then the bootstrap.
// ---------------------------------------------------------------------------

/** Hard configuration errors (a remote endpoint, a config dir inside ~/.azure, ...). */
export const requireAzureConfig = (): ToolResponse | null => {
  const { errors } = azureConfig();
  if (!errors.length) return null;
  return ResponseBuilder.error(
    "Azure Tool Configuration Error",
    errors.map((e) => `- ${e}`).join("\n")
  );
};

export const requireAzureEmulatorRunning = async (): Promise<ToolResponse | null> => {
  const status = await getAzureEmulatorStatus(azureConfig());
  recordEmulatorSession(status.sessionId);
  return status.ok
    ? null
    : ResponseBuilder.error("LocalStack Azure Emulator Not Ready", status.message);
};

/** Resolves and probes `az` once per process (~0.17 s); the minimum is 2.85. */
export const requireAzureCli = async (): Promise<ToolResponse | null> => {
  try {
    await azCli();
    return null;
  } catch (error) {
    if (error instanceof AzResolveError) {
      const skipped = error.reasons.length
        ? `\n\nSkipped candidates:\n${error.reasons.map((r) => `- ${r}`).join("\n")}`
        : "";
      return ResponseBuilder.error("Azure CLI Not Available", error.message + skipped);
    }
    return ResponseBuilder.error(
      "Azure CLI Not Available",
      error instanceof Error ? error.message : String(error)
    );
  }
};

/**
 * Bootstraps the isolated CLI profile under its locks. A failed
 * `az` step is an az failure, so the caller formats it with the error classes.
 */
export const requireAzureCliConfigured = async (
  formatBootstrapFailure: (error: BootstrapError) => ToolResponse
): Promise<ToolResponse | null> => {
  try {
    await ensureProfile();
    return null;
  } catch (error) {
    if (error instanceof BootstrapError) return formatBootstrapFailure(error);
    if (error instanceof ConfigDirInUseError) {
      return ResponseBuilder.error("Azure CLI Profile In Use", error.message);
    }
    return ResponseBuilder.error(
      "Azure CLI Profile Setup Failed",
      error instanceof Error ? error.message : String(error)
    );
  }
};
