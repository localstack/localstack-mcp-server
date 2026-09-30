#!/usr/bin/env node
// Builds fixtures/recorded-verifications.json, which tasks.test.ts replays, from live E2 runs:
//
//   node tests/azure/evals/run.mjs --oracle   --out test-results/e2-oracle
//   node tests/azure/evals/run.mjs --negative --out test-results/e2-negative
//   node tests/azure/evals/record-fixtures.mjs test-results/e2-oracle/runs.jsonl test-results/e2-negative/runs.jsonl
//
// For each (task, mode) it keeps the latest record that met its expectation (--oracle: the
// verifier passed; --negative: it failed) and holds exactly what the verifier read: the slots,
// the text, and every answer the verifier got (JSON stdout minified; connection-string key
// parts in the text, stdout and stderr, which no verifier reads, redacted). Records with a
// truncated input are skipped.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "fixtures", "recorded-verifications.json");

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error(
    "usage: node tests/azure/evals/record-fixtures.mjs <runs.jsonl> [<runs.jsonl> ...]"
  );
  process.exit(2);
}

const redact = (s) =>
  String(s ?? "")
    .replace(/(SharedAccessKey=)[^;"\\]+/g, "$1[redacted]")
    .replace(/(AccountKey=)[^;"\\]+/g, "$1[redacted]");

function minify(stdout) {
  const t = String(stdout ?? "");
  if (!t.trim()) return t;
  try {
    return redact(JSON.stringify(JSON.parse(t)));
  } catch {
    return redact(t);
  }
}

const latest = new Map();
for (const file of inputs) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!r.verify_input || r.success !== true || !["oracle", "negative"].includes(r.mode)) continue;
    if (r.verify_input.text_truncated) continue;
    if ((r.verifier?.queries ?? []).some((q) => q.answer?.stdout_truncated)) continue;
    latest.set(`${r.task_id}|${r.mode}`, r);
  }
}

const entries = [...latest.values()]
  .sort((a, b) => (a.task_id + a.mode < b.task_id + b.mode ? -1 : 1))
  .map((r) => ({
    task: r.task_id,
    mode: r.mode,
    passed: r.verifier.passed,
    wait_s: r.mode === "negative" ? 10 : 90,
    recorded: r.ended,
    slots: r.verify_input.slots,
    text: redact(r.verify_input.text),
    queries: (r.verifier.queries ?? []).map((q) => ({
      command: q.command,
      ...(q.repeat ? { repeat: q.repeat } : {}),
      answer: {
        exitCode: q.answer.exitCode,
        stdout: minify(q.answer.stdout),
        stderr: redact(q.answer.stderr).slice(0, 400),
        classId: q.answer.classId ?? null,
        ...(q.answer.stoppedByTool ? { stoppedByTool: true } : {}),
      },
    })),
  }));

const doc = {
  about:
    "Recorded answers of E2's verifiers from live runs against the LocalStack Azure emulator " +
    "(run.mjs --oracle: the verifier passed; --negative: setup only, the verifier failed). " +
    "tasks.test.ts replays each entry through its task's verifier and expects the recorded " +
    "verdict. All values are local emulator test data. Regenerate with record-fixtures.mjs.",
  entries,
};
// Written in the repo's Prettier layout, so `prettier --check` stays clean.
let text = JSON.stringify(doc, null, 2) + "\n";
try {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(OUT)) ?? {};
  text = await prettier.format(text, { ...options, parser: "json" });
} catch (error) {
  console.error(`prettier not available (${error.message}); writing plain JSON`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
console.log(
  `${entries.length} entries, ${Math.round(JSON.stringify(doc).length / 1024)} KB -> ${OUT}`
);
const modes = new Map();
for (const e of entries) modes.set(e.task, (modes.get(e.task) ?? new Set()).add(e.mode));
for (const [t, m] of modes) if (m.size < 2) console.log(`  ${t}: only ${[...m].join(", ")}`);
