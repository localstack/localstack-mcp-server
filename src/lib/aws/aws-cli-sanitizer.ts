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
  // lstk strips its own --config <file> from anywhere in the command and reads that file.
  const lstkFlag = args.find((arg) => /^--config(?:=|$)/i.test(arg));
  if (lstkFlag) {
    throw new Error(`Option '--config' is not allowed: lstk would read it as its own config file.`);
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

const deny = (reason: string, ...prefixes: string[][]) =>
  prefixes.map((match) => ({ match, reason }));

/**
 * Commands refused before anything runs, matched on the leading command words. The CLI runs
 * where this server runs, so these would change this machine, run another program on it, or
 * wait for a person. The private HOME and the egress guard cover most of what remains.
 */
export const DENIED: Array<{ match: string[]; reason: string }> = [
  ...deny(
    "this downloads and installs software on this machine",
    ["update"],
    ["deploy", "install"],
    ["deploy", "uninstall"]
  ),
  ...deny(
    "this opens a browser or waits for a person to sign in",
    ["login"],
    ["logout"],
    ["signup"],
    ["sso", "login"],
    ["sso", "logout"]
  ),
  ...deny(
    "this opens a shell, a tunnel or a session on this machine",
    ["ec2-instance-connect", "ssh"],
    ["ec2-instance-connect", "open-tunnel"],
    ["ssm", "start-session"],
    ["ecs", "execute-command"],
    ["emr", "ssh"],
    ["emr", "socks"],
    ["emr", "get"],
    ["emr", "put"],
    ["opsworks", "register"]
  ),
  ...deny(
    "this configures other tools on this machine",
    ["codeartifact", "login"],
    ["eks", "update-kubeconfig"]
  ),
  ...deny(
    "this uploads the local files a template names, which the tool cannot check; use the deployer tool",
    ["cloudformation", "package"]
  ),
  ...deny("the AWS client keeps no history of its own", ["history"]),
  ...deny("this streams until it is stopped; read the events with filter-log-events instead", [
    "logs",
    "start-live-tail",
  ]),
  ...deny("this needs a person to answer its prompts", ["wizard"]),
  ...deny("this manages agent skills on this machine", ["agent-toolkit"]),
  ...deny("this is the CLI's developer tooling", ["cli-dev"]),
  ...deny("this runs lightsailctl and Docker on this machine", [
    "lightsail",
    "push-container-image",
  ]),
  ...deny(
    "this zips a local directory and follows its symlinks out of the working directory",
    ["deploy", "push"],
    ["gamelift", "upload-build"],
    ["lambda-web"]
  ),
  // The only command that fetches a URL from a server's response: with urlopen, which opens
  // file:// URLs too, so it would copy a local file into the working directory.
  ...deny("this downloads whatever URL the server returns, local files included", [
    "gamelift",
    "get-game-session-log",
  ]),
];

export function sanitizeAwsCliCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  if (!command) {
    throw new Error("Command cannot be empty.");
  }

  if (/(^|[\\/\s])\.\.(?:[\\/\s]|$)/.test(command)) {
    throw new Error("Command contains forbidden path traversal.");
  }

  if (/^(?:aws|awslocal|lstk)(?:\s|$)/i.test(command)) {
    throw new Error("Command must not include the lstk, aws or awslocal executable.");
  }

  if (!/^(?:[a-z][a-z0-9-]*(?:\s+|$)|help$|version$)/i.test(command) || command.startsWith("-")) {
    throw new Error("Command must start with an AWS service or built-in command.");
  }

  const args = splitAwsCliArgs(command);

  assertTargetsLocalStack(args);
  // On the parsed argv: a quote splits `..` in the raw string ('..'/x, ."."/x).
  if (args.some((arg) => /(?:^|[\\/=]|:\/\/)\.\.(?:[\\/]|$)/.test(arg))) {
    throw new Error("Command contains forbidden path traversal.");
  }

  // The service is always the first word. The CLI accepts global options (--region, --output,
  // --no-cli-pager, ...) before the operation, so a denied operation may come at any later
  // position: matching any later word refuses the rare value that happens to equal it.
  const words = args.map((arg) => arg.toLowerCase());
  const has = (word: string) => words.slice(1).includes(word);
  const denied = DENIED.find(
    ({ match }) => words[0] === match[0] && (match.length === 1 || has(match[1]))
  );
  if (denied) {
    throw new Error(`'${denied.match.join(" ")}' is not allowed: ${denied.reason}.`);
  }
  // Any unambiguous prefix of --follow is --follow to the CLI.
  const follow = (w: string) => {
    const name = w.match(/^--([a-z-]+)(?:=|$)/)?.[1];
    return name !== undefined && "follow".startsWith(name);
  };
  if (words[0] === "logs" && has("tail") && words.some(follow)) {
    throw new Error(
      "'logs tail --follow' is not allowed: it streams until it is stopped. Use 'logs tail' with --since instead."
    );
  }
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
