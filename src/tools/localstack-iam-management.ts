import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  runPreflights,
  requireAuthToken,
  requireLocalStackRunning,
  requireProFeature,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature } from "../lib/localstack/license-checker";
import { IamApiClient } from "../lib/localstack/localstack.client";
import {
  DERIVED_POLICIES_UNAVAILABLE,
  IAM_MODES,
  renderEnforcementChange,
  renderEnforcementUnchanged,
  renderErrorBody,
} from "../lib/iam/iam-actions.logic";
import { formatIamConfigError } from "../lib/iam/iam-errors";

export const schema = {
  action: z
    .enum(["set-enforcement", "reset-derived-policies"])
    .describe(
      "IAM changes in LocalStack. set-enforcement sets the IAM mode and reports the previous one and how to restore it. reset-derived-policies clears the policies LocalStack derived from the requests it saw (every principal, cannot be undone), to start a fresh window before a least-privilege run. Reads are in localstack-iam."
    ),
  mode: z
    .enum(IAM_MODES)
    .optional()
    .describe(
      "set-enforcement only. ENFORCED: denied requests fail, as on AWS. SOFT_MODE: they are allowed and logged. ENGINE_ONLY: evaluated without rejecting or logging; App Inspector still records denials. DISABLED: nothing is evaluated or recorded. Lowering the mode fixes no policy."
    ),
};

export type IamManagementArgs = InferSchema<typeof schema>;

export const metadata: ToolMetadata = {
  name: "localstack-iam-management",
  description:
    "Change LocalStack's IAM behaviour: set the IAM enforcement mode, or reset the derived least-privilege policies. Every change reports what it replaced. To diagnose denials, use localstack-iam.",
  annotations: {
    title: "LocalStack IAM Management",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export default async function localstackIamManagement(params: IamManagementArgs) {
  return withToolAnalytics(
    "localstack-iam-management",
    { action: params.action, mode: params.action === "set-enforcement" ? params.mode : undefined },
    async () => {
      if (params.action === "reset-derived-policies" && params.mode) {
        return ResponseBuilder.error(
          "Invalid Parameter",
          "`mode` is not a parameter of reset-derived-policies; it belongs to `set-enforcement`."
        );
      }
      const preflightError = await runPreflights([
        requireAuthToken(),
        requireLocalStackRunning(),
        requireProFeature(
          params.action === "set-enforcement" ? ProFeature.IAM_ENFORCEMENT : ProFeature.IAM_STREAM
        ),
      ]);
      if (preflightError) return preflightError;
      switch (params.action) {
        case "set-enforcement":
          return await handleSetEnforcement(params);
        case "reset-derived-policies":
          return await handleResetDerivedPolicies();
        default:
          return ResponseBuilder.error("Unknown action", `Unknown action: ${params.action}`);
      }
    }
  );
}

async function handleSetEnforcement(params: IamManagementArgs) {
  if (!params.mode) {
    return ResponseBuilder.error(
      "Missing Parameter",
      `\`mode\` is required for set-enforcement (${IAM_MODES.join(", ")}).`
    );
  }
  const client = new IamApiClient();
  const before = await client.getConfig();
  if (!before.success) return formatIamConfigError(before);
  const old = before.data?.state ?? "UNKNOWN";
  if (old.toUpperCase() === params.mode) {
    return ResponseBuilder.markdown(renderEnforcementUnchanged(old));
  }
  const result = await client.setMode(params.mode);
  if (!result.success) return formatIamConfigError(result);
  // Report the mode LocalStack reports now, not the one requested
  const after = await client.getConfig();
  if (!after.success) {
    return ResponseBuilder.markdown(
      `## IAM Enforcement Updated\n\nLocalStack accepted mode \`${params.mode}\`, but reading it back failed. Use \`localstack-iam\` \`get-enforcement\` to check. To restore: \`set-enforcement\` with mode \`${old}\`.`
    );
  }
  return ResponseBuilder.markdown(
    renderEnforcementChange({
      before: old,
      requested: params.mode,
      after: after.data?.state ?? "UNKNOWN",
    })
  );
}

async function handleResetDerivedPolicies() {
  const result = await new IamApiClient().resetPolicySummary();
  if (!result.success) {
    if (result.statusCode === 404) {
      return ResponseBuilder.error(
        "Derived IAM Policies Not Available",
        DERIVED_POLICIES_UNAVAILABLE
      );
    }
    return ResponseBuilder.error(
      result.statusCode ? `HTTP ${result.statusCode}` : "IAM API Error",
      renderErrorBody(result.message)
    );
  }
  return ResponseBuilder.markdown(
    "## Derived IAM Policies Reset\n\nCleared the derived policies of every principal in this LocalStack. This cannot be undone; they come back only by re-running the workload.\n\n**Next step:** re-run the workload, then `localstack-iam` `get-derived-policies`."
  );
}
