import { ResponseBuilder } from "../../core/response-builder";
import { commandWords, extensionFor, missingExtensionHint } from "./extension-map";
import type { AzRunResult } from "./runner";

/** How much of az's output a response carries, in characters. */
export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_STDERR_CHARS = 4_000;

type ToolResponse = ReturnType<typeof ResponseBuilder.markdown>;

export interface FormatOptions {
  /** The argv that ran, without `az`. */
  argv: string[];
  /** The policy's notes, such as a rewritten URL. */
  notes: string[];
  timeoutSeconds: number;
  /** The emulator's gateway, for the coverage link. */
  healthBaseUrl: string;
  installedExtensions: ReadonlySet<string>;
}

/** The first `max` characters, never ending inside a surrogate pair, with a note on the cut. */
function cap(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max;
  return `${text.slice(0, end)}\n[... ${(text.length - end).toLocaleString("en-US")} more characters of ${what} cut]`;
}

/** az's stderr without Python traceback frames (its ERROR: lines stay), capped. */
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
  return cap(kept.join("\n").trim(), MAX_STDERR_CHARS, "stderr");
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
    const words = commandWords(opts.argv);
    const upTo = words.slice(0, words.indexOf(unknown[1]) + 1);
    const extension = upTo.length ? extensionFor(upTo, opts.installedExtensions) : undefined;
    if (extension) return missingExtensionHint(upTo.join(" "), extension);
  }
  if (/Unable to prompt for confirmation as no tty available\. Use --yes\./.test(stderr)) {
    return "This command asks for confirmation. Re-run it with `--yes`.";
  }
  if (/Could not find the "bicep" executable on PATH/.test(stderr)) {
    // az's own advice (config set, az bicep install) is refused here.
    return "The tool runs Bicep from PATH. Install it (for example `brew install bicep` or `winget install Microsoft.Bicep`), then restart this MCP server.";
  }
  return undefined;
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
      [advice, stderr].filter(Boolean).join("\n\n")
    );
  }
  const notes = [...opts.notes];
  if (result.truncated) {
    notes.push(
      "Note: `az` printed more than the tool captures, so it was stopped and its output is incomplete. Narrow it with `--query` or `-o tsv`."
    );
  }
  const stdout = cap(
    result.stdout.replace(/\r\n/g, "\n").replace(/\s+$/, ""),
    MAX_OUTPUT_CHARS,
    "output"
  );
  if (result.exitCode === 0) {
    const blocks = [...notes, stdout || "The command succeeded and printed no output.", stderr];
    return ResponseBuilder.markdown(blocks.filter(Boolean).join("\n\n"));
  }
  const blocks = [
    stderr || "`az` exited without an error message.",
    stdout && `Output:\n${stdout}`,
    failureHint(result.stderr, opts),
    ...notes,
  ];
  return ResponseBuilder.error(
    `Command Failed (exit ${result.exitCode})`,
    blocks.filter(Boolean).join("\n\n")
  );
}
