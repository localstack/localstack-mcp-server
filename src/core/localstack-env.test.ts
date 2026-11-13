import { buildIacCliEnv } from "./localstack-env";

const ORIGINAL_ENV = process.env;

describe("buildIacCliEnv", () => {
  beforeEach(() => {
    process.env = {};
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("injects CDK credentials and defaults for local stdio usage", () => {
    const env = buildIacCliEnv({ CI: "true" });

    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("test");
    expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.CDK_DEFAULT_ACCOUNT).toBe("000000000000");
    expect(env.CDK_DEFAULT_REGION).toBe("us-east-1");
    expect(env.CI).toBe("true");
  });

  it("points lstk at localhost.localstack.cloud for a local LocalStack", () => {
    const env = buildIacCliEnv();

    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost.localstack.cloud:4566");
    expect(env.AWS_ENDPOINT_URL_S3).toBeUndefined();
  });

  it("points lstk at the host gateway when LocalStack runs outside the container", () => {
    process.env.LOCALSTACK_HOSTNAME = "host.docker.internal";

    const env = buildIacCliEnv();

    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("test");
    expect(env.AWS_ENDPOINT_URL).toBe("http://host.docker.internal:4566");
    // lstk derives the S3 endpoint and path-style addressing itself.
    expect(env.AWS_ENDPOINT_URL_S3).toBeUndefined();
  });

  it("preserves an explicit endpoint", () => {
    process.env.LOCALSTACK_HOSTNAME = "host.docker.internal";

    const env = buildIacCliEnv({ AWS_ENDPOINT_URL: "https://example.localstack.cloud" });

    expect(env.AWS_ENDPOINT_URL).toBe("https://example.localstack.cloud");
  });

  it("preserves explicit credentials and regions", () => {
    const env = buildIacCliEnv({
      AWS_ACCESS_KEY_ID: "custom-key",
      AWS_SECRET_ACCESS_KEY: "custom-secret",
      AWS_DEFAULT_REGION: "eu-central-1",
      CDK_DEFAULT_ACCOUNT: "111111111111",
    });

    expect(env.AWS_ACCESS_KEY_ID).toBe("custom-key");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("custom-secret");
    expect(env.AWS_DEFAULT_REGION).toBe("eu-central-1");
    expect(env.AWS_REGION).toBe("eu-central-1");
    expect(env.CDK_DEFAULT_ACCOUNT).toBe("111111111111");
    expect(env.CDK_DEFAULT_REGION).toBe("eu-central-1");
  });
});
