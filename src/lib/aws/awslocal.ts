import type { DockerApiClient } from "../docker/docker.client";
import { awslocalExecEnv } from "./awslocal-endpoint.logic";

/**
 * Runs `awslocal <args>` inside the LocalStack container, pointed at the gateway's
 * container-side address (see `awslocal-endpoint.logic.ts`), so it works whatever host port
 * publishes the gateway and whatever `LOCALSTACK_HOST` says.
 */
export async function execAwslocal(
  dockerClient: DockerApiClient,
  containerId: string,
  args: string[]
) {
  const { env } = await dockerClient.inspectContainer(containerId);
  return dockerClient.executeInContainer(containerId, ["awslocal", ...args], undefined, {
    env: awslocalExecEnv(env),
  });
}
