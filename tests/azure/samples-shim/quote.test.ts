/**
 * The tests of the L4 test code: the `az` shim's quoting and its
 * envelope round trip. Runs in plain `yarn test`; no emulator, no real az.
 *
 * - Quoting: every argv of the samples corpus (and synthetic and random ones) goes
 *   through the shim's quote function and back through the tool's tokenizer unchanged,
 *   and never uses the `'\''` idiom the tokenizer refuses.
 * - Envelope: the shim writes the envelope's stdout to fd 1 and stderr plus notes to
 *   fd 2 byte for byte, and exits with az's code; checked in-process, through a real
 *   child process against a fake MCP server, and (where a usable bash exists) through
 *   `x=$(az ...)` in bash.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { splitCliArgs } from "../../../src/lib/cli/argv";
import { evaluateAzCommand } from "../../../src/lib/azure/policy";
import type { PolicyOptions } from "../../../src/lib/azure/types";

interface QuoteModule {
  SAFE_ARG: RegExp;
  quoteArg(arg: string): string;
  quoteArgv(argv: string[]): string;
  toToolCommand(argv: string[]): string;
}
interface Envelope {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notes: string[];
  classId: string | null;
  truncated: boolean;
}
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
interface OutputPlan {
  stdout: string;
  stderr: string;
  exitCode: number;
  record: Record<string, unknown>;
}
interface Writable {
  write(chunk: string | Buffer): boolean;
}
interface ShimModule {
  EXIT: { STOPPED: number; REFUSED: number; SHIM_ERROR: number };
  NOTE_PREFIX: string;
  RECURSION_VAR: string;
  readArgv(env: NodeJS.ProcessEnv, stdin: Buffer | undefined, fallback: string[]): string[];
  convertMsysDrivePaths(argv: string[], platform?: string): string[];
  workdirFor(argv: string[], cwd: string, root: string | undefined, platform?: string): string;
  serverEnv(
    parent: NodeJS.ProcessEnv,
    opts: { cwd: string; workdir?: string; platform?: string; shimDir?: string }
  ): Record<string, string>;
  childEnv(
    parent: NodeJS.ProcessEnv,
    opts?: { platform?: string; shimDir?: string }
  ): Record<string, string>;
  stripDirFromPath(value: string, dir: string, platform?: string): string;
  timeoutMsFrom(env: NodeJS.ProcessEnv): number;
  parseEnvelope(text: string | undefined): Envelope | null | undefined;
  planOutput(result: ToolResult, argv: string[], opts?: { newlines?: "keep" | "lf" }): OutputPlan;
  planAcrLoginRewrite(argv: string[]): { registry: string; toolArgv: string[] } | null;
  parseAcrToken(stdout: string): { accessToken: string; loginServer: string } | undefined;
  dockerLogin(
    token: { accessToken: string; loginServer: string },
    opts: { env: NodeJS.ProcessEnv; docker: string; stdout: Writable; stderr: Writable }
  ): Promise<number>;
}
interface CorpusCase {
  command: string;
  argv: string[];
  origins: string[];
  expect: "ok" | { ruleId: string };
}

// The modules are CommonJS files the bash shim runs with plain node; typed here.
/* eslint-disable @typescript-eslint/no-require-imports */
const quote = require("./quote.cjs") as QuoteModule;
const shim = require("./az-shim.cjs") as ShimModule;
const corpus = require("../../fixtures/azure/corpus/samples-az-corpus.json") as {
  cases: CorpusCase[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const SHIM_DIR = __dirname;
const SHIM_JS = path.join(SHIM_DIR, "az-shim.cjs");
const SHIM_BASH = path.join(SHIM_DIR, "az");

// The tokenizer options the Azure tool uses (policy.ts step 2).
const AZURE_OPTIONS = {
  quotedControlChars: true,
  keepEmptyQuoted: true,
  bashDoubleQuoteEscapes: true,
} as const;

// As in the samples corpus test (policy.corpus.test.ts): a workdir the samples' relative file names resolve inside.
const corpusOpts: PolicyOptions = {
  workdir: "/work/samples",
  homeDir: "/work/.mcp/azure/home",
  platform: "linux",
};

const POSIX_IDIOM = "'\\''";

// ---------------------------------------------------------------------------------------
describe("shim quoting: the samples corpus", () => {
  test("the fixture has the 736 distinct commands of the samples corpus", () => {
    expect(corpus.cases).toHaveLength(736);
  });

  test("every corpus argv survives quote -> splitCliArgs unchanged, without the '\\'' idiom", () => {
    const mismatches: string[] = [];
    for (const c of corpus.cases) {
      const quoted = quote.quoteArgv(c.argv);
      if (quoted.includes(POSIX_IDIOM)) mismatches.push(`uses '\\'': ${quoted}`);
      const back = splitCliArgs(quoted, AZURE_OPTIONS);
      if (JSON.stringify(back) !== JSON.stringify(c.argv)) {
        mismatches.push(`${c.origins[0]}\n  sent ${quoted}\n  got  ${JSON.stringify(back)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("the shim's command gets the same policy verdict and argv as the sample's own quoting", () => {
    const mismatches: string[] = [];
    let refused = 0;
    for (const c of corpus.cases) {
      const viaShim = evaluateAzCommand(quote.toToolCommand(c.argv), corpusOpts);
      if (c.expect === "ok") {
        if (!viaShim.ok) {
          mismatches.push(`${c.origins[0]}: refused ${viaShim.ruleId}`);
        } else if (JSON.stringify(viaShim.argv) !== JSON.stringify(c.argv)) {
          mismatches.push(`${c.origins[0]}: argv ${JSON.stringify(viaShim.argv)}`);
        }
      } else {
        refused++;
        if (viaShim.ok || viaShim.ruleId !== c.expect.ruleId) {
          mismatches.push(`${c.origins[0]}: expected ${c.expect.ruleId}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // The two known-gap commands (seven occurrences): acr login, container exec.
    expect(refused).toBe(2);
  });
});

describe("shim quoting: synthetic and random argv", () => {
  const cases: Array<[string, string[]]> = [
    ["empty strings", ["keyvault", "secret", "set", "--value", "", "--name", ""]],
    ["only an empty string", [""]],
    ["dollar forms", ["x", "$HOME", "${HOME}", "$(whoami)", "$Default", "a$", "$"]],
    ["backslash escapes", ["x", "\\$Default", "\\`", '\\"', "\\\\", "\\", "a\\", "\\\n"]],
    ["backticks", ["x", "`whoami`", "[?tags.env==`dev`].name", "join(`,`, a)"]],
    ["newlines and CR", ["x", "line1\nline2", "crlf\r\n", "\r", "\n", "a\n\nb"]],
    ["tabs and spaces", ["x", "a b", " lead", "trail ", "\t", "  ", "a\tb"]],
    ["single quotes", ["x", "it's", "'", "''", "'\\''", "it'\\''s", "'a'"]],
    ["double quotes", ["x", '"', '""', 'say "hi"', '\\"quoted\\"']],
    ["Windows paths", ["x", "C:\\Users\\dev\\app.zip", "\\\\host\\share\\x", "C:\\x\\"]],
    ["non-ASCII", ["x", "é", "日本語", "😀", "a\u00a0b", "\u2028", "\ufeff", "Ωmega"]],
    ["JSON", ["x", '{"a": [1, "b"], "c": {"d": null}}', "[]", "{}", '[{"k":"v"}]']],
    [
      "multi-line JSON (monitor diagnostic-settings)",
      ["x", '[\n\t\t\t{"category": "AllMetrics", "enabled": true}\n\t\t]'],
    ],
    [
      "JMESPath",
      [
        "x",
        "[?name=='a b'].id | [0]",
        "[?key=='PG_HOST' || key=='PG_PORT'].key",
        "join(',', rights)",
        "{name:name, partitions:partitionCount}",
        "length(@) > `0`",
      ],
    ],
    ["KQL", ["x", "Resources | where type =~ 'x' | project name, id | take 5 > 1"]],
    ["shell metacharacters", ["x", ";", "&&", "|", "a|b", "<in", ">out", "a&b", "2>&1"]],
    ["comment and globs", ["x", "#note", "#", "*", "?", "[a-z]*", "~", "~/.ssh/id_rsa", "!"]],
    ["connection string", ["x", "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=k=="]],
    ["flags", ["x", "--flag=value with space", "-", "--", "-1", "=", "--a=", "@file.json"]],
    ["percent", ["x", "%VAR%", "!VAR!", "100%"]],
    ["ARM ids", ["role", "assignment", "list", "--scope", "/subscriptions/0/resourceGroups/rg"]],
    ["a long value", ["x", "a b ".repeat(25_000)]],
  ];

  test.each(cases)("%s", (_name, argv) => {
    const quoted = quote.quoteArgv(argv);
    expect(splitCliArgs(quoted, AZURE_OPTIONS)).toEqual(argv);
    expect(quoted).not.toContain(POSIX_IDIOM);
  });

  test("3000 random argv round-trip (seeded)", () => {
    const alphabet = [
      ..."aZ09-_./:=@%+,",
      " ",
      "\t",
      "\n",
      "\r",
      "'",
      '"',
      "\\",
      "$",
      "`",
      ..."(){}[]|&;<>#~*?!",
      "é",
      "日",
      "😀",
      "\u00a0",
      "\u2028",
      "\ufeff",
    ];
    let seed = 0x5eed;
    const random = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const failures: string[] = [];
    for (let n = 0; n < 3000; n++) {
      const argv = Array.from({ length: Math.floor(random() * 7) }, () =>
        Array.from(
          { length: Math.floor(random() * 13) },
          () => alphabet[Math.floor(random() * alphabet.length)]
        ).join("")
      );
      const quoted = quote.quoteArgv(argv);
      const back = splitCliArgs(quoted, AZURE_OPTIONS);
      if (JSON.stringify(back) !== JSON.stringify(argv) || quoted.includes(POSIX_IDIOM)) {
        failures.push(JSON.stringify(argv));
      }
    }
    expect(failures).toEqual([]);
  });

  test("safe words stay bare; everything else is double-quoted, never single-quoted", () => {
    expect(quote.quoteArg("--resource-group")).toBe("--resource-group");
    expect(quote.quoteArg("/subscriptions/0/x")).toBe("/subscriptions/0/x");
    expect(quote.quoteArg("a=b,c:d@e%f+g")).toBe("a=b,c:d@e%f+g");
    expect(quote.quoteArg("")).toBe('""');
    expect(quote.quoteArg("it's")).toBe(`"it's"`);
    expect(quote.quoteArg('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quote.quoteArg("~")).toBe('"~"');
  });

  test("toToolCommand keeps one leading az (the tool strips exactly one)", () => {
    expect(quote.toToolCommand([])).toBe("az");
    expect(quote.toToolCommand(["group", "list"])).toBe("az group list");
    const doubled = evaluateAzCommand(quote.toToolCommand(["az", "group", "list"]), corpusOpts);
    expect(doubled.ok).toBe(false);
  });

  test("NUL and non-string arguments are refused", () => {
    expect(() => quote.quoteArg("a\0b")).toThrow(/NUL/);
    expect(() => quote.quoteArg(1 as unknown as string)).toThrow(TypeError);
    expect(() => quote.quoteArgv("group list" as unknown as string[])).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------
describe("shim: argv from the bash half", () => {
  const nul = (fields: string[]) => Buffer.from(fields.map((f) => `${f}\0`).join(""), "utf8");

  test("NUL-separated fields decode exactly, empty ones and newlines included", () => {
    const argv = ["group", "show", "", "a\nb", "日本 é", "--query", "[?a=='b']"];
    expect(shim.readArgv({ AZ_SHIM_ARGC: String(argv.length) }, nul(argv), ["fallback"])).toEqual(
      argv
    );
  });

  test("zero arguments, and the process.argv fallback without AZ_SHIM_ARGC", () => {
    expect(shim.readArgv({ AZ_SHIM_ARGC: "0" }, Buffer.alloc(0), ["x"])).toEqual([]);
    expect(shim.readArgv({}, undefined, ["group", "list"])).toEqual(["group", "list"]);
  });

  test("a count that does not match the stream is an error", () => {
    expect(() => shim.readArgv({ AZ_SHIM_ARGC: "3" }, nul(["a", "b"]), [])).toThrow(/expected 3/);
    expect(() => shim.readArgv({ AZ_SHIM_ARGC: "1" }, Buffer.from("a"), [])).toThrow();
    expect(() => shim.readArgv({ AZ_SHIM_ARGC: "x" }, undefined, [])).toThrow(/count/);
  });
});

describe("shim: the server's environment", () => {
  test("POSIX: the shim dir leaves PATH; envelope, workdir and the recursion guard are set", () => {
    const env = shim.serverEnv(
      {
        PATH: "/repo/tests/azure/samples-shim:/usr/bin::/repo/tests/azure/samples-shim/",
        LOCALSTACK_AZ_WORKDIR: "/elsewhere",
        LOCALSTACK_AZ_PATH: "/opt/az/bin/python3",
        AZ_SHIM_ARGC: "2",
        AZ_SHIM_LOG: "/tmp/log",
        HOME: "/tmp/private-home",
      },
      {
        cwd: "/samples/eventhubs/python/scripts",
        platform: "linux",
        shimDir: "/repo/tests/azure/samples-shim",
      }
    );
    expect(env.PATH).toBe("/usr/bin:");
    expect(env.LOCALSTACK_AZ_TEST_ENVELOPE).toBe("1");
    expect(env.LOCALSTACK_AZ_WORKDIR).toBe("/samples/eventhubs/python/scripts");
    expect(env.LOCALSTACK_AZ_PATH).toBe("/opt/az/bin/python3");
    expect(env.HOME).toBe("/tmp/private-home");
    expect(env.MCP_ANALYTICS_DISABLED).toBe("1");
    expect(env[shim.RECURSION_VAR]).toBe("1");
    expect(Object.keys(env).filter((k) => k.startsWith("AZ_SHIM_"))).toEqual([]);
  });

  test("Windows: PATH matches case-insensitively, whatever the key's case", () => {
    const env = shim.serverEnv(
      {
        Path: "C:\\Repo\\Tests\\Azure\\Samples-Shim\\;C:\\Windows;C:\\repo\\tests\\azure\\samples-shim",
        MCP_ANALYTICS_DISABLED: "0",
      },
      { cwd: "C:\\work", platform: "win32", shimDir: "c:\\repo\\tests\\azure\\samples-shim" }
    );
    expect(env.PATH).toBe("C:\\Windows");
    expect(env.Path).toBeUndefined();
    expect(env.MCP_ANALYTICS_DISABLED).toBe("0");
  });

  test("the timeout is the tool's limit plus 300 s, or AZ_SHIM_TIMEOUT_SECONDS", () => {
    expect(shim.timeoutMsFrom({})).toBe(600_000);
    expect(shim.timeoutMsFrom({ LOCALSTACK_AZ_TIMEOUT_SECONDS: "1800" })).toBe(2_100_000);
    expect(shim.timeoutMsFrom({ AZ_SHIM_TIMEOUT_SECONDS: "0.5" })).toBe(500);
  });
});

// ---------------------------------------------------------------------------------------
const envelopeResult = (envelope: Partial<Envelope>, text = "answer"): ToolResult => ({
  content: [
    { type: "text", text },
    {
      type: "text",
      text: JSON.stringify({
        exitCode: 0,
        stdout: "",
        stderr: "",
        notes: [],
        classId: null,
        truncated: false,
        ...envelope,
      }),
    },
  ],
});

// The round-trip case: a successful command that also printed a warning.
const WARN_ENVELOPE: Partial<Envelope> = {
  exitCode: 0,
  stdout:
    '[\n  {\n    "id": "/subscriptions/0/resourceGroups/rg-é",\n    "name": "rg-é 日本",\n    "tags": {"k": "a;b $x `y`"}\n  }\n]\n',
  stderr: "WARNING: This command is in preview and under development.\n",
};

describe("shim: from the envelope to fd 1, fd 2 and the exit code", () => {
  test("success with a warning: stdout and stderr exactly, exit 0", () => {
    const plan = shim.planOutput(envelopeResult(WARN_ENVELOPE), ["group", "list"]);
    expect(plan.stdout).toBe(WARN_ENVELOPE.stdout);
    expect(plan.stderr).toBe(WARN_ENVELOPE.stderr);
    expect(plan.exitCode).toBe(0);
    expect(plan.record).toMatchObject({ envelope: true, azExitCode: 0 });
  });

  test("notes follow az's stderr on fd 2, one prefixed line each", () => {
    const plan = shim.planOutput(
      envelopeResult({ stdout: "x\n", stderr: "WARNING: w", notes: ["Note: one", "Note: two"] }),
      ["rest"]
    );
    expect(plan.stdout).toBe("x\n");
    expect(plan.stderr).toBe(
      `WARNING: w\n${shim.NOTE_PREFIX}Note: one\n${shim.NOTE_PREFIX}Note: two\n`
    );
  });

  test("az's failure exit code passes through, with its stdout and stderr", () => {
    const plan = shim.planOutput(
      envelopeResult(
        {
          exitCode: 3,
          stdout: "",
          stderr: "ERROR: (ResourceNotFound) not found\n",
          classId: "not-found",
        },
        "❌ **Command Failed** (exit 3, not-found)"
      ),
      ["group", "show", "--name", "x"]
    );
    expect(plan.exitCode).toBe(3);
    expect(plan.stdout).toBe("");
    expect(plan.stderr).toBe("ERROR: (ResourceNotFound) not found\n");
    expect(plan.record).toMatchObject({
      classId: "not-found",
      toolFirstLine: expect.stringContaining("exit 3"),
    });
  });

  test("the tool stopped az (exitCode null): exit 1 and the tool's reason on fd 2", () => {
    const text = "❌ **Command Failed** (exit none, timeout)\n\nThe command ran longer than 300 s.";
    const plan = shim.planOutput(envelopeResult({ exitCode: null, stderr: "partial" }, text), [
      "x",
    ]);
    expect(plan.exitCode).toBe(shim.EXIT.STOPPED);
    expect(plan.stderr).toBe(`partial\n${shim.NOTE_PREFIX}${text}\n`);
  });

  test("`exit none` wins over the killed process's code (taskkill's 1, a fail-fast 0)", () => {
    for (const [code, cls] of [
      [1, "timeout"],
      [0, "egress-refused"],
    ] as const) {
      const text = `❌ **Command Failed** (exit none, ${cls})\n\nwhy`;
      const plan = shim.planOutput(envelopeResult({ exitCode: code, stdout: "{}" }, text), ["x"]);
      expect(plan.exitCode).toBe(shim.EXIT.STOPPED);
      expect(plan.stdout).toBe("{}");
      expect(plan.stderr).toContain(`${shim.NOTE_PREFIX}❌ **Command Failed** (exit none, ${cls})`);
    }
  });

  test("an exit code outside 0-255 becomes 1", () => {
    const plan = shim.planOutput(envelopeResult({ exitCode: 3221225477 }), ["x"]);
    expect(plan.exitCode).toBe(1);
  });

  test("a refusal (no envelope): exit 2, the refusal on fd 2, nothing on fd 1", () => {
    const text = "❌ **Command refused**\n\n`container exec` opens an interactive shell.";
    const plan = shim.planOutput({ content: [{ type: "text", text }] }, ["container", "exec"]);
    expect(plan).toMatchObject({ stdout: "", stderr: `${text}\n`, exitCode: shim.EXIT.REFUSED });
    expect(plan.record).toMatchObject({ refusal: "❌ **Command refused**" });
    const isError = shim.planOutput({ content: [{ type: "text", text: "bad" }], isError: true }, [
      "x",
    ]);
    expect(isError.exitCode).toBe(shim.EXIT.REFUSED);
  });

  test("the local `version` answer: its JSON on fd 1, the sentence on fd 2", () => {
    const body = JSON.stringify({ "azure-cli-core": "2.87.0", extensions: {} }, null, 2);
    const text = `${body}\n\nAnswered by the tool without running \`az version\`.`;
    const plan = shim.planOutput({ content: [{ type: "text", text }] }, ["version"]);
    expect(plan.stdout).toBe(`${body}\n`);
    expect(plan.stderr).toBe(
      `${shim.NOTE_PREFIX}Answered by the tool without running \`az version\`.\n`
    );
    expect(plan.exitCode).toBe(0);
  });

  test("a success without an envelope, or a malformed one, is a shim error (125)", () => {
    const none = shim.planOutput({ content: [{ type: "text", text: "ok" }] }, ["group", "list"]);
    expect(none.exitCode).toBe(shim.EXIT.SHIM_ERROR);
    expect(none.stderr).toContain("LOCALSTACK_AZ_TEST_ENVELOPE");
    const bad = shim.planOutput(
      {
        content: [
          { type: "text", text: "ok" },
          { type: "text", text: "{not json" },
        ],
      },
      ["group", "list"]
    );
    expect(bad.exitCode).toBe(shim.EXIT.SHIM_ERROR);
    expect(shim.parseEnvelope('{"exitCode": 0}')).toBeUndefined();
    expect(shim.parseEnvelope(undefined)).toBeNull();
  });

  test("AZ_SHIM_NEWLINES=lf turns CRLF into LF (Windows az), keep leaves bytes alone", () => {
    const result = envelopeResult({ stdout: "a\r\nb\r\n", stderr: "w\r\n" });
    expect(shim.planOutput(result, ["x"], { newlines: "lf" })).toMatchObject({
      stdout: "a\nb\n",
      stderr: "w\n",
    });
    expect(shim.planOutput(result, ["x"])).toMatchObject({ stdout: "a\r\nb\r\n", stderr: "w\r\n" });
  });
});

describe("shim: CI-only acr login rewrite (known gap)", () => {
  test("the samples' form is rewritten to --expose-token with JSON output", () => {
    expect(
      shim.planAcrLoginRewrite(["acr", "login", "--name", "x_acr_name", "--only-show-errors"])
    ).toEqual({
      registry: "x_acr_name",
      toolArgv: [
        "acr",
        "login",
        "--name",
        "x_acr_name",
        "--only-show-errors",
        "--expose-token",
        "--output",
        "json",
      ],
    });
    expect(shim.planAcrLoginRewrite(["acr", "login", "-n=reg", "-o", "table"])).toBeNull();
    expect(shim.planAcrLoginRewrite(["acr", "login", "--name=reg", "-o", "table"])).toEqual({
      registry: "reg",
      toolArgv: ["acr", "login", "--name", "reg", "--expose-token", "--output", "json"],
    });
  });

  test("anything else is left for the policy", () => {
    expect(shim.planAcrLoginRewrite(["acr", "login", "--name", "r", "--expose-token"])).toBeNull();
    expect(shim.planAcrLoginRewrite(["acr", "login", "-n", "r", "-t"])).toBeNull();
    expect(shim.planAcrLoginRewrite(["acr", "login", "--name", "r", "--username", "u"])).toBeNull();
    expect(shim.planAcrLoginRewrite(["acr", "login"])).toBeNull();
    expect(shim.planAcrLoginRewrite(["acr", "show", "--name", "r"])).toBeNull();
  });

  test("the token is read from the JSON, and docker login needs a throwaway DOCKER_CONFIG", async () => {
    expect(shim.parseAcrToken('{"accessToken": "t", "loginServer": "r.azurecr.io"}')).toEqual({
      accessToken: "t",
      loginServer: "r.azurecr.io",
    });
    expect(shim.parseAcrToken("{}")).toBeUndefined();
    const err: string[] = [];
    const code = await shim.dockerLogin(
      { accessToken: "t", loginServer: "r" },
      {
        env: {},
        docker: "docker-must-not-run",
        stdout: { write: () => true },
        stderr: { write: (c) => (err.push(String(c)), true) },
      }
    );
    expect(code).toBe(shim.EXIT.REFUSED);
    expect(err.join("")).toContain("DOCKER_CONFIG");
  });

  (process.platform === "win32" ? test.skip : test)(
    "POSIX: the token reaches docker on stdin, never in its argv",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsaz-shim-docker-"));
      try {
        const fake = path.join(dir, "docker");
        fs.writeFileSync(
          fake,
          '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_CONFIG/argv.txt"\ncat > "$DOCKER_CONFIG/stdin.txt"\necho "Login Succeeded"\n',
          { mode: 0o755 }
        );
        const out: string[] = [];
        const code = await shim.dockerLogin(
          {
            accessToken: "secret-token",
            loginServer: "reg.azurecr.localhost.localstack.cloud:4566",
          },
          {
            env: { ...process.env, DOCKER_CONFIG: dir },
            docker: fake,
            stdout: { write: (c) => (out.push(String(c)), true) },
            stderr: { write: () => true },
          }
        );
        expect(code).toBe(0);
        expect(out.join("")).toContain("Login Succeeded");
        const argv = fs.readFileSync(path.join(dir, "argv.txt"), "utf8");
        expect(argv).not.toContain("secret-token");
        expect(argv).toContain("--password-stdin");
        expect(fs.readFileSync(path.join(dir, "stdin.txt"), "utf8")).toBe("secret-token\n");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

// ---------------------------------------------------------------------------------------
// A fake MCP server: initialize, then one tools/call answered from FAKE_* variables. It
// records what it received (the command, its cwd and a few variables) in FAKE_RECORD.
const FAKE_SERVER = String.raw`"use strict";
const fs = require("fs");
const mode = process.env.FAKE_MODE || "envelope";
if (mode === "crash") process.exit(3);
let buffer = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write("a stray non-JSON line\n");
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    } else if (msg.method === "tools/call") {
      if (process.env.FAKE_RECORD) {
        fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
          name: msg.params.name,
          command: msg.params.arguments.command,
          cwd: process.cwd(),
          workdir: process.env.LOCALSTACK_AZ_WORKDIR,
          envelope: process.env.LOCALSTACK_AZ_TEST_ENVELOPE,
          guard: process.env.LOCALSTACK_AZ_SHIM_ACTIVE,
          path: process.env.PATH || process.env.Path,
          shimVars: Object.keys(process.env).filter((k) => k.startsWith("AZ_SHIM_")),
        }));
      }
      if (mode === "hang") continue;
      if (mode === "rpcerror") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad params" } }); continue; }
      const content = [{ type: "text", text: process.env.FAKE_TEXT || "fake answer" }];
      if (mode === "envelope") content.push({ type: "text", text: process.env.FAKE_ENVELOPE });
      send({ jsonrpc: "2.0", id: msg.id, result: { content } });
    }
  }
});
`;

interface Run {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

describe("shim: a real child process against a fake MCP server", () => {
  let dir: string;
  let fakeServer: string;
  let record: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsaz-shim-"));
    fakeServer = path.join(dir, "fake-server.cjs");
    record = path.join(dir, "record.json");
    fs.writeFileSync(fakeServer, FAKE_SERVER);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const baseEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...process.env,
    AZ_SHIM_SERVER_JS: fakeServer,
    FAKE_RECORD: record,
    LOCALSTACK_AZ_SHIM_ACTIVE: undefined,
    ...extra,
  });

  /** Run az-shim.cjs as the bash half does: argv NUL-separated on stdin. */
  function runShim(argv: string[], extra: NodeJS.ProcessEnv = {}, cwd = dir): Run {
    const r = spawnSync(process.execPath, [SHIM_JS], {
      cwd,
      env: baseEnv({ AZ_SHIM_ARGC: String(argv.length), ...extra }),
      input: Buffer.from(argv.map((a) => `${a}\0`).join(""), "utf8"),
      timeout: 60_000,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test("success with a warning round-trips byte for byte (exit 0)", () => {
    const r = runShim(["group", "list"], {
      FAKE_ENVELOPE: JSON.stringify({
        ...WARN_ENVELOPE,
        notes: [],
        classId: null,
        truncated: false,
      }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.equals(Buffer.from(WARN_ENVELOPE.stdout as string, "utf8"))).toBe(true);
    expect(r.stderr.equals(Buffer.from(WARN_ENVELOPE.stderr as string, "utf8"))).toBe(true);
  });

  test("the server gets the quoted command, the cwd as workdir, the envelope flag, no shim dir on PATH", () => {
    const argv = ["group", "show", "--name", "a b", "--query", "[?x=='y'] | [0]", "--value", ""];
    const r = runShim(argv, {
      FAKE_ENVELOPE: JSON.stringify({
        exitCode: 0,
        stdout: "",
        stderr: "",
        notes: [],
        classId: null,
        truncated: false,
      }),
    });
    expect(r.code).toBe(0);
    const got = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(got.name).toBe("localstack-azure-client");
    expect(got.command).toBe(quote.toToolCommand(argv));
    expect(splitCliArgs(got.command.replace(/^az /, ""), AZURE_OPTIONS)).toEqual(argv);
    // Real paths: macOS reports /private/var for a temp dir under /var.
    expect(fs.realpathSync.native(got.cwd)).toBe(fs.realpathSync.native(dir));
    expect(fs.realpathSync.native(got.workdir)).toBe(fs.realpathSync.native(dir));
    expect(got.envelope).toBe("1");
    expect(got.guard).toBe("1");
    expect(got.shimVars).toEqual([]);
    const entries = String(got.path)
      .split(path.delimiter)
      .map((e: string) => path.resolve(e || ".").toLowerCase());
    expect(entries).not.toContain(path.resolve(SHIM_DIR).toLowerCase());
  });

  test("az's exit code, a refusal (2), a crash, a JSON-RPC error and a timeout (125)", () => {
    const failing = JSON.stringify({
      exitCode: 3,
      stdout: "",
      stderr: "ERROR: not found\n",
      notes: [],
      classId: "not-found",
      truncated: false,
    });
    expect(runShim(["group", "show"], { FAKE_ENVELOPE: failing }).code).toBe(3);

    const refused = runShim(["container", "exec"], {
      FAKE_MODE: "text",
      FAKE_TEXT: "❌ **Command refused**\n\nno",
    });
    expect(refused.code).toBe(2);
    expect(refused.stdout.length).toBe(0);
    expect(refused.stderr.toString("utf8")).toBe("❌ **Command refused**\n\nno\n");

    const crashed = runShim(["group", "list"], { FAKE_MODE: "crash" });
    expect(crashed.code).toBe(125);
    expect(crashed.stderr.toString("utf8")).toContain("exited");

    expect(runShim(["group", "list"], { FAKE_MODE: "rpcerror" }).code).toBe(125);

    const hung = runShim(["group", "list"], { FAKE_MODE: "hang", AZ_SHIM_TIMEOUT_SECONDS: "1" });
    expect(hung.code).toBe(125);
    expect(hung.stderr.toString("utf8")).toContain("no answer");
  });

  test("AZ_SHIM_LOG gets one JSON line per call", () => {
    const log = path.join(dir, "calls.jsonl");
    const ok = JSON.stringify({
      exitCode: 0,
      stdout: "[]\n",
      stderr: "",
      notes: ["Note: n"],
      classId: null,
      truncated: false,
    });
    runShim(["group", "list"], {
      FAKE_ENVELOPE: ok,
      AZ_SHIM_LOG: log,
      AZ_SHIM_STEP: "unit:deploy",
    });
    runShim(["container", "exec"], {
      FAKE_MODE: "text",
      FAKE_TEXT: "❌ **Command refused**",
      AZ_SHIM_LOG: log,
    });
    const lines = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      step: "unit:deploy",
      argv: ["group", "list"],
      exitCode: 0,
      envelope: true,
      notes: ["Note: n"],
    });
    expect(lines[1]).toMatchObject({
      argv: ["container", "exec"],
      exitCode: 2,
      refusal: "❌ **Command refused**",
    });
    expect(typeof lines[0].ms).toBe("number");
  });

  test("a missing server, the recursion guard and a bad argument count are shim errors", () => {
    expect(
      runShim(["group", "list"], { AZ_SHIM_SERVER_JS: path.join(dir, "missing.js") }).code
    ).toBe(125);
    const nested = runShim(["group", "list"], { LOCALSTACK_AZ_SHIM_ACTIVE: "1" });
    expect(nested.code).toBe(125);
    expect(nested.stderr.toString("utf8")).toContain("LOCALSTACK_AZ_PATH");
    const r = spawnSync(process.execPath, [SHIM_JS], {
      env: baseEnv({ AZ_SHIM_ARGC: "2" }),
      input: Buffer.from("only-one\0"),
      timeout: 60_000,
    });
    expect(r.status).toBe(125);
  });

  // -------------------------------------------------------------------------------------
  // Through bash: `x=$(az ...)` as the samples write it. POSIX bash, or Git Bash on
  // Windows (never WSL's System32\bash.exe).
  function findBash(): string | undefined {
    if (process.platform !== "win32") {
      return ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"].find(
        (p) => fs.existsSync(p)
      );
    }
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [
      process.env.AZ_SHIM_BASH,
      path.join(programFiles, "Git", "bin", "bash.exe"),
      path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    ].find(
      (p): p is string =>
        Boolean(p) && fs.existsSync(p as string) && !/\\system32\\/i.test(p as string)
    );
  }
  const bash = findBash();
  const withBash = bash ? describe : describe.skip;

  withBash("through bash", () => {
    let bin: string;
    const fwd = (p: string) => p.replace(/\\/g, "/");

    beforeAll(() => {
      // A wrapper `az` on PATH that runs the real shim with bash (so the test does not
      // depend on the checkout's executable bit; the POSIX test below checks that).
      bin = path.join(dir, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, "az"),
        `#!/usr/bin/env bash\nexec bash '${fwd(SHIM_BASH)}' "$@"\n`,
        {
          mode: 0o755,
        }
      );
    });

    function runBash(script: string, extra: NodeJS.ProcessEnv): Run {
      const env = baseEnv(extra);
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;
      const r = spawnSync(bash as string, ["-c", script], { cwd: dir, env, timeout: 120_000 });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    }

    test("x=$(az ...) captures az's stdout exactly (a warning on fd 2), and exit codes pass", () => {
      const envelope = JSON.stringify({
        ...WARN_ENVELOPE,
        notes: [],
        classId: null,
        truncated: false,
      });
      const r = runBash(
        [
          `x=$(az group list --query "[?name=='a b'].id" -o json 2>err.bin); code=$?`,
          `printf '%s' "$x" > captured.bin`,
          `az group list > out.bin 2> err2.bin`,
          `printf '%s' "$code"`,
        ].join("\n"),
        { FAKE_ENVELOPE: envelope }
      );
      expect(r.stderr.toString("utf8")).toBe("");
      expect(r.stdout.toString("utf8")).toBe("0");
      const stdout = WARN_ENVELOPE.stdout as string;
      const read = (f: string) => fs.readFileSync(path.join(dir, f));
      // $(...) drops trailing newlines, exactly as it does with the real az.
      expect(read("captured.bin").equals(Buffer.from(stdout.replace(/\n+$/, ""), "utf8"))).toBe(
        true
      );
      expect(read("out.bin").equals(Buffer.from(stdout, "utf8"))).toBe(true);
      expect(read("err.bin").equals(Buffer.from(WARN_ENVELOPE.stderr as string, "utf8"))).toBe(
        true
      );
      expect(read("err2.bin").equals(Buffer.from(WARN_ENVELOPE.stderr as string, "utf8"))).toBe(
        true
      );

      const failing = JSON.stringify({
        exitCode: 3,
        stdout: "",
        stderr: "ERROR: not found\n",
        notes: [],
        classId: "not-found",
        truncated: false,
      });
      const f = runBash(`az group show --name nope 2>/dev/null; printf '%s' "$?"`, {
        FAKE_ENVELOPE: failing,
      });
      expect(f.stdout.toString("utf8")).toBe("3");
    });

    test("tricky arguments reach the tool unchanged through bash's argv (no MSYS path conversion)", () => {
      const argv = [
        "role",
        "assignment",
        "list",
        "--scope",
        "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg",
        "--query",
        "[?roleDefinitionName=='Storage Blob Data Contributor'].id | [0]",
        "--value",
        "",
        "--json",
        '[\n\t{"category": "AllMetrics", "enabled": true}\n]',
        "--x",
        "it's $HOME `id` \\$Default C:\\x\\y 日本 é",
        "--settings",
        "A=DefaultEndpointsProtocol=https;AccountName=a;AccountKey=k==",
      ];
      fs.writeFileSync(
        path.join(dir, "args.bin"),
        Buffer.from(argv.map((a) => `${a}\0`).join(""), "utf8")
      );
      const ok = JSON.stringify({
        exitCode: 0,
        stdout: "",
        stderr: "",
        notes: [],
        classId: null,
        truncated: false,
      });
      const r = runBash(
        `args=(); while IFS= read -r -d '' a; do args+=("$a"); done < args.bin; az "\${args[@]}"; printf '%s' "$?"`,
        { FAKE_ENVELOPE: ok }
      );
      expect(r.stdout.toString("utf8")).toBe("0");
      const got = JSON.parse(fs.readFileSync(record, "utf8"));
      expect(splitCliArgs(got.command.replace(/^az /, ""), AZURE_OPTIONS)).toEqual(argv);
    });

    test("command -v az finds the wrapper, and AZ_SHIM_IDENTIFY answers without a server", () => {
      const r = runBash(`command -v az; AZ_SHIM_IDENTIFY=1 az`, {
        AZ_SHIM_SERVER_JS: path.join(dir, "missing.js"),
      });
      const lines = r.stdout.toString("utf8").trim().split("\n");
      expect(lines[0]).toMatch(/\/bin\/az$/);
      expect(lines[1]).toMatch(/^localstack-az-shim .*samples-shim$/);
      expect(r.code).toBe(0);
    });

    test("a refusal exits 2 with the tool's text on fd 2 and nothing on fd 1", () => {
      const r = runBash(`out=$(az container exec --name x 2>err.txt); printf '%s|%s' "$?" "$out"`, {
        FAKE_MODE: "text",
        FAKE_TEXT: "❌ **Command refused**",
      });
      expect(r.stdout.toString("utf8")).toBe("2|");
      expect(fs.readFileSync(path.join(dir, "err.txt"), "utf8")).toBe("❌ **Command refused**\n");
    });
  });
});

(process.platform === "win32" ? test.skip : test)(
  "POSIX: tests/azure/samples-shim/az is executable (git update-index --chmod=+x tests/azure/samples-shim/az)",
  () => {
    expect(() => fs.accessSync(SHIM_BASH, fs.constants.X_OK)).not.toThrow();
  }
);

test("the bash shim has LF line endings and a bash shebang", () => {
  const text = fs.readFileSync(SHIM_BASH, "utf8");
  expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  expect(text).not.toContain("\r");
});

// ---------------------------------------------------------------------------------------
// Windows: the callers that go through cmd.exe. An SDK credential chain runs
// `cmd /c az account get-access-token ...`, and Go tools (Terraform) find `az` through PATHEXT:
// neither sees the bash shim. Without az.cmd they reached the machine's real az, and the chain
// then fell through to AzurePowerShellCredential, whose Az module wrote three files into the
// user's real %USERPROFILE%\.Azure (.NET ignores the step's private USERPROFILE).
(process.platform === "win32" ? describe : describe.skip)(
  "shim on Windows: cmd.exe callers",
  () => {
    let dir: string;
    let fakeServer: string;
    let record: string;
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    /** The machine's full PATH behind the shim dir, as samples-replay's stepEnv builds it. */
    const fullPath = () => `${SHIM_DIR}${path.delimiter}${process.env[pathKey] ?? ""}`;
    /**
     * The PATH for the cases that EXECUTE something: the shim dir, node and System32 only, so
     * that if a .cmd file were missing nothing real could run in its place (the machine's az
     * with the user's own profile, or PowerShell). A first version ran these
     * with the full PATH, and its fail-first run, without az.cmd, started the machine's real
     * `az account get-access-token`.
     */
    const sealedPath = () =>
      [
        SHIM_DIR,
        path.dirname(process.execPath),
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      ].join(path.delimiter);
    const stepEnv = (pathValue: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
      return {
        ...env,
        PATH: pathValue,
        AZURE_CONFIG_DIR: path.join(dir, "azure-config"),
        AZ_SHIM_SERVER_JS: fakeServer,
        FAKE_RECORD: record,
        LOCALSTACK_AZ_SHIM_ACTIVE: undefined,
        ...extra,
      };
    };

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsaz-shim-cmd-"));
      fakeServer = path.join(dir, "fake-server.cjs");
      record = path.join(dir, "record.json");
      fs.writeFileSync(fakeServer, FAKE_SERVER);
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    test.each(["az", "pwsh", "powershell", "azd"])(
      "cmd.exe resolves `%s` to the shim dir's .cmd first",
      (name) => {
        // where.exe only looks (nothing runs), so this one sees the machine's full PATH; from
        // a neutral cwd, since it looks in the current directory before PATH.
        const r = spawnSync("where.exe", [name], {
          cwd: dir,
          env: stepEnv(fullPath()),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        });
        // where also lists the extensionless bash `az`, which cmd.exe never runs: the first
        // match cmd.exe would execute is the first one with a PATHEXT extension.
        const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";");
        const first = (r.stdout || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => exts.includes(path.extname(line).toLowerCase()));
        expect(first?.toLowerCase()).toBe(path.join(SHIM_DIR, `${name}.cmd`).toLowerCase());
      }
    );

    test("`cmd /c az ...`, as AzureCliCredential calls it, reaches the tool with its arguments", () => {
      const r = spawnSync(
        "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          "az account get-access-token --output json --resource https://eventhubs.azure.net",
        ],
        {
          cwd: dir,
          env: stepEnv(sealedPath(), {
            FAKE_ENVELOPE: JSON.stringify({
              exitCode: 0,
              stdout: '{"accessToken": "emulator-token"}\n',
              stderr: "",
              notes: [],
              classId: null,
              truncated: false,
            }),
          }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 60_000,
        }
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ accessToken: "emulator-token" });
      const got = JSON.parse(fs.readFileSync(record, "utf8")) as { command: string };
      expect(got.command).toBe(
        quote.toToolCommand([
          "account",
          "get-access-token",
          "--output",
          "json",
          "--resource",
          "https://eventhubs.azure.net",
        ])
      );
    });

    test.each(["pwsh", "powershell", "azd"])(
      "`cmd /c %s ...`, a later credential in the chain, fails closed with a note",
      (name) => {
        const r = spawnSync(
          "cmd.exe",
          ["/d", "/c", `${name} -NoProfile -NonInteractive -Command exit 0`],
          {
            cwd: dir,
            env: stepEnv(sealedPath()),
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
          }
        );
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/is blocked for sample steps/);
      }
    );
  }
);

test("the Windows .cmd files have CRLF line endings (cmd.exe parses batch files by line)", () => {
  for (const name of ["az", "pwsh", "powershell", "azd"]) {
    const text = fs.readFileSync(path.join(SHIM_DIR, `${name}.cmd`), "utf8");
    expect(text.startsWith("@echo off\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  }
});

describe("shim: Git Bash drive paths reach a Windows az as Windows paths", () => {
  // Git Bash turns `/c/...` into `C:/...` when it starts a native Windows program, but the bash
  // shim hands its argv NUL-separated (so ARM ids stay intact), so the shim redoes the one part a
  // Windows az needs: a single-letter drive root, alone or as a `--flag=` value.
  const win = (argv: string[]) => shim.convertMsysDrivePaths(argv, "win32");

  test("a drive-root path, bare or after a flag or as a --flag= value, becomes C:/...", () => {
    expect(win(["--specification-path", "/c/tmp/x/openapi.json"])).toEqual([
      "--specification-path",
      "C:/tmp/x/openapi.json",
    ]);
    expect(win(["--file=/d/work/a.zip"])).toEqual(["--file=D:/work/a.zip"]);
    expect(win(["/c"])).toEqual(["C:/"]);
    expect(win(["/c/"])).toEqual(["C:/"]);
  });

  test("ARM ids and other multi-letter roots stay exactly as they are", () => {
    for (const argv of [
      ["--ids", "/subscriptions/0000/resourceGroups/rg"],
      ["--scope=/providers/Microsoft.Foo"],
      ["/tenants/abc"],
      ["/tmp/x"],
      ["/cd/x"],
    ]) {
      expect(win(argv)).toEqual(argv);
    }
  });

  test("relative values, flags and plain values are untouched", () => {
    const argv = ["main.bicep", "-g", "rg", "--tags", "a=b", "--query", "[].name", "c/x", ""];
    expect(win(argv)).toEqual(argv);
  });

  test("on Linux and macOS the paths are native: nothing changes", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(shim.convertMsysDrivePaths(["/c/tmp/x"], platform)).toEqual(["/c/tmp/x"]);
    }
  });
});

describe("shim: a file elsewhere in the sample widens the workdir to the sample", () => {
  // The tool runs az in its workdir and refuses files outside it. The shim makes the workdir the
  // directory the script called az from, so a script that `cd`s into a subfolder and then names a
  // sibling folder's file by absolute path was refused. A user's workdir is the whole project, so
  // for such a call the shim uses the sample's folder (AZ_SHIM_ROOT) instead.
  let root: string;
  let cwd: string;
  let spec: string;
  let elsewhere: string;
  let outsideFile: string;
  beforeAll(() => {
    // As spelled, not through realpath: on macOS the temp dir is behind a link (/var ->
    // /private/var), which the policy must handle.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lsaz-shim-root-"));
    cwd = path.join(root, "function");
    for (const d of [cwd, path.join(root, "scripts"), path.join(root, "apim")]) fs.mkdirSync(d);
    spec = path.join(root, "apim", "openapi.json");
    fs.writeFileSync(spec, "{}");
    fs.writeFileSync(path.join(cwd, "app.zip"), "zip");
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "lsaz-shim-elsewhere-"));
    outsideFile = path.join(elsewhere, "openapi.json");
    fs.writeFileSync(outsideFile, "{}");
  });
  afterAll(() => {
    for (const d of [root, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
  });

  // The sample's call as its script builds it, from `$SCRIPT_DIR/../apim/openapi.json`.
  const importArgv = () => [
    "apim",
    "api",
    "import",
    "--api-id",
    "inventory-api",
    "--path",
    "inventory",
    "--specification-format",
    "OpenApiJson",
    "--specification-path",
    `${root.split(path.sep).join("/")}/scripts/../apim/openapi.json`,
    "--service-url",
    "http://local-inventory-functionapp-test.azurewebsites.azure.localhost.localstack.cloud:4566/api",
  ];
  const policyAt = (workdir: string) =>
    evaluateAzCommand(quote.toToolCommand(importArgv()), {
      workdir,
      homeDir: path.join(elsewhere, "home"),
      platform: process.platform,
    });

  test("the sample's call: refused with the cwd as the workdir, allowed with the widened one", () => {
    const before = policyAt(cwd);
    expect(before.ok).toBe(false);
    expect(before.ok ? "" : before.message).toMatch(/--specification-path/);
    const workdir = shim.workdirFor(importArgv(), cwd, root);
    expect(workdir).toBe(root);
    expect(policyAt(workdir).ok).toBe(true);
  });

  test("a relative path in the same call keeps az where the script ran it", () => {
    // Run from the sample's folder, `app.zip` and `.` would name something else.
    expect(shim.workdirFor([...importArgv(), "--src-path", "app.zip"], cwd, root)).toBe(cwd);
    expect(shim.workdirFor([...importArgv(), "."], cwd, root)).toBe(cwd);
  });

  test("--flag= and @file values count; a directory, a missing file or one outside the sample does not", () => {
    expect(shim.workdirFor(["x", `--specification-path=${spec}`], cwd, root)).toBe(root);
    expect(shim.workdirFor(["x", "--parameters", `@${spec}`], cwd, root)).toBe(root);
    expect(shim.workdirFor(["x", "--path", path.join(root, "apim")], cwd, root)).toBe(cwd);
    const missing = path.join(root, "apim", "missing.json");
    expect(shim.workdirFor(["x", "--file", missing], cwd, root)).toBe(cwd);
    expect(shim.workdirFor(["x", "--file", outsideFile], cwd, root)).toBe(cwd);
    if (process.platform === "win32") {
      const lowerDrive = spec.charAt(0).toLowerCase() + spec.slice(1);
      expect(shim.workdirFor(["x", "--file", lowerDrive], cwd, root)).toBe(root);
    }
  });

  test("files in the cwd, ARM ids, URLs and names never widen; no root, or a cwd outside it, changes nothing", () => {
    expect(shim.workdirFor(["x", "--src-path", path.join(cwd, "app.zip")], cwd, root)).toBe(cwd);
    const names = ["--ids", "/subscriptions/0/resourceGroups/rg", "--url", "https://x.example/a"];
    expect(shim.workdirFor(["x", ...names, "-n", "inventory"], cwd, root)).toBe(cwd);
    expect(shim.workdirFor(importArgv(), cwd, undefined)).toBe(cwd);
    expect(shim.workdirFor(importArgv(), elsewhere, root)).toBe(elsewhere);
  });

  test("the widened workdir reaches the server as LOCALSTACK_AZ_WORKDIR", () => {
    const opts = { cwd: "/w/function", platform: "linux", shimDir: "/shim" };
    expect(shim.serverEnv({}, { ...opts, workdir: "/w" }).LOCALSTACK_AZ_WORKDIR).toBe("/w");
    expect(shim.serverEnv({}, opts).LOCALSTACK_AZ_WORKDIR).toBe("/w/function");
  });
});
