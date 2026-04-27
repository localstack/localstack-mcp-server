import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { ResponseBuilder } from "../core/response-builder";
import {
  runPreflights,
  requireAuthToken,
  requireLocalStackRunning,
  requireProFeature,
} from "../core/preflight";
import { withToolAnalytics } from "../core/analytics";
import { ProFeature } from "../lib/localstack/license-checker";
import {
  AwsReplicatorApiClient,
  type AwsConfig,
  type ReplicationJobResponse,
  type StartReplicationJobRequest,
} from "../lib/localstack/localstack.client";

export const schema = {
  action: z
    .enum(["start", "status"])
    .describe("The AWS Replicator action to perform: start a job or check job status."),
  replication_type: z
    .enum(["SINGLE_RESOURCE", "BATCH"])
    .default("SINGLE_RESOURCE")
    .describe(
      "Replication job type. Use SINGLE_RESOURCE for one resource, or BATCH for supported batch jobs such as SSM parameters under a path prefix."
    ),
  resource_type: z
    .string()
    .trim()
    .optional()
    .describe("CloudFormation resource type to replicate, e.g. AWS::EC2::VPC or AWS::SSM::Parameter."),
  resource_identifier: z
    .string()
    .trim()
    .optional()
    .describe(
      "Resource identifier to replicate. For BATCH SSM parameter replication, this must be a path prefix such as /dev/."
    ),
  resource_arn: z
    .string()
    .trim()
    .optional()
    .describe("Full ARN of the resource to replicate. Only supported for SINGLE_RESOURCE jobs."),
  job_id: z.string().trim().optional().describe("Replication job id. Required for the status action."),
  target_account_id: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional LocalStack target AWS account id override. This is sent as the target AWS access key id for LocalStack account routing."
    ),
  target_region_name: z
    .string()
    .trim()
    .optional()
    .describe("Optional LocalStack target AWS region override. Defaults to the source region."),
};

export const metadata: ToolMetadata = {
  name: "localstack-aws-replicator",
  description:
    "Replicate external AWS resources into a running LocalStack instance using the AWS Replicator HTTP API.",
  annotations: {
    title: "LocalStack AWS Replicator",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export type AwsReplicatorArgs = InferSchema<typeof schema>;

export default async function localstackAwsReplicator(args: AwsReplicatorArgs) {
  return withToolAnalytics(
    "localstack-aws-replicator",
    {
      action: args.action,
      replication_type: args.replication_type,
      resource_type: args.resource_type,
      has_resource_identifier: Boolean(args.resource_identifier),
      has_resource_arn: Boolean(args.resource_arn),
      target_account_id: args.target_account_id,
      target_region_name: args.target_region_name,
    },
    async () => {
      const preflightError = await runPreflights([
        requireAuthToken(),
        requireLocalStackRunning(),
        requireProFeature(ProFeature.REPLICATOR),
      ]);
      if (preflightError) return preflightError;

      const client = new AwsReplicatorApiClient();

      switch (args.action) {
        case "start":
          return await handleStart(client, args);
        case "status":
          return await handleStatus(client, args.job_id);
        default:
          return ResponseBuilder.error("Unknown action", `Unsupported action: ${args.action}`);
      }
    }
  );
}

async function handleStart(client: AwsReplicatorApiClient, args: AwsReplicatorArgs) {
  const validationError = validateStartArgs(args);
  if (validationError) return validationError;

  const request = buildStartReplicationJobRequest(args);
  const result = await client.startJob(request);
  if (!result.success) {
    return ResponseBuilder.error("AWS Replicator Error", result.message);
  }

  return ResponseBuilder.markdown(formatReplicationJob("AWS Replicator Job Started", result.data));
}

async function handleStatus(client: AwsReplicatorApiClient, jobId?: string) {
  if (!jobId?.trim()) {
    return ResponseBuilder.error(
      "Missing Required Parameter",
      "The `status` action requires the `job_id` parameter."
    );
  }

  const result = await client.getJobStatus(jobId.trim());
  if (!result.success) {
    return ResponseBuilder.error("AWS Replicator Error", result.message);
  }

  return ResponseBuilder.markdown(formatReplicationJob("AWS Replicator Job Status", result.data));
}

function validateStartArgs(args: AwsReplicatorArgs) {
  const hasArn = Boolean(args.resource_arn?.trim());
  const hasTypeAndIdentifier = Boolean(args.resource_type?.trim() && args.resource_identifier?.trim());

  if (args.replication_type === "BATCH" && hasArn) {
    return ResponseBuilder.error(
      "Invalid Parameters",
      "`resource_arn` is only supported for `SINGLE_RESOURCE` replication jobs."
    );
  }

  if (hasArn === hasTypeAndIdentifier) {
    return ResponseBuilder.error(
      "Invalid Parameters",
      "Provide exactly one resource target: either `resource_arn`, or both `resource_type` and `resource_identifier`."
    );
  }

  const sourceAwsConfig = getSourceAwsConfigFromEnv();
  const missingSourceFields = sourceAwsConfig.missing.map((field) => `\`${field}\``);

  if (missingSourceFields.length > 0) {
    return ResponseBuilder.error(
      "Missing Source AWS Configuration",
      `Configure ${missingSourceFields.join(", ")} in the MCP server environment. The Replicator uses these credentials to read the source AWS account.`
    );
  }

  return null;
}

export function buildStartReplicationJobRequest(
  args: AwsReplicatorArgs
): StartReplicationJobRequest {
  const replicationJobConfig =
    args.resource_arn?.trim()
      ? { resource_arn: args.resource_arn.trim() }
      : {
          resource_type: args.resource_type!.trim(),
          resource_identifier: args.resource_identifier!.trim(),
        };

  const sourceAwsConfig = getSourceAwsConfigFromEnv().config;
  const targetAwsConfig = getTargetAwsConfig(args);

  return {
    replication_type: args.replication_type,
    replication_job_config: replicationJobConfig,
    source_aws_config: sourceAwsConfig,
    ...(targetAwsConfig ? { target_aws_config: targetAwsConfig } : {}),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function getSourceAwsConfigFromEnv(): { config: AwsConfig; missing: string[] } {
  const config: AwsConfig = {
    aws_access_key_id: firstNonEmpty(
      process.env.AWS_REPLICATOR_SOURCE_AWS_ACCESS_KEY_ID,
      process.env.AWS_ACCESS_KEY_ID
    ),
    aws_secret_access_key: firstNonEmpty(
      process.env.AWS_REPLICATOR_SOURCE_AWS_SECRET_ACCESS_KEY,
      process.env.AWS_SECRET_ACCESS_KEY
    ),
    region_name: firstNonEmpty(
      process.env.AWS_REPLICATOR_SOURCE_REGION_NAME,
      process.env.AWS_DEFAULT_REGION,
      process.env.AWS_REGION
    ),
  };

  const sessionToken = firstNonEmpty(
    process.env.AWS_REPLICATOR_SOURCE_AWS_SESSION_TOKEN,
    process.env.AWS_SESSION_TOKEN
  );
  if (sessionToken) {
    config.aws_session_token = sessionToken;
  }

  const endpointUrl = firstNonEmpty(
    process.env.AWS_REPLICATOR_SOURCE_ENDPOINT_URL,
    process.env.AWS_ENDPOINT_URL
  );
  if (endpointUrl) {
    config.endpoint_url = endpointUrl;
  }

  const missing: string[] = [];
  if (!config.aws_access_key_id) missing.push("AWS_ACCESS_KEY_ID");
  if (!config.aws_secret_access_key) missing.push("AWS_SECRET_ACCESS_KEY");
  if (!config.region_name) missing.push("AWS_DEFAULT_REGION");

  return { config, missing };
}

function getTargetAwsConfig(args: AwsReplicatorArgs): AwsConfig | undefined {
  const targetAccountId = firstNonEmpty(
    args.target_account_id,
    process.env.AWS_REPLICATOR_TARGET_ACCOUNT_ID,
    process.env.AWS_REPLICATOR_TARGET_AWS_ACCESS_KEY_ID
  );
  const targetRegionName = firstNonEmpty(
    args.target_region_name,
    process.env.AWS_REPLICATOR_TARGET_REGION_NAME
  );
  const targetEndpointUrl = firstNonEmpty(process.env.AWS_REPLICATOR_TARGET_ENDPOINT_URL);

  if (!targetAccountId && !targetRegionName && !targetEndpointUrl) {
    return undefined;
  }

  const config: AwsConfig = {
    aws_access_key_id: targetAccountId || "test",
    aws_secret_access_key: firstNonEmpty(
      process.env.AWS_REPLICATOR_TARGET_AWS_SECRET_ACCESS_KEY
    ) || "test",
    region_name: targetRegionName || getSourceAwsConfigFromEnv().config.region_name,
  };

  const targetSessionToken = firstNonEmpty(process.env.AWS_REPLICATOR_TARGET_AWS_SESSION_TOKEN);
  if (targetSessionToken) {
    config.aws_session_token = targetSessionToken;
  }
  if (targetEndpointUrl) {
    config.endpoint_url = targetEndpointUrl;
  }

  return config;
}

export function formatReplicationJob(title: string, job: ReplicationJobResponse): string {
  const state = job.state || "UNKNOWN";
  const jobType = job.type || job.replication_type || "UNKNOWN";
  const config = job.replication_config || job.replication_job_config;
  const result = job.result;

  let markdown = `## ${title}\n\n`;
  markdown += `- **Job ID:** \`${job.job_id || "N/A"}\`\n`;
  markdown += `- **State:** \`${state}\`\n`;
  markdown += `- **Type:** \`${jobType}\`\n`;

  if (job.error_message) {
    markdown += `- **Error:** ${job.error_message}\n`;
  }

  if (config) {
    markdown += `\n### Replication Config\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`\n`;
  }

  if (result) {
    markdown += `\n### Result\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`;
  }

  markdown += `\n### Raw Response\n\n\`\`\`json\n${JSON.stringify(job, null, 2)}\n\`\`\``;

  return markdown;
}
