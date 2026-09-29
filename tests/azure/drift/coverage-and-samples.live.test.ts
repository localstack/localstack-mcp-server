// Drift gates DR6 and DR8.
// DR6: every provider in the emulator's coverage list has an L2 matrix row (or a known gap).
// DR8: the samples corpus, regenerated from the samples repo, still tokenizes to bash's
// argv and passes the policy; new commands are reported.
import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { describeLive } from "../live/harness";
import { splitCliArgs } from "../../../src/lib/cli/argv";
import { evaluateAzCommand } from "../../../src/lib/azure/policy";
import { gatewayGet, REPO, writeReport } from "./drift-helpers";

/** Every `operations` entry anywhere in a parsed matrix file (cases and known gaps). */
function collectOperations(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOperations(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "operations" && Array.isArray(value)) {
        for (const op of value) if (typeof op === "string") out.push(op);
      } else {
        collectOperations(value, out);
      }
    }
  }
}

describeLive("DR6: coarse coverage", () => {
  test("every provider in /_localstack/coverage has an L2 matrix row", async () => {
    const coverage = JSON.parse((await gatewayGet("/_localstack/coverage")).body) as Array<{
      resource_provider: string;
      implemented?: boolean;
    }>;
    const providers = [
      ...new Set(coverage.filter((e) => e.implemented).map((e) => e.resource_provider)),
    ].sort();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require("yaml") as { parse(text: string): unknown };
    const dir = path.join(REPO, "tests/azure/matrix");
    const operations: string[] = [];
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      collectOperations(yaml.parse(readFileSync(path.join(dir, file), "utf8")), operations);
    }
    const covered = new Set(operations.map((op) => op.split(" ")[0]));
    const missing = providers.filter((p) => !covered.has(p));
    writeReport("dr6-coverage", { providers, covered: [...covered].sort(), missing });
    expect(missing).toEqual([]);
  });
});

const AZURE_TOKENIZER = {
  quotedControlChars: true,
  keepEmptyQuoted: true,
  bashDoubleQuoteEscapes: true,
} as const;

function python(): string {
  for (const candidate of [process.env.PYTHON, "python3", "python"].filter(Boolean) as string[]) {
    if (spawnSync(candidate, ["--version"], { timeout: 20_000 }).status === 0) return candidate;
  }
  throw new Error("DR8 needs Python (set PYTHON)");
}

// DR8 needs a samples checkout: the weekly job clones the samples repo's current commit.
const describeDr8 = process.env.AZURE_SAMPLES_DIR ? describeLive : describe.skip;

describeDr8("DR8: the samples corpus", () => {
  test("regenerated commands tokenize to bash's argv and pass the policy", () => {
    const corpusDir = path.join(REPO, "tests/fixtures/azure/corpus");
    const work = mkdtempSync(path.join(os.tmpdir(), "lsaz-dr8-"));
    try {
      const env = { ...process.env, CORPUS_WORK_DIR: work };
      for (const script of ["extract.py", "bash_argv.py"]) {
        const run = spawnSync(python(), [path.join(corpusDir, script)], {
          env,
          encoding: "utf8",
          timeout: 600_000,
        });
        if (run.status !== 0) throw new Error(`${script} failed:\n${run.stdout}\n${run.stderr}`);
      }
      const extracted = JSON.parse(readFileSync(path.join(work, "extracted.json"), "utf8"));
      const bash = JSON.parse(readFileSync(path.join(work, "bash.json"), "utf8"));
      const fixture = JSON.parse(
        readFileSync(path.join(corpusDir, "samples-az-corpus.json"), "utf8")
      );
      const known = new Map<string, { expect: "ok" | { ruleId: string } }>(
        fixture.cases.map((c: { command: string; expect: "ok" | { ruleId: string } }) => [
          c.command,
          c,
        ])
      );
      const opts = {
        workdir: "/work/samples",
        homeDir: "/work/.mcp/azure/home",
        platform: "linux" as const,
      };

      const unaccounted = extracted.reconciliation.flatMap(
        (r: { file: string; unaccounted: string[] }) => r.unaccounted.map((u) => `${r.file}:${u}`)
      );
      const argvMismatches: string[] = [];
      const newlyRefused: string[] = [];
      const newCommands = new Set<string>();
      extracted.commands.forEach(
        (c: { command: string; file: string; line: number }, i: number) => {
          const origin = `${c.file}:${c.line}`;
          const bashArgv: string[] | undefined = bash.argv[String(i)];
          if (!bashArgv) {
            argvMismatches.push(`${origin}: bash oracle refused it (${bash.refused[String(i)]})`);
            return;
          }
          let ours: string[] | undefined;
          try {
            ours = splitCliArgs(c.command, AZURE_TOKENIZER);
          } catch (error) {
            argvMismatches.push(`${origin}: tokenizer refused it (${(error as Error).message})`);
            return;
          }
          if (JSON.stringify(ours) !== JSON.stringify(bashArgv))
            argvMismatches.push(`${origin}: argv differs from bash`);
          const previous = known.get(c.command);
          if (!previous) newCommands.add(c.command);
          const verdict = evaluateAzCommand(c.command, opts);
          const expectedRefusal =
            previous && previous.expect !== "ok" ? previous.expect.ruleId : undefined;
          if (!verdict.ok && verdict.ruleId !== expectedRefusal)
            newlyRefused.push(`${origin}: ${verdict.ruleId}`);
        }
      );
      writeReport("dr8-samples-corpus", {
        sourceCommit: extracted.source_commit,
        fixtureCommit: fixture._metadata.source_commit,
        commands: extracted.commands.length,
        newCommands: [...newCommands],
        unaccounted,
        argvMismatches,
        newlyRefused,
      });
      expect(unaccounted).toEqual([]);
      expect(argvMismatches).toEqual([]);
      expect(newlyRefused).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
