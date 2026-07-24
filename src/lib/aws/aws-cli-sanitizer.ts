export function sanitizeAwsCliCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  if (!command) {
    throw new Error("Command cannot be empty.");
  }

  // The command is ultimately passed as an argv array, but reject shell syntax
  // defensively so future execution changes cannot turn this input into a shell
  // injection primitive.
  const forbiddenShellSyntax = /[;&|`<>$\\\r\n\t]/;
  if (forbiddenShellSyntax.test(command)) {
    throw new Error("Command contains forbidden shell syntax.");
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

  let quote: "'" | '"' | undefined;
  for (const character of command) {
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
    }
  }
  if (quote) {
    throw new Error("Command contains an unterminated quote.");
  }

  return command;
}
