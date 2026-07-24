import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  runPreflights,
  requireLocalStackRunning,
  requireProFeature,
  requireAuthToken,
  requireDockerDaemon,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";
import { withToolAnalytics } from "../core/analytics";
import { DockerApiClient } from "../lib/docker/docker.client";
import {
  recreateRunningContainer,
  restartRuntimeInPlace,
} from "../lib/localstack/localstack.utils";
import {
  EXTENSIONS_MANAGER_COMMAND,
  EXTENSIONS_VENV_REPAIR_SCRIPT,
  formatInstalledExtensions,
  parseExtensionEvents,
  parseInstalledExtensions,
  summarizeInstall,
  summarizeUninstall,
  validateExtensionTarget,
  type ExtensionOutcome,
} from "../lib/localstack/extensions.logic";
import { PlatformApiClient, describePlatformError } from "../lib/localstack/platform.client";

const EXTENSION_EXEC_TIMEOUT_MS = 120000;

export const schema = {
  action: z
    .enum(["list", "install", "uninstall", "available"])
    .describe(
      "list = installed extensions; install = install an extension; uninstall = remove an extension; available = browse the marketplace/extensions library"
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Extension package name (e.g. 'localstack-extension-typedb' or 'localstack-extension-typedb==1.0.0'). Required for install and uninstall actions."
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Git URL to install from (e.g. 'git+https://github.com/org/repo.git'). Use this instead of name when installing from a repository."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-extensions",
  description: "Install, uninstall, list, and discover LocalStack Extensions from the marketplace",
  annotations: {
    title: "LocalStack Extensions",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function localstackExtensions({
  action,
  name,
  source,
}: InferSchema<typeof schema>) {
  return withToolAnalytics("localstack-extensions", { action, name, source }, async () => {
    // `available` only needs the platform API; the container-touching actions need a
    // running LocalStack (the extension manager runs inside it) + the Docker daemon.
    const checks =
      action === "available"
        ? [requireAuthToken()]
        : [
            requireAuthToken(),
            requireDockerDaemon(),
            requireLocalStackRunning(),
            requireProFeature(ProFeature.EXTENSIONS),
          ];

    const preflightError = await runPreflights(checks);
    if (preflightError) return preflightError;

    switch (action) {
      case "list":
        return await handleList();
      case "install":
        return await handleInstall(name, source);
      case "uninstall":
        return await handleUninstall(name);
      case "available":
        return await handleAvailable();
      default:
        return ResponseBuilder.error("Unknown action", `Unsupported action: ${action}`);
    }
  });
}

/**
 * Run the extension manager module inside the running LocalStack container. The
 * manager pip-installs into the extensions venv on /var/lib/localstack.
 */
async function runExtensionManager(args: string[], { repairVenv = false } = {}) {
  const docker = new DockerApiClient();
  const containerId = await docker.findLocalStackContainer();
  if (repairVenv) {
    const repair = await docker.executeInContainer(
      containerId,
      ["sh", "-c", EXTENSIONS_VENV_REPAIR_SCRIPT],
      undefined,
      {
        env: ["DEBUG=0"],
        timeoutMs: EXTENSION_EXEC_TIMEOUT_MS,
      }
    );
    if (repair.exitCode !== 0) {
      // e.g. a custom image where the extension manager's interpreter lives at a
      // different path — fail with the real cause instead of letting the manager
      // produce an unrelated-looking error later.
      const detail = repair.stderr || repair.stdout || `exit code ${repair.exitCode}`;
      throw new Error(`the extensions environment could not be prepared: ${detail}`);
    }
  }
  return await docker.executeInContainer(
    containerId,
    [...EXTENSIONS_MANAGER_COMMAND, ...args],
    undefined,
    { env: ["DEBUG=0"], timeoutMs: EXTENSION_EXEC_TIMEOUT_MS }
  );
}

function outcomeSummaryBlock(outcome: ExtensionOutcome): string {
  return outcome.summaryLines.length
    ? `\n\n\`\`\`\n${outcome.summaryLines.join("\n")}\n\`\`\``
    : "";
}

/**
 * Activate an install/uninstall by restarting the runtime. Prefer the fast in-place
 * restart; if it doesn't confirm (the in-place path can leave the runtime down under
 * heavy Lambda load), fall back to a full container recreate — which is reliable — so
 * the caller never ends up with a silently-dead stack.
 */
async function activationSuffix(): Promise<string> {
  const restart = await restartRuntimeInPlace();
  if (restart.ok) {
    return "\n\nLocalStack was restarted to activate the change. ✅";
  }

  const recreate = await recreateRunningContainer();
  const recreatedOk = !recreate.content[0]?.text?.trimStart().startsWith("❌");
  if (recreatedOk) {
    return "\n\nThe in-place restart did not confirm, so LocalStack was recreated to activate the change. ✅";
  }
  return (
    `\n\n⚠️ Could not confirm LocalStack restarted to activate the change (${restart.detail}) ` +
    "and the recreate fallback also did not confirm. Check LocalStack status and restart it with the management tool."
  );
}

async function handleList() {
  let result;
  try {
    result = await runExtensionManager(["list"]);
  } catch (error) {
    return ResponseBuilder.error(
      "List Failed",
      `Could not run the extension manager in the LocalStack container: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const extensions = parseInstalledExtensions(result.stdout);
  if (extensions.length === 0 && result.exitCode !== 0) {
    return ResponseBuilder.error(
      "List Failed",
      result.stderr || result.stdout || "Failed to list installed extensions."
    );
  }

  return ResponseBuilder.markdown(formatInstalledExtensions(extensions));
}

async function handleInstall(name?: string, source?: string) {
  const hasName = !!name;
  const hasSource = !!source;
  if ((hasName && hasSource) || (!hasName && !hasSource)) {
    return ResponseBuilder.error(
      "Invalid Parameters",
      "Provide either `name` or `source` for install, but not both."
    );
  }

  const validationError = validateExtensionTarget({ name, source });
  if (validationError) {
    return ResponseBuilder.error("Invalid Extension Target", validationError);
  }

  const target = source || name!;
  let result;
  try {
    result = await runExtensionManager(["install", target], { repairVenv: true });
  } catch (error) {
    return ResponseBuilder.error(
      "Install Failed",
      `Could not run the extension manager in the LocalStack container: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const outcome = summarizeInstall(parseExtensionEvents(result.stdout));

  if (outcome.kind === "not-found") {
    return ResponseBuilder.error(
      "Extension Not Found",
      `Could not resolve the extension package '${target}'. Please verify it exists on PyPI, or provide a git repository URL using the source parameter.`
    );
  }
  if (!outcome.success) {
    return ResponseBuilder.error(
      "Install Failed",
      `${outcome.errorDetail || "Extension installation failed."}${outcomeSummaryBlock(outcome)}`
    );
  }

  if (outcome.kind === "already-installed") {
    return ResponseBuilder.markdown(
      `## Extension Installation Result${outcomeSummaryBlock(outcome)}\n\nThe extension is already installed — no restart needed.`
    );
  }

  const restartNote = await activationSuffix();
  return ResponseBuilder.markdown(
    `## Extension Installation Result${outcomeSummaryBlock(outcome)}${restartNote}`
  );
}

async function handleUninstall(name?: string) {
  if (!name) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `uninstall` action requires the `name` parameter to be specified."
    );
  }

  const validationError = validateExtensionTarget({ name });
  if (validationError) {
    return ResponseBuilder.error("Invalid Extension Target", validationError);
  }

  let result;
  try {
    result = await runExtensionManager(["uninstall", name], { repairVenv: true });
  } catch (error) {
    return ResponseBuilder.error(
      "Uninstall Failed",
      `Could not run the extension manager in the LocalStack container: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const outcome = summarizeUninstall(parseExtensionEvents(result.stdout));

  if (outcome.kind === "not-installed") {
    return ResponseBuilder.error(
      "Extension Not Installed",
      outcome.errorDetail || `Extension '${name}' is not installed.`
    );
  }
  if (!outcome.success) {
    return ResponseBuilder.error(
      "Uninstall Failed",
      `${outcome.errorDetail || "Extension uninstallation failed."}${outcomeSummaryBlock(outcome)}`
    );
  }

  const restartNote = await activationSuffix();
  return ResponseBuilder.markdown(
    `## Extension Uninstall Result${outcomeSummaryBlock(outcome)}${restartNote}`
  );
}

async function handleAvailable() {
  const token = process.env.LOCALSTACK_AUTH_TOKEN!;
  const client = new PlatformApiClient(token);

  try {
    const marketplace = await client.getExtensionsMarketplace();

    const simplified = marketplace.map((item) => ({
      name: item.name || "unknown-extension",
      summary: item.summary || item.description || "No summary provided.",
      author: item.author || "Unknown",
      version: item.version || "Unknown",
    }));

    let markdown = `# LocalStack Extensions Marketplace\n\n${simplified.length} extensions available. Install any with the \`install\` action.\n\n---`;
    for (const extension of simplified) {
      markdown += `\n\n### ${extension.name}\n**Author:** ${extension.author} | **Version:** ${extension.version}\n${extension.summary}\n\n---`;
    }

    return ResponseBuilder.markdown(markdown);
  } catch (error) {
    return ResponseBuilder.error(
      "Marketplace Fetch Failed",
      describePlatformError(error, "the extensions marketplace")
    );
  }
}
