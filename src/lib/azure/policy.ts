import os from "os";
import { AzSyntaxError, splitAzArgs } from "./argv";
import { isLocalHost } from "./config";

/**
 * The Azure command policy: a decision over one `az` command string, made before anything runs.
 * It refuses commands that would break the tool's own profile, change this machine or never end
 * (the deny list), refuses `..` path traversal as the AWS client does, and keeps `rest` on local
 * hosts: a management.azure.com URL becomes the relative path the emulator serves, and any other
 * absolute URL must name a local host. A leading `~` becomes the user's home, which is what `az`
 * would make of it without the tool's private HOME. Everything else is left to `az`.
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
    ["storage", "copy"], // these download azcopy first
    ["storage", "remove"],
    ["storage", "blob", "sync"],
    ["storage", "fs", "directory", "upload"],
    ["storage", "fs", "directory", "download"]
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
    ["network", "bastion", "tunnel"],
    ["ssh"] // the ssh extension's `ssh vm` and `ssh arc`
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

/** A `rest` URL flag, or a prefix of one (`--ur`): az finds those ambiguous, and so are they here. */
const isRestUrlFlag = (flag: string) =>
  REST_URL_FLAGS.some(
    (full) => flag === full || (flag.startsWith("--") && flag.length >= 4 && full.startsWith(flag))
  );

/** `az rest` sends a URL with a scheme as it is, and puts the emulator's endpoint before any other. */
const hasScheme = (url: string) => url.includes("://") || /^https?:/i.test(url);

/**
 * `~`, `~/x`, `@~/x`, `--flag=~/x` and `-f~/x` with the user's home in place of the `~`, in any
 * argument: the policy cannot tell which values are paths.
 */
function expandHome(token: string, home: string, platform: NodeJS.Platform): string {
  const tilde =
    platform === "win32"
      ? /^(--[^=]+=|-[A-Za-z]=?)?(@?)~(?=$|[\\/])/
      : /^(--[^=]+=|-[A-Za-z]=?)?(@?)~(?=$|\/)/;
  return token.replace(tilde, (_match, flag = "", at = "") => `${flag}${at}${home}`);
}

const refuse = (title: string, message: string): PolicyResult => ({ ok: false, title, message });

export function evaluateAzCommand(
  command: string,
  user: { home?: string; platform?: NodeJS.Platform } = {}
): PolicyResult {
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
  if (argv[0] === "--version") {
    return refuse(
      "Not a valid command",
      "`--version` asks PyPI for a newer Azure CLI; use `version`, which makes no network call."
    );
  }
  if (!START_TOKEN.test(argv[0]) && !["--help", "-h"].includes(argv[0])) {
    return refuse(
      "Not a valid command",
      "Start with a command group or verb, for example `group list`."
    );
  }
  // A short option's attached value (`-f../x`) is checked on its own too.
  const values = argv.flatMap((t) => (/^-[^-]/.test(t) ? [t, parseOption(t).value ?? ""] : [t]));
  if (values.some((value) => TRAVERSAL.test(value))) {
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
    if (flags.includes(rule.flag)) {
      const scope = rule.command ? `\`az ${rule.command.join(" ")}\` ` : "";
      return refuse(
        "Flag not allowed",
        `${scope}cannot be run with \`${rule.flag}\` here: ${rule.reason}.`
      );
    }
  }

  // `rest` would send an absolute URL, and a file given as its body, to any host.
  const notes: string[] = [];
  if (argv[0] === "rest") {
    for (let i = 1; i < argv.length; i++) {
      if (!argv[i].startsWith("-")) continue;
      const { flag, value } = parseOption(argv[i]);
      if (!isRestUrlFlag(flag)) continue;
      const index = value === undefined ? i + 1 : i;
      const url = value ?? argv[index];
      if (url === undefined) continue;
      if (MANAGEMENT_URL.test(url)) {
        const relative = url.replace(MANAGEMENT_URL, "").replace(/^(?!\/)/, "/");
        argv[index] =
          value === undefined ? relative : `${argv[i].slice(0, -value.length)}${relative}`;
        notes.push(
          `Rewrote the management.azure.com URL to the relative path \`${relative}\`, which the emulator serves.`
        );
        continue;
      }
      const host = URL.canParse(url) ? new URL(url).hostname : undefined;
      if (hasScheme(url) && !(host && isLocalHost(host))) {
        return refuse(
          "URL not allowed",
          `\`rest\` calls the emulator only: give a relative URL such as \`/subscriptions?api-version=2022-12-01\`, or one on a local host. ${host ? `"${host}" is not a local host.` : `"${url}" is not a valid URL.`}`
        );
      }
    }
  }
  const home = user.home ?? os.homedir();
  const platform = user.platform ?? process.platform;
  return { ok: true, argv: argv.map((token) => expandHome(token, home, platform)), notes };
}
