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

  splitAwsCliArgs(command);

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
