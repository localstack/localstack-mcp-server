import { z } from "zod";
import { type InferSchema, type PromptMetadata } from "xmcp";
import { withPromptAnalytics } from "../core/analytics";

export const schema = {
  iac_path: z
    .string()
    .optional()
    .describe(
      "(Optional) Path to a CloudFormation, Terraform, CDK, or SAM project. When provided, the advisor parses the template and checks every required operation automatically."
    ),
  services: z
    .string()
    .optional()
    .describe(
      "(Optional) Comma-separated AWS service names to check in full (e.g. 's3,lambda,dynamodb'). Use when you want per-service detail without a template."
    ),
  operations: z
    .string()
    .optional()
    .describe(
      "(Optional) Comma-separated 'service:Operation' pairs to check directly (e.g. 's3:CreateBucket,iam:CreateRole'). Overrides auto-extraction when provided."
    ),
  mode: z
    .string()
    .optional()
    .describe(
      "(Optional) 'summary' (default) shows only gaps and a deploy verdict; 'full' lists every implemented and missing operation."
    ),
};

export const metadata: PromptMetadata = {
  name: "coverage-advisor",
  title: "Coverage Advisor",
  description:
    "Check LocalStack API coverage for an IaC template, a list of services, or specific operations — and get a clear deploy-readiness verdict.",
  role: "user",
};

type PromptArgs = InferSchema<typeof schema>;

export default async function coverageAdvisor(args: PromptArgs): Promise<string> {
  return withPromptAnalytics(metadata.name, args, async () => {
    const values = {
      iac_path: args.iac_path?.trim() ?? "",
      services: args.services?.trim() ?? "",
      operations: args.operations?.trim() ?? "",
      mode: normalize(args.mode, "summary"),
    };
    return renderCoverageAdvisorPrompt(values);
  });
}

function normalize(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v && v.length > 0 ? v : fallback;
}

function renderCoverageAdvisorPrompt(values: {
  iac_path: string;
  services: string;
  operations: string;
  mode: string;
}): string {
  const hasIac = values.iac_path.length > 0;
  const hasServices = values.services.length > 0;
  const hasOperations = values.operations.length > 0;

  return `# LocalStack Coverage Check

## OUTPUT RULE — follow exactly

Call the tool, then copy its output **verbatim** into your response. No preamble, no summary, no extra analysis, no rephrasing. Your entire response is the raw tool output followed by the patch offer (see below).

## What to call

Use only the \`mcp__localstack__localstack-coverage-advisor\` tool.

${hasOperations
  ? `Split \`${values.operations}\` on commas and call \`check_operations\` with the resulting array.`
  : hasIac
  ? `Call \`scan_iac\` with \`iac_path: "${values.iac_path}"\`. Do not read the files yourself.`
  : hasServices
  ? `Call \`get_service_coverage\` once for each service in \`${values.services}\` (split on commas).`
  : `Call \`scan_iac\` with the workspace root as \`iac_path\`. If the tool returns "No resource types found", ask the user: "I didn't find any IaC files in <path> — where is your Terraform project?"`}

${hasIac && !hasOperations ? `If the template has more than 50 resource types, chunk \`check_resources\` into batches of 50 and concatenate the outputs.` : ""}

## After showing the verdict

If the scan found **any blockers** and the project is Terraform, append exactly this line after the tool output:

> Want me to patch this so it deploys on LocalStack? I'll gate the unsupported resources with \`count = 0\` and add the LocalStack provider config — shown as a diff before anything is changed.

If the user says yes, call \`patch_iac\` with the same \`iac_path\`.

## Absolute prohibitions

- Do NOT read IaC files yourself. The tool does this — call the tool.
- Do NOT add a "LocalStack Tier" column or any tier/edition labels (Community, Pro, etc.).
- Do NOT add file paths or line numbers.
- Do NOT add risk labels, impact descriptions, or percentages.
- Do NOT rewrite, rename, reformat, or reorder any table row.
- Do NOT add any text before the tool output other than the patch offer line above.`;
}
