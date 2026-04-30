import { z } from "zod";
import { type InferSchema, type PromptMetadata } from "xmcp";
import { withPromptAnalytics } from "../core/analytics";

export const schema = {
  iac_path: z
    .string()
    .min(1)
    .describe("Path to the IaC root directory, e.g. ./infra, ./cdk, or ./terraform."),
  iac_type: z
    .string()
    .optional()
    .describe("IaC framework: cdk, terraform, sam, cloudformation, or auto. Defaults to auto."),
  test_language: z
    .string()
    .optional()
    .describe("Language for generated integration tests. Defaults to typescript."),
  test_framework: z
    .string()
    .optional()
    .describe("Test framework. Defaults from the test language, e.g. jest or pytest."),
  mode: z
    .string()
    .optional()
    .describe("validate-only runs deployment validation only; full also writes and runs tests."),
  services_focus: z
    .string()
    .optional()
    .describe("Comma-separated AWS services to focus on. Empty means all discovered services."),
};

export const metadata: PromptMetadata = {
  name: "infrastructure-tester",
  title: "Infrastructure Tester",
  description:
    "Deploy IaC to LocalStack, validate every resource, then write and run integration tests with trace-backed debugging.",
  role: "user",
};

type PromptArgs = InferSchema<typeof schema>;

export default async function infrastructureTester(args: PromptArgs): Promise<string> {
  return withPromptAnalytics(metadata.name, args, async () => {
    const values = {
      iac_path: args.iac_path,
      iac_type: normalize(args.iac_type, "auto"),
      test_language: normalize(args.test_language, "typescript"),
      test_framework: normalize(args.test_framework, defaultFrameworkFor(args.test_language)),
      mode: normalize(args.mode, "full"),
      services_focus: normalize(args.services_focus, "all discovered services"),
    };

    return renderInfrastructureTesterPrompt(values);
  });
}

function normalize(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function defaultFrameworkFor(language: string | undefined): string {
  switch (language?.trim().toLowerCase()) {
    case "python":
      return "pytest";
    case "java":
      return "junit";
    case "go":
      return "go-test";
    case "javascript":
    case "typescript":
    default:
      return "jest";
  }
}

function renderInfrastructureTesterPrompt(values: {
  iac_path: string;
  iac_type: string;
  test_language: string;
  test_framework: string;
  mode: string;
  services_focus: string;
}): string {
  return `# Infrastructure Tester (LocalStack)

You are an Infrastructure Tester operating against one running LocalStack instance. Deploy the IaC, prove the declared resources exist with matching configuration, then write and run integration tests until they pass or you can explain why they cannot.

## Inputs

- IaC path: \`${values.iac_path}\`
- IaC framework: \`${values.iac_type}\`
- Test language: \`${values.test_language}\`
- Test framework: \`${values.test_framework}\`
- Mode: \`${values.mode}\`
- Services in focus: \`${values.services_focus}\`

## Tool Discipline

Use the LocalStack MCP tools instead of guessing:
- \`localstack-management\` for runtime status and start/restart.
- \`localstack-deployer\` for CDK, Terraform, SAM, or CloudFormation deploy/destroy.
- \`localstack-aws-client\` for live \`awslocal\` resource probes.
- \`localstack-app-inspector\` for traces, spans, events, and IAM evaluation evidence.
- \`localstack-logs-analysis\` for container errors around deploy or test windows.
- \`localstack-docs\` for service coverage and LocalStack-specific limitations.

## Phase 0: Preflight

1. Check LocalStack status. Start it if it is not running; do not start a second container.
2. Detect the IaC framework if \`${values.iac_type}\` is \`auto\`: \`cdk.json\` means CDK, \`*.tf\` means Terraform, \`template.yaml\` plus SAM config means SAM, and CloudFormation templates mean CloudFormation.
3. Read the IaC and extract a resource graph: logical ID, resource type, key config, and dependencies/edges.

Report a short preflight summary before continuing.

## Phase 1: Deploy and Validate

1. Deploy \`${values.iac_path}\` with \`localstack-deployer\`.
2. If deploy fails, fetch recent logs, quote the real failure, and stop with status \`deploy-blocked\`.
3. For every declared resource, verify live state with \`localstack-aws-client\`. Compare the deployed configuration to the IaC declaration.
4. Use App Inspector traces for deployment API calls when available. A resource that appears present but has failed or missing create-call traces should be flagged for review.

Return this table:

| Resource | Type | Status | Evidence | Remediation |
| --- | --- | --- | --- | --- |
| \`Example\` | \`AWS::S3::Bucket\` | ready / partial / failed / unsupported | tool-backed proof | next action |

After the table, summarize whether Phase 2 should proceed. If mode is \`validate-only\`, stop after Phase 1.

## Phase 2: Write and Run Integration Tests

1. Plan tests from the resource graph: single-resource CRUD, cross-resource edges, and expected failure modes.
2. Generate deterministic tests in \`${values.test_language}\` using \`${values.test_framework}\`. Put them under \`tests/integration/\`.
3. Bake in LocalStack settings: endpoint \`http://localhost.localstack.cloud:4566\`, dummy AWS credentials, region from IaC or \`us-east-1\`, path-style S3, unique test resource names, and cleanup.
4. Run tests. On failure, correlate test time with logs and App Inspector traces, classify the cause, fix test code or IaC when appropriate, and retry up to three times.

## Final Report

Return:
- Readiness table from Phase 1.
- Per-test table with status, iterations, last error, and remediation.
- Headline counts: resources ready/partial/failed/unsupported, tests written, passed, failed, skipped.

Never hide real failures. If IaC is wrong, say so and propose the smallest fix. Ask before proceeding if the IaC framework is ambiguous or the stack has more than 50 declared resources.`;
}
