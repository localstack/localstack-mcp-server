// node --test evals/agentic/lib/summary.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "./summary.mjs";

const run = (scenario, pass, extra = {}) => ({
  scenario,
  pass,
  usedExpectedTools: pass,
  turns: 4,
  durationSeconds: 60,
  costUsd: 0.05,
  finalMessage: "SECRET-LOOKING final message",
  checks: [
    { type: "trigger_succeeds", pass },
    { type: "tool_called", pass: false, report: true, detail: "agent text | x" },
  ],
  ...extra,
});

const report = {
  provider: "openrouter:anthropic/claude-sonnet-5.5",
  startedAt: "2026-11-24T14-03-43-102Z",
  versions: { localstack: "2026.12.0.dev47", claudeCode: "2.1.322", commit: "1ebb881d33d4b0ac" },
  results: [
    run("06-central-event-bus", true),
    run("06-central-event-bus", false),
    run("07-cross-account-key", false, { error: "initial deploy failed", checks: [] }),
  ],
};

test("one row per scenario with pass rate, tools, turns, time, cost and failed checks", () => {
  const text = summarize(report);
  assert.match(text, /^### Agentic eval: 1\/3 passed/);
  assert.match(
    text,
    /\| 06-central-event-bus \| 1\/2 \| 1\/2 \| 4\.0 \| 60 s \| \$0\.100 \| trigger\\_succeeds \|/
  );
  assert.match(
    text,
    /\| 07-cross-account-key \| 0\/1 \| 0\/1 \| 4\.0 \| 60 s \| \$0\.050 \| error \|/
  );
  assert.match(text, /commit 1ebb881/);
  assert.match(text, /Total cost: \$0\.15/);
});

test("reported checks don't count as failed, and no agent text leaks", () => {
  const text = summarize(report);
  assert.doesNotMatch(text, /tool\\_called/);
  assert.doesNotMatch(text, /SECRET-LOOKING|agent text/);
});

test("markup in a value can't break the table", () => {
  const text = summarize({
    ...report,
    results: [run("x | y\n# z", true)],
  });
  const row = text.split("\n").find((line) => line.startsWith("| x"));
  assert.equal(row.split(/(?<!\\)\|/).length, 9);
  assert.doesNotMatch(text, /^# z/m);
});
