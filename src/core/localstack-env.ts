import { LOCALSTACK_PORT } from "./config";

/**
 * Build the environment for spawned LocalStack IaC CLIs (tflocal, cdklocal, samlocal)
 * so they target the right LocalStack endpoint when the server runs in a container
 * and LocalStack is reachable at a non-default host (e.g. host.docker.internal).
 *
 * Why this is needed (verified against the wrapper sources):
 *   - tflocal / samlocal honor LOCALSTACK_HOSTNAME + EDGE_PORT (AWS_ENDPOINT_URL wins).
 *   - cdklocal (aws-cdk >= 2.177) IGNORES LOCALSTACK_HOSTNAME and REQUIRES
 *     AWS_ENDPOINT_URL together with AWS_ENDPOINT_URL_S3 (the S3 URL keeps an `s3.`
 *     component so CDK routes S3 traffic). Setting AWS_ENDPOINT_URL without the S3
 *     one makes cdklocal throw.
 *
 * This env is injected ONLY into the IaC CLI child processes — never globally and
 * never into the LocalStack container, because a container-side AWS_ENDPOINT_URL
 * would redirect LocalStack's own internal service-to-service calls and break them.
 *
 * When LOCALSTACK_HOSTNAME is unset / localhost (the default `npx` workflow), the
 * environment is returned unchanged so the wrappers use their built-in
 * localhost.localstack.cloud defaults — no behavior change for existing users.
 */
export function buildIacCliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...extra };

  const explicitHost = process.env.LOCALSTACK_HOSTNAME?.trim();
  if (!explicitHost || explicitHost === "localhost" || explicitHost === "127.0.0.1") {
    return base;
  }

  const port = String(LOCALSTACK_PORT);
  const endpoint = `http://${explicitHost}:${port}`;
  const s3Endpoint = `http://s3.${explicitHost}:${port}`;

  return {
    ...base,
    AWS_ENDPOINT_URL: base.AWS_ENDPOINT_URL || endpoint,
    AWS_ENDPOINT_URL_S3: base.AWS_ENDPOINT_URL_S3 || s3Endpoint,
    AWS_ENVAR_ALLOWLIST: base.AWS_ENVAR_ALLOWLIST || [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_DEFAULT_REGION",
      "AWS_REGION",
      "CDK_DEFAULT_ACCOUNT",
      "CDK_DEFAULT_REGION",
    ].join(","),
    LOCALSTACK_HOSTNAME: explicitHost,
    EDGE_PORT: base.EDGE_PORT || port,
    AWS_ACCESS_KEY_ID: base.AWS_ACCESS_KEY_ID || "test",
    AWS_SECRET_ACCESS_KEY: base.AWS_SECRET_ACCESS_KEY || "test",
    AWS_DEFAULT_REGION: base.AWS_DEFAULT_REGION || "us-east-1",
    AWS_REGION: base.AWS_REGION || base.AWS_DEFAULT_REGION || "us-east-1",
    CDK_DEFAULT_ACCOUNT: base.CDK_DEFAULT_ACCOUNT || "000000000000",
    CDK_DEFAULT_REGION: base.CDK_DEFAULT_REGION || base.AWS_DEFAULT_REGION || "us-east-1",
  };
}
