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
    // The tester leaves iterations with infrastructure errors (rate limits, 5xx, network) out of
    // the pass rate, so 1 good iteration out of 5 can pass a case. Count them as failures instead.
    const thresholds = new Map(
      dataset.cases.map((c) => [c.id, Math.ceil((c.accuracyThreshold ?? 1) * (c.iterations ?? 1))])
    );
    // The tester drops a tool result's isError and keeps only its text, which this server starts
    // with ❌ on an error. A model can still read a usable answer out of an error's text, so each
    // required call needs at least one matching call that didn't fail.
    const cases = new Map(dataset.cases.map((c) => [c.id, c]));
    const matches = (call, expected) =>
      call.name === expected.name &&
      Object.entries(expected.arguments ?? {}).every(
        ([key, value]) => JSON.stringify(call.arguments?.[key]) === JSON.stringify(value)
      );
    const failedCalls = (entry, iteration) =>
      (cases.get(entry.id)?.expect?.toolsTriggered?.calls ?? [])
        .filter((expected) => expected.required)
        .filter(
          (expected) =>
            !(iteration.response?.toolCalls ?? []).some(
              (call) => matches(call, expected) && !String(call.output ?? "").startsWith("❌")
            )
        )
        .map((expected) => expected.name);
    const passesIteration = (entry, iteration) =>
      iteration.pass === true && failedCalls(entry, iteration).length === 0;
    const passesCase = (entry) =>
      entry?.pass === true &&
      (entry.iterationResults ?? [entry]).filter((r) => passesIteration(entry, r)).length >=
        thresholds.get(entry.id);
    const passed = caseResults.filter(passesCase).length;
    const failed = caseResults.filter((entry) => !passesCase(entry));

    if (failed.length > 0) {
      for (const entry of failed) {
        const errored = (entry.iterationResults ?? [entry]).map((r) => failedCalls(entry, r));
        console.error(
          `Eval case failed: ${entry.id} (infrastructure errors: ${entry.infrastructureErrorCount ?? 0}; required calls that only returned errors: ${JSON.stringify(errored)})`
        );
        console.error(JSON.stringify(entry, null, 2));
      }
    }
    console.log(`Eval pass rate: ${passed}/${caseResults.length}`);

    // Every case must pass. A case's own accuracyThreshold already absorbs flaky iterations, so a
    // case that fails here failed most of them, e.g. because its tool is broken.
    expect(caseResults).toHaveLength(dataset.cases.length);
    expect(failed.map((entry) => entry.id)).toEqual([]);
  });
});
