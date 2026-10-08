import { splitCliArgs } from "../cli/argv";

// The tokenizer lives in src/lib/cli/argv.ts so the Azure client can share it. The
// AWS client calls it without options, which keeps its original behaviour.
export { splitCliArgs as splitAwsCliArgs } from "../cli/argv";

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

  splitCliArgs(command);

  return command;
}
