import { formatAzResult, MAX_OUTPUT_CHARS, prepareStderr } from "./output";
import type { AzRunResult } from "./runner";

const result = (over: Partial<AzRunResult>): AzRunResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  truncated: false,
  ...over,
});
const opts = { notes: [], timeoutSeconds: 300, healthBaseUrl: "http://localhost:4566" };
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("formatAzResult", () => {
  test("success: az's output, the policy's notes first, warnings after", () => {
    const answer = formatAzResult(
      result({ stdout: '[\r\n  "rg"\r\n]\r\n', stderr: "WARNING: x\n" }),
      {
        ...opts,
        notes: ["Rewrote the URL."],
      }
    );
    expect(text(answer)).toBe('Rewrote the URL.\n\n[\n  "rg"\n]\n\nWARNING: x');
    expect(text(formatAzResult(result({}), opts))).toBe(
      "The command succeeded and printed no output."
    );
  });

  test("failure: the exit code in the title, az's error, a traceback reduced to its ERROR line", () => {
    const stderr =
      'Traceback (most recent call last):\n  File "x.py", line 1\nKeyError: 1\nERROR: The command failed.\n';
    const answer = text(formatAzResult(result({ exitCode: 1, stderr }), opts));
    expect(answer).toBe(
      "❌ **Command Failed (exit 1)**\n\n(Python traceback omitted)\nERROR: The command failed."
    );
  });

  test("an operation the emulator does not implement links its coverage list", () => {
    const stderr =
      "ERROR: (NotImplemented) The API operation 'GET /subscriptions/x/providers/Microsoft.Foo/bars' is not yet implemented in LocalStack.";
    const answer = text(formatAzResult(result({ exitCode: 1, stderr }), opts));
    expect(answer).toContain(
      "does not implement `GET /subscriptions/x/providers/Microsoft.Foo/bars` yet"
    );
    expect(answer).toContain("http://localhost:4566/_localstack/coverage");
  });

  test("an unknown command group points at the user's own az extension add", () => {
    const stderr = "ERROR: 'graph' is misspelled or not recognized by the system.";
    const answer = text(formatAzResult(result({ exitCode: 2, stderr }), opts));
    expect(answer).toContain("If `graph` comes from an Azure CLI extension");
    expect(answer).toContain("az extension add --name <extension>");
  });

  test("a confirmation prompt asks for --yes; a missing bicep points at PATH", () => {
    const hint = (stderr: string) => text(formatAzResult(result({ exitCode: 1, stderr }), opts));
    expect(
      hint("ERROR: Unable to prompt for confirmation as no tty available. Use --yes.")
    ).toContain("Re-run it with `--yes`.");
    expect(hint('ERROR: Could not find the "bicep" executable on PATH.')).toContain(
      "The tool runs Bicep from PATH."
    );
  });

  test("a failure or timeout names the hosts the egress guard refused; a success does not", () => {
    const refused = ["storage.evil.example", "localhost:2375"];
    const note = "The tool kept `az` from reaching `storage.evil.example`, `localhost:2375`";
    const failed = text(formatAzResult(result({ exitCode: 1, stderr: "ERROR: x", refused }), opts));
    expect(failed).toContain(note);
    expect(failed).toContain("`--blob-endpoint` or a connection string, must point there");
    const timedOut = result({ exitCode: null, timedOut: true, refused });
    expect(text(formatAzResult(timedOut, opts))).toContain(note);
    expect(text(formatAzResult(result({ stdout: "{}", refused }), opts))).toBe("{}");
  });

  test("timeout, cancel and a spawn failure", () => {
    expect(text(formatAzResult(result({ exitCode: null, timedOut: true }), opts))).toMatch(
      /^❌ \*\*Command Timed Out\*\*\n\n`az` did not finish within 300 s/
    );
    expect(text(formatAzResult(result({ aborted: true }), opts))).toContain("Command Cancelled");
    expect(text(formatAzResult(result({ spawnError: "ENOENT: x" }), opts))).toContain("ENOENT: x");
  });

  test("the capture cap: az was stopped, so the answer has its own title and the output so far", () => {
    // What the runner returns at the cap: the killed az has no exit code.
    const big = text(
      formatAzResult(
        result({ exitCode: null, stdout: "y".repeat(MAX_OUTPUT_CHARS + 10), truncated: true }),
        opts
      )
    );
    expect(big).toMatch(/^❌ \*\*Output Too Large\*\*\n\n`az` printed more than the tool captures/);
    expect(big).toContain("[... 10 more characters of output cut]");
    expect(big).not.toContain("exit null");
    expect(big).not.toContain("exited without an error message");
  });
});

describe("prepareStderr", () => {
  test("keeps the end, where az prints its ERROR: line after a long --debug log", () => {
    const debug = Array.from({ length: 200 }, (_, i) => `DEBUG: cli.knack: line ${i}`).join("\n");
    const stderr = `${debug}\nERROR: Please run 'az login' to setup account.\nINFO: telemetry: done`;
    const prepared = prepareStderr(stderr);
    expect(prepared).toMatch(/^\[\.\.\. [\d,]+ earlier characters of stderr cut\]\n/);
    expect(prepared).toContain("ERROR: Please run 'az login' to setup account.");
    expect(prepared.endsWith("INFO: telemetry: done")).toBe(true);
  });

  test("caps without splitting a surrogate pair", () => {
    const capped = prepareStderr("a".repeat(100) + "😀" + "b".repeat(3_999));
    expect(capped.endsWith("b".repeat(3_999))).toBe(true);
    expect(capped).not.toMatch(/[\udc00-\udfff]b/);
  });
});
