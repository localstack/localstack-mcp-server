/**
 * L3 (c), the policy half (plan section 5.4; reviews F17 and R02): the benchmark's leak commands.
 *
 * The P1a arm of the CLI-vs-REST benchmark sent these `az rest` calls with an absolute
 * https://management.azure.com URL, so real Azure was their target and only the guard stopped
 * them. scripts/extract-leak-commands.mjs copied them from the run records into
 * tests/fixtures/azure/leak-commands.json. Every one must now be rewritten to a relative URL
 * before anything is spawned, with nothing else in the argv changed, and no argv element may
 * still name the ARM host, except as a `--resource` token audience (the leak commands have none).
 * The live half (GET and DELETE replayed on a CI emulator) is in tests/azure/egress.live.test.ts.
 */
import { splitCliArgs } from "../cli/argv";
import { evaluateAzCommand } from "./policy";
import type { PolicyOptions, PolicyResult } from "./types";

interface LeakCommand {
  id: string;
  method: string;
  calls: number;
  tasks: string[];
  command: string;
}
interface LeakFixture {
  calls: number;
  distinct: number;
  byMethod: Record<string, number>;
  byMethodDistinct: Record<string, number>;
  redactions: Array<{ id: string; category: string; chars: number }>;
  commands: LeakCommand[];
}

// resolveJsonModule is off, so the fixture is loaded with require and typed here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixture: LeakFixture = require("../../../tests/fixtures/azure/leak-commands.json");

// The three "variant P" options the Azure client uses (check C06), as in the policy.
const AZURE_TOKENIZER = {
  quotedControlChars: true,
  keepEmptyQuoted: true,
  bashDoubleQuoteEscapes: true,
} as const;

// Synthetic paths on both path flavours: the leak commands name no file, so the file rule
// passes them on either, and the URL rule does not depend on the platform.
const PLATFORMS: Array<[string, PolicyOptions]> = [
  ["linux", { workdir: "/work/project", homeDir: "/work/.mcp/azure/home", platform: "linux" }],
  [
    "win32",
    {
      workdir: "C:\\work\\project",
      homeDir: "C:\\work\\.mcp\\azure\\home",
      protectedDirs: ["C:\\Users\\me\\.azure"],
      platform: "win32",
    },
  ],
];

/** The ARM host itself; `schema.management.azure.com` is another host and does not count. */
const ARM_HOST = /(?<![A-Za-z0-9.-])management\.azure\.com/i;
const ARM_ORIGIN = /^https:\/\/management\.azure\.com(?::443)?/i;
const URL_FLAGS = new Set(["--url", "--uri", "-u"]);
const REDACTION_MARKER = "REDACTED-BY-EXTRACT-LEAK-COMMANDS-PKCS12-WITH-PRIVATE-KEY";

function ok(result: PolicyResult, id: string): Extract<PolicyResult, { ok: true }> {
  if (!result.ok) throw new Error(`${id}: refused ${result.ruleId}: ${result.message}`);
  return result;
}

/** Index of the URL value in an argv (`--url <v>`; the leak commands never use `--url=<v>`). */
function urlIndex(argv: string[]): number {
  const flag = argv.findIndex((token) => URL_FLAGS.has(token));
  return flag === -1 ? -1 : flag + 1;
}

describe("L3 leak commands (the benchmark's absolute management.azure.com calls)", () => {
  test("the fixture holds the plan's 154 distinct commands from 182 calls", () => {
    expect(fixture.calls).toBe(182);
    expect(fixture.distinct).toBe(154);
    expect(fixture.commands).toHaveLength(154);
    expect(new Set(fixture.commands.map((c) => c.command)).size).toBe(154);
    expect(fixture.commands.reduce((n, c) => n + c.calls, 0)).toBe(182);
    expect(fixture.byMethod).toEqual({ DELETE: 7, GET: 87, PATCH: 13, POST: 49, PUT: 26 });
    for (const leak of fixture.commands) {
      expect(leak.command.startsWith("rest ")).toBe(true);
      expect(leak.command).toContain("https://management.azure.com");
    }
  });

  test("no private key material is left in the fixture (the certificate bodies are redacted)", () => {
    const redacted = fixture.commands.filter((c) => c.command.includes(REDACTION_MARKER));
    expect(redacted.map((c) => c.id)).toEqual(fixture.redactions.map((r) => r.id));
    for (const leak of fixture.commands) {
      expect(leak.command).not.toMatch(/[A-Za-z0-9+/]{200,}/);
      expect(leak.command).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });

  describe.each(PLATFORMS)("through evaluateAzCommand (%s paths)", (_name, opts) => {
    test("every command is rewritten to a relative URL with a note", () => {
      const problems: string[] = [];
      for (const leak of fixture.commands) {
        const result = evaluateAzCommand(leak.command, opts);
        if (!result.ok) {
          problems.push(`${leak.id}: refused ${result.ruleId}`);
          continue;
        }
        if (result.outcome !== "rewritten") problems.push(`${leak.id}: outcome ${result.outcome}`);
        const value = result.argv[urlIndex(result.argv)];
        if (value === undefined || !value.startsWith("/"))
          problems.push(`${leak.id}: the URL is not relative: ${value}`);
        if (!result.notes.some((n) => n.startsWith("Rewrote the management.azure.com URL")))
          problems.push(`${leak.id}: no rewrite note`);
      }
      expect(problems.join("\n")).toBe("");
    });

    test("no argv element names the ARM host, except as a --resource audience", () => {
      const problems: string[] = [];
      let exempted = 0;
      for (const leak of fixture.commands) {
        const { argv } = ok(evaluateAzCommand(leak.command, opts), leak.id);
        argv.forEach((token, i) => {
          if (!ARM_HOST.test(token)) return;
          if (argv[i - 1] === "--resource" || token.startsWith("--resource=")) exempted++;
          else problems.push(`${leak.id}: argv[${i}] still names management.azure.com`);
        });
      }
      expect(problems.join("\n")).toBe("");
      // None of the leak commands asks for a token audience, so the exemption never applied.
      expect(exempted).toBe(0);
    });

    test("the rewrite keeps the path and query, and changes no other argv element", () => {
      const problems: string[] = [];
      for (const leak of fixture.commands) {
        const original = splitCliArgs(leak.command, AZURE_TOKENIZER);
        const { argv } = ok(evaluateAzCommand(leak.command, opts), leak.id);
        const at = urlIndex(original);
        if (at === -1 || argv.length !== original.length) {
          problems.push(`${leak.id}: argv shape changed`);
          continue;
        }
        const expected = original[at].replace(ARM_ORIGIN, "") || "/";
        if (argv[at] !== expected) problems.push(`${leak.id}: ${argv[at]} !== ${expected}`);
        original.forEach((token, i) => {
          if (i !== at && argv[i] !== token) problems.push(`${leak.id}: argv[${i}] changed`);
        });
      }
      expect(problems.join("\n")).toBe("");
    });
  });

  test("the only other management.azure.com names are ARM template $schema URIs in --body", () => {
    // The 20 deployment create and validate bodies carry
    // "$schema": "https://schema.management.azure.com/...": data sent to the emulator, which
    // az never fetches, and a different host from the ARM endpoint.
    const withSchemaHost: string[] = [];
    const outsideBody: string[] = [];
    for (const leak of fixture.commands) {
      const { argv } = ok(evaluateAzCommand(leak.command, PLATFORMS[0][1]), leak.id);
      argv.forEach((token, i) => {
        if (!/management\.azure\.com/i.test(token)) return;
        withSchemaHost.push(leak.id);
        const isBody = argv[i - 1] === "--body" || argv[i - 1] === "-b";
        if (!isBody || !/"\$schema":\s*"https:\/\/schema\.management\.azure\.com\//.test(token))
          outsideBody.push(`${leak.id}: argv[${i}]`);
      });
    }
    expect(outsideBody).toEqual([]);
    expect(new Set(withSchemaHost).size).toBe(20);
  });
});
