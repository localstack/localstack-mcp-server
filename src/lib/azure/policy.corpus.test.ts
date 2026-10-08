/**
 * The samples corpus through the shared tokenizer and the policy.
 *
 * Every `az` command in localstack-azure-samples (pinned commit) must tokenize to exactly the
 * bash-generated argv, and get the expected policy verdict: pass, except the seven sample steps
 * the policy refuses, recorded with their rule ids. The fixture and the scripts
 * that regenerate it live in tests/fixtures/azure/corpus/ (see its README).
 */
import { splitCliArgs } from "../cli/argv";
import { evaluateAzCommand } from "./policy";
import type { PolicyOptions } from "./types";

interface CorpusCase {
  command: string;
  argv: string[];
  origins: string[];
  expect: "ok" | { ruleId: string };
}
interface CorpusFixture {
  _metadata: {
    source_commit: string;
    distinct_count: number;
    refused_occurrences: number;
    command_count: number;
  };
  cases: CorpusCase[];
}

// resolveJsonModule is off, so the fixture is loaded with require and typed here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixture: CorpusFixture = require("../../../tests/fixtures/azure/corpus/samples-az-corpus.json");

// The three tokenizer options the Azure client uses.
const AZURE_TOKENIZER = {
  quotedControlChars: true,
  keepEmptyQuoted: true,
  bashDoubleQuoteEscapes: true,
} as const;

// A workdir the samples' relative paths (main.bicep, planner_website.zip, ...) resolve inside, so
// the file rule allows them. POSIX, for host-independent resolution.
const corpusOpts: PolicyOptions = {
  workdir: "/work/samples",
  homeDir: "/work/.mcp/azure/home",
  platform: "linux",
};

describe("samples corpus", () => {
  test("the fixture has 736 distinct cases and 7 refused occurrences", () => {
    expect(fixture.cases.length).toBe(736);
    expect(fixture._metadata.distinct_count).toBe(736);
    expect(fixture._metadata.command_count).toBe(1985);
    expect(fixture._metadata.refused_occurrences).toBe(7);
  });

  test("every case tokenizes to the expected bash argv and gets the expected verdict", () => {
    const tokenizerMismatches: string[] = [];
    const verdictMismatches: string[] = [];
    let refusedOccurrences = 0;

    for (const testCase of fixture.cases) {
      const argv = splitCliArgs(testCase.command, AZURE_TOKENIZER);
      if (JSON.stringify(argv) !== JSON.stringify(testCase.argv)) {
        tokenizerMismatches.push(
          `${testCase.origins[0]}: ${testCase.command}\n  got ${JSON.stringify(argv)}\n  want ${JSON.stringify(testCase.argv)}`
        );
      }

      const result = evaluateAzCommand(testCase.command, corpusOpts);
      if (testCase.expect === "ok") {
        if (!result.ok) {
          verdictMismatches.push(
            `${testCase.origins[0]}: expected ok, refused ${result.ruleId}: ${testCase.command}`
          );
        }
      } else {
        refusedOccurrences += testCase.origins.length;
        if (result.ok) {
          verdictMismatches.push(
            `${testCase.origins[0]}: expected refusal ${testCase.expect.ruleId}, got ok: ${testCase.command}`
          );
        } else if (result.ruleId !== testCase.expect.ruleId) {
          verdictMismatches.push(
            `${testCase.origins[0]}: expected ${testCase.expect.ruleId}, got ${result.ruleId}: ${testCase.command}`
          );
        }
      }
    }

    expect(tokenizerMismatches.join("\n")).toBe("");
    expect(verdictMismatches.join("\n")).toBe("");
    // Exactly the seven known sample steps are refused, no more, no fewer.
    expect(refusedOccurrences).toBe(7);
  });

  test("the seven expected refusals are the acr login and container exec sample steps", () => {
    const refused = fixture.cases.filter((c) => c.expect !== "ok");
    expect(refused).toHaveLength(2);
    const acrLogin = refused.find((c) => c.command.startsWith("acr login"));
    const containerExec = refused.find((c) => c.command.startsWith("container exec"));
    expect(acrLogin?.expect).toEqual({ ruleId: "denied:acr-login" });
    expect(acrLogin?.origins).toHaveLength(6);
    expect(containerExec?.expect).toEqual({ ruleId: "denied:container-exec" });
    expect(containerExec?.origins).toHaveLength(1);
    // And the policy really refuses them.
    expect(evaluateAzCommand(acrLogin!.command, corpusOpts).ok).toBe(false);
    expect(evaluateAzCommand(containerExec!.command, corpusOpts).ok).toBe(false);
  });
});
