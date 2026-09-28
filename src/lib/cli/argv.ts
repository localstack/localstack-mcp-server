/**
 * Quote-aware splitting of a CLI command string into an argv array, shared by the
 * AWS and Azure client tools.
 *
 * No shell is ever involved: the result goes to exec/spawn as an argument vector, so
 * this only has to reproduce POSIX word splitting for a safe subset, and refuse
 * anything that would need a shell (pipes, chaining, redirects, substitutions).
 *
 * Deliberate differences from bash, pinned by tests:
 * - an unquoted backslash is literal (Windows paths such as C:\x\y work);
 * - `$VAR` outside quotes is passed literally (there is no expansion);
 * - an unquoted `#word` is an argument, not a comment;
 * - the POSIX `'\''` idiom is refused as an unterminated quote.
 */

export class CliSyntaxError extends Error {
  constructor(
    public readonly code: "shell-syntax" | "unterminated-quote",
    message: string
  ) {
    super(message);
    this.name = "CliSyntaxError";
  }
}

/**
 * Opt-in fixes found by check C06 ("variant P"). All default to false, so callers
 * that pass no options (the AWS client) keep their original behaviour exactly.
 */
export interface CliArgsOptions {
  /** Refuse newline, CR and backtick only outside quotes; inside quotes they are data. */
  quotedControlChars?: boolean;
  /** `""` and `''` produce an empty argument instead of disappearing. */
  keepEmptyQuoted?: boolean;
  /** Inside double quotes, `\$`, `` \` `` and `\<newline>` behave as in bash. */
  bashDoubleQuoteEscapes?: boolean;
}

const SHELL_SYNTAX_MESSAGE = "Command contains forbidden shell syntax.";
const UNTERMINATED_QUOTE_MESSAGE = "Command contains an unterminated quote.";

export function splitCliArgs(command: string, opts: CliArgsOptions = {}): string[] {
  const args: string[] = [];
  let current = "";
  // True once the current word has started, even if it holds no characters yet (a
  // quoted empty string). Only consulted when keepEmptyQuoted is on.
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (current || (opts.keepEmptyQuoted && wordStarted)) {
      args.push(current);
    }
    current = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (character === "\n" || character === "\r" || character === "`") {
      if (!opts.quotedControlChars || !quote) {
        throw new CliSyntaxError("shell-syntax", SHELL_SYNTAX_MESSAGE);
      }
    }

    if (character === "\\" && quote === '"') {
      const escaped = command[index + 1];
      if (escaped === '"' || escaped === "\\") {
        current += escaped;
        index++;
      } else if (opts.bashDoubleQuoteEscapes && (escaped === "$" || escaped === "`")) {
        current += escaped;
        index++;
      } else if (opts.bashDoubleQuoteEscapes && escaped === "\n") {
        // Line continuation inside double quotes: bash drops both characters.
        index++;
      } else {
        current += character;
      }
      continue;
    }

    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      wordStarted = true;
      continue;
    }

    if (!quote) {
      if (
        ";&|<>".includes(character) ||
        command.startsWith("$(", index) ||
        command.startsWith("${", index)
      ) {
        throw new CliSyntaxError("shell-syntax", SHELL_SYNTAX_MESSAGE);
      }
      if (/\s/.test(character)) {
        endWord();
        continue;
      }
    }

    current += character;
    wordStarted = true;
  }

  if (quote) {
    throw new CliSyntaxError("unterminated-quote", UNTERMINATED_QUOTE_MESSAGE);
  }
  endWord();
  return args;
}
