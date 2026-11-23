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

describe("localstack-iam-policy-analyzer recommends localstack-app-inspector", () => {
  test("the description recommends app-inspector without deprecating the tool", () => {
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

  test("an error keeps isError and gets the recommendation too", () => {
    const result = withRecommendation("set-mode", response("❌ **Failed**", true));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("set-iam-mode");
  });
});

test("the handler appends the recommendation, also to a preflight error", async () => {
  process.env.MCP_ANALYTICS_DISABLED = "1";
  delete process.env.LOCALSTACK_AUTH_TOKEN;
  // nothing may reach a real LocalStack
  global.fetch = jest.fn(async () => {
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }) as typeof fetch;
  const result = await localstackIamPolicyAnalyzer({ action: "set-mode", mode: "SOFT_MODE" });
  expect((result as { isError?: boolean }).isError).toBe(true);
  expect(result.content[0].text).toContain("Auth Token Required");
  expect(result.content[0].text).toContain("`set-iam-mode`");
});
