import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";

// ---------------------------------------------------------------------------
// Coverage extension REST client
// ---------------------------------------------------------------------------
function getCoverageUrl(): string {
  return (
    process.env.LOCALSTACK_COVERAGE_URL ??
    "http://localhost:4566/_extension/localstack-coverage"
  ).replace(/\/$/, "");
}

async function coverageFetch<T>(path: string, body?: unknown): Promise<T> {
  const url = `${getCoverageUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, body !== undefined ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    } : undefined);
  } catch {
    throw new Error(
      `LocalStack coverage extension unreachable at ${url}. ` +
      `Is LocalStack running with the localstack-extension-coverage extension installed?`
    );
  }
  if (!res.ok) {
    throw new Error(`Coverage API returned HTTP ${res.status} for ${path}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Friendly display names for common IaC resource types
// ---------------------------------------------------------------------------
export const FRIENDLY_NAMES: Record<string, string> = {
  // Terraform
  aws_sqs_queue: "SQS queue",
  aws_dynamodb_table: "DynamoDB table",
  aws_lambda_function: "Lambda function",
  aws_lambda_event_source_mapping: "Lambda event source mapping",
  aws_lambda_permission: "Lambda permission",
  aws_iam_role: "IAM role",
  aws_iam_policy: "IAM policy",
  aws_iam_role_policy: "IAM role policy",
  aws_iam_role_policy_attachment: "IAM role policy attachment",
  aws_s3_bucket: "S3 bucket",
  aws_s3_bucket_policy: "S3 bucket policy",
  aws_s3_object: "S3 object",
  aws_api_gateway_rest_api: "API Gateway REST API",
  aws_api_gateway_resource: "API Gateway resource",
  aws_api_gateway_method: "API Gateway method",
  aws_api_gateway_integration: "API Gateway integration",
  aws_api_gateway_deployment: "API Gateway deployment",
  aws_api_gateway_stage: "API Gateway stage",
  aws_api_gateway_authorizer: "API Gateway authorizer",
  aws_sns_topic: "SNS topic",
  aws_sns_topic_subscription: "SNS topic subscription",
  aws_ses_email_identity: "SES email identity",
  aws_ses_domain_identity: "SES domain identity",
  aws_secretsmanager_secret: "Secrets Manager secret",
  aws_secretsmanager_secret_version: "Secrets Manager secret version",
  aws_ssm_parameter: "SSM parameter",
  aws_cloudwatch_log_group: "CloudWatch log group",
  aws_cloudwatch_metric_alarm: "CloudWatch alarm",
  aws_cloudwatch_event_rule: "EventBridge rule",
  aws_cloudwatch_event_target: "EventBridge target",
  aws_pipes_pipe: "EventBridge Pipe",
  aws_sfn_state_machine: "Step Functions state machine",
  aws_ecr_repository: "ECR repository",
  aws_ecs_cluster: "ECS cluster",
  aws_ecs_task_definition: "ECS task definition",
  aws_ecs_service: "ECS service",
  aws_rds_cluster: "RDS cluster",
  aws_rds_instance: "RDS instance",
  aws_elasticache_cluster: "ElastiCache cluster",
  aws_kinesis_stream: "Kinesis stream",
  aws_kinesis_firehose_delivery_stream: "Kinesis Firehose delivery stream",
  aws_cognito_user_pool: "Cognito user pool",
  aws_cognito_user_pool_client: "Cognito user pool client",
  aws_route53_zone: "Route53 hosted zone",
  aws_route53_record: "Route53 record",
  aws_acm_certificate: "ACM certificate",
  aws_cloudfront_distribution: "CloudFront distribution",
  aws_cloudfront_origin_access_identity: "CloudFront origin access identity",
  aws_wafv2_web_acl: "WAFv2 web ACL",
  aws_media_convert_queue: "MediaConvert queue",
  aws_chimesdkvoice_sip_media_application: "Chime SDK voice SIP media app",
  aws_vpc: "VPC",
  aws_subnet: "Subnet",
  aws_security_group: "Security group",
  aws_internet_gateway: "Internet gateway",
  aws_elasticloadbalancingv2_load_balancer: "Application Load Balancer",
  aws_elasticloadbalancingv2_target_group: "ALB target group",
  aws_elasticloadbalancingv2_listener: "ALB listener",
  // CloudFormation / CDK
  "AWS::SQS::Queue": "SQS queue",
  "AWS::DynamoDB::Table": "DynamoDB table",
  "AWS::Lambda::Function": "Lambda function",
  "AWS::Lambda::EventSourceMapping": "Lambda event source mapping",
  "AWS::IAM::Role": "IAM role",
  "AWS::IAM::Policy": "IAM policy",
  "AWS::IAM::ManagedPolicy": "IAM managed policy",
  "AWS::S3::Bucket": "S3 bucket",
  "AWS::S3::BucketPolicy": "S3 bucket policy",
  "AWS::ApiGateway::RestApi": "API Gateway REST API",
  "AWS::ApiGateway::Resource": "API Gateway resource",
  "AWS::ApiGateway::Method": "API Gateway method",
  "AWS::ApiGateway::Deployment": "API Gateway deployment",
  "AWS::ApiGateway::Stage": "API Gateway stage",
  "AWS::SNS::Topic": "SNS topic",
  "AWS::SNS::Subscription": "SNS subscription",
  "AWS::SES::EmailIdentity": "SES email identity",
  "AWS::SecretsManager::Secret": "Secrets Manager secret",
  "AWS::SSM::Parameter": "SSM parameter",
  "AWS::Logs::LogGroup": "CloudWatch log group",
  "AWS::CloudWatch::Alarm": "CloudWatch alarm",
  "AWS::Events::Rule": "EventBridge rule",
  "AWS::Pipes::Pipe": "EventBridge Pipe",
  "AWS::StepFunctions::StateMachine": "Step Functions state machine",
  "AWS::ECR::Repository": "ECR repository",
  "AWS::ECS::Cluster": "ECS cluster",
  "AWS::ECS::TaskDefinition": "ECS task definition",
  "AWS::ECS::Service": "ECS service",
  "AWS::RDS::DBCluster": "RDS cluster",
  "AWS::RDS::DBInstance": "RDS instance",
  "AWS::Cognito::UserPool": "Cognito user pool",
  "AWS::Cognito::UserPoolClient": "Cognito user pool client",
  "AWS::Route53::HostedZone": "Route53 hosted zone",
  "AWS::Route53::RecordSet": "Route53 record",
  "AWS::CertificateManager::Certificate": "ACM certificate",
  "AWS::CloudFront::Distribution": "CloudFront distribution",
  "AWS::CloudFront::CloudFrontOriginAccessIdentity": "CloudFront OAI",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "Application Load Balancer",
  "AWS::ElasticLoadBalancingV2::TargetGroup": "ALB target group",
  "AWS::ElasticLoadBalancingV2::Listener": "ALB listener",
  // Pulumi
  "aws:sqs/queue:Queue": "SQS queue",
  "aws:dynamodb/table:Table": "DynamoDB table",
  "aws:lambda/function:Function": "Lambda function",
  "aws:iam/role:Role": "IAM role",
  "aws:iam/policy:Policy": "IAM policy",
  "aws:s3/bucket:Bucket": "S3 bucket",
  "aws:sns/topic:Topic": "SNS topic",
  "aws:cloudwatch/logGroup:LogGroup": "CloudWatch log group",
  "aws:sfn/stateMachine:StateMachine": "Step Functions state machine",
};

export function friendlyName(resourceType: string): string {
  return FRIENDLY_NAMES[resourceType] ?? resourceType;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const schema = {
  action: z
    .enum(["list_services", "get_service_coverage", "check_operations", "check_resources", "scan_iac", "patch_iac"])
    .describe(
      [
        "list_services — overview of all AWS services with their coverage percentage.",
        "get_service_coverage — full list of implemented and missing operations for one service.",
        "check_operations — given a list of 'service:Operation' pairs, report which are implemented and which are missing.",
        "check_resources — given a list of IaC resource type names (e.g. 'AWS::S3::Bucket', 'aws_lambda_function', 'aws:s3/bucket:Bucket'), look up their required operations from the coverage DB and report a per-resource deploy-readiness verdict.",
        "scan_iac — given a path to a Terraform, CloudFormation, CDK, Pulumi, or shell script project, read the files fresh from disk, extract all resource types and AWS CLI calls, and return a deploy-readiness verdict. Use this instead of reading files manually — it always reflects the current state of the files.",
        "patch_iac — given a path to a Terraform project, generate a unified diff that gates all blocking resources with 'count = 0' (marked # localstack-patch) and injects a LocalStack provider config. Terraform only. Show the diff to the user before applying.",
      ].join(" | ")
    ),

  service: z
    .string()
    .optional()
    .describe(
      "AWS service name (e.g. 's3', 'iam', 'lambda'). Required for get_service_coverage."
    ),

  operations: z
    .array(z.string())
    .optional()
    .describe(
      "List of 'service:Operation' pairs to check (e.g. ['s3:CreateBucket', 'iam:CreateRole']). Required for check_operations."
    ),

  resources: z
    .array(z.string())
    .optional()
    .describe(
      "List of IaC resource type names to check (e.g. ['AWS::S3::Bucket', 'aws_lambda_function', 'aws:sqs/queue:Queue']). Required for check_resources."
    ),

  iac_path: z
    .string()
    .optional()
    .describe(
      "Path to a Terraform, CloudFormation, CDK, Pulumi, or shell script project directory or file. Required for scan_iac. Files are read fresh from disk on every call. Shell scripts (.sh) with aws/awslocal CLI calls are also supported."
    ),
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: ToolMetadata = {
  name: "localstack-preflight",
  description:
    "Preflight coverage check — reads IaC files and queries the LocalStack coverage extension to report which AWS resources and API operations are supported. " +
    "Requires LocalStack to be running with the localstack-extension-coverage extension installed. " +
    "Does NOT deploy, run terraform, or install tools. " +
    "Use this BEFORE localstack-deployer whenever the user wants to know if their IaC is compatible with LocalStack. " +
    "Trigger phrases: 'will this work on localstack', 'will my IaC work', 'will this deploy on localstack', " +
    "'is this compatible with localstack', 'does localstack support this', " +
    "'check my terraform / stack / IaC', 'validate my terraform / stack / IaC', " +
    "'what won't work on localstack', 'what operations are missing', 'any blockers', " +
    "'preflight check', 'coverage check', 'localstack coverage'. " +
    "When the user asks without providing a path, infer the workspace root and pass it as iac_path to scan_iac. " +
    "If scan_iac returns no resources found, ask the user once: 'I didn't find any IaC files in <path> — where is your project?' " +
    "If the coverage extension is unreachable, tell the user: 'Install the localstack-extension-coverage extension and restart LocalStack. " +
    "You can override the endpoint with the LOCALSTACK_COVERAGE_URL environment variable.' " +
    "After showing the verdict, offer to patch the project so it deploys on LocalStack (Terraform only).",
  annotations: {
    title: "LocalStack Preflight",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Row = Record<string, string | number | null>;

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export default async function localstackCoverage({
  action,
  service,
  operations,
  resources,
  iac_path,
}: InferSchema<typeof schema>) {
  return withToolAnalytics(
    "localstack-preflight",
    { action, service },
    async () => {
      try {
        switch (action) {
          case "list_services":
            return await listServices();
          case "get_service_coverage":
            return await getServiceCoverage(service);
          case "check_operations":
            return await checkOperations(operations);
          case "check_resources":
            return await checkResources(resources);
          case "scan_iac":
            return await scanIac(iac_path);
          case "patch_iac":
            return await patchIac(iac_path);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return ResponseBuilder.error("Coverage unavailable", msg);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Action: list_services
// ---------------------------------------------------------------------------

async function listServices() {
  const { services: rows } = await coverageFetch<{ services: Row[] }>("/services");
  rows.sort((a, b) => pct(b.implemented as number, b.total as number) - pct(a.implemented as number, a.total as number));

  const total_ops = rows.reduce((s, r) => s + (r.total as number), 0);
  const total_impl = rows.reduce((s, r) => s + (r.implemented as number), 0);

  let md = `# LocalStack API Coverage\n\n`;
  md += `**${rows.length} services** | **${total_impl}/${total_ops} operations implemented** `;
  md += `(${pct(total_impl, total_ops)}%)\n\n`;
  md += `| Service | Implemented | Total | Coverage |\n`;
  md += `|---------|-------------|-------|----------|\n`;

  for (const r of rows) {
    const impl = r.implemented as number;
    const total = r.total as number;
    const bar = coverageEmoji(pct(impl, total));
    md += `| \`${r.service}\` | ${impl} | ${total} | ${bar} ${pct(impl, total)}% |\n`;
  }

  return ResponseBuilder.markdown(md);
}

// ---------------------------------------------------------------------------
// Action: get_service_coverage
// ---------------------------------------------------------------------------

async function getServiceCoverage(service: string | undefined) {
  if (!service) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`service` is required for get_service_coverage."
    );
  }

  let data: { service: string; operations: Row[] };
  try {
    data = await coverageFetch<{ service: string; operations: Row[] }>(
      `/services/${encodeURIComponent(service)}`
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes("HTTP 404")) {
      return ResponseBuilder.error(
        "Service not found",
        `No coverage data for service '${service}'. Use list_services to see available services.`
      );
    }
    throw e;
  }

  const rows = data.operations;
  const implemented = rows.filter((r) => r.implemented === 1);
  const missing = rows.filter((r) => r.implemented === 0);

  let md = `# Coverage: \`${service}\`\n\n`;
  md += `| Service | Implemented | Total | Coverage |\n`;
  md += `|---------|-------------|-------|----------|\n`;
  const p = pct(implemented.length, rows.length);
  md += `| \`${service}\` | ${implemented.length} | ${rows.length} | ${coverageEmoji(p)} ${p}% |\n\n`;

  if (implemented.length > 0) {
    md += `## ✅ Implemented (${implemented.length})\n\n`;
    md += implemented.map((r) => `- \`${r.operation as string}\``).join("\n") + "\n\n";
  }

  if (missing.length > 0) {
    md += `## ❌ Not implemented (${missing.length})\n\n`;
    md += missing.map((r) => `- \`${r.operation as string}\``).join("\n") + "\n";
  }

  return ResponseBuilder.markdown(md);
}

// ---------------------------------------------------------------------------
// Action: check_operations
// ---------------------------------------------------------------------------

async function checkOperations(operations: string[] | undefined) {
  if (!operations || operations.length === 0) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`operations` is required for check_operations. Provide an array of 'service:Operation' strings."
    );
  }

  // Normalize "service.Operation" → "service:Operation" before sending
  const normalized = operations.map((op) => op.replace(/^([^:.]+)\./, "$1:"));

  const { results: apiResults } = await coverageFetch<{
    results: { operation: string; implemented: number | null }[];
  }>("/operations", normalized);

  const results = apiResults.map(({ operation, implemented }) => {
    if (implemented === null) {
      return { raw: operation, status: "unknown" as const, note: "Not in coverage DB — may be a newer API" };
    }
    return { raw: operation, status: (implemented === 1 ? "implemented" : "missing") as "implemented" | "missing" };
  });

  const implemented = results.filter((r) => r.status === "implemented");
  const missing = results.filter((r) => r.status === "missing");
  const unknown = results.filter((r) => r.status === "unknown");

  const deployable = missing.length === 0;
  const opDot = deployable ? "🟢" : "🔴";
  let md = `# Operation Coverage Check\n\n`;
  md += `**${operations.length} operations checked** — `;
  md +=
    deployable
      ? `${opDot} All required operations are implemented. Template should deploy successfully.`
      : `${opDot} ${missing.length} operation(s) missing. Template may fail to deploy.`;
  md += "\n\n";

  if (implemented.length > 0) {
    md += `## ✅ Implemented (${implemented.length})\n`;
    md += implemented.map((r) => `- \`${r.raw}\``).join("\n") + "\n\n";
  }

  if (missing.length > 0) {
    md += `## ❌ Not implemented (${missing.length})\n`;
    md +=
      missing.map((r) => `- \`${r.raw}\``).join("\n") +
      "\n\n";
    md += `> These operations are not yet supported by LocalStack. `;
    md += `Check https://docs.localstack.cloud for workarounds or open an issue.\n`;
  }

  if (unknown.length > 0) {
    md += `\n## ⚠️ Unknown (${unknown.length})\n`;
    md +=
      unknown.map((r) => `- \`${r.raw}\` — ${r.note}`).join("\n") + "\n";
  }

  return ResponseBuilder.markdown(md);
}

// ---------------------------------------------------------------------------
// Action: scan_iac
// ---------------------------------------------------------------------------

function collectFiles(root: string, exts: string[], maxDepth = 4): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".terraform") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (exts.includes(extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  }
  try {
    const stat = statSync(root);
    if (stat.isFile()) return [root];
    walk(root, 0);
  } catch { /* path doesn't exist */ }
  return results;
}

const SERVICE_ALIASES: Record<string, string> = { s3api: "s3" };
const SKIP_CLI_OPS = new Set(["configure", "help", "wait"]);

type IacScanResult = {
  framework: string;
  counts: Map<string, number>;
  shellOps: Map<string, number>;
  tfContents: Map<string, string>; // path → content, reused by patchIac
};

function extractResourceTypes(path: string): IacScanResult {
  const files = collectFiles(path, [".tf", ".yaml", ".yml", ".json", ".ts", ".py", ".sh"]);

  const tfCounts = new Map<string, number>();
  const cfCounts = new Map<string, number>();
  const pulumiCounts = new Map<string, number>();
  const shellOps = new Map<string, number>();
  const tfContents = new Map<string, string>();

  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }

    const ext = extname(file).toLowerCase();

    if (ext === ".tf") {
      tfContents.set(file, content);
      for (const m of content.matchAll(/^resource\s+"(aws_[a-z0-9_]+)"/gm)) {
        inc(tfCounts, m[1]);
      }
    }

    if (ext === ".yaml" || ext === ".yml" || ext === ".json") {
      for (const m of content.matchAll(/[Tt]ype["']?\s*[:=]\s*["']?(AWS::[A-Za-z0-9:]+)/g)) {
        inc(cfCounts, m[1]);
      }
    }

    if (ext === ".ts") {
      for (const m of content.matchAll(/new\s+aws\.([a-z0-9]+)\.([A-Z][a-zA-Z0-9]+)\s*\(/g)) {
        const [, svc, res] = m;
        inc(pulumiCounts, `aws:${svc}/${res.charAt(0).toLowerCase() + res.slice(1)}:${res}`);
      }
    }

    if (ext === ".py") {
      for (const m of content.matchAll(/aws\.([a-z0-9]+)\.([A-Z][a-zA-Z0-9]+)\s*\(/g)) {
        const [, svc, res] = m;
        inc(pulumiCounts, `aws:${svc}/${res.charAt(0).toLowerCase() + res.slice(1)}:${res}`);
      }
    }

    if (ext === ".sh") {
      for (const m of content.matchAll(
        /(?:^|[\s;|&(])(awslocal|aws)\s+([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]+)/gm
      )) {
        const rawSvc = m[2];
        const rawOp = m[3];
        if (SKIP_CLI_OPS.has(rawOp)) continue;
        const svc = SERVICE_ALIASES[rawSvc] ?? rawSvc;
        const op = rawOp.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
        inc(shellOps, `${svc}:${op}`);
      }
    }
  }

  const counts = new Map<string, number>([...cfCounts, ...tfCounts, ...pulumiCounts]);
  const frameworks = [
    cfCounts.size > 0 ? "CloudFormation/CDK" : null,
    tfCounts.size > 0 ? "Terraform" : null,
    pulumiCounts.size > 0 ? "Pulumi" : null,
  ].filter(Boolean).join(", ");

  return { framework: frameworks || "unknown", counts, shellOps, tfContents };
}

async function shellOpsSectionMarkdown(ops: Map<string, number>): Promise<string> {
  const { results } = await coverageFetch<{
    results: Array<{ operation: string; implemented: number | null }>;
  }>("/operations", [...ops.keys()]);

  const lines = results.map(r => {
    if (r.implemented === 1) return `✅ ${r.operation}`;
    if (r.implemented === null) return `⚠️ ${r.operation} — not in coverage DB`;
    return `❌ ${r.operation}`;
  });

  const blocking = results.filter(r => r.implemented === 0).length;
  const verdict = blocking === 0 ? "**Ready**" : `**${blocking} operation(s) not implemented**`;
  return `**Shell scripts** — ${verdict}\n\n${lines.join("\n")}`;
}

async function scanIac(iac_path: string | undefined) {
  if (!iac_path) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`iac_path` is required for scan_iac."
    );
  }

  const { framework, counts, shellOps } = extractResourceTypes(iac_path);

  if (counts.size === 0 && shellOps.size === 0) {
    return ResponseBuilder.error(
      "No resource types found",
      `No AWS resource types detected in \`${iac_path}\`. ` +
      `Supported: Terraform (.tf), CloudFormation/CDK (.yaml/.json), Pulumi (.ts/.py), shell scripts (.sh with aws/awslocal calls).`
    );
  }

  const sections: string[] = [];

  if (counts.size > 0) {
    sections.push(await resourcesSectionMarkdown([...counts.keys()], counts, framework));
  }
  if (shellOps.size > 0) {
    sections.push(await shellOpsSectionMarkdown(shellOps));
  }

  return ResponseBuilder.markdown(
    sections.length === 1 ? sections[0] : sections.join("\n\n---\n\n")
  );
}

// ---------------------------------------------------------------------------
// Action: check_resources
// ---------------------------------------------------------------------------

type ResourceResult = {
  resource_type: string;
  known: boolean;
  blocking: string[];
};

async function fetchResourceResults(resources: string[]): Promise<ResourceResult[]> {
  const { resources: apiResources } = await coverageFetch<{
    resources: { resource_type: string; known: boolean; operations: Row[] }[];
  }>("/resources", resources);

  return apiResources.map(({ resource_type, known, operations }) => {
    if (!known) return { resource_type, known: false, blocking: [] };
    const blocking = operations
      .filter((r) => r.implemented === 0)
      .map((r) => r.operation as string);
    return { resource_type, known: true, blocking };
  });
}

async function resourcesSectionMarkdown(
  resources: string[],
  counts?: Map<string, number>,
  framework?: string
): Promise<string> {
  const results = await fetchResourceResults(resources);

  const blocked = results.filter((r) => !r.known || r.blocking.length > 0);
  const hasBlockers = blocked.length > 0;
  const stackLabel = framework ?? "Service coverage summary";

  const knownBlockers = blocked.filter((r) => r.known && r.blocking.length > 0);
  const unknownBlockers = blocked.filter((r) => !r.known);
  let blockerSummary = "";
  if (knownBlockers.length > 0) {
    blockerSummary += knownBlockers.map((r) => `${friendlyName(r.resource_type)} requires: ${r.blocking.join(", ")}`).join("; ") + ".";
  }
  if (unknownBlockers.length > 0) {
    const names = unknownBlockers.map((r) => friendlyName(r.resource_type)).join(", ");
    blockerSummary += (blockerSummary ? " " : "") + `${names}: not in coverage database.`;
  }
  const verdict = hasBlockers
    ? `**${blocked.length} blocker(s) found.** ${blockerSummary}`
    : `**No blockers.**`;

  const lines = results.map((r) => {
    const count = counts?.get(r.resource_type) ?? 1;
    const label = count > 1
      ? `${count}x ${friendlyName(r.resource_type)}`
      : friendlyName(r.resource_type);
    const ok = r.known && r.blocking.length === 0;
    const detail = !r.known
      ? " — not in coverage DB"
      : r.blocking.length > 0
        ? ` — missing: ${r.blocking.join(", ")}`
        : "";
    return `${ok ? "✅" : "❌"} ${label}${detail}`;
  });

  return `**${stackLabel}** — ${verdict}\n\n${lines.join("\n")}`;
}

async function checkResources(
  resources: string[] | undefined,
  counts?: Map<string, number>,
  framework?: string
) {
  if (!resources || resources.length === 0) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`resources` is required for check_resources. Provide an array of IaC resource type names."
    );
  }

  return ResponseBuilder.markdown(await resourcesSectionMarkdown(resources, counts, framework));
}

// ---------------------------------------------------------------------------
// Action: patch_iac
// ---------------------------------------------------------------------------

const LOCALSTACK_PROVIDER_BLOCK = `
provider "aws" {
  access_key                  = "test"
  secret_key                  = "test"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    # localstack-patch: auto-generated — remove when deploying to AWS
    s3             = "http://localhost:4566"
    lambda         = "http://localhost:4566"
    dynamodb       = "http://localhost:4566"
    iam            = "http://localhost:4566"
    sqs            = "http://localhost:4566"
    sns            = "http://localhost:4566"
    apigateway     = "http://localhost:4566"
    cloudwatch     = "http://localhost:4566"
    secretsmanager = "http://localhost:4566"
    ssm            = "http://localhost:4566"
    sts            = "http://localhost:4566"
  }
}
`;

async function patchIac(iac_path: string | undefined) {
  if (!iac_path) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`iac_path` is required for patch_iac."
    );
  }

  const { framework, counts, tfContents } = extractResourceTypes(iac_path);

  if (!framework.includes("Terraform") || counts.size === 0) {
    return ResponseBuilder.error(
      "No Terraform resources found",
      `No Terraform (.tf) resources detected in \`${iac_path}\`. patch_iac only supports Terraform in v1.`
    );
  }

  // Find blockers via REST
  const tfResources = [...counts.keys()].filter((rt) => rt.startsWith("aws_"));
  const results = await fetchResourceResults(tfResources);
  const blockers = results
    .filter(({ known, blocking }) => known && blocking.length > 0)
    .map(({ resource_type }) => resource_type);

  if (blockers.length === 0) {
    return ResponseBuilder.markdown(
      `**No blockers found** — no patch needed. Your Terraform project should deploy cleanly on LocalStack.\n\n` +
      `You may still want to add the LocalStack provider config if you haven't already.`
    );
  }

  // Build the diff using cached file contents from extractResourceTypes
  const hunks: string[] = [];

  for (const [file, content] of tfContents) {
    const lines = content.split("\n");
    const fileHunks: Array<{ lineNo: number; original: string }> = [];

    for (const blocker of blockers) {
      const re = new RegExp(`^(resource\\s+"${blocker}"\\s+"[^"]*"\\s*\\{)`, "m");
      lines.forEach((line, idx) => {
        if (re.test(line)) fileHunks.push({ lineNo: idx + 1, original: line });
      });
    }

    if (fileHunks.length === 0) continue;

    for (const h of fileHunks) {
      const context = Math.max(0, h.lineNo - 3);
      const ctxLines = lines.slice(context, h.lineNo - 1).map(l => ` ${l}`).join("\n");
      hunks.push(
        `--- a/${file}\n` +
        `+++ b/${file}\n` +
        `@@ -${h.lineNo},1 +${h.lineNo},2 @@\n` +
        (ctxLines ? ctxLines + "\n" : "") +
        ` ${h.original}\n` +
        `+  count = 0 # localstack-patch: ${h.original.match(/"(aws_[a-z0-9_]+)"/)?.[1] ?? "resource"} not supported on LocalStack`
      );
    }
  }

  // Provider block — use cached contents, no re-read needed
  let providerFile = [...tfContents.entries()].find(([, c]) => c.includes(`provider "aws"`))?.[0]
    ?? [...tfContents.keys()].find(f => f.endsWith("main.tf"))
    ?? [...tfContents.keys()][0];

  let providerHunk = "";
  if (providerFile) {
    const content = tfContents.get(providerFile) ?? "";
    if (!content.includes("localstack-patch")) {
      const lines = content.split("\n");
      providerHunk =
        `--- a/${providerFile}\n` +
        `+++ b/${providerFile}\n` +
        `@@ -${lines.length + 1},0 +${lines.length + 1},${LOCALSTACK_PROVIDER_BLOCK.split("\n").length} @@\n` +
        LOCALSTACK_PROVIDER_BLOCK.split("\n").map(l => `+${l}`).join("\n");
    }
  }

  const allHunks = [...hunks, providerHunk].filter(Boolean).join("\n\n");
  const blockerList = blockers.map(b => `- \`${b}\``).join("\n");

  let md = `# LocalStack Patch\n\n`;
  md += `**${blockers.length} blocker(s) gated** with \`count = 0 # localstack-patch\`:\n${blockerList}\n\n`;
  md += `All patches are marked \`# localstack-patch\` — search for that string to remove them before deploying to AWS.\n\n`;
  md += `\`\`\`diff\n${allHunks}\n\`\`\`\n\n`;
  md += `> Apply this patch? (yes/no)`;

  return ResponseBuilder.markdown(md);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((100 * n) / total);
}

function coverageEmoji(p: number): string {
  if (p >= 80) return "🟢";
  if (p >= 50) return "🟡";
  return "🔴";
}
