#!/usr/bin/env node
// Extracts the benchmark's "leak commands" into tests/fixtures/azure/leak-commands.json (plan
// section 5.4, L3 (c); reviews F17 and R02). These are the `az rest` calls the P1a arm of the
// CLI-vs-REST benchmark sent with an absolute https://management.azure.com URL: real-Azure
// requests that only the guard stopped. The policy must rewrite every one of them to a relative
// URL (src/lib/azure/policy.leak.test.ts), and the CI-only live replay in
// tests/azure/egress.live.test.ts sends their GET and DELETE calls to the job's own emulator.
//
//   node scripts/extract-leak-commands.mjs --source <results dir> [--out <file>] [--dry-run]
//
//   --source   the benchmark's results directory, whose `*-llm/runs.jsonl` files are read;
//              default: $AZURE_BENCH_RESULTS_DIR.
//   --out      default: tests/fixtures/azure/leak-commands.json
//   --dry-run  print the counts and the secret scan, and write nothing
//
// The source is only read. `g1_events` in those rows hold host names only, so the commands come
// from `tool_trace[i].args.command` where the tool is `run_azlocal_command`. Duplicates are merged
// in first-seen order (run directories sorted by name, rows and trace entries in file order).
//
// Before anything is written, every distinct command is scanned for secrets (JWTs, bearer
// tokens, SAS signatures, storage keys and connection strings, non-empty password or secret
// fields and flags, private keys, provider API keys, LocalStack tokens, high-entropy strings).
// A base64 DER blob that carries a private key (a PKCS#12 bundle) is redacted in the fixture:
// the URL rewrite does not depend on the body, and the replay never sends a PUT. Any other
// finding stops the script without writing. Values are never printed, only ids and categories.
//
// The plan counted 182 calls, 154 distinct, all from P1a (GET 87, POST 49, PUT 26, PATCH 13,
// DELETE 7, per call). The script prints its own counts and says whether they match.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(REPO_ROOT, "tests", "fixtures", "azure", "leak-commands.json");
const ARM = "https://management.azure.com";
const PLAN = {
  calls: 182,
  distinct: 154,
  byMethod: { GET: 87, POST: 49, PUT: 26, PATCH: 13, DELETE: 7 },
};
const REDACTED_BLOB = "REDACTED-BY-EXTRACT-LEAK-COMMANDS-PKCS12-WITH-PRIVATE-KEY";

class ScriptError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const opts = { source: process.env.AZURE_BENCH_RESULTS_DIR, out: DEFAULT_OUT, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--"))
        throw new ScriptError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--source") opts.source = value();
    else if (arg === "--out") opts.out = resolve(value());
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/extract-leak-commands.mjs --source <results dir> [--out <file>] [--dry-run]"
      );
      process.exit(0);
    } else throw new ScriptError(`unknown argument: ${arg}`);
  }
  if (!opts.source)
    throw new ScriptError("give --source <results dir> or set AZURE_BENCH_RESULTS_DIR");
  opts.source = resolve(opts.source);
  if (!existsSync(opts.source) || !statSync(opts.source).isDirectory())
    throw new ScriptError(`not a directory: ${opts.source}`);
  return opts;
}

/** az rest's method: the value of --method/-m, GET when absent (az's default). */
export function methodOf(command) {
  const match = /(?:^|\s)(?:--method|-m)(?:\s+|=)["']?([A-Za-z]+)/.exec(command);
  return (match ? match[1] : "get").toUpperCase();
}

function countBy(items, key, weight = () => 1) {
  const counts = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + weight(item);
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------------------------
// Secret scan

/** Values that are known dummies of the emulator and the benchmark (never secrets). */
const DUMMY_VALUES = new Set(["", "any-pass", "any-app", "dGVzdA==", "x"]);

/** Findings that stop the script: the pattern must never be in a checked-in fixture. */
const BLOCKING_PATTERNS = [
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g],
  ["bearer-token", /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  ["sas-signature", /[?&]sig=[A-Za-z0-9%+/=]{8,}/gi],
  [
    "storage-connection-string",
    /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;"'\s\\]{8,}/gi,
  ],
  ["storage-account-key", /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g],
  ["pem-private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic-api-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openai-api-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["localstack-auth-token", /\bls-[A-Za-z0-9]{4,12}(?:-[A-Za-z0-9]{4,12}){3,}\b/g],
];

/** JSON fields (escaped or not) whose non-dummy value is a secret. */
const SECRET_FIELD =
  /\\?["'](password|adminPassword|administratorLoginPassword|clientSecret|client_secret|secretValue|primaryKey|secondaryKey|primaryMasterKey|apiKey|accessKey|sharedKey|sasToken|connectionString|token|accessToken|refreshToken)\\?["']\s*:\s*\\?["']([^"'\\]*)/gi;

/** Flags whose non-dummy value is a secret. */
const SECRET_FLAG =
  /(?:^|\s)--(password|admin-password|client-secret|secret|sas-token|account-key|connection-string|token)(?:=|\s+)(["']?)([^\s"']*)/gi;

/** A long base64 run: a DER certificate, a PKCS#12 bundle, or a key. */
const BASE64_BLOB = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])/g;

// DER of the PKCS#12 bag types keyBag (1.2.840.113549.1.12.10.1.1) and pkcs8ShroudedKeyBag (.2),
// and the start of a PKCS#1 RSAPrivateKey (SEQUENCE, INTEGER 0, INTEGER modulus).
const KEY_BAG = Buffer.from("060b2a864886f70d010c0a0101", "hex");
const SHROUDED_KEY_BAG = Buffer.from("060b2a864886f70d010c0a0102", "hex");
const RSA_PRIVATE_KEY = /3082[0-9a-f]{4}020100028201/;

function derCarriesPrivateKey(base64) {
  let der;
  try {
    der = Buffer.from(base64, "base64");
  } catch {
    return false;
  }
  return (
    der.includes(KEY_BAG) ||
    der.includes(SHROUDED_KEY_BAG) ||
    RSA_PRIVATE_KEY.test(der.toString("hex"))
  );
}

/** Shannon entropy in bits per character. */
function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/** Hex ids, GUIDs and lower-case resource names are not secrets, however long. */
const BENIGN_TOKEN = /^(?:[0-9a-f-]+|[a-z0-9._-]+)$/;

/**
 * Scan one command. Returns the blocking findings, the redactions to apply, and the
 * informational high-entropy hits, each as a category and the matched length only.
 */
export function scanCommand(command) {
  const blocking = [];
  const redactions = [];
  const informational = [];
  for (const [category, pattern] of BLOCKING_PATTERNS) {
    for (const match of command.matchAll(pattern))
      blocking.push({ category, chars: match[0].length });
  }
  for (const match of command.matchAll(SECRET_FIELD)) {
    if (!DUMMY_VALUES.has(match[2]))
      blocking.push({ category: `field:${match[1]}`, chars: match[2].length });
  }
  for (const match of command.matchAll(SECRET_FLAG)) {
    if (!DUMMY_VALUES.has(match[3]))
      blocking.push({ category: `flag:--${match[1]}`, chars: match[3].length });
  }
  for (const match of command.matchAll(BASE64_BLOB)) {
    if (derCarriesPrivateKey(match[0])) {
      redactions.push({ category: "pkcs12-private-key", value: match[0], chars: match[0].length });
    } else {
      blocking.push({ category: "unknown-base64-blob", chars: match[0].length });
    }
  }
  // Catch-all for token formats the list does not know: long, mixed-case, high-entropy runs.
  const withoutBlobs = command.replace(BASE64_BLOB, " ");
  for (const token of withoutBlobs.split(/[\s"'\\,:;=&?/{}[\]()]+/)) {
    if (token.length >= 32 && !BENIGN_TOKEN.test(token) && entropy(token) >= 4.5)
      informational.push({ category: "high-entropy", chars: token.length });
  }
  return { blocking, redactions, informational };
}

// ---------------------------------------------------------------------------------------------
// Extraction

function readRuns(sourceDir) {
  const runs = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /-llm$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (runs.length === 0) throw new ScriptError(`no *-llm directories under ${sourceDir}`);
  const occurrences = [];
  const sourceFiles = [];
  for (const run of runs) {
    const file = join(sourceDir, run, "runs.jsonl");
    if (!existsSync(file)) {
      sourceFiles.push({ run, missing: true });
      continue;
    }
    const bytes = readFileSync(file);
    const lines = bytes.toString("utf8").split(/\r?\n/);
    let rows = 0;
    let p1aRows = 0;
    let calls = 0;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new ScriptError(`${run}/runs.jsonl line ${index + 1} is not JSON`, 1);
      }
      rows++;
      if (row.arm !== "P1a") return;
      p1aRows++;
      for (const entry of row.tool_trace ?? []) {
        const command = entry?.args?.command;
        if (entry?.name !== "run_azlocal_command" || typeof command !== "string") continue;
        if (!command.includes(ARM)) continue;
        calls++;
        occurrences.push({ command, run, task: row.task_id });
      }
    });
    sourceFiles.push({
      run,
      rows,
      p1aRows,
      calls,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { occurrences, sourceFiles };
}

function dedupe(occurrences) {
  const byCommand = new Map();
  for (const occurrence of occurrences) {
    const entry = byCommand.get(occurrence.command);
    if (entry) {
      entry.calls++;
      if (occurrence.task && !entry.tasks.includes(occurrence.task))
        entry.tasks.push(occurrence.task);
    } else {
      byCommand.set(occurrence.command, {
        method: methodOf(occurrence.command),
        calls: 1,
        tasks: occurrence.task ? [occurrence.task] : [],
        firstRun: occurrence.run,
        command: occurrence.command,
      });
    }
  }
  return [...byCommand.values()].map((entry, index) => ({
    id: `L${String(index + 1).padStart(3, "0")}`,
    ...entry,
  }));
}

function sameCounts(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { occurrences, sourceFiles } = readRuns(opts.source);
  const commands = dedupe(occurrences);

  // The scan runs on the commands as extracted, before any redaction or write.
  const blocking = [];
  const informational = [];
  const redactions = [];
  for (const entry of commands) {
    const scan = scanCommand(entry.command);
    for (const finding of scan.blocking) blocking.push({ id: entry.id, ...finding });
    for (const finding of scan.informational) informational.push({ id: entry.id, ...finding });
    for (const redaction of scan.redactions) {
      entry.command = entry.command.split(redaction.value).join(REDACTED_BLOB);
      redactions.push({ id: entry.id, category: redaction.category, chars: redaction.chars });
    }
  }
  // A redaction must leave no key material behind (re-scan the redacted commands), and must not
  // merge two commands that differed only in the redacted value.
  for (const entry of commands) {
    const rescan = scanCommand(entry.command);
    if (rescan.redactions.length > 0 || rescan.blocking.length > 0)
      throw new ScriptError(`${entry.id}: the redacted command still has findings`, 1);
  }
  if (new Set(commands.map((c) => c.command)).size !== commands.length)
    throw new ScriptError("two commands became identical after the redaction", 1);

  const calls = occurrences.length;
  const byMethod = countBy(
    commands,
    (c) => c.method,
    (c) => c.calls
  );
  const byMethodDistinct = countBy(commands, (c) => c.method);
  const orderedPlan = countBy(
    Object.entries(PLAN.byMethod),
    ([m]) => m,
    ([, n]) => n
  );

  console.log(`source: ${opts.source}`);
  for (const file of sourceFiles) {
    console.log(
      file.missing
        ? `  ${file.run}: no runs.jsonl`
        : `  ${file.run}: ${file.rows} rows, ${file.p1aRows} P1a, ${file.calls} leak calls`
    );
  }
  console.log(`calls: ${calls} (plan ${PLAN.calls})`);
  console.log(`distinct: ${commands.length} (plan ${PLAN.distinct})`);
  console.log(
    `by method, per call: ${JSON.stringify(byMethod)} (plan ${JSON.stringify(orderedPlan)})`
  );
  console.log(`by method, distinct: ${JSON.stringify(byMethodDistinct)}`);
  const matches =
    calls === PLAN.calls && commands.length === PLAN.distinct && sameCounts(byMethod, orderedPlan);
  console.log(
    matches ? "counts: match the plan" : "counts: DIFFER from the plan (record a deviation)"
  );

  console.log(`secret scan: ${commands.length} distinct commands scanned`);
  console.log(`  blocking findings: ${blocking.length}`);
  for (const finding of blocking)
    console.log(`    ${finding.id}: ${finding.category} (${finding.chars} chars)`);
  console.log(`  redacted: ${redactions.length}`);
  for (const r of redactions) console.log(`    ${r.id}: ${r.category} (${r.chars} base64 chars)`);
  console.log(`  high-entropy strings (informational): ${informational.length}`);
  for (const finding of informational) console.log(`    ${finding.id}: ${finding.chars} chars`);
  if (blocking.length > 0)
    throw new ScriptError("secret scan found values that must not be written", 1);

  const fixture = {
    _comment:
      "Generated by scripts/extract-leak-commands.mjs (plan section 5.4, L3 (c)). The P1a arm's " +
      "`az rest` calls with an absolute https://management.azure.com URL, deduplicated. Do not edit.",
    source:
      "<benchmark results>/*-llm/runs.jsonl: rows with arm P1a, " +
      "tool_trace[i].args.command where tool_trace[i].name is run_azlocal_command and the " +
      "command contains https://management.azure.com",
    sourceFiles,
    extractedAt: new Date().toISOString(),
    calls,
    distinct: commands.length,
    byMethod,
    byMethodDistinct,
    secretScan: {
      scanned: commands.length,
      blocking: 0,
      informational: informational.length,
      redacted: redactions.length,
      note:
        "Base64 PKCS#12 bundles that carry a private key (the benchmark's self-signed test " +
        `certificate) are replaced with ${REDACTED_BLOB}; nothing else was changed.`,
    },
    redactions,
    commands,
  };
  if (opts.dryRun) {
    console.log("dry run: nothing written");
    return;
  }
  writeFileSync(opts.out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${relative(REPO_ROOT, opts.out).split("\\").join("/")}`);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`extract-leak-commands: ${error instanceof Error ? error.message : error}`);
    process.exit(error instanceof ScriptError ? error.exitCode : 1);
  }
}
