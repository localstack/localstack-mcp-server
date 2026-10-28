import { loadEvalDataset, runEvalDataset } from "@gleanwork/mcp-server-tester";
import { test, expect } from "@gleanwork/mcp-server-tester/fixtures/mcp";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

test.describe("OpenRouter comprehensive eval", () => {
  test.describe.configure({ timeout: 5400000 });

  test("single comprehensive eval dataset passes", async ({ mcp }, testInfo) => {
    requireEnv("OPENROUTER_API_KEY");
    requireEnv("LOCALSTACK_AUTH_TOKEN");

    const dataset = await loadEvalDataset("./data/evals/comprehensive.json");
    // EVAL_MODEL swaps the OpenRouter model for every case, e.g. anthropic/claude-sonnet-4.5.
    const model = process.env.EVAL_MODEL?.trim();
    if (model) {
      for (const evalCase of dataset.cases) {
        if (evalCase.mcpHostConfig) evalCase.mcpHostConfig.model = model;
      }
    }
    const result = await runEvalDataset({ dataset }, { mcp, testInfo });
    const caseResults = result.caseResults || [];
    const passed = caseResults.filter((entry) => entry?.pass === true).length;
    const failed = caseResults.filter((entry) => entry?.pass !== true);

    if (failed.length > 0) {
      for (const entry of failed) {
        console.error(`Eval case failed: ${entry.id}`);
        console.error(JSON.stringify(entry, null, 2));
      }
    }
    console.log(`Eval pass rate: ${passed}/${caseResults.length}`);

    const passRate = caseResults.length > 0 ? passed / caseResults.length : 1;
    expect(passRate).toBeGreaterThanOrEqual(0.75);
  });
});
