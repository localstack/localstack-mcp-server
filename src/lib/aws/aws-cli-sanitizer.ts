export function sanitizeAwsCliCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  const forbidden = /(\|\||&&|;|`|\$\([^)]*\)|\||>|<|\n)/;
  if (forbidden.test(command)) {
    throw new Error("Command contains forbidden shell characters.");
  }
  return command;
}
