#!/usr/bin/env node
/**
 * Merges the L2 matrix shards' operation catalogues into one (the portal's inventory gate
 * reads the result). The rule of tests/azure/matrix/README.md: per
 * operation key, concatenate the cases and keep the best result (pass > gap_fixed >
 * known_gap > fail > setup_failed > skipped).
 *
 *   node scripts/ci/merge-op-catalogue.cjs --out <merged.json> <file-or-dir>...
 *
 * A directory is searched recursively for azure-op-catalogue*.json files.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const RESULT_RANK = { pass: 6, gap_fixed: 5, known_gap: 4, fail: 3, setup_failed: 2, skipped: 1 };
const rank = (result) => RESULT_RANK[result] ?? 0;

function mergeCatalogues(catalogues) {
  if (catalogues.length === 0) throw new Error("no catalogues to merge");
  for (const c of catalogues) {
    if (c.schemaVersion !== 1)
      throw new Error(`unsupported catalogue schemaVersion ${c.schemaVersion}`);
  }
  const cases = new Map();
  const implemented = new Map();
  for (const c of catalogues) {
    for (const [key, op] of Object.entries(c.operations ?? {})) {
      cases.set(key, [...(cases.get(key) ?? []), ...(op.cases ?? [])]);
      if (op.implemented !== null && op.implemented !== undefined && !implemented.has(key)) {
        implemented.set(key, op.implemented);
      }
    }
  }
  const operations = {};
  const summary = { operations: 0 };
  for (const key of [...cases.keys()].sort()) {
    const entries = cases.get(key);
    const best = entries.reduce((a, b) => (rank(b.result) > rank(a.result) ? b : a));
    const passing = entries.filter((e) => e.result === "pass" || e.result === "gap_fixed");
    const verified = passing.reduce(
      (latest, e) => (!latest || e.checked > latest.checked ? e : latest),
      undefined
    );
    operations[key] = {
      implemented: implemented.has(key) ? implemented.get(key) : null,
      result: best.result,
      verified: verified ? verified.checked : null,
      command: (verified ?? best).command,
      cases: entries,
    };
    summary.operations++;
    summary[best.result] = (summary[best.result] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    run: catalogues
      .map((c) => c.run)
      .filter(Boolean)
      .join(","),
    matrix: [...new Set(catalogues.map((c) => c.matrix))].join(","),
    shard: `merged ${catalogues.map((c) => c.shard).join(",")}`,
    backing: catalogues.every((c) => c.backing === true),
    coverageChecked: catalogues.some((c) => c.coverageChecked === true),
    extensionsInstalled: [
      ...new Set(catalogues.flatMap((c) => c.extensionsInstalled ?? [])),
    ].sort(),
    summary,
    operations,
  };
}

function findCatalogues(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => {
      const p = path.join(target, entry.name);
      if (entry.isDirectory()) return findCatalogues(p);
      return /^azure-op-catalogue.*\.json$/.test(entry.name) ? [p] : [];
    })
    .sort();
}

function main(argv) {
  const outIndex = argv.indexOf("--out");
  if (outIndex < 0 || !argv[outIndex + 1]) {
    console.error("usage: merge-op-catalogue.cjs --out <merged.json> <file-or-dir>...");
    return 2;
  }
  const out = argv[outIndex + 1];
  const inputs = argv.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  const files = inputs.flatMap(findCatalogues);
  if (files.length === 0) {
    console.error("merge-op-catalogue: no azure-op-catalogue*.json found");
    return 1;
  }
  const merged = mergeCatalogues(files.map((f) => JSON.parse(fs.readFileSync(f, "utf8"))));
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    `merged ${files.length} catalogues, ${merged.summary.operations} operations -> ${out}`
  );
  return 0;
}

module.exports = { mergeCatalogues, findCatalogues, RESULT_RANK };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
