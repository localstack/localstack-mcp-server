import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { HttpClient, HttpError } from "../core/http-client";
import { runCommand, stripAnsiCodes } from "../core/command-runner";
import {
  runPreflights,
  requireLocalStackCli,
  requireLocalStackRunning,
  requireProFeature,
  requireAuthToken,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";

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

interface MarketplaceExtension {
  name?: string;
  summary?: string;
  description?: string;
  author?: string;
  version?: string;
}

export default async function localstackExtensions({
  action,
  name,
  source,
}: InferSchema<typeof schema>) {
  const checks = [
    requireAuthToken(),
    requireLocalStackCli(),
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
  
}

function cleanOutput(stdout: string, stderr: string) {
  return {
    stdout: stripAnsiCodes(stdout || "").trim(),
    stderr: stripAnsiCodes(stderr || "").trim(),
  };
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((part) => part.trim().length > 0).join("\n").trim();
}

async function handleList() {
  const cmd = await runCommand("localstack", ["extensions", "list"], {
    env: { ...process.env },
  });
  const cleaned = cleanOutput(cmd.stdout, cmd.stderr);
  const combined = combineOutput(cleaned.stdout, cleaned.stderr);
  const combinedLower = combined.toLowerCase();

  if (cmd.exitCode !== 0 && !combined) {
    return ResponseBuilder.error("List Failed", cleaned.stderr || "Failed to list installed extensions.");
  }

  const looksEmpty =
    !combined ||
    combinedLower.includes("no extensions installed") ||
    combinedLower.includes("no extension installed");
  if (looksEmpty) {
    return ResponseBuilder.markdown(
      "No LocalStack extensions are currently installed.\n\nUse the `available` action to browse the marketplace."
    );
  }

  return ResponseBuilder.markdown(`## Installed LocalStack Extensions\n\n\`\`\`\n${combined}\n\`\`\``);
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

  const target = source || name!;
  const cmd = await runCommand("localstack", ["extensions", "install", target], {
    env: { ...process.env },
    timeout: 120000,
  });
  const cleaned = cleanOutput(cmd.stdout, cmd.stderr);
  const combined = combineOutput(cleaned.stdout, cleaned.stderr);
  const combinedLower = combined.toLowerCase();

  if (combinedLower.includes("could not resolve package")) {
    return ResponseBuilder.error(
      "Extension Not Found",
      `Could not resolve the extension package '${name || target}'. Please verify it exists on PyPI, or provide a git repository URL using the source parameter.`
    );
  }

  if (combinedLower.includes("no module named 'localstack.pro'")) {
    return ResponseBuilder.error(
      "Auth Token Required",
      "LocalStack Pro modules are not available. Ensure LOCALSTACK_AUTH_TOKEN is set correctly and LocalStack is running with a valid license."
    );
  }

  if (
    combinedLower.includes("non-zero exit status") ||
    combinedLower.includes("returned non-zero")
  ) {
    return ResponseBuilder.error(
      "Install Failed",
      "The extension could not be installed from the provided source. The repository may not contain valid LocalStack extension code. Run the command again with --verbose for more details, or check that the repository contains a proper LocalStack extension."
    );
  }

  const hasSuccessPattern = combinedLower.includes("extension successfully installed");
  if (cmd.exitCode !== 0 && !hasSuccessPattern) {
    return ResponseBuilder.error("Install Failed", cleaned.stderr || "Extension installation failed.");
  }

  if (hasSuccessPattern || cmd.exitCode === 0) {
    const restartCmd = await runCommand("localstack", ["restart"], { timeout: 60000 });
    const restartCleaned = cleanOutput(restartCmd.stdout, restartCmd.stderr);
    const restartCombined = combineOutput(restartCleaned.stdout, restartCleaned.stderr);

    let response = `## Extension Installation Result\n\n\`\`\`\n${combined || "Extension successfully installed."}\n\`\`\`\n\n`;
    response += "LocalStack was restarted to activate the extension.";
    if (restartCombined) {
      response += `\n\n### Restart Output\n\n\`\`\`\n${restartCombined}\n\`\`\``;
    }
    if (restartCmd.exitCode !== 0) {
      response += "\n\n⚠️ Restart command reported an issue. Please verify LocalStack status.";
    }
    return ResponseBuilder.markdown(response);
  }

  return ResponseBuilder.error("Install Failed", cleaned.stderr || "Extension installation failed.");
}

async function handleUninstall(name?: string) {
  if (!name) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `uninstall` action requires the `name` parameter to be specified."
    );
  }

  const cmd = await runCommand("localstack", ["extensions", "uninstall", name], {
    env: { ...process.env },
    timeout: 60000,
  });
  const cleaned = cleanOutput(cmd.stdout, cmd.stderr);
  const combined = combineOutput(cleaned.stdout, cleaned.stderr);
  const combinedLower = combined.toLowerCase();

  if (combinedLower.includes("no module named 'localstack.pro'")) {
    return ResponseBuilder.error(
      "Auth Token Required",
      "LocalStack Pro modules are not available. Ensure LOCALSTACK_AUTH_TOKEN is set correctly and LocalStack is running with a valid license."
    );
  }

  const hasSuccessPattern = combinedLower.includes("extension successfully uninstalled");
  if (cmd.exitCode !== 0 && !hasSuccessPattern) {
    return ResponseBuilder.error("Uninstall Failed", cleaned.stderr || "Extension uninstallation failed.");
  }

  if (hasSuccessPattern || cmd.exitCode === 0) {
    const restartCmd = await runCommand("localstack", ["restart"], { timeout: 60000 });
    const restartCleaned = cleanOutput(restartCmd.stdout, restartCmd.stderr);
    const restartCombined = combineOutput(restartCleaned.stdout, restartCleaned.stderr);

    let response = `## Extension Uninstall Result\n\n\`\`\`\n${combined || "Extension successfully uninstalled."}\n\`\`\`\n\n`;
    response += "LocalStack was restarted to apply extension removal.";
    if (restartCombined) {
      response += `\n\n### Restart Output\n\n\`\`\`\n${restartCombined}\n\`\`\``;
    }
    if (restartCmd.exitCode !== 0) {
      response += "\n\n⚠️ Restart command reported an issue. Please verify LocalStack status.";
    }
    return ResponseBuilder.markdown(response);
  }

  return ResponseBuilder.error("Uninstall Failed", cleaned.stderr || "Extension uninstallation failed.");
}

async function handleAvailable() {
  const token = process.env.LOCALSTACK_AUTH_TOKEN!;

  const encoded = Buffer.from(`:${token}`).toString("base64");
  const client = new HttpClient();

  try {
    const marketplace = await client.request<MarketplaceExtension[]>(
      "https://api.localstack.cloud/v1/extensions/marketplace",
      {
        method: "GET",
        baseUrl: "",
        headers: {
          Authorization: `Basic ${encoded}`,
          Accept: "application/json",
        },
      }
    );

    if (!Array.isArray(marketplace)) {
      return ResponseBuilder.error("Marketplace Fetch Failed", "Unexpected marketplace response format.");
    }

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
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return ResponseBuilder.error(
        "Authentication Failed",
        "Could not fetch the marketplace. Ensure LOCALSTACK_AUTH_TOKEN is set correctly."
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.error("Marketplace Fetch Failed", message);
  }
}
