// Tool tests live outside src/tools/ because xmcp registers every src/tools/*.ts as a tool.
import localstackIamPolicyAnalyzer, {
  RECOMMENDED_ALTERNATIVES,
  metadata,
  withRecommendation,
} from "../tools/localstack-iam-policy-analyzer";

const response = (text: string, isError?: boolean) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

describe("localstack-iam-policy-analyzer recommends the IAM tools", () => {
  test("the description recommends the IAM tools without deprecating this one", () => {
    expect(metadata.description).toMatch(/^Configures LocalStack's IAM enforcement/);
    expect(metadata.description).toContain("localstack-app-inspector is recommended instead");
    expect(metadata.description).not.toMatch(/deprecat|removed/i);
  });

  test.each(Object.entries(RECOMMENDED_ALTERNATIVES))(
    "every %s response recommends its alternative",
    (action, alternative) => {
      const text = withRecommendation(action, response("done")).content[0].text;
      expect(text.startsWith("done")).toBe(true);
      expect(text).toContain("**Recommended:**");
      expect(text).toContain(alternative);
      expect(text).not.toMatch(/deprecat|removed/i);
    }
  );

  test("covers every action of the schema", async () => {
    const { schema } = await import("../tools/localstack-iam-policy-analyzer");
    expect(Object.keys(RECOMMENDED_ALTERNATIVES).sort()).toEqual([...schema.action.options].sort());
  });

  test("get-status points to the read-only get-iam-mode, set-mode to set-iam-mode", () => {
    expect(RECOMMENDED_ALTERNATIVES["get-status"]).toContain(
      "`localstack-app-inspector` with action `get-iam-mode`"
    );
    expect(RECOMMENDED_ALTERNATIVES["set-mode"]).toContain("`localstack-app-inspector`");
  });
});

test("the handler adds no recommendation to an error", async () => {
  process.env.MCP_ANALYTICS_DISABLED = "1";
  delete process.env.LOCALSTACK_AUTH_TOKEN;
  // nothing may reach a real LocalStack
  global.fetch = jest.fn(async () => {
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }) as typeof fetch;
  const result = await localstackIamPolicyAnalyzer({ action: "set-mode", mode: "SOFT_MODE" });
  expect((result as { isError?: boolean }).isError).toBe(true);
  expect(result.content[0].text).toContain("Auth Token Required");
  expect(result.content[0].text).not.toContain("Recommended");
});

test("the handler adds no recommendation to a markdown failure", async () => {
  process.env.MCP_ANALYTICS_DISABLED = "1";
  process.env.LOCALSTACK_AUTH_TOKEN = "ls-FAKE";
  global.fetch = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/_localstack/health") return new Response(JSON.stringify({ services: {} }));
    if (path === "/_localstack/licenseinfo") {
      return new Response(
        JSON.stringify({ available_plugins: ["localstack.platform.plugin/iam-enforcement"] })
      );
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const result = await localstackIamPolicyAnalyzer({ action: "get-status", mode: undefined });
  expect(result.content[0].text).toMatch(/^\s*(❌|⚠️)/u);
  expect(result.content[0].text).not.toContain("Recommended");
});
