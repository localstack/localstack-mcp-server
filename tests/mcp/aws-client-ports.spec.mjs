import { expect, test } from "@playwright/test";
import { closeMCPClient, createMCPClientForConfig } from "@gleanwork/mcp-server-tester";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// localstack-aws-client and the deployer's CloudFormation actions run the AWS CLI through
// `lstk aws` where the server runs, against LOCALSTACK_HOSTNAME:LOCALSTACK_PORT. Each case starts
// its own LocalStack with a different gateway setup and its own MCP server pointed at it, then
// checks that the tools reach the gateway, that the URLs LocalStack returns name the host-side
// address (LOCALSTACK_HOST), and that a presigned URL works from the host.
//
// The containers get names unique to the run and are removed afterwards. Every case publishes
// its gateway on a free host port, never on 4566, so no case can take over the traffic of a
// LocalStack already running on the host. What makes the default case the default is the
// in-container configuration: the gateway on 4566 and no LOCALSTACK_HOST.

const IMAGE = process.env.LOCALSTACK_IMAGE_NAME?.trim() || "localstack/localstack-pro:latest";
const DEFAULT_GATEWAY_PORT = 4566;
const READY_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 300_000;
const RUN_ID = `${process.pid}-${Date.now()}`;

/** A port the OS reports free on every address (listening without a host binds `::` and 0.0.0.0). */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
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
 * which port the URLs LocalStack returns should name. Ports are picked when a case runs, not when
 * the file is collected.
 */
const CASES = [
  {
    title: "default gateway (container port 4566, no LOCALSTACK_HOST)",
    key: "default",
    async ports() {
      // Without LOCALSTACK_HOST, LocalStack names its own gateway port in the URLs it returns.
      // A presigned URL is built by the CLI on the host, so it names the host port anyway.
      const hostPort = await freePort();
      return {
        hostPort,
        containerPort: DEFAULT_GATEWAY_PORT,
        env: {},
        urlPort: DEFAULT_GATEWAY_PORT,
      };
    },
  },
  {
    title: "gateway published on a non-default host port, named by LOCALSTACK_HOST",
    key: "mapped",
    async ports() {
      const hostPort = await freePort();
      return {
        hostPort,
        containerPort: DEFAULT_GATEWAY_PORT,
        env: { LOCALSTACK_HOST: `localhost.localstack.cloud:${hostPort}` },
        urlPort: hostPort,
      };
    },
  },
  {
    title: "gateway moved by GATEWAY_LISTEN, published on another host port",
    key: "listen",
    async ports() {
      const containerPort = await freePort();
      const hostPort = await freePort();
      return {
        hostPort,
        containerPort,
        env: {
          GATEWAY_LISTEN: `0.0.0.0:${containerPort}`,
          LOCALSTACK_HOST: `localhost.localstack.cloud:${hostPort}`,
        },
        urlPort: hostPort,
      };
    },
  },
];

test.describe("aws-client and deployer reach LocalStack on any gateway port", () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeAll(() => {
    if (!process.env.LOCALSTACK_AUTH_TOKEN?.trim()) {
      throw new Error("Missing required environment variable: LOCALSTACK_AUTH_TOKEN");
    }
  });

  for (const { title, key, ports } of CASES) {
    test(title, async () => {
      const testCase = { key, ...(await ports()) };
      test.info().annotations.push({
        type: "ports",
        description: `host ${testCase.hostPort} -> container ${testCase.containerPort}`,
      });
      const name = `lsmcp-port-test-${testCase.key}-${RUN_ID}`;
      // The AWS client's working directory: the template and the file to upload live here.
      const workdir = realpathSync(mkdtempSync(join(tmpdir(), "lsmcp-port-test-")));
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
            LOCALSTACK_AWS_WORKDIR: workdir,
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
        const templatePath = join(workdir, "template.yaml");
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

        // s3 presign builds a URL for the caller without calling the gateway: it must name the
        // host-side port, and the host must be able to fetch it.
        const bucket = `ports-${testCase.key}-bucket`;
        writeFileSync(join(workdir, "hello.txt"), "hello\n");
        await aws(client, `s3 mb s3://${bucket}`);
        await aws(client, `s3api put-object --bucket ${bucket} --key hello.txt --body hello.txt`);
        const url = (await aws(client, `s3 presign s3://${bucket}/hello.txt`)).trim();
        expect(new URL(url).port).toBe(String(testCase.hostPort));
        const response = await fetch(url);
        expect(response.status, `GET ${url}`).toBe(200);
        expect(await response.text()).toBe("hello\n");
      } finally {
        if (client) await closeMCPClient(client);
        removeContainer(name);
        rmSync(workdir, { recursive: true, force: true });
      }
    });
  }
});
