import type { DockerApiClient } from "../docker/docker.client";
import { awslocalExecEnv, buildsClientUrl } from "./awslocal-endpoint.logic";

/**
 * Runs `awslocal <args>` inside the LocalStack container, pointed at the gateway's
 * container-side address (see `awslocal-endpoint.logic.ts`), so it works whatever host port
 * publishes the gateway and whatever `LOCALSTACK_HOST` says. Commands that build a URL for
 * the caller keep `awslocal`'s own endpoint and need no container inspect.
 */
export async function execAwslocal(
  dockerClient: DockerApiClient,
  containerId: string,
  args: string[]
) {
  const containerEnv = buildsClientUrl(args)
    ? undefined
    : (await dockerClient.inspectContainer(containerId)).env;
  return dockerClient.executeInContainer(containerId, ["awslocal", ...args], undefined, {
    env: awslocalExecEnv(containerEnv, args),
  });
}
