import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// One deterministic call sequence per tool against a running LocalStack: no model involved, so
// these run on every pull request. The evals (evals.spec.mjs) cover whether a model picks and
// combines the tools; these cover whether each tool works.
//
// Each test checks the state a tool leaves behind, read back through another call, not only the
// tool's own success message: a tool that skips its API call but still reports success must fail.
//
// The tests share one LocalStack and run in order: the first starts LocalStack if needed, the
// deploy creates the bucket and queue that later tests look for. To use an instance other than
// the default on 4566, set LOCALSTACK_PORT and MAIN_CONTAINER_NAME.

// The tester's callTool applies the MCP SDK's 60s request timeout; a start, a deploy or a Cloud
// Pod save can take longer, so call the SDK client directly.
const CALL_TIMEOUT_MS = 300_000;
// A name_prefix other than data/sample-terraform's default, so the test sees the variable applied.
const PREFIX = "mcp-tools";
const BUCKET = `${PREFIX}-bucket`;
const QUEUE = `${PREFIX}-queue`;
// Unique per run and attempt, so a re-run never meets a pod an aborted attempt left behind.
const RUN = `${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`;
const POD = `mcp-tools-test-${RUN}`;

async function callRaw(mcp, name, args) {
  const result = await mcp.client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const text = (result.content ?? []).map((block) => block.text ?? "").join("\n");
  return { isError: result.isError === true, text };
}

// Returns the tool's text, failing with that text when the tool reports an error.
async function call(mcp, name, args) {
  const { isError, text } = await callRaw(mcp, name, args);
  expect(isError, `${name} ${JSON.stringify(args)} failed:\n${text}`).toBe(false);
  return text;
}

// Calls SQS ListQueues as the IAM user that owns `accessKeyId`. LocalStack identifies the caller by the access key
// in the Authorization header; it does not check the signature unless told to, so none is computed.
async function listQueuesAs(accessKeyId) {
  const endpoint = `http://${process.env.LOCALSTACK_HOSTNAME || "localhost"}:${process.env.LOCALSTACK_PORT || 4566}`;
  const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const response = await fetch(`${endpoint}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Amz-Date": date,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${date.slice(0, 8)}/us-east-1/sqs/aws4_request, SignedHeaders=host;x-amz-date, Signature=${"0".repeat(64)}`,
    },
    body: "Action=ListQueues&Version=2012-11-05",
  });
  await response.text();
}

test.describe("tools against a running LocalStack", () => {
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  test.beforeAll(() => {
    if (!process.env.LOCALSTACK_AUTH_TOKEN?.trim()) {
      throw new Error("Missing required environment variable: LOCALSTACK_AUTH_TOKEN");
    }
  });

  test("management: starts LocalStack and reports it ready", async ({ mcp }) => {
    const before = await callRaw(mcp, "localstack-management", { action: "status" });
    if (!/Services initialized/.test(before.text)) {
      await call(mcp, "localstack-management", { action: "start" });
    }
    const status = await call(mcp, "localstack-management", { action: "status" });
    expect(status).toMatch(/Services initialized: [1-9]\d*\/\d+/);
  });

  // Disabling first means the enable has to change something, whatever an earlier run left.
  test("app-inspector: disables and enables tracing", async ({ mcp }) => {
    const tool = "localstack-app-inspector";
    await call(mcp, tool, { action: "set-status", status: "disabled" });
    expect(await call(mcp, tool, { action: "get-status" })).toMatch(/\*\*Status:\*\* disabled\b/i);
    await call(mcp, tool, { action: "set-status", status: "enabled" });
    expect(await call(mcp, tool, { action: "get-status" })).toMatch(/\*\*Status:\*\* enabled\b/i);
  });

  test("deployer: applies the sample Terraform project with a variable", async ({ mcp }) => {
    const report = await call(mcp, "localstack-deployer", {
      action: "deploy",
      projectType: "terraform",
      directory: "data/sample-terraform",
      variables: { name_prefix: PREFIX },
    });
    expect(report).toContain("Apply complete!");
    // The outputs table, not the apply log, which also prints the outputs.
    expect(report).toContain(`| **bucket_name** | \`${BUCKET}\` |`);
  });

  test("aws-client: lists the deployed bucket and queue", async ({ mcp }) => {
    const tool = "localstack-aws-client";
    expect(await call(mcp, tool, { command: "s3 ls" })).toContain(BUCKET);
    // SQS is regional, so this also catches a client that talks to the wrong region.
    expect(await call(mcp, tool, { command: "sqs list-queues" })).toContain(QUEUE);
  });

  // The template is read by the AWS CLI where the server runs, then the stack's queue is read
  // back through the AWS client tool.
  test("deployer: creates and deletes a CloudFormation stack", async ({ mcp }) => {
    // Unique per run, so a run killed before its delete-stack never blocks the next one.
    const stackName = `${PREFIX}-cfn-${RUN}`;
    const queue = `${stackName}-queue`;
    const aws = (command) => call(mcp, "localstack-aws-client", { command });
    await call(mcp, "localstack-deployer", {
      action: "create-stack",
      stackName,
      templatePath: "data/sample-cloudformation/template.yaml",
    });
    try {
      await expect
        .poll(() => aws(`cloudformation describe-stacks --stack-name ${stackName}`), {
          timeout: 60_000,
        })
        .toContain("CREATE_COMPLETE");
      expect(await aws("sqs list-queues")).toContain(queue);
    } finally {
      await call(mcp, "localstack-deployer", { action: "delete-stack", stackName });
    }
    await expect.poll(() => aws("sqs list-queues"), { timeout: 60_000 }).not.toContain(queue);
  });

  // Each refusal must come from the tool, not from AWS: none of these may leave LocalStack or
  // touch a file outside the server's working directory.
  test("aws-client: keeps commands on LocalStack and in its working directory", async ({ mcp }) => {
    const refused = async (command, pattern) => {
      const { isError, text } = await callRaw(mcp, "localstack-aws-client", { command });
      expect(isError, `${command}:\n${text}`).toBe(true);
      expect(text, command).toMatch(pattern);
    };
    await refused(
      "s3api list-objects-v2 --bucket arn:aws:s3::123456789012:accesspoint/mcp.mrap",
      /Multi-Region Access Point ARNs are disabled/
    );
    await refused(
      "sqs list-queues --endp https://sqs.us-east-1.amazonaws.com",
      /target LocalStack/
    );
    await refused("s3 cp /etc/hosts s3://mcp-tools-bucket/hosts", /outside the AWS client's/);
    await refused("update", /not allowed/);
  });

  test("state-management: shows S3 state", async ({ mcp }) => {
    const state = await call(mcp, "localstack-state-management", { action: "inspect" });
    expect(state).toContain("## LocalStack State Inspect");
    expect(state).toMatch(/\bs3\b/i);
  });

  test("app-inspector: lists traces of the deploy", async ({ mcp }) => {
    const traces = await call(mcp, "localstack-app-inspector", { action: "list-traces" });
    expect(traces).toMatch(/## Traces \([1-9]\d*\)/);
    expect(traces).toMatch(/^\| [0-9a-f]{32} \|/m);
  });

  // xmcp drops parameters a tool does not declare; one declared for another action is rejected by the handler.
  test("app-inspector: rejects a trace filter on an IAM action over stdio", async ({ mcp }) => {
    const result = await callRaw(mcp, "localstack-app-inspector", {
      action: "list-iam-denials",
      trace_id: "t1",
    });
    expect(result.isError, result.text).toBe(true);
    expect(result.text).toContain("not a parameter of list-iam-denials");
  });

  // ENFORCED, then SOFT_MODE: a set-iam-mode that changes nothing fails one of the two read-backs.
  test("app-inspector: switches the IAM enforcement mode", async ({ mcp }) => {
    const tool = "localstack-app-inspector";
    try {
      for (const mode of ["ENFORCED", "SOFT_MODE"]) {
        await call(mcp, tool, { action: "set-iam-mode", mode });
        expect(await call(mcp, tool, { action: "get-iam-mode" })).toContain(
          `**Mode:** \`${mode}\``
        );
      }
    } finally {
      await callRaw(mcp, tool, { action: "set-iam-mode", mode: "DISABLED" });
    }
  });

  // A user without policies lists queues. App Inspector (enabled above) records the denial in SOFT_MODE, without blocking it, so
  // the IAM actions have something to list, explain and derive a policy from.
  test("app-inspector: lists, explains and derives a policy from an IAM denial", async ({
    mcp,
  }) => {
    const tool = "localstack-app-inspector";
    const user = `${PREFIX}-iam-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
    let accessKeyId;
    try {
      // DISABLED (the mode the previous test leaves) turns the IAM engine off, so nothing would be recorded.
      // SOFT_MODE records denials without blocking any request.
      await call(mcp, tool, { action: "set-iam-mode", mode: "SOFT_MODE" });
      await call(mcp, tool, { action: "clear-auto-derived-iam-policies" });
      expect(await call(mcp, tool, { action: "get-auto-derived-iam-policies" })).toContain(
        "No policies derived yet"
      );

      await call(mcp, "localstack-aws-client", { command: `iam create-user --user-name ${user}` });
      const key = await call(mcp, "localstack-aws-client", {
        command: `iam create-access-key --user-name ${user}`,
      });
      accessKeyId = key.match(/"AccessKeyId":\s*"(\w+)"/)?.[1];
      expect(accessKeyId, key).toBeTruthy();
      await listQueuesAs(accessKeyId);

      // App Inspector writes events in the background.
      let denials = "";
      await expect
        .poll(
          async () => {
            denials = await call(mcp, tool, { action: "list-iam-denials" });
            return denials;
          },
          { timeout: 30_000 }
        )
        .toMatch(new RegExp(`^\\|.*sqs:ListQueues.*${user}`, "m"));
      const row = denials.split("\n").find((line) => line.includes(user));
      const eventId = row.match(/^\| (\w+) \|/)?.[1];
      expect(eventId, row).toBeTruthy();
      const newerThan = denials.match(/keep `newer_than` `([^`]+)`/)?.[1];
      expect(newerThan, denials).toBeTruthy();

      const explanation = await call(mcp, tool, { action: "explain-iam", event_id: eventId });
      expect(explanation).toContain("sqs:ListQueues");
      expect(explanation).toContain(`user/${user}`);
      expect(explanation).not.toContain("Event payload (as LocalStack sent it)");
      const full = await call(mcp, tool, {
        action: "explain-iam",
        event_id: eventId,
        detail: "full",
      });
      expect(full).toContain("Event payload (as LocalStack sent it)");

      // A key the event does not have reaches the policy route and comes back as its documented error.
      const policy = await callRaw(mcp, tool, {
        action: "get-iam-policy",
        event_id: eventId,
        policy_key: "p999",
      });
      expect(policy.isError, policy.text).toBe(true);
      expect(policy.text).toContain("policy_not_in_event");

      // Nothing denied since: LocalStack's backward cursor returns no rows, and the cursor is kept.
      const none = await call(mcp, tool, { action: "list-iam-denials", newer_than: newerThan });
      expect(none).toContain("No denials since the previous call.");
      expect(none).toContain(`keep \`newer_than\` \`${newerThan}\``);
      // A new denial is returned under the same cursor.
      await listQueuesAs(accessKeyId);
      await expect
        .poll(async () => call(mcp, tool, { action: "list-iam-denials", newer_than: newerThan }), {
          timeout: 30_000,
        })
        .toContain("## New IAM Denials (1)");

      await expect
        .poll(async () => call(mcp, tool, { action: "get-auto-derived-iam-policies" }), {
          timeout: 30_000,
        })
        .toContain(user);
    } finally {
      if (accessKeyId) {
        await callRaw(mcp, "localstack-aws-client", {
          command: `iam delete-access-key --user-name ${user} --access-key-id ${accessKeyId}`,
        });
      }
      await callRaw(mcp, "localstack-aws-client", {
        command: `iam delete-user --user-name ${user}`,
      });
      await callRaw(mcp, tool, { action: "set-iam-mode", mode: "DISABLED" });
    }
  });

  test("logs-analysis: reports a failed request", async ({ mcp }) => {
    const missing = await callRaw(mcp, "localstack-aws-client", {
      command: `s3api head-bucket --bucket ${PREFIX}-missing-bucket`,
    });
    expect(missing.isError, missing.text).toBe(true);
    const logs = await call(mcp, "localstack-logs-analysis", { analysisType: "errors" });
    expect(logs).toContain("# 🚨 LocalStack Errors");
    expect(logs).toMatch(/HeadBucket/);
  });

  // ENFORCED, then SOFT_MODE: a set-mode that changes nothing fails one of the two read-backs.
  test("iam-policy-analyzer: switches enforcement modes", async ({ mcp }) => {
    const tool = "localstack-iam-policy-analyzer";
    try {
      for (const mode of ["ENFORCED", "SOFT_MODE"]) {
        await call(mcp, tool, { action: "set-mode", mode });
        const status = await call(mcp, tool, { action: "get-status" });
        expect(status).toContain(`**Current Mode:** \`${mode}\``);
        // every response recommends the app-inspector action for the same job
        expect(status).toContain(
          "**Recommended:** `localstack-app-inspector` with action `get-iam-mode`"
        );
      }
    } finally {
      await callRaw(mcp, tool, { action: "set-mode", mode: "DISABLED" });
    }
  });

  test("chaos-injector: injects, reads and clears latency", async ({ mcp }) => {
    const tool = "localstack-chaos-injector";
    try {
      expect(await call(mcp, tool, { action: "inject-latency", latency_ms: 100 })).toContain(
        "Latency of 100ms has been injected"
      );
      expect(await call(mcp, tool, { action: "get-latency" })).toContain(
        "The current network latency is 100ms"
      );
      expect(await call(mcp, tool, { action: "clear-latency" })).toContain(
        "Network latency has been cleared"
      );
      expect(await call(mcp, tool, { action: "get-latency" })).toContain(
        "The current network latency is 0ms"
      );
    } finally {
      await callRaw(mcp, tool, { action: "clear-latency" });
    }
  });

  // The bucket is removed after the save, so only a load that restores the pod brings it back.
  test("cloud-pods: saves, loads and deletes a pod", async ({ mcp }) => {
    const tool = "localstack-cloud-pods";
    let saved = false;
    try {
      expect(await call(mcp, tool, { action: "save", pod_name: POD })).toContain(
        "was saved successfully"
      );
      saved = true;
      await call(mcp, "localstack-aws-client", { command: `s3 rb s3://${BUCKET} --force` });
      expect(await call(mcp, "localstack-aws-client", { command: "s3 ls" })).not.toContain(BUCKET);
      expect(await call(mcp, tool, { action: "load", pod_name: POD })).toContain(
        "Your LocalStack instance has been restored"
      );
      expect(await call(mcp, "localstack-aws-client", { command: "s3 ls" })).toContain(BUCKET);
      expect(await call(mcp, tool, { action: "delete", pod_name: POD })).toContain(
        "has been permanently deleted"
      );
      saved = false;
      // A delete that did nothing would leave the pod, and a second delete would succeed.
      const again = await callRaw(mcp, tool, { action: "delete", pod_name: POD });
      expect(again.isError, again.text).toBe(true);
    } finally {
      // Clean up without asserting, so a failed save or load reports its own error.
      if (saved) await callRaw(mcp, tool, { action: "delete", pod_name: POD });
    }
  });

  test("aws-replicator: lists resource types and jobs", async ({ mcp }) => {
    const tool = "localstack-aws-replicator";
    expect(await call(mcp, tool, { action: "list-resources" })).toContain(
      "## AWS Replicator Supported Resources"
    );
    expect(await call(mcp, tool, { action: "list" })).toContain("## AWS Replicator Jobs");
  });

  test("extensions: lists the marketplace", async ({ mcp }) => {
    expect(await call(mcp, "localstack-extensions", { action: "available" })).toMatch(
      /[1-9]\d* extensions available\. Install any/
    );
  });

  test("ephemeral-instances: lists instances", async ({ mcp }) => {
    expect(await call(mcp, "localstack-ephemeral-instances", { action: "list" })).toContain(
      "## Ephemeral Instances"
    );
  });
});
