import { loadEvalDataset, runEvalDataset } from "@gleanwork/mcp-server-tester";
import { test, expect } from "@gleanwork/mcp-server-tester/fixtures/mcp";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

test.describe("Gemini comprehensive eval", () => {
  test.describe.configure({ timeout: 1800000 });

  test("single comprehensive eval dataset passes", async ({ mcp }, testInfo) => {
    requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
    requireEnv("LOCALSTACK_AUTH_TOKEN");

    const dataset = await loadEvalDataset("./data/evals/gemini-comprehensive.json");
    const result = await runEvalDataset({ dataset }, { mcp, testInfo });
    const caseResults = result.caseResults || [];
    const passed = caseResults.filter((entry) => entry?.pass === true).length;
    const failed = caseResults.filter((entry) => entry?.pass !== true);

    if (failed.length > 0) {
      console.error(
        "Comprehensive eval failed cases:",
        failed.map((entry) => entry.id)
      );
    }

    const passRate = caseResults.length > 0 ? passed / caseResults.length : 1;
    expect(passRate).toBeGreaterThanOrEqual(0.75);
  });
});
