import { ResponseBuilder } from "../../core/response-builder";
import type { AzRunResult } from "./runner";

/** How much of az's output a response carries, in characters. */
export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_STDERR_CHARS = 4_000;

type ToolResponse = ReturnType<typeof ResponseBuilder.markdown>;

export interface FormatOptions {
  /** The argv that ran, without `az`: a refused host it names is the command's own endpoint. */
  argv: string[];
  /** The policy's notes, such as a rewritten URL. */
  notes: string[];
  timeoutSeconds: number;
  /** The emulator's gateway, for the coverage link. */
  healthBaseUrl: string;
}

/** The first `max` characters, never ending inside a surrogate pair, with a note on the cut. */
function cap(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max;
  return `${text.slice(0, end)}\n[... ${(text.length - end).toLocaleString("en-US")} more characters of ${what} cut]`;
}

/** The last `max` characters, never starting inside a surrogate pair, with a note on the cut. */
function capTail(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const start = text.length - max + (/[\udc00-\udfff]/.test(text[text.length - max]) ? 1 : 0);
  return `[... ${start.toLocaleString("en-US")} earlier characters of ${what} cut]\n${text.slice(start)}`;
}

/**
 * az's stderr without Python traceback frames (its ERROR: lines stay), capped from the front: az
 * prints its ERROR: line last, after any `--debug` log.
 */
export function prepareStderr(raw: string): string {
  const kept: string[] = [];
  let inTraceback = false;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^Traceback \(most recent call last\):\s*$/.test(line)) {
      if (!inTraceback) kept.push("(Python traceback omitted)");
      inTraceback = true;
    } else if (!inTraceback || line.startsWith("ERROR:")) {
      kept.push(line);
    }
  }
  return capTail(kept.join("\n").trim(), MAX_STDERR_CHARS, "stderr");
}

function failureHint(stderr: string, opts: FormatOptions): string | undefined {
  const notImplemented =
    /The API operation '([A-Z]+) ([^']+)' is not yet implemented in LocalStack\./.exec(stderr);
  if (notImplemented || /\(NotImplemented\)|"code": "NotImplemented"/.test(stderr)) {
    const what = notImplemented
      ? `\`${notImplemented[1]} ${notImplemented[2]}\``
      : "this operation";
    return (
      `The LocalStack Azure emulator does not implement ${what} yet, so retrying will not help. ` +
      `The implemented operations are listed at ${opts.healthBaseUrl}/_localstack/coverage.`
    );
  }
  const unknown = /'([\w-]+)' is misspelled or not recognized by the system\./.exec(stderr);
  if (unknown) {
    return (
      `If \`${unknown[1]}\` comes from an Azure CLI extension, add the extension with your own ` +
      "Azure CLI (`az extension list-available` lists them, `az extension add --name <extension>` " +
      "adds one): the tool loads the extensions in your extension directory. Meanwhile `rest` " +
      "with a relative URL usually works."
    );
  }
  if (/Unable to prompt for confirmation as no tty available\. Use --yes\./.test(stderr)) {
    return "This command asks for confirmation. Re-run it with `--yes`.";
  }
  if (/Could not find the "bicep" executable on PATH/.test(stderr)) {
    // az's own advice (config set, az bicep install) is refused here.
    return "The tool runs Bicep from PATH. Install it (for example `brew install bicep` or `winget install Microsoft.Bicep`), then restart this MCP server.";
  }
  if (/\bBCP192\b/.test(stderr)) {
    return "Bicep could not download a registry module (`br:` or `br/public:`): the tool lets `az` and Bicep reach only the emulator. Use a local module path instead.";
  }
  return undefined;
}

/** The host in a refused entry: `host`, `host:port`, `[v6]:port` or `http://host[:port]`. */
const hostOf = (entry: string) =>
  entry
    .replace(/^http:\/\//, "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");

/**
 * What the egress guard refused, which az's own error often does not name. Only a host the
 * command names gets the endpoint advice: `az` and Bicep also call hosts of their own (Bicep's
 * module index on aka.ms, for one), and those refusals are harmless.
 */
function refusedNote(result: AzRunResult, argv: string[]): string | undefined {
  const refused = result.refused ?? [];
  if (refused.length === 0) return undefined;
  const command = argv.join(" ").toLowerCase();
  const named = refused.filter((entry) => command.includes(hostOf(entry)));
  const other = refused.filter((entry) => !named.includes(entry));
  const list = (entries: string[]) => entries.map((entry) => `\`${entry}\``).join(", ");
  const lines: string[] = [];
  if (named.length > 0) {
    lines.push(
      `\`az\` could not reach ${list(named)}: the tool lets \`az\` reach only the emulator ` +
        "(`localhost.localstack.cloud` and every name under it, `localhost`, `127.0.0.1` and " +
        "`::1`), over https and on the emulator's ports. Point the endpoint in the command, such " +
        "as `--blob-endpoint` or a connection string, at the emulator."
    );
  }
  if (other.length > 0) {
    lines.push(
      `\`az\` (or a program it ran, such as Bicep) ${named.length > 0 ? "also " : ""}tried to ` +
        `reach ${list(other)}, which the tool does not allow.`
    );
  }
  return lines.join(" ");
}

export function formatAzResult(result: AzRunResult, opts: FormatOptions): ToolResponse {
  if (result.spawnError) {
    return ResponseBuilder.error("Azure CLI Could Not Start", result.spawnError);
  }
  if (result.aborted) {
    return ResponseBuilder.error(
      "Command Cancelled",
      "The client cancelled the call, so `az` was stopped."
    );
  }
  const stderr = prepareStderr(result.stderr);
  if (result.timedOut) {
    const advice =
      `\`az\` did not finish within ${opts.timeoutSeconds} s and was stopped; it may have changed ` +
      "the emulator already. For long operations raise LOCALSTACK_AZ_TIMEOUT_SECONDS, or use " +
      "`--no-wait` where the command has it.";
    return ResponseBuilder.error(
      "Command Timed Out",
      // A refusal comes first: az's retries after one can be what used up the time.
      [refusedNote(result, opts.argv), advice, stderr].filter(Boolean).join("\n\n")
    );
  }
  const stdout = cap(
    result.stdout.replace(/\r\n/g, "\n").replace(/\s+$/, ""),
    MAX_OUTPUT_CHARS,
    "output"
  );
  if (result.truncated) {
    const advice =
      "`az` printed more than the tool captures, so it was stopped and its output is " +
      "incomplete; it may have changed the emulator already. Narrow it with `--query` or `-o tsv`.";
    return ResponseBuilder.error(
      "Output Too Large",
      [advice, stdout && `Output so far:\n${stdout}`, stderr, ...opts.notes]
        .filter(Boolean)
        .join("\n\n")
    );
  }
  if (result.exitCode === 0) {
    const blocks = [
      ...opts.notes,
      stdout || "The command succeeded and printed no output.",
      stderr,
    ];
    return ResponseBuilder.markdown(blocks.filter(Boolean).join("\n\n"));
  }
  const blocks = [
    stderr || "`az` exited without an error message.",
    stdout && `Output:\n${stdout}`,
    refusedNote(result, opts.argv),
    failureHint(result.stderr, opts),
    ...opts.notes,
  ];
  return ResponseBuilder.error(
    `Command Failed (exit ${result.exitCode})`,
    blocks.filter(Boolean).join("\n\n")
  );
}
