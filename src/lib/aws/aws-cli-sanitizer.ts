const HELP_TOKENS = new Set(["help", "-h", "--help"]);
// Global options that would send a command to another endpoint, or sign it with the
// credentials of a real AWS account, because the CLI runs where this server runs.
const LOCALSTACK_ESCAPE_OPTIONS = ["endpoint-url", "profile"];

/**
 * Throws unless the argv `lstk aws` receives is certain to reach LocalStack. Every argv passed
 * to `lstk aws` goes through this, whether it came from the agent's command or a tool parameter.
 */
export function assertTargetsLocalStack(args: string[]): void {
  // The CLI accepts any unambiguous prefix of an option (`--endp x`, `--e=x`, `--pro p`), and a
  // later --endpoint-url overrides the one lstk puts first.
  for (const arg of args) {
    const name = arg.match(/^--([^=]+)/)?.[1].toLowerCase();
    const escape = name && LOCALSTACK_ESCAPE_OPTIONS.find((option) => option.startsWith(name));
    if (escape) {
      throw new Error(
        `Option '${arg.split("=")[0]}' (--${escape}) is not allowed: commands always target LocalStack.`
      );
    }
  }
  // lstk answers any help token itself and then runs aws without its endpoint and credential
  // handling, so an API call with a `help` value would leave LocalStack. Only a pure help
  // request, command words followed by one trailing help token, may contain one.
  const helpIndex = args.findIndex((arg) => HELP_TOKENS.has(arg));
  if (
    helpIndex !== -1 &&
    (helpIndex !== args.length - 1 ||
      !args.slice(0, -1).every((arg) => /^[a-z0-9][a-z0-9-]*$/i.test(arg)))
  ) {
    throw new Error(
      "'help', '-h' and '--help' may only end a help request such as 's3 ls help', not appear as a value."
    );
  }
}

export function sanitizeAwsCliCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  if (!command) {
    throw new Error("Command cannot be empty.");
  }

  if (/(^|[\\/\s])\.\.(?:[\\/\s]|$)/.test(command)) {
    throw new Error("Command contains forbidden path traversal.");
  }

  if (/^(?:aws|awslocal)(?:\s|$)/i.test(command)) {
    throw new Error("Command must not include the aws or awslocal executable.");
  }

  if (!/^(?:[a-z][a-z0-9-]*(?:\s+|$)|help$|version$)/i.test(command) || command.startsWith("-")) {
    throw new Error("Command must start with an AWS service or built-in command.");
  }

  const args = splitAwsCliArgs(command);

  assertTargetsLocalStack(args);
  if (args[0]?.toLowerCase() === "configure" && args[1]?.toLowerCase() !== "list") {
    throw new Error("Only 'configure list' is allowed: the AWS CLI config is not changed.");
  }

  return command;
}

export function splitAwsCliArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (character === "\n" || character === "\r" || character === "`") {
      throw new Error("Command contains forbidden shell syntax.");
    }

    if (character === "\\" && quote === '"') {
      const escaped = command[index + 1];
      if (escaped === '"' || escaped === "\\") {
        current += escaped;
        index++;
      } else {
        current += character;
      }
      continue;
    }

    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      continue;
    }

    if (!quote) {
      if (
        ";&|<>".includes(character) ||
        command.startsWith("$(", index) ||
        command.startsWith("${", index)
      ) {
        throw new Error("Command contains forbidden shell syntax.");
      }
      if (/\s/.test(character)) {
        if (current) {
          args.push(current);
          current = "";
        }
        continue;
      }
    }

    current += character;
  }

  if (quote) {
    throw new Error("Command contains an unterminated quote.");
  }
  if (current) {
    args.push(current);
  }
  return args;
}
