import { expect, test } from "@playwright/test";
import { closeMCPClient, createMCPClientForConfig } from "@gleanwork/mcp-server-tester";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// localstack-aws-client and the deployer's CloudFormation actions run `awslocal` inside the
// LocalStack container. Each case starts its own LocalStack with a different gateway setup and
// its own MCP server pointed at it, then checks that the tools reach the gateway and that the URLs
// LocalStack returns still name the host-side address (LOCALSTACK_HOST).
//
// The containers get names unique to the run and are removed afterwards. No case touches another
// LocalStack: the default case publishes host port 4566 only when it is free, and otherwise
// publishes the same in-container defaults on a free port.

const IMAGE = process.env.LOCALSTACK_IMAGE_NAME?.trim() || "localstack/localstack-pro:latest";
const DEFAULT_GATEWAY_PORT = 4566;
const READY_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 300_000;
const RUN_ID = `${process.pid}-${Date.now()}`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function portIsFree(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Starts LocalStack with the given gateway setup; the auth token is passed by name only. */
function startLocalStack({ name, hostPort, containerPort, env }) {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `127.0.0.1:${hostPort}:${containerPort}`,
    "-e",
    "LOCALSTACK_AUTH_TOKEN",
    ...envArgs,
    IMAGE,
  ]);
}

function removeContainer(name) {
  try {
    docker(["rm", "-f", name]);
  } catch {
    // already gone
  }
}

async function waitForGateway(hostPort, name) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/_localstack/init/ready`);
      if (response.ok) {
        const body = await response.json();
        if (body.completed === true) return;
        last = JSON.stringify(body);
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  let logs = "";
  try {
    logs = docker(["logs", "--tail", "40", name]);
  } catch {}
  throw new Error(`LocalStack ${name} not ready on port ${hostPort}: ${last}\n${logs}`);
}

async function callRaw(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const text = (result.content ?? []).map((block) => block.text ?? "").join("\n");
  return { isError: result.isError === true, text };
}

async function call(client, name, args) {
  const { isError, text } = await callRaw(client, name, args);
  expect(isError, `${name} ${JSON.stringify(args)} failed:\n${text}`).toBe(false);
  return text;
}

const aws = (client, command) => call(client, "localstack-aws-client", { command });

async function waitForStackStatus(client, stackName, wanted) {
  const deadline = Date.now() + 120_000;
  let status = "";
  while (Date.now() < deadline) {
    const { isError, text } = await callRaw(client, "localstack-aws-client", {
      command: `cloudformation describe-stacks --stack-name ${stackName} --query Stacks[0].StackStatus --output text`,
    });
    // A deleted stack is no longer found by its name.
    if (isError && wanted === "DELETE_COMPLETE" && /does not exist/.test(text)) {
      status = wanted;
      break;
    }
    expect(isError, `describe-stacks failed:\n${text}`).toBe(false);
    status = text.trim();
    if (status === wanted || /FAILED|ROLLBACK/.test(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  expect(status).toBe(wanted);
}

/**
 * The cases: where the gateway listens inside the container, which host port publishes it, and
 * which port the URLs LocalStack returns should name.
 */
async function cases() {
  const defaultHostPort = (await portIsFree(DEFAULT_GATEWAY_PORT))
    ? DEFAULT_GATEWAY_PORT
    : await freePort();
  const mappedHostPort = await freePort();
  const listenContainerPort = await freePort();
  const listenHostPort = await freePort();
  return [
    {
      title: "default gateway (container port 4566, no LOCALSTACK_HOST)",
      key: "default",
      hostPort: defaultHostPort,
      containerPort: DEFAULT_GATEWAY_PORT,
      env: {},
      // Without LOCALSTACK_HOST, LocalStack names its own gateway port.
      urlPort: DEFAULT_GATEWAY_PORT,
    },
    {
      title: "gateway published on a non-default host port, named by LOCALSTACK_HOST",
      key: "mapped",
      hostPort: mappedHostPort,
      containerPort: DEFAULT_GATEWAY_PORT,
      env: { LOCALSTACK_HOST: `localhost.localstack.cloud:${mappedHostPort}` },
      urlPort: mappedHostPort,
    },
    {
      title: "gateway moved by GATEWAY_LISTEN, published on another host port",
      key: "listen",
      hostPort: listenHostPort,
      containerPort: listenContainerPort,
      env: {
        GATEWAY_LISTEN: `0.0.0.0:${listenContainerPort}`,
        LOCALSTACK_HOST: `localhost.localstack.cloud:${listenHostPort}`,
      },
      urlPort: listenHostPort,
    },
  ];
}

const CASES = await cases();

test.describe("aws-client and deployer reach LocalStack on any gateway port", () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeAll(() => {
    if (!process.env.LOCALSTACK_AUTH_TOKEN?.trim()) {
      throw new Error("Missing required environment variable: LOCALSTACK_AUTH_TOKEN");
    }
  });

  for (const testCase of CASES) {
    test(testCase.title, async () => {
      test.info().annotations.push({
        type: "ports",
        description: `host ${testCase.hostPort} -> container ${testCase.containerPort}`,
      });
      const name = `lsmcp-port-test-${testCase.key}-${RUN_ID}`;
      const templateDir = mkdtempSync(join(tmpdir(), "lsmcp-port-test-"));
      let client;
      try {
        startLocalStack({ name, ...testCase });
        await waitForGateway(testCase.hostPort, name);

        client = await createMCPClientForConfig({
          transport: "stdio",
          command: process.env.MCP_TEST_COMMAND || "node",
          args: process.env.MCP_TEST_ARGS
            ? process.env.MCP_TEST_ARGS.split(" ").filter(Boolean)
            : ["dist/cli.js"],
          cwd: process.cwd(),
          quiet: true,
          connectTimeoutMs: 30000,
          requestTimeoutMs: CALL_TIMEOUT_MS,
          callTimeoutMs: CALL_TIMEOUT_MS,
          env: {
            ...process.env,
            LOCALSTACK_HOSTNAME: "localhost",
            LOCALSTACK_PORT: String(testCase.hostPort),
            MAIN_CONTAINER_NAME: name,
            MCP_ANALYTICS_DISABLED: "1",
          },
        });

        // aws-client: create a queue; the URL LocalStack returns names the host-side port.
        const queue = `ports-${testCase.key}`;
        const created = JSON.parse(await aws(client, `sqs create-queue --queue-name ${queue}`));
        expect(created.QueueUrl).toContain(`:${testCase.urlPort}/`);

        // The returned URL works for later calls, and the message lands in the queue.
        await aws(client, `sqs send-message --queue-url ${created.QueueUrl} --message-body hello`);
        const attributes = JSON.parse(
          await aws(
            client,
            `sqs get-queue-attributes --queue-url ${created.QueueUrl} --attribute-names ApproximateNumberOfMessages`
          )
        );
        expect(attributes.Attributes.ApproximateNumberOfMessages).toBe("1");

        // deployer: create-stack and delete-stack, checked through the aws-client.
        const stackName = `ports-${testCase.key}-stack`;
        const stackQueue = `ports-${testCase.key}-stack-queue`;
        const templatePath = join(templateDir, "template.yaml");
        writeFileSync(
          templatePath,
          [
            "Resources:",
            "  Queue:",
            "    Type: AWS::SQS::Queue",
            "    Properties:",
            `      QueueName: ${stackQueue}`,
            "",
          ].join("\n")
        );
        await call(client, "localstack-deployer", {
          action: "create-stack",
          stackName,
          templatePath,
        });
        await waitForStackStatus(client, stackName, "CREATE_COMPLETE");
        expect(await aws(client, `sqs get-queue-url --queue-name ${stackQueue}`)).toContain(
          `:${testCase.urlPort}/`
        );

        await call(client, "localstack-deployer", { action: "delete-stack", stackName });
        await waitForStackStatus(client, stackName, "DELETE_COMPLETE");
      } finally {
        if (client) await closeMCPClient(client);
        removeContainer(name);
        rmSync(templateDir, { recursive: true, force: true });
      }
    });
  }
});
