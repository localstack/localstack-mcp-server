import { LOCALSTACK_PORT } from "./config";

/**
 * Build the environment for the spawned `lstk aws|terraform|cdk|sam` proxies so they
 * target the LocalStack endpoint this server is configured for.
 *
 * Why this is needed (verified against the lstk sources):
 *   - Without AWS_ENDPOINT_URL, lstk only accepts the AWS container named in its own
 *     config.toml, so a container this server started or found under another name
 *     (e.g. `localstack-main`), or LocalStack behind host.docker.internal, is
 *     rejected. With it, lstk probes `/_localstack/health` and uses that endpoint.
 *   - AWS_ENDPOINT_URL_S3 is left unset: lstk derives it and, for CDK >= 2.1138,
 *     forces path-style S3. A preset S3 endpoint turns that off.
 *
 * This env is injected ONLY into the lstk child processes — never globally and
 * never into the LocalStack container, because a container-side AWS_ENDPOINT_URL
 * would redirect LocalStack's own internal service-to-service calls and break them.
 *
 * A local LocalStack (LOCALSTACK_HOSTNAME unset / localhost, the default `npx`
 * workflow) is addressed as localhost.localstack.cloud, lstk's own default, so CDK
 * versions without path-style support still reach S3 through `s3.` virtual hosts.
 * Dummy credentials and CDK defaults are injected because CDK bootstrap requires
 * them even for LocalStack.
 */
/**
 * The LocalStack endpoint the lstk proxies target: localhost.localstack.cloud for a local
 * LocalStack, otherwise LOCALSTACK_HOSTNAME (host.docker.internal in the Docker image).
 */
export function localstackEndpointUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicitHost = env.LOCALSTACK_HOSTNAME?.trim().toLowerCase();
  // A DNS name or an IPv4 address. Anything else (an IPv6 address, `user@host`, `host:port`,
  // a path) would turn into a different host or port in the URL, or none at all.
  if (
    explicitHost &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(explicitHost)
  ) {
    throw new Error(
      `LOCALSTACK_HOSTNAME (${env.LOCALSTACK_HOSTNAME}) is not a host name: set it to a host name or IPv4 address only, such as host.docker.internal or 127.0.0.1, without a port, user or path. IPv6 addresses are not supported.`
    );
  }
  const port = String(env.LOCALSTACK_PORT || LOCALSTACK_PORT).trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(
      `LOCALSTACK_PORT (${env.LOCALSTACK_PORT}) is not a port: set it to a number from 1 to 65535, such as 4566.`
    );
  }
  const host =
    !explicitHost || explicitHost === "localhost" || explicitHost === "127.0.0.1"
      ? "localhost.localstack.cloud"
      : explicitHost;
  return `http://${host}:${Number(port)}`;
}

export function buildIacCliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...extra };

  return {
    ...base,
    AWS_ACCESS_KEY_ID: base.AWS_ACCESS_KEY_ID || "test",
    AWS_SECRET_ACCESS_KEY: base.AWS_SECRET_ACCESS_KEY || "test",
    AWS_DEFAULT_REGION: base.AWS_DEFAULT_REGION || "us-east-1",
    AWS_REGION: base.AWS_REGION || base.AWS_DEFAULT_REGION || "us-east-1",
    CDK_DEFAULT_ACCOUNT: base.CDK_DEFAULT_ACCOUNT || "000000000000",
    CDK_DEFAULT_REGION: base.CDK_DEFAULT_REGION || base.AWS_DEFAULT_REGION || "us-east-1",
    AWS_ENDPOINT_URL: base.AWS_ENDPOINT_URL || localstackEndpointUrl(),
  };
}
