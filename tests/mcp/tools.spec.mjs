import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// One deterministic call sequence per tool against a running LocalStack: no model involved, so
// these run on every pull request. The evals (evals.spec.mjs) cover whether a model picks and
// combines the tools; these cover whether each tool works.
//
// The tests share one LocalStack and run in order: the first starts LocalStack if needed, the
// deploy creates the bucket that later tests look for. To use an instance other than the
// default on 4566, set LOCALSTACK_PORT and MAIN_CONTAINER_NAME.

// The tester's callTool applies the MCP SDK's 60s request timeout; a start, a deploy or a Cloud
// Pod save can take longer, so call the SDK client directly.
const CALL_TIMEOUT_MS = 300_000;
const BUCKET = "mcpjam-eval-bucket"; // data/sample-terraform's default name_prefix
const POD = `mcp-tools-test-${process.env.GITHUB_RUN_ID ?? Date.now()}`;

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

  test("app-inspector: enables tracing", async ({ mcp }) => {
    await call(mcp, "localstack-app-inspector", { action: "set-status", status: "enabled" });
    const status = await call(mcp, "localstack-app-inspector", { action: "get-status" });
    expect(status).toContain("## App Inspector Status");
    expect(status).toMatch(/enabled/i);
  });

  test("deployer: applies the sample Terraform project", async ({ mcp }) => {
    const report = await call(mcp, "localstack-deployer", {
      action: "deploy",
      projectType: "terraform",
      directory: "data/sample-terraform",
    });
    expect(report).toContain("Apply complete!");
    expect(report).toContain(BUCKET);
  });

  test("aws-client: lists the deployed bucket", async ({ mcp }) => {
    expect(await call(mcp, "localstack-aws-client", { command: "s3 ls" })).toContain(BUCKET);
  });

  test("state-management: shows S3 state", async ({ mcp }) => {
    const state = await call(mcp, "localstack-state-management", { action: "inspect" });
    expect(state).toContain("## LocalStack State Inspect");
    expect(state).toMatch(/\bs3\b/i);
  });

  test("app-inspector: lists traces of the deploy", async ({ mcp }) => {
    const traces = await call(mcp, "localstack-app-inspector", { action: "list-traces" });
    expect(traces).toMatch(/## Traces \([1-9]\d*\)/);
  });

  test("logs-analysis: runs an errors analysis", async ({ mcp }) => {
    const logs = await call(mcp, "localstack-logs-analysis", { analysisType: "errors" });
    expect(logs).toMatch(/# 🚨 LocalStack Errors|✅ No errors found/);
  });

  test("iam-policy-analyzer: switches to soft mode", async ({ mcp }) => {
    expect(await call(mcp, "localstack-iam-policy-analyzer", { action: "get-status" })).toContain(
      "**LocalStack IAM Enforcement Status**"
    );
    await call(mcp, "localstack-iam-policy-analyzer", { action: "set-mode", mode: "SOFT_MODE" });
    expect(await call(mcp, "localstack-iam-policy-analyzer", { action: "get-status" })).toContain(
      "SOFT_MODE"
    );
  });

  test("chaos-injector: injects, reads and clears latency", async ({ mcp }) => {
    const tool = "localstack-chaos-injector";
    expect(await call(mcp, tool, { action: "inject-latency", latency_ms: 100 })).toContain(
      "Latency of 100ms has been injected"
    );
    expect(await call(mcp, tool, { action: "get-latency" })).toContain(
      "The current network latency is 100ms"
    );
    expect(await call(mcp, tool, { action: "clear-latency" })).toContain(
      "Network latency has been cleared"
    );
  });

  test("cloud-pods: saves, loads and deletes a pod", async ({ mcp }) => {
    const tool = "localstack-cloud-pods";
    try {
      expect(await call(mcp, tool, { action: "save", pod_name: POD })).toContain(
        "was saved successfully"
      );
      expect(await call(mcp, tool, { action: "load", pod_name: POD })).toContain(
        "Your LocalStack instance has been restored"
      );
    } finally {
      expect(await call(mcp, tool, { action: "delete", pod_name: POD })).toContain(
        "has been permanently deleted"
      );
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
