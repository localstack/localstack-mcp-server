const cdk = require("aws-cdk-lib");
const s3 = require("aws-cdk-lib/aws-s3");

class SampleCdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "SampleBucket", {
      bucketName: "mcp-cdk-sample-bucket",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
    });
  }
}

const app = new cdk.App();
new SampleCdkStack(app, "McpSampleCdkStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || "000000000000",
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1",
  },
  synthesizer: new cdk.BootstraplessSynthesizer(),
});
