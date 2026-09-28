import { loadEvalDataset, runEvalDataset } from "@gleanwork/mcp-server-tester";
import { test, expect } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// E1 (plan task 4.8): Gemini tool-trigger evals for the Azure tools, manual like the
// existing Gemini suite. The management case only reads status; run it in CI, or locally
// against an emulator you own (plan section 5.3's recipe).
function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

test.describe("Gemini Azure eval", () => {
  test.describe.configure({ timeout: 1800000 });

  test("the Azure eval dataset passes", async ({ mcp }, testInfo) => {
    requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
    requireEnv("LOCALSTACK_AUTH_TOKEN");

    const dataset = await loadEvalDataset("./data/evals/gemini-azure.json");
    const result = await runEvalDataset({ dataset }, { mcp, testInfo });
    const caseResults = result.caseResults || [];
    const passed = caseResults.filter((entry) => entry?.pass === true).length;
    for (const entry of caseResults.filter((e) => e?.pass !== true)) {
      console.error(`Eval case failed: ${entry.id}`);
      console.error(JSON.stringify(entry, null, 2));
    }
    console.log(`Azure eval pass rate: ${passed}/${caseResults.length}`);

    const passRate = caseResults.length > 0 ? passed / caseResults.length : 1;
    expect(passRate).toBeGreaterThanOrEqual(0.8);
  });
});
