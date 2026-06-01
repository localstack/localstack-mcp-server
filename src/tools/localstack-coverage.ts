import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import Database from "better-sqlite3";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";

// ---------------------------------------------------------------------------
// DB path — bundled at data/coverage.db relative to the dist directory.
// LOCALSTACK_COVERAGE_DB env var is a silent override for tests only.
// ---------------------------------------------------------------------------
function getDbPath(): string {
  // __dirname is shimmed by esbuild for ESM Node builds; works natively in CJS/Jest
  return process.env.LOCALSTACK_COVERAGE_DB ?? join(__dirname, "../data/coverage.db");
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
        "scan_iac — given a path to a Terraform, CloudFormation, CDK, or Pulumi project, read the files fresh from disk, extract all resource types, and return a deploy-readiness verdict. Use this instead of reading files manually — it always reflects the current state of the files.",
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
      "Path to a Terraform, CloudFormation, CDK, or Pulumi project directory or file. Required for scan_iac. Files are read fresh from disk on every call."
    ),
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: ToolMetadata = {
  name: "localstack-coverage-advisor",
  description:
    "STATIC analysis only — reads IaC files and queries the coverage database. Does NOT deploy, run terraform, install tools, or require LocalStack to be running. " +
    "Use this tool whenever the user asks whether their IaC (Terraform, CloudFormation, CDK, Pulumi) will work, deploy, " +
    "or run on LocalStack — e.g. 'will this terraform work on localstack?', 'can I deploy this to localstack?', " +
    "'what won't work on localstack?', 'is my stack compatible with localstack?', 'check my terraform', " +
    "'validate my terraform', 'validate this stack', 'check coverage for my IaC', 'what's the localstack coverage?', " +
    "'will this work?', 'is this supported?', 'what operations are missing?', 'check localstack support'. " +
    "ALWAYS prefer this tool over localstack-deployer when the user wants to CHECK, VALIDATE, or VERIFY compatibility without actually deploying. " +
    "When the user asks such a question without providing a path, infer the workspace root and pass it as iac_path to scan_iac. " +
    "If scan_iac returns no resources found, ask the user once: 'I didn't find any IaC files in <path> — where is your Terraform project?' " +
    "After showing the deploy-readiness verdict, offer to patch the project so it deploys on LocalStack (Terraform only).",
  annotations: {
    title: "LocalStack Coverage",
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
    "localstack-coverage-advisor",
    { action, service },
    async () => {
      let db: Database.Database;
      try {
        db = new Database(getDbPath());
      } catch {
        return ResponseBuilder.error(
          "Coverage DB unavailable",
          `Could not open coverage database at ${getDbPath()}. ` +
            `Regenerate it with:\n\n` +
            `  python bin/create_service_coverage_catalog.py --db-path data/coverage.db`
        );
      }

      try {
        switch (action) {
          case "list_services":
            return listServices(db);
          case "get_service_coverage":
            return getServiceCoverage(db, service);
          case "check_operations":
            return checkOperations(db, operations);
          case "check_resources":
            return checkResources(db, resources);
          case "scan_iac":
            return scanIac(db, iac_path);
          case "patch_iac":
            return patchIac(db, iac_path);
        }
      } finally {
        db.close();
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Action: list_services
// ---------------------------------------------------------------------------

function listServices(db: Database.Database) {
  const rows = db
    .prepare(
      `SELECT service,
              COUNT(*)                        AS total,
              SUM(implemented)                AS implemented
       FROM   operations
       GROUP  BY service
       ORDER  BY CAST(SUM(implemented) AS REAL) / COUNT(*) DESC`
    )
    .all() as Row[];

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

function getServiceCoverage(db: Database.Database, service: string | undefined) {
  if (!service) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`service` is required for get_service_coverage."
    );
  }

  const rows = db
    .prepare(
      `SELECT operation, implemented
       FROM   operations
       WHERE  service = ?
       ORDER  BY operation`
    )
    .all(service) as Row[];

  if (rows.length === 0) {
    return ResponseBuilder.error(
      "Service not found",
      `No coverage data for service '${service}'. Use list_services to see available services.`
    );
  }

  const implemented = rows.filter((r) => r.implemented === 1);
  const missing = rows.filter((r) => r.implemented === 0);

  let md = `# Coverage: \`${service}\`\n\n`;
  md += serviceSummaryTable(db, [service]);
  md += `\n`;

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

function checkOperations(db: Database.Database, operations: string[] | undefined) {
  if (!operations || operations.length === 0) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`operations` is required for check_operations. Provide an array of 'service:Operation' strings."
    );
  }

  // Parse "service:Operation" or "service.Operation"
  const parsed = operations.map((op) => {
    const [svc, ...rest] = op.split(/[:.]/, 2);
    return { raw: op, service: svc?.toLowerCase(), operation: rest.join("") };
  });

  const stmt = db.prepare(
    `SELECT implemented FROM operations WHERE service = ? AND operation = ?`
  );

  const results = parsed.map(({ raw, service, operation }) => {
    if (!service || !operation) {
      return { raw, status: "invalid" as const, note: "Could not parse service:Operation" };
    }
    const row = stmt.get(service, operation) as Row | undefined;
    if (!row) {
      return { raw, status: "unknown" as const, note: "Not in coverage DB — may be a newer API" };
    }
    return {
      raw,
      status: (row.implemented === 1) ? ("implemented" as const) : ("missing" as const),
    };
  });

  const implemented = results.filter((r) => r.status === "implemented");
  const missing = results.filter((r) => r.status === "missing");
  const unknown = results.filter((r) => r.status === "unknown" || r.status === "invalid");

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

function extractResourceTypes(path: string): { framework: string; counts: Map<string, number> } {
  const files = collectFiles(path, [".tf", ".yaml", ".yml", ".json", ".ts", ".py"]);

  const tfCounts = new Map<string, number>();
  const cfCounts = new Map<string, number>();
  const pulumiCounts = new Map<string, number>();

  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }

    const ext = extname(file).toLowerCase();

    if (ext === ".tf") {
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
  }

  const counts = new Map<string, number>([...cfCounts, ...tfCounts, ...pulumiCounts]);
  const frameworks = [
    cfCounts.size > 0 ? "CloudFormation/CDK" : null,
    tfCounts.size > 0 ? "Terraform" : null,
    pulumiCounts.size > 0 ? "Pulumi" : null,
  ].filter(Boolean).join(", ");

  return { framework: frameworks || "unknown", counts };
}

function scanIac(db: Database.Database, iac_path: string | undefined) {
  if (!iac_path) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`iac_path` is required for scan_iac."
    );
  }

  const { framework, counts } = extractResourceTypes(iac_path);

  if (counts.size === 0) {
    return ResponseBuilder.error(
      "No resource types found",
      `No AWS resource types detected in \`${iac_path}\`. ` +
      `Supported: Terraform (.tf), CloudFormation/CDK (.yaml/.json), Pulumi (.ts/.py).`
    );
  }

  return checkResources(db, [...counts.keys()], counts, framework);
}

// ---------------------------------------------------------------------------
// Action: check_resources
// ---------------------------------------------------------------------------

function checkResources(
  db: Database.Database,
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

  const stmt = db.prepare(
    `SELECT rto.operation, rto.required, o.implemented
     FROM   resource_type_ops rto
     JOIN   operations o ON rto.service = o.service AND rto.operation = o.operation
     WHERE  rto.resource_type = ?
     ORDER  BY rto.required DESC, rto.operation`
  );

  type ResourceResult = {
    resource_type: string;
    known: boolean;
    blocking: string[];
    optional_gaps: string[];
  };

  const results: ResourceResult[] = resources.map((rt) => {
    const rows = stmt.all(rt) as (Row & { required: number })[];
    if (rows.length === 0) {
      return { resource_type: rt, known: false, blocking: [], optional_gaps: [] };
    }
    const blocking = rows
      .filter((r) => r.required === 1 && r.implemented === 0)
      .map((r) => r.operation as string);
    const optional_gaps = rows
      .filter((r) => r.required === 0 && r.implemented === 0)
      .map((r) => r.operation as string);
    return { resource_type: rt, known: true, blocking, optional_gaps };
  });

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

  return ResponseBuilder.markdown(`**${stackLabel}** — ${verdict}\n\n${lines.join("\n")}`);
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

function patchIac(db: Database.Database, iac_path: string | undefined) {
  if (!iac_path) {
    return ResponseBuilder.error(
      "Missing parameter",
      "`iac_path` is required for patch_iac."
    );
  }

  const { framework, counts } = extractResourceTypes(iac_path);

  if (!framework.includes("Terraform") || counts.size === 0) {
    return ResponseBuilder.error(
      "No Terraform resources found",
      `No Terraform (.tf) resources detected in \`${iac_path}\`. patch_iac only supports Terraform in v1.`
    );
  }

  // Find blockers
  const stmt = db.prepare(
    `SELECT rto.operation
     FROM   resource_type_ops rto
     JOIN   operations o ON rto.service = o.service AND rto.operation = o.operation
     WHERE  rto.resource_type = ? AND rto.required = 1 AND o.implemented = 0`
  );

  const blockers: string[] = [];
  for (const rt of counts.keys()) {
    if (!rt.startsWith("aws_")) continue;
    const rows = stmt.all(rt) as Row[];
    if (rows.length > 0) blockers.push(rt);
  }

  if (blockers.length === 0) {
    return ResponseBuilder.markdown(
      `**No blockers found** — no patch needed. Your Terraform project should deploy cleanly on LocalStack.\n\n` +
      `You may still want to add the LocalStack provider config if you haven't already.`
    );
  }

  // Build the diff
  const tfFiles = collectFiles(iac_path, [".tf"]);
  const hunks: string[] = [];

  // Gate each blocker resource in-place
  for (const file of tfFiles) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }

    const lines = content.split("\n");
    const fileHunks: Array<{ lineNo: number; original: string; patched: string }> = [];

    for (const blocker of blockers) {
      const re = new RegExp(`^(resource\\s+"${blocker}"\\s+"[^"]*"\\s*\\{)`, "m");
      let idx = 0;
      for (const line of lines) {
        if (re.test(line)) {
          const countLine = `  count = 0 # localstack-patch: ${blocker} not supported`;
          fileHunks.push({ lineNo: idx + 1, original: line, patched: line + "\n" + countLine });
        }
        idx++;
      }
    }

    if (fileHunks.length === 0) continue;

    // Format as unified diff hunks
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

  // Provider block — find the first .tf file that already has a provider "aws" block or use main.tf
  const providerFile = tfFiles.find(f => {
    try { return readFileSync(f, "utf8").includes(`provider "aws"`); } catch { return false; }
  }) ?? tfFiles.find(f => f.endsWith("main.tf")) ?? tfFiles[0];

  let providerHunk = "";
  if (providerFile) {
    let content = "";
    try { content = readFileSync(providerFile, "utf8"); } catch {}
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

function serviceSummaryTable(db: Database.Database, services: string[]): string {
  const stmt = db.prepare(
    `SELECT COUNT(*) AS total, SUM(implemented) AS implemented
     FROM   operations
     WHERE  service = ?`
  );

  let md = `| Service | Implemented | Total | Coverage |\n`;
  md +=    `|---------|-------------|-------|----------|\n`;

  for (const svc of services) {
    const row = stmt.get(svc) as Row | undefined;
    if (!row) continue;
    const impl = row.implemented as number;
    const total = row.total as number;
    const p = pct(impl, total);
    md += `| \`${svc}\` | ${impl} | ${total} | ${coverageEmoji(p)} ${p}% |\n`;
  }

  return md;
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((100 * n) / total);
}

function coverageEmoji(p: number): string {
  if (p >= 80) return "🟢";
  if (p >= 50) return "🟡";
  return "🔴";
}
