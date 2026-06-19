import { friendlyName, FRIENDLY_NAMES } from "../../src/tools/localstack-coverage";

describe("friendlyName", () => {
  it("maps known Terraform types", () => {
    expect(friendlyName("aws_sqs_queue")).toBe("SQS queue");
    expect(friendlyName("aws_lambda_function")).toBe("Lambda function");
    expect(friendlyName("aws_dynamodb_table")).toBe("DynamoDB table");
    expect(friendlyName("aws_s3_bucket")).toBe("S3 bucket");
    expect(friendlyName("aws_iam_role")).toBe("IAM role");
  });

  it("maps known CloudFormation types", () => {
    expect(friendlyName("AWS::SQS::Queue")).toBe("SQS queue");
    expect(friendlyName("AWS::Lambda::Function")).toBe("Lambda function");
    expect(friendlyName("AWS::DynamoDB::Table")).toBe("DynamoDB table");
    expect(friendlyName("AWS::S3::Bucket")).toBe("S3 bucket");
    expect(friendlyName("AWS::IAM::Role")).toBe("IAM role");
  });

  it("falls back to raw type when no mapping exists", () => {
    expect(friendlyName("aws_unknown_widget")).toBe("aws_unknown_widget");
    expect(friendlyName("AWS::Unknown::Thing")).toBe("AWS::Unknown::Thing");
  });

  it("all FRIENDLY_NAMES values are non-empty strings", () => {
    for (const [type, name] of Object.entries(FRIENDLY_NAMES)) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toContain("aws_");
      expect(name).not.toMatch(/^AWS::/);
    }
  });
});
