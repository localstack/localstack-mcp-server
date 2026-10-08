import { AzSyntaxError, splitAzArgs } from "./argv";

/**
 * The Azure command policy: a pure decision over one `az` command string, made before anything
 * runs. It refuses commands that would break the tool's own profile, change this machine or never
 * end (the deny list), refuses `..` path traversal as the AWS client does, and turns a
 * management.azure.com URL given to `rest` into the relative path the emulator serves. Everything
 * else is left to `az`.
 */

export type PolicyResult =
  { ok: true; argv: string[]; notes: string[] } | { ok: false; title: string; message: string };

const deny = (reason: string, ...prefixes: string[][]) =>
  prefixes.map((match) => ({ match, reason }));

/** Denied command groups and verbs, matched on the leading command words. */
export const DENIED: Array<{ match: string[]; reason: string }> = [
  ...deny("the CLI is already logged in to the emulator with a dummy account", ["login"]),
  ...deny(
    "this would break routing to the emulator",
    ["logout"],
    ["account", "clear"],
    ["cloud", "register"],
    ["cloud", "unregister"],
    ["cloud", "update"],
    ["cloud", "set"]
  ),
  // `config get` survives this (ALLOWED_EXCEPTIONS); every other `config` rewrites the profile.
  ...deny("the tool manages the CLI configuration", ["config"], ["configure"], ["init"]),
  ...deny(
    "the tool uses the extensions you installed with your own `az extension add`",
    ["extension", "add"],
    ["extension", "update"],
    ["extension", "remove"]
  ),
  ...deny(
    "this downloads or installs software on this machine",
    ["upgrade"],
    ["bicep", "install"],
    ["bicep", "upgrade"],
    ["bicep", "uninstall"],
    ["aks", "install-cli"], // on Windows it also rewrites the user's PATH with `setx`
    ["storage", "copy"], // copy, remove and sync download azcopy first
    ["storage", "remove"],
    ["storage", "blob", "sync"]
  ),
  ...deny("this calls a Microsoft web service", ["find"], ["feedback"], ["survey"]),
  ...deny("this needs an interactive session", ["interactive"], ["self-test"]),
  ...deny(
    "this opens a browser, a shell, a tunnel or a live stream on this machine",
    ["aks", "browse"],
    ["webapp", "browse"],
    ["containerapp", "browse"],
    ["webapp", "ssh"],
    ["webapp", "create-remote-connection"],
    ["webapp", "log", "tail"],
    ["container", "exec"],
    ["container", "attach"],
    ["containerapp", "exec"],
    ["network", "bastion", "ssh"],
    ["network", "bastion", "rdp"],
    ["network", "bastion", "tunnel"]
  ),
];

const ALLOWED_EXCEPTIONS = [["config", "get"]];

/** Flags that are refused, everywhere or on one command. */
export const DENIED_FLAGS: Array<{ command?: string[]; flag: string; reason: string }> = [
  { flag: "--follow", reason: "it streams output until killed" },
  { flag: "--login-with-github", reason: "it opens a browser login" },
  { command: ["webapp", "up"], flag: "--launch-browser", reason: "it opens a browser" },
  { command: ["webapp", "up"], flag: "-b", reason: "it opens a browser" },
  { command: ["webapp", "up"], flag: "--logs", reason: "it streams logs until killed" },
];

const START_TOKEN = /^[a-z][a-z0-9-]*$/;
/** A `..` path segment in a value, an `@file` or a `--flag=value`, as the AWS client refuses it. */
const TRAVERSAL = /(^|[\\/=@])\.\.([\\/]|$)/;
const REST_URL_FLAGS = ["--url", "--uri", "-u"];
const MANAGEMENT_URL = /^https?:\/\/management\.azure\.com(:443)?(?=[/?#]|$)/i;

const hasPrefix = (argv: string[], prefix: string[]) =>
  prefix.length <= argv.length && prefix.every((word, index) => argv[index] === word);

/** A token's flag and the value packed into it (`--flag=value`, `-fvalue`), if any. */
function parseOption(token: string): { flag: string; value?: string } {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    return eq < 0 ? { flag: token } : { flag: token.slice(0, eq), value: token.slice(eq + 1) };
  }
  const rest = token.slice(2);
  return { flag: token.slice(0, 2), value: rest ? rest.replace(/^=/, "") : undefined };
}

/** argparse accepts an unambiguous prefix of a long flag (`--fol` for `--follow`). */
function flagMatches(tokenFlag: string, fullFlag: string): boolean {
  if (tokenFlag === fullFlag) return true;
  return (
    fullFlag.startsWith("--") &&
    tokenFlag.startsWith("--") &&
    tokenFlag.length >= 4 &&
    fullFlag.startsWith(tokenFlag)
  );
}

const refuse = (title: string, message: string): PolicyResult => ({ ok: false, title, message });

export function evaluateAzCommand(command: string): PolicyResult {
  // One leading `az` is optional.
  const body = command.trim().replace(/^az(\s+|$)/, "");

  let argv: string[];
  try {
    argv = splitAzArgs(body);
  } catch (error) {
    const message = error instanceof AzSyntaxError ? error.message : "Command could not be parsed.";
    return refuse("Command not understood", message);
  }
  if (argv.length === 0) {
    return refuse("No command given", "Give one `az` command, for example `group list`.");
  }
  if (argv[0] === "az" || argv[0] === "azlocal") {
    return refuse(
      "Extra executable in the command",
      "Give the command without the `az` or `azlocal` executable, for example `group list`."
    );
  }
  if (!START_TOKEN.test(argv[0]) && !["--help", "-h", "--version"].includes(argv[0])) {
    return refuse(
      "Not a valid command",
      "Start with a command group or verb, for example `group list`."
    );
  }
  if (argv.some((token) => TRAVERSAL.test(token))) {
    return refuse("Path not allowed", "Command contains forbidden path traversal (`..`).");
  }

  const isException = ALLOWED_EXCEPTIONS.some((prefix) => hasPrefix(argv, prefix));
  for (const entry of DENIED) {
    if (!hasPrefix(argv, entry.match)) continue;
    if (isException && entry.match.join(" ") === "config") continue;
    return refuse(
      "Command not allowed",
      `\`az ${entry.match.join(" ")}\` is not allowed here: ${entry.reason}.`
    );
  }
  const flags = argv.filter((token) => token.startsWith("-")).map((t) => parseOption(t).flag);
  for (const rule of DENIED_FLAGS) {
    if (rule.command && !hasPrefix(argv, rule.command)) continue;
    if (flags.some((flag) => flagMatches(flag, rule.flag))) {
      const scope = rule.command ? `\`az ${rule.command.join(" ")}\` ` : "";
      return refuse(
        "Flag not allowed",
        `${scope}cannot be run with \`${rule.flag}\` here: ${rule.reason}.`
      );
    }
  }

  // `rest` sends absolute URLs as they are: one for management.azure.com would leave the emulator.
  const notes: string[] = [];
  if (argv[0] === "rest") {
    for (let i = 1; i < argv.length; i++) {
      if (!argv[i].startsWith("-")) continue;
      const { flag, value } = parseOption(argv[i]);
      if (!REST_URL_FLAGS.some((urlFlag) => flagMatches(flag, urlFlag))) continue;
      const index = value === undefined ? i + 1 : i;
      const url = value ?? argv[index];
      if (url === undefined || !MANAGEMENT_URL.test(url)) continue;
      const relative = url.replace(MANAGEMENT_URL, "").replace(/^(?!\/)/, "/");
      argv[index] =
        value === undefined ? relative : `${argv[i].slice(0, -value.length)}${relative}`;
      notes.push(
        `Rewrote the management.azure.com URL to the relative path \`${relative}\`, which the emulator serves.`
      );
    }
  }
  return { ok: true, argv, notes };
}
