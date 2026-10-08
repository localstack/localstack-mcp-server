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
const opts = {
  argv: ["group", "list"],
  notes: [],
  timeoutSeconds: 300,
  healthBaseUrl: "http://localhost:4566",
  installedExtensions: new Set<string>(),
};
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

  test("a command from a missing extension names the extension to add", () => {
    const stderr = "ERROR: 'graph' is misspelled or not recognized by the system.";
    const answer = (installed: string[]) =>
      text(
        formatAzResult(result({ exitCode: 2, stderr }), {
          ...opts,
          argv: ["graph", "query", "-q", "x"],
          installedExtensions: new Set(installed),
        })
      );
    expect(answer([])).toContain("az extension add --name resource-graph");
    expect(answer(["resource-graph"])).not.toContain("az extension add");
  });

  test("timeout, cancel, a spawn failure and the capture cap", () => {
    expect(text(formatAzResult(result({ exitCode: null, timedOut: true }), opts))).toMatch(
      /^❌ \*\*Command Timed Out\*\*\n\n`az` did not finish within 300 s/
    );
    expect(text(formatAzResult(result({ aborted: true }), opts))).toContain("Command Cancelled");
    expect(text(formatAzResult(result({ spawnError: "ENOENT: x" }), opts))).toContain("ENOENT: x");
    const big = formatAzResult(
      result({ stdout: "y".repeat(MAX_OUTPUT_CHARS + 10), truncated: true }),
      opts
    );
    expect(text(big)).toContain("[... 10 more characters of output cut]");
    expect(text(big)).toMatch(/^Note: `az` printed more than the tool captures/);
  });
});

test("prepareStderr caps without splitting a surrogate pair", () => {
  const capped = prepareStderr("a".repeat(3_999) + "😀" + "b".repeat(100));
  expect(capped.startsWith("a".repeat(3_999) + "\n[...")).toBe(true);
});
