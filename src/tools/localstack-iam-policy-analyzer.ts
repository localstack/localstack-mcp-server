import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { LocalStackLogRetriever, type LogEntry } from "../lib/logs/log-retriever";
import { ProFeature } from "../lib/localstack/license-checker";
import { httpClient, HttpError } from "../core/http-client";
import { IAM_CONFIG_ENDPOINT } from "../core/config";
import {
  enrichWithResourceData,
  deduplicatePermissions,
  generateIamPolicy,
  formatPolicyReport,
} from "../lib/iam/iam-policy.logic";
import {
  runPreflights,
  requireAuthToken,
  requireLocalStackRunning,
  requireProFeature,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";

export const schema = {
  action: z
    .enum(["set-mode", "analyze-policies", "get-status"])
    .describe(
      "The action to perform: 'set-mode' to configure enforcement, 'analyze-policies' to generate a policy from logs, or 'get-status' to check the current mode."
    ),
  mode: z
    .enum(["ENFORCED", "SOFT_MODE", "DISABLED"])
    .optional()
    .describe("The enforcement mode to set. This is required only when the action is 'set-mode'."),
};

export const metadata: ToolMetadata = {
  name: "localstack-iam-policy-analyzer",
  description:
    "Configures LocalStack's IAM enforcement and analyzes logs to generate missing IAM policies. For IAM, localstack-app-inspector is recommended instead (list-iam-denials, explain-iam, get-auto-derived-iam-policies, get-iam-mode, set-iam-mode): it reads LocalStack's structured IAM data and shows the policies that decided a request, including another account's, and LocalStack's suggested fix.",
  annotations: {
    title: "LocalStack IAM Policy Analyzer",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

// Using centralized IAM config endpoint from core/config

interface IamConfigResponse {
  state: string;
  [key: string]: any;
}

export default async function localstackIamPolicyAnalyzer({
  action,
  mode,
}: InferSchema<typeof schema>) {
  return withToolAnalytics("localstack-iam-policy-analyzer", { action, mode }, async () =>
    withRecommendation(action, await runAction(action, mode))
  );
}

/** The `localstack-app-inspector` action recommended for the job of each action */
export const RECOMMENDED_ALTERNATIVES: Record<string, string> = {
  "get-status": "`localstack-app-inspector` with action `get-iam-mode`",
  "set-mode": "`localstack-app-inspector` with action `set-iam-mode`",
  "analyze-policies":
    "`localstack-app-inspector` with actions `list-iam-denials` and `explain-iam` (why a request was denied and LocalStack's suggested fix), or `get-auto-derived-iam-policies` (least-privilege policies derived from a run)",
};

/**
 * Recommends the app-inspector action for the same job after every response. Whether to deprecate this tool is a
 * pending product decision; until then it works unchanged and only recommends.
 */
export function withRecommendation<T extends { content: Array<{ type: string; text: string }> }>(
  action: string,
  response: T
): T {
  const alternative = RECOMMENDED_ALTERNATIVES[action] ?? "`localstack-app-inspector`";
  const notice = `\n\n---\n💡 **Recommended:** ${alternative}, which reads LocalStack's structured IAM data instead of its log.`;
  const [first, ...rest] = response.content;
  if (!first) return response;
  return { ...response, content: [{ ...first, text: first.text + notice }, ...rest] };
}

async function runAction(
  action: InferSchema<typeof schema>["action"],
  mode: InferSchema<typeof schema>["mode"]
) {
  const preflightError = await runPreflights([
    requireAuthToken(),
    requireLocalStackRunning(),
    requireProFeature(ProFeature.IAM_ENFORCEMENT),
  ]);
  if (preflightError) return preflightError;

  switch (action) {
    case "get-status":
      return await handleGetStatus();
    case "set-mode":
      if (!mode) {
        return ResponseBuilder.error(
          "Missing Required Parameter",
          `The 'mode' parameter is required when using 'set-mode' action.

Valid modes:
- **ENFORCED**: Strict IAM enforcement (blocks unauthorized actions)
- **SOFT_MODE**: Log IAM violations without blocking
- **DISABLED**: Turn off IAM enforcement completely`
        );
      }
      return await handleSetMode(mode);
    case "analyze-policies":
      return await handleAnalyzePolicies();
    default:
      return ResponseBuilder.error(
        "Unknown action",
        `Unknown action: ${action}. Supported actions: get-status, set-mode, analyze-policies`
      );
  }
}

async function handleGetStatus() {
  try {
    const response = await httpClient.request<IamConfigResponse>(IAM_CONFIG_ENDPOINT, {
      method: "GET",
    });
    const currentState = response.state || "UNKNOWN";
    let statusEmoji = "⚠️";
    let statusDescription = "";
    switch (currentState) {
      case "ENFORCED":
        statusEmoji = "🔒";
        statusDescription =
          "Strict IAM enforcement is active. Unauthorized actions will be blocked.";
        break;
      case "SOFT_MODE":
        statusEmoji = "📝";
        statusDescription =
          "IAM violations are logged but not blocked. Good for testing and policy development.";
        break;
      case "DISABLED":
        statusEmoji = "🔓";
        statusDescription = "IAM enforcement is disabled. All actions are permitted.";
        break;
      default:
        statusDescription = `Unknown state: ${currentState}`;
    }
    return ResponseBuilder.markdown(`${statusEmoji} **LocalStack IAM Enforcement Status**

**Current Mode:** \`${currentState}\`

${statusDescription}

**Available Actions:**
- Use \`set-mode\` to change enforcement mode
- Use \`analyze-policies\` to generate policies from recent IAM denials`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return ResponseBuilder.markdown(`⚠️ **LocalStack IAM Configuration Not Available**

This could mean:
- LocalStack is not running
- LocalStack version doesn't support IAM configuration
- IAM enforcement is not available in your LocalStack version

Please ensure LocalStack is running and supports IAM enforcement.`);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.markdown(`❌ **Failed to Get IAM Status**

Error: ${errorMessage}

**Troubleshooting:**
- Ensure LocalStack is running on port 4566
- Check if your LocalStack version supports IAM enforcement
- Verify network connectivity to LocalStack`);
  }
}

async function handleSetMode(mode: "ENFORCED" | "SOFT_MODE" | "DISABLED") {
  try {
    const payload = { state: mode };
    await httpClient.request(IAM_CONFIG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let nextStepGuidance = "";
    let modeEmoji = "⚙️";

    switch (mode) {
      case "ENFORCED":
        modeEmoji = "🔒";
        nextStepGuidance = `
**🎯 Next Step:** Now, run your application, deployment, or tests that are failing due to permissions.

Once you have triggered the errors, ask me to "**analyze the IAM policies**" to automatically generate the required permissions.

**Example workflow:**
1. Deploy your CDK/Terraform stack
2. Run your application tests
3. Use \`analyze-policies\` action to generate missing IAM policies`;
        break;
      case "SOFT_MODE":
        modeEmoji = "📝";
        nextStepGuidance = `
**🎯 Next Step:** Run your application to log IAM violations without blocking them.

This mode is perfect for:
- Understanding what permissions your app needs
- Testing policy changes safely
- Gradual migration to stricter IAM enforcement`;
        break;
      case "DISABLED":
        modeEmoji = "🔓";
        nextStepGuidance = `
**Note:** IAM enforcement is now disabled. All AWS actions will be permitted regardless of policies.`;
        break;
    }

    return ResponseBuilder.markdown(`${modeEmoji} **IAM Enforcement Mode Updated**

✅ IAM enforcement mode has been set to \`${mode}\`.

${nextStepGuidance}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.markdown(`❌ **Failed to Set IAM Mode**

Error: ${errorMessage}

**Troubleshooting:**
- Ensure LocalStack is running on port 4566
- Check if your LocalStack version supports IAM configuration
- Verify you have permission to modify LocalStack settings`);
  }
}

async function handleAnalyzePolicies() {
  try {
    const logRetriever = new LocalStackLogRetriever();
    const logResult = await logRetriever.retrieveLogs(5000);

    if (!logResult.success) {
      return ResponseBuilder.markdown(`❌ **Failed to Retrieve Logs**

${logResult.errorMessage}

Please ensure LocalStack is running and generating logs.`);
    }

    const iamDenials = logResult.logs.filter((log) => log.isIamDenial === true);

    if (iamDenials.length === 0) {
      return ResponseBuilder.markdown(`✅ **Analysis Complete - No IAM Denials Found**

No IAM permission errors were found in the recent logs.

**This means either:**
- Your application has all necessary permissions
- IAM enforcement is not active (check with \`get-status\`)
- No recent activity has triggered permission checks
- IAM denials occurred outside the analyzed log window

**Next steps:**
- If you expected to see denials, ensure IAM enforcement is in \`ENFORCED\` or \`SOFT_MODE\`
- Try running your application again to generate fresh logs
- Increase the log analysis window if needed`);
    }

    const enrichedDenials = await enrichWithResourceData(iamDenials, logResult.logs);
    const uniquePermissions = deduplicatePermissions(enrichedDenials);
    const iamPolicy = generateIamPolicy(uniquePermissions);

    return formatPolicyReport(enrichedDenials, uniquePermissions, iamPolicy);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.markdown(`❌ **Policy Analysis Failed**

Error: ${errorMessage}

Please ensure LocalStack is running and check the logs for more details.`);
  }
}
