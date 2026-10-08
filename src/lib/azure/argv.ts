/**
 * Quote-aware splitting of an `az` command string into an argv array. No shell is ever involved:
 * the result goes to spawn as an argument vector, so this reproduces POSIX word splitting for a
 * safe subset and refuses anything that would need a shell (pipes, chaining, redirects,
 * substitutions).
 *
 * It is the AWS client's splitter with three changes that `az` commands need (JMESPath queries,
 * empty values, JSON in double quotes):
 * - newline, CR and backtick are refused only outside quotes; inside quotes they are data;
 * - `""` and `''` produce an empty argument instead of disappearing;
 * - inside double quotes, `\$`, `` \` `` and `\<newline>` behave as in bash.
 *
 * As there, an unquoted backslash is literal (Windows paths work), `$VAR` is passed literally, and
 * an unquoted `#word` is an argument.
 */

export class AzSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzSyntaxError";
  }
}

export function splitAzArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  // True once the current word has started, even if it holds no characters yet ("").
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (wordStarted) args.push(current);
    current = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (!quote && (character === "\n" || character === "\r" || character === "`")) {
      throw new AzSyntaxError("Command contains forbidden shell syntax.");
    }

    if (character === "\\" && quote === '"') {
      const escaped = command[index + 1];
      if (escaped === '"' || escaped === "\\" || escaped === "$" || escaped === "`") {
        current += escaped;
        index++;
      } else if (escaped === "\n") {
        index++; // a line continuation: bash drops both characters
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
        throw new AzSyntaxError("Command contains forbidden shell syntax.");
      }
      if (/\s/.test(character)) {
        endWord();
        continue;
      }
    }

    current += character;
    wordStarted = true;
  }

  if (quote) throw new AzSyntaxError("Command contains an unterminated quote.");
  endWord();
  return args;
}
