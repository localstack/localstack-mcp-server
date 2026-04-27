import {
  buildStartReplicationJobRequest,
  formatReplicationJob,
} from "../../tools/localstack-aws-replicator";

describe("localstack-aws-replicator", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_DEFAULT_REGION: "us-east-1",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("buildStartReplicationJobRequest", () => {
    it("builds a single-resource request from type and identifier using env credentials", () => {
      const request = buildStartReplicationJobRequest({
        action: "start",
        replication_type: "SINGLE_RESOURCE",
        resource_type: "AWS::EC2::VPC",
        resource_identifier: "vpc-123",
        target_account_id: "111111111111",
        target_region_name: "eu-central-1",
      } as any);

      expect(request).toEqual({
        replication_type: "SINGLE_RESOURCE",
        replication_job_config: {
          resource_type: "AWS::EC2::VPC",
          resource_identifier: "vpc-123",
        },
        source_aws_config: {
          aws_access_key_id: "AKIA...",
          aws_secret_access_key: "secret",
          region_name: "us-east-1",
        },
        target_aws_config: {
          aws_access_key_id: "111111111111",
          aws_secret_access_key: "test",
          region_name: "eu-central-1",
        },
      });
    });

    it("builds a resource ARN request without requiring resource type using env credentials", () => {
      process.env.AWS_SESSION_TOKEN = "token";
      process.env.AWS_ENDPOINT_URL = "https://example.com";

      const request = buildStartReplicationJobRequest({
        action: "start",
        replication_type: "SINGLE_RESOURCE",
        resource_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
      } as any);

      expect(request).toEqual({
        replication_type: "SINGLE_RESOURCE",
        replication_job_config: {
          resource_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
        },
        source_aws_config: {
          aws_access_key_id: "AKIA...",
          aws_secret_access_key: "secret",
          aws_session_token: "token",
          region_name: "us-east-1",
          endpoint_url: "https://example.com",
        },
      });
    });
  });

  describe("formatReplicationJob", () => {
    it("includes batch result details", () => {
      const formatted = formatReplicationJob("AWS Replicator Job Status", {
        job_id: "job-123",
        state: "SUCCEEDED",
        type: "BATCH",
        replication_config: {
          resource_type: "AWS::SSM::Parameter",
          identifier: "/dev/",
        },
        result: {
          resources_succeeded: 2,
          resources_failed: 0,
        },
      });

      expect(formatted).toContain("AWS Replicator Job Status");
      expect(formatted).toContain("`job-123`");
      expect(formatted).toContain("resources_succeeded");
      expect(formatted).toContain("AWS::SSM::Parameter");
    });
  });
});
