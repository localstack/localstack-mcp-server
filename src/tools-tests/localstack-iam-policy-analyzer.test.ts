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
    expect(metadata.description).toContain("localstack-iam is recommended instead");
    expect(metadata.description).toContain("localstack-iam-management");
    expect(metadata.description).not.toMatch(/list-iam-denials|explain-iam|set-iam-mode/);
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

  test("get-status points to the read-only get-enforcement, set-mode to set-enforcement", () => {
    expect(RECOMMENDED_ALTERNATIVES["get-status"]).toContain(
      "`localstack-iam` with action `get-enforcement`"
    );
    expect(RECOMMENDED_ALTERNATIVES["set-mode"]).toContain("`localstack-iam-management`");
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
