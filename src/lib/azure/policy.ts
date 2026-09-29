/**
 * The Azure command policy: a pure decision over one `az` command string.
 *
 * It never spawns anything and never reaches the network. It decides, before the emulator is
 * touched, whether a command may run, must be rewritten (a management.azure.com URL made
 * relative), is answered locally (`version`), or is refused with a stable rule id. The handler
 * runs this first, so a refusal costs nothing.
 *
 * The tokenizer is the shared one in src/lib/cli/argv.ts, run with the three options that make
 * it accept every `az` command in the Azure samples (policy.corpus.test.ts).
 */

import fs from "fs";
import path from "path";
import { CliSyntaxError, splitCliArgs } from "../cli/argv";
import { isLocalHost, LOCAL_HOST } from "./local-hosts";
import type { PolicyOptions, PolicyResult } from "./types";

/** The platform-specific path flavour (path.win32 / path.posix), so resolution is host-independent. */
type PlatformPath = typeof path.win32;

// The generated file-argument table (scripts/gen-az-file-args.py). tsconfig has
// resolveJsonModule off, so it is loaded with require and typed here.
interface FileArgsEntry {
  /** All option strings (long and short) az annotates as a file/directory for this command. */
  flags: string[];
  /** The subset that is nargs '+'/'*', so it consumes several path values. */
  greedy?: string[];
  /** The command takes a positional path (acr build / acr run source). */
  positional?: boolean;
}
interface FileArgsTable {
  _metadata: Record<string, unknown>;
  commands: Record<string, FileArgsEntry>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const GENERATED_TABLE: FileArgsTable = require("./az-file-args.generated.json");

/**
 * Path arguments az 2.87 does NOT annotate with `file_type` or a file/directory completer, so
 * the generated table misses them, yet they read or write a local path outside the workdir.
 * Only the LOCAL side of each is listed: for `download-batch`
 * `--destination` is local (the source is a remote container); for `upload-batch` `--source`
 * is local. DR4 note: recheck this list when the az pin moves, in case az adds the annotations.
 */
const EXTRA_FILE_ARGS: Record<string, { flags: string[]; greedy?: string[] }> = {
  "storage blob download-batch": { flags: ["--destination", "-d"] },
  "storage file download-batch": { flags: ["--destination", "-d"] },
  "storage blob upload-batch": { flags: ["--source", "-s"] },
  "storage file upload-batch": { flags: ["--source", "-s"] },
  "storage fs directory download": { flags: ["--destination-path", "-d"] },
  "storage fs directory upload": { flags: ["--source", "-s"] },
  "webapp deploy": { flags: ["--src-path"] },
  "functionapp deploy": { flags: ["--src-path"] },
  "webapp deployment source config-zip": { flags: ["--src"] },
  "functionapp deployment source config-zip": { flags: ["--src"] },
  "logicapp deployment source config-zip": { flags: ["--src"] },
  "webapp config container set": { flags: ["--multicontainer-config-file"] },
  "webapp create": { flags: ["--multicontainer-config-file"] },
  "container create": { flags: ["--file", "-f"] },
  "container container-group-profile create": { flags: ["--file", "-f"] },
  "aks command invoke": { flags: ["--file", "-f"] },
  "ts export": { flags: ["--output-folder"] },
  "appconfig kv export": { flags: ["--path"] },
  // az opens these itself in custom code, and they always take a path (never inline), so they are
  // checked unconditionally like the rest of this list — a write target need not exist yet, so the
  // existing-path safety net below would miss it. `rest --output-file` writes the
  // response; the `apim` ones read/write a spec or schema file.
  rest: { flags: ["--output-file"] },
  "apim api import": { flags: ["--specification-path"] },
  "apim api export": { flags: ["--file-path", "-f"] },
  "apim api schema create": { flags: ["--schema-path"] },
};

// ---------------------------------------------------------------------------
// Policy data. Exported so tests and the cross-check can read the same source.
// ---------------------------------------------------------------------------

const deny = (
  reason: string,
  ...prefixes: string[][]
): Array<{ match: string[]; reason: string }> => prefixes.map((match) => ({ match, reason }));

/** Denied command groups and verbs. Prefix matches. */
export const DENIED: Array<{ match: string[]; reason: string }> = [
  ...deny("the CLI is already logged in to the emulator with a dummy account", ["login"]),
  ...deny("this would break routing to the emulator", ["logout"], ["account", "clear"]),
  ...deny(
    "this would re-point the CLI away from the emulator",
    ["cloud", "register"],
    ["cloud", "unregister"],
    ["cloud", "update"],
    ["cloud", "set"]
  ),
  // `config get` is allowed below; every other `config`, plus `configure`/`init`, writes state.
  ...deny("the tool manages the CLI configuration", ["config"], ["configure"], ["init"]),
  ...deny(
    "extensions are pre-installed; adding or updating one downloads from the internet",
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
    ["bicep", "list-versions"],
    ["aks", "install-cli"] // also runs `setx path`, rewriting the real user PATH
  ),
  ...deny(
    "Bicep registry modules cannot be reached from the local emulator",
    ["bicep", "restore"],
    ["bicep", "publish"]
  ),
  ...deny("this calls a Microsoft web service", ["find"], ["feedback"], ["survey"]),
  ...deny("this needs an interactive session", ["interactive"], ["self-test"]),
  ...deny(
    "this opens a browser on this machine",
    ["aks", "browse"],
    ["webapp", "browse"],
    ["containerapp", "browse"]
  ),
  ...deny(
    "this opens a shell, tunnel or live stream",
    ["webapp", "ssh"],
    ["webapp", "create-remote-connection"],
    ["container", "exec"],
    ["container", "attach"],
    ["containerapp", "exec"],
    ["webapp", "log", "tail"],
    ["appservice", "plan", "managed-instance", "instance", "connect"],
    ["network", "bastion", "ssh"],
    ["network", "bastion", "rdp"],
    ["network", "bastion", "tunnel"]
  ),
  ...deny(
    "this runs Docker or downloads tools on this machine",
    ["acr", "check-health"],
    ["acr", "helm"],
    ["aks", "check-acr"],
    ["storage", "copy"],
    ["storage", "remove"],
    ["storage", "blob", "sync"], // storage copy/remove/sync auto-install azcopy from aka.ms
    ["backup", "restore", "files", "mount-rp"],
    ["mysql", "flexible-server", "deploy"],
    ["postgres", "flexible-server", "deploy"]
  ),
  // Denied outright until its local-source flag is wired from _params.py. With a
  // local source it makes az run `docker build`/`push` on the shared engine.
  ...deny("this builds and pushes images on the shared Docker engine", [
    "cognitiveservices",
    "agent",
    "create",
  ]),
  ...deny(
    "Azure DevOps is not emulated",
    ["devops"],
    ["boards"],
    ["repos"],
    ["pipelines"],
    ["artifacts"]
  ),
];

/** Verbs that survive a broader group denial. */
export const ALLOWED_EXCEPTIONS: string[][] = [["config", "get"]];

/** Flags that are refused, globally or for a specific command. */
export const DENIED_FLAGS: Array<{ command?: string[]; flag: string; reason: string }> = [
  { flag: "--follow", reason: "it streams output until killed" },
  { flag: "--login-with-github", reason: "it opens a browser login" },
  { command: ["webapp", "up"], flag: "--launch-browser", reason: "it opens a browser" },
  { command: ["webapp", "up"], flag: "-b", reason: "it opens a browser" },
  { command: ["webapp", "up"], flag: "--logs", reason: "it streams logs until killed" },
  {
    command: ["containerapp", "up"],
    flag: "--source",
    reason: "it builds an image on the shared Docker engine",
  },
  {
    command: ["containerapp", "up"],
    flag: "--repo",
    reason: "it wires up a GitHub Actions build",
  },
  {
    command: ["containerapp", "create"],
    flag: "--source",
    reason: "it builds an image on the shared Docker engine",
  },
  {
    command: ["containerapp", "create"],
    flag: "--repo",
    reason: "it wires up a GitHub Actions build",
  },
];

/** Flags a command must carry, or it is refused. */
export const REQUIRED_FLAGS: Array<{
  command: string[];
  flag: string;
  aliases?: string[];
  reason: string;
}> = [
  {
    command: ["acr", "login"],
    flag: "--expose-token",
    aliases: ["-t"],
    reason:
      "without `--expose-token` az runs `docker login` on this machine; re-run it with `--expose-token`",
  },
];

/**
 * Local hosts the URL rule and the egress guard both allow: one
 * shared check in local-hosts.ts. Re-exported here for the policy's own tests.
 */
export { LOCAL_HOST };

/** The ARM host whose absolute URLs are rewritten to a relative path (matched case-insensitively). */
const MANAGEMENT_HOST = "management.azure.com";

/** URL-target flags whose value az turns into a request or a download. */
const REST_URL_FLAGS = new Set(["--url", "--uri", "-u"]); // only for the `rest` command
const FETCH_URL_FLAGS = new Set(["--template-uri", "--multicontainer-config-file"]); // any command
const PARAMETERS_FLAGS = new Set(["--parameters", "-p"]); // URL or file, depending on the value

// ---------------------------------------------------------------------------
// Denylist file parsing.
// ---------------------------------------------------------------------------

/**
 * Parse LOCALSTACK_AZ_DENYLIST_FILE: one command prefix per line, split on whitespace. Blank
 * lines and `#` comments are ignored. The result is passed to evaluateAzCommand
 * as opts.extraDenied, so the policy itself stays pure.
 */
export function parseDenylistFile(text: string): string[][] {
  const prefixes: string[][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/#.*$/, "");
    const words = withoutComment.trim().split(/\s+/).filter(Boolean);
    if (words.length > 0) prefixes.push(words);
  }
  return prefixes;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const START_TOKEN = /^[a-z][a-z0-9-]*$/;
const HELP_TOKENS = new Set(["--help", "-h"]);
const ARM_ID = /^\/(subscriptions|providers|tenants)\//i;
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function effectivePlatform(opts: PolicyOptions): NodeJS.Platform {
  return opts.platform ?? process.platform;
}

/** True when a command's leading words match `prefix` exactly. */
function hasPrefix(argv: string[], prefix: string[]): boolean {
  if (prefix.length > argv.length) return false;
  return prefix.every((word, index) => argv[index] === word);
}

/**
 * Match an option token against a canonical flag, honouring argparse's unambiguous-prefix
 * abbreviation for long flags (verified: `cloud list --out tsv` and `--que` both work). A token
 * `--<p>` with p.length >= 2 that is a strict prefix of a long flag counts as that flag; short
 * `-x` flags match only exactly. When a prefix could match several path/URL flags we still apply
 * the rule (argparse would reject it as ambiguous, so being stricter is safe).
 */
function flagMatches(tokenFlag: string, fullFlag: string): boolean {
  if (tokenFlag === fullFlag) return true;
  return (
    fullFlag.startsWith("--") &&
    tokenFlag.startsWith("--") &&
    tokenFlag.length >= 4 && // "--" plus at least two characters
    fullFlag.length > tokenFlag.length &&
    fullFlag.startsWith(tokenFlag)
  );
}

/** True when a token's flag matches any flag in the set (exact or an unambiguous prefix). */
function matchesAnyFlag(tokenFlag: string, flags: Iterable<string>): boolean {
  for (const flag of flags) if (flagMatches(tokenFlag, flag)) return true;
  return false;
}

interface ParsedOption {
  flag: string;
  /** The value packed into the token itself (`--flag=v`, `-fv`, `-f=v`), else undefined. */
  value?: string;
  /** How an inline value was attached, so a rewrite can rebuild the token. */
  sep: "=" | "";
}

/** Split one option token into its flag and any attached value (no lookup of the next token). */
function parseOption(token: string): ParsedOption {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    if (eq >= 0) return { flag: token.slice(0, eq), value: token.slice(eq + 1), sep: "=" };
    return { flag: token, sep: "" };
  }
  // A single-dash short option, possibly with a stuck or `=`-joined value (`-f/x`, `-f=/x`).
  const flag = token.slice(0, 2);
  const rest = token.slice(2);
  if (rest === "") return { flag, sep: "" };
  if (rest.startsWith("=")) return { flag, value: rest.slice(1), sep: "=" };
  return { flag, value: rest, sep: "" };
}

/** The path-taking flags of the command in `argv`, from the generated table plus the supplement. */
function commandFileFlags(argv: string[]): {
  generic: Set<string>;
  greedy: Set<string>;
  params: Set<string>;
  positional: boolean;
} {
  const generic = new Set<string>();
  const greedy = new Set<string>();
  const params = new Set<string>();
  let positional = false;

  const apply = (entry: { flags: string[]; greedy?: string[]; positional?: boolean }) => {
    const hasParameters = entry.flags.includes("--parameters");
    for (const flag of entry.flags) {
      // `--parameters` (and its `-p` alias, only where `--parameters` exists) needs the special
      // rule below, not the plain path check, so it is routed to `params`.
      if (flag === "--parameters" || (hasParameters && flag === "-p")) {
        params.add(flag);
        continue;
      }
      generic.add(flag);
    }
    for (const flag of entry.greedy ?? []) {
      if (flag === "--parameters" || (hasParameters && flag === "-p")) continue;
      greedy.add(flag);
    }
    if (entry.positional) positional = true;
  };

  // The command path is the longest table key whose words are a prefix of argv (so
  // "storage blob download-batch" is matched, not "storage blob download").
  for (const source of [GENERATED_TABLE.commands, EXTRA_FILE_ARGS]) {
    let bestWords = -1;
    let bestEntry: { flags: string[]; greedy?: string[]; positional?: boolean } | undefined;
    for (const [key, entry] of Object.entries(source)) {
      const words = key.split(" ");
      if (words.length > bestWords && hasPrefix(argv, words)) {
        bestWords = words.length;
        bestEntry = entry;
      }
    }
    if (bestEntry) apply(bestEntry);
  }
  return { generic, greedy, params, positional };
}

// ---------------------------------------------------------------------------
// The file rule: resolve a path value and decide whether it stays inside the workdir.
// ---------------------------------------------------------------------------

type PathVerdict =
  | { kind: "ok" }
  | { kind: "arm" }
  | { kind: "outside" }
  | { kind: "protected"; dir: string }
  | { kind: "unsupported"; why: string };

function stripAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Classify one path value. Lexical always (resolve, normalise, case-insensitive on win32/darwin);
 * realpath too, but only when the file exists, to catch a symlink or junction that escapes. The
 * realpath step is the one bit of I/O the policy does, and it is skipped for the paths the tests
 * use, which do not exist — so the default path stays pure and deterministic.
 */
function classifyPath(rawValue: string, opts: PolicyOptions): PathVerdict {
  const value = stripAt(rawValue);
  if (value === "" || value === "-") return { kind: "ok" }; // empty or stdin: not a filesystem path
  if (ARM_ID.test(value)) return { kind: "arm" };

  const plat = effectivePlatform(opts);
  const P = plat === "win32" ? path.win32 : path.posix;

  if (plat === "win32") {
    if (/^[\\/]{2}/.test(value)) {
      // \\host\share (also attempts outbound SMB auth), \\?\ and \\.\ device paths.
      return { kind: "unsupported", why: "a UNC or device path" };
    }
    if (/^[A-Za-z]:([^\\/]|$)/.test(value)) {
      // Drive-relative `C:x` or a bare drive `C:`: it resolves against a per-drive cwd, not ours.
      return { kind: "unsupported", why: "a drive-relative path" };
    }
  }

  // `~` means the tool's private home, as it does for az itself.
  const isTilde = value === "~" || value.startsWith("~/") || value.startsWith("~\\");
  const expanded = isTilde ? opts.homeDir + value.slice(1) : value;
  const base = isTilde ? opts.homeDir : opts.workdir;
  const resolvedLexical = P.resolve(base, expanded);

  const lexical = containmentVerdict(resolvedLexical, opts, P);
  if (lexical.kind !== "ok") return lexical;

  // Only if the lexical path is allowed do we pay for realpath, and only if the file exists.
  try {
    if (fs.existsSync(resolvedLexical)) {
      const real = fs.realpathSync.native(resolvedLexical);
      const realVerdict = containmentVerdict(real, opts, P);
      if (realVerdict.kind !== "ok") return realVerdict;
    }
  } catch {
    // A stat/realpath failure is not evidence of an escape; keep the lexical verdict.
  }
  return { kind: "ok" };
}

function containmentVerdict(resolved: string, opts: PolicyOptions, P: PlatformPath): PathVerdict {
  const plat = effectivePlatform(opts);
  const inside = (parent: string): boolean => isInside(resolved, parent, plat, P);

  // The private home is always allowed, even though a protected dir (the config dir) contains it.
  if (opts.homeDir && inside(opts.homeDir)) return { kind: "ok" };
  // Protected dirs are checked before the workdir allowance: when the workdir is the user's home
  // or an ancestor, a relative `.ssh/id_rsa` would otherwise pass the workdir check (coordinator).
  for (const dir of opts.protectedDirs ?? []) {
    if (dir && inside(dir)) return { kind: "protected", dir };
  }
  if (inside(opts.workdir)) return { kind: "ok" };
  return { kind: "outside" };
}

function isInside(child: string, parent: string, plat: NodeJS.Platform, P: PlatformPath): boolean {
  const fold = (p: string) => (plat === "win32" || plat === "darwin" ? p.toLowerCase() : p);
  const c = fold(P.resolve(child));
  let pa = fold(P.resolve(parent));
  if (c === pa) return true;
  if (!pa.endsWith(P.sep)) pa += P.sep;
  return c.startsWith(pa);
}

// ---------------------------------------------------------------------------
// The URL rule (request targets only).
// ---------------------------------------------------------------------------

type UrlVerdict =
  | { action: "none" } // not an absolute URL: leave it to the file rule / pass through
  | { action: "allow" } // a local host
  | { action: "rewrite"; rewritten: string }
  | { action: "refuse"; host: string };

function classifyUrl(value: string): UrlVerdict {
  // The host is a bracketed IPv6 literal or a name (userinfo stays in it, so
  // `https://management.azure.com@evil.example` is not the management host).
  const match = value.match(
    /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(\[[^\]]*\]|[^/:?#[\]]+)(:\d+)?([/?#].*)?$/
  );
  if (!match) return { action: "none" };
  const scheme = match[1].toLowerCase();
  const host = match[2];
  const port = match[3] ?? "";
  const rest = match[4] ?? "";
  const isHttp = scheme === "http" || scheme === "https";

  if (isHttp && host.toLowerCase() === MANAGEMENT_HOST && (port === "" || port === ":443")) {
    // Rewrite https://management.azure.com/<p> to /<p>, keeping the leading slash.
    const rewritten = rest.startsWith("/") ? rest : "/";
    return { action: "rewrite", rewritten };
  }
  if (isLocalHost(host)) return { action: "allow" };
  return { action: "refuse", host };
}

// ---------------------------------------------------------------------------
// Refusal builders.
// ---------------------------------------------------------------------------

function refuse(title: string, message: string, ruleId: string, argv?: string[]): PolicyResult {
  return { ok: false, title, message, ruleId, argv };
}

function slug(prefix: string[]): string {
  return prefix.join("-");
}

// ---------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------

/**
 * Decide what to do with one `az` command string. Pure: no spawn, no network, and no file read
 * except the guarded realpath check in classifyPath. See the module comment for the pipeline.
 */
export function evaluateAzCommand(command: string, opts: PolicyOptions): PolicyResult {
  // 1. Trim, then strip ONE leading `az`.
  let body = command.trim();
  const azStrip = body.match(/^az(\s+|$)/);
  if (azStrip) body = body.slice(azStrip[0].length).trim();

  // 2. Tokenize with the three Azure options; a syntax error stops here.
  let argv: string[];
  try {
    argv = splitCliArgs(body, {
      quotedControlChars: true,
      keepEmptyQuoted: true,
      bashDoubleQuoteEscapes: true,
    });
  } catch (error) {
    const message =
      error instanceof CliSyntaxError ? error.message : "Command could not be parsed.";
    return refuse("Command not understood", message, "syntax");
  }

  if (argv.length === 0) {
    return refuse(
      "No command given",
      "Give one `az` command without the leading `az`, for example `group list`.",
      "start"
    );
  }

  // 3. A second `az`, or `azlocal`, is refused (one `az` was already stripped).
  if (argv[0] === "az" || argv[0] === "azlocal") {
    return refuse(
      "Extra executable in the command",
      "Give just the command, without the `az` or `azlocal` executable, for example `group list`.",
      "start",
      argv
    );
  }

  // 4. Start rule: a command group/verb, or a bare `--help`/`-h`/`--version`.
  const first = argv[0];
  const startOk = START_TOKEN.test(first) || HELP_TOKENS.has(first) || first === "--version";
  if (!startOk) {
    return refuse(
      "Not a valid command",
      "Start with a command group or verb (e.g. `group list`). A leading global flag such as " +
        "`--debug` is not supported here.",
      "start",
      argv
    );
  }

  // 5. Denied groups and verbs, honouring the `config get` exception.
  const denialCheck = checkDenied(argv, opts);
  if (denialCheck) return denialCheck;

  // 6. The URL rule (request targets only): rewrite, allow local, or refuse. May change argv.
  const notes: string[] = [];
  const urlResult = applyUrlRule(argv, notes);
  if (!urlResult.ok) return urlResult.refusal;
  argv = urlResult.argv;

  // 7. The file rule on the (possibly rewritten) argv.
  const fileRefusal = applyFileRule(argv, opts, notes);
  if (fileRefusal) return fileRefusal;

  // 8. Bicep detection and help detection.
  const needsBicep = detectBicep(argv);
  const isHelp = argv.some((token) => HELP_TOKENS.has(token));

  // 9. The `version` marker (answered locally by the handler), last so a real `--version 16` flag
  //    on `postgres flexible-server create` still runs.
  if (argv[0] === "version" || (argv.length === 1 && argv[0] === "--version")) {
    return {
      ok: true,
      local: "version",
      argv,
      notes,
      isHelp: false,
      needsBicep: false,
      outcome: "local",
    };
  }

  return {
    ok: true,
    argv,
    notes,
    isHelp,
    needsBicep,
    outcome: notes.length > 0 ? "rewritten" : "ok",
  };
}

function checkDenied(argv: string[], opts: PolicyOptions): PolicyResult | null {
  const isException = ALLOWED_EXCEPTIONS.some((prefix) => hasPrefix(argv, prefix));

  for (const entry of DENIED) {
    if (!hasPrefix(argv, entry.match)) continue;
    // `config get` survives the whole-group `config` denial.
    if (isException && entry.match.length === 1 && entry.match[0] === "config") continue;
    return refuse(
      "Command not allowed",
      `\`az ${entry.match.join(" ")}\` is not allowed here: ${entry.reason}.`,
      `denied:${slug(entry.match)}`,
      argv
    );
  }

  for (const prefix of opts.extraDenied ?? []) {
    if (prefix.length > 0 && hasPrefix(argv, prefix)) {
      return refuse(
        "Command not allowed",
        `\`az ${prefix.join(" ")}\` is blocked by the configured denylist (LOCALSTACK_AZ_DENYLIST_FILE).`,
        `denied:${slug(prefix)}`,
        argv
      );
    }
  }

  // Denied flags, global or per command. Prefix-aware: `--fol` counts as `--follow` (argparse
  // abbreviation), so an abbreviation cannot slip a denied flag past the policy.
  const tokenFlags = argv
    .filter((token) => token.startsWith("-"))
    .map((token) => parseOption(token).flag);
  for (const rule of DENIED_FLAGS) {
    if (rule.command && !hasPrefix(argv, rule.command)) continue;
    if (tokenFlags.some((tokenFlag) => flagMatches(tokenFlag, rule.flag))) {
      const scope = rule.command ? `\`az ${rule.command.join(" ")}\` ` : "";
      return refuse(
        "Flag not allowed",
        `${scope}cannot be run with \`${rule.flag}\`: ${rule.reason}.`,
        "denied:flag",
        argv
      );
    }
  }

  // Required flags (acr login --expose-token). An abbreviation such as `--expose` satisfies it.
  // A help request needs none: `az acr login --help` only prints help.
  const helpRequest = argv.some((token) => HELP_TOKENS.has(token));
  for (const rule of REQUIRED_FLAGS) {
    if (helpRequest || !hasPrefix(argv, rule.command)) continue;
    const satisfied =
      tokenFlags.some((tokenFlag) => flagMatches(tokenFlag, rule.flag)) ||
      (rule.aliases ?? []).some((alias) => tokenFlags.includes(alias));
    if (!satisfied) {
      return refuse(
        "Missing required flag",
        `\`az ${rule.command.join(" ")}\` needs \`${rule.flag}\`: ${rule.reason}.`,
        `denied:${slug(rule.command)}`,
        argv
      );
    }
  }
  return null;
}

interface UrlPassResult {
  ok: boolean;
  argv: string[];
  refusal: PolicyResult;
}

function applyUrlRule(argv: string[], notes: string[]): UrlPassResult {
  const out = [...argv];
  const isRest = argv[0] === "rest";
  const isAcrBuildRun = argv[0] === "acr" && (argv[1] === "build" || argv[1] === "run");
  const ok = (): UrlPassResult => ({ ok: true, argv: out, refusal: {} as PolicyResult });
  const bad = (r: PolicyResult): UrlPassResult => ({ ok: false, argv: out, refusal: r });

  const refuseHost = (
    flagLabel: string,
    host: string,
    kind: "request" | "download"
  ): UrlPassResult => {
    // `rest` takes a request target; the other URL flags make az download a file.
    const advice =
      kind === "request"
        ? "For ARM calls, use a relative URL such as `/subscriptions/<id>/resourceGroups?api-version=2022-09-01`."
        : "Download the file into the working directory yourself and pass it as a local path instead.";
    return bad(
      refuse(
        "Address not allowed",
        `${flagLabel} points at \`${host}\`, which the tool cannot reach: it only talks to the ` +
          `local emulator. ${advice}`,
        "url:blocked",
        argv
      )
    );
  };

  const handleUrlValue = (
    flagLabel: string,
    value: string,
    write: (rewritten: string) => void,
    kind: "request" | "download" = "download"
  ): UrlPassResult | null => {
    const verdict = classifyUrl(value);
    if (verdict.action === "refuse") return refuseHost(flagLabel, verdict.host, kind);
    if (verdict.action === "rewrite") {
      write(verdict.rewritten);
      notes.push(
        `Rewrote the ${MANAGEMENT_HOST} URL of ${flagLabel} to the relative path \`${verdict.rewritten}\`.`
      );
    }
    return null;
  };

  for (let i = 0; i < out.length; i++) {
    const token = out[i];
    if (!token.startsWith("-")) continue;
    const parsed = parseOption(token);
    // Prefix-aware, so `rest --ur` and `--template-u` are caught like the full flags.
    const isRestFlag = isRest && matchesAnyFlag(parsed.flag, REST_URL_FLAGS);
    const isFetchFlag = matchesAnyFlag(parsed.flag, FETCH_URL_FLAGS);
    const isParams = matchesAnyFlag(parsed.flag, PARAMETERS_FLAGS);
    if (!isRestFlag && !isFetchFlag && !isParams) continue;

    const label = `\`${parsed.flag}\``;
    const kind = isRestFlag ? "request" : "download";
    if (parsed.value !== undefined) {
      // `--parameters` only gets the URL rule when the value is actually a URL.
      if (isParams && classifyUrl(parsed.value).action === "none") continue;
      const result = handleUrlValue(
        label,
        parsed.value,
        (rewritten) => {
          out[i] = parsed.flag + parsed.sep + rewritten;
        },
        kind
      );
      if (result) return result;
    } else if (i + 1 < out.length && !out[i + 1].startsWith("-")) {
      const value = out[i + 1];
      if (isParams && classifyUrl(value).action === "none") continue;
      const valueIndex = i + 1;
      const result = handleUrlValue(
        label,
        value,
        (rewritten) => {
          out[valueIndex] = rewritten;
        },
        kind
      );
      if (result) return result;
    }
  }

  // acr build / acr run: a URL as the positional source is a request target too.
  if (isAcrBuildRun) {
    for (const idx of positionalIndexes(out, 2)) {
      const value = out[idx];
      const lower = value.toLowerCase();
      const isGitOrOci =
        lower.startsWith("git@") ||
        lower.startsWith("git://") ||
        lower.startsWith("github.com/") ||
        lower.startsWith("oci://");
      if (isGitOrOci) return refuseHost("the `acr` source", value, "download");
      if (ABSOLUTE_URL.test(value)) {
        const result = handleUrlValue("the `acr` source", value, (rewritten) => {
          out[idx] = rewritten;
        });
        if (result) return result;
      }
    }
  }

  return ok();
}

/** Indexes of positional tokens (a bare token whose predecessor is not an option). */
function positionalIndexes(argv: string[], startAfter: number): number[] {
  const out: number[] = [];
  for (let i = startAfter; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("-")) continue;
    const previous = argv[i - 1];
    if (i === startAfter || previous === undefined || !previous.startsWith("-")) out.push(i);
  }
  return out;
}

function applyFileRule(argv: string[], opts: PolicyOptions, notes: string[]): PolicyResult | null {
  const { generic, greedy, params, positional } = commandFileFlags(argv);

  // `~` is the tool's private home. When a `~` path does not exist there, say so: a
  // user who meant their own ~/.ssh or ~/.azure would otherwise see only az's "No such file",
  // naming a path of ours. One note per command.
  let tildeNoted = false;
  const noteMissingTilde = (rawValue: string, flagLabel: string): void => {
    const value = stripAt(rawValue);
    const isTilde = value === "~" || value.startsWith("~/") || value.startsWith("~\\");
    if (tildeNoted || !isTilde || !opts.homeDir) return;
    const P = effectivePlatform(opts) === "win32" ? path.win32 : path.posix;
    let exists = false;
    try {
      exists = fs.existsSync(P.resolve(opts.homeDir, `.${value.slice(1)}`));
    } catch {
      exists = false;
    }
    if (exists) return;
    tildeNoted = true;
    notes.push(
      `\`~\` in ${flagLabel} is the tool's private home (${opts.homeDir}), not your home directory, ` +
        `and ${value} does not exist there. Files in your own home, including ~/.azure, ~/.ssh, ` +
        "~/.kube and ~/.docker, are never available through this tool: copy what a command needs " +
        "into the working directory."
    );
  };

  const check = (rawValue: string, flagLabel: string): PolicyResult | null => {
    const verdict = classifyPath(rawValue, opts);
    if (verdict.kind === "ok") noteMissingTilde(rawValue, flagLabel);
    if (verdict.kind === "ok" || verdict.kind === "arm") return null;
    if (verdict.kind === "protected") {
      return refuse(
        "Path not allowed",
        `${flagLabel} points into a protected directory (${verdict.dir}): the tool keeps az away ` +
          "from your own Azure CLI profile, SSH keys, kube and Docker config.",
        "file:protected",
        argv
      );
    }
    if (verdict.kind === "unsupported") {
      return refuse(
        "Path not allowed",
        `${flagLabel} is ${verdict.why}, which is not supported: use a path inside the working directory.`,
        "file:unsupported-path",
        argv
      );
    }
    return refuse(
      "Path not allowed",
      `${flagLabel} points outside the working directory (${opts.workdir}): files must be inside it. ` +
        "To use files elsewhere, set LOCALSTACK_AZ_WORKDIR in this MCP server's configuration to " +
        "the folder that holds them (a GUI client starts the server in its own folder).",
      "file:outside-workdir",
      argv
    );
  };

  const paramsIsPath = (value: string): boolean => {
    // `--parameters` is a path only as `@file`, or a bare value ending .json/.bicepparam. An
    // inline assignment such as `location=westeurope` is not a path.
    if (value.startsWith("@")) return true;
    if (value.includes("=")) return false;
    return /\.(json|bicepparam)$/i.test(value);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // The `@file` rule applies to any token, whatever its flag (az loads `@file` everywhere).
    const atValue = atFileValue(token);
    if (atValue !== undefined) {
      const result = check(atValue, "an `@file` argument");
      if (result) return result;
    }

    if (token.startsWith("-")) {
      const parsed = parseOption(token);
      const label = `\`${parsed.flag}\``;
      // Prefix-aware (argparse abbreviation): `--template-f` counts as `--template-file`, `--fi`
      // as `--file`. `--parameters` is nargs '+' in az, so it and its abbreviations are greedy.
      const isParams = matchesAnyFlag(parsed.flag, params);
      const isGeneric = !isParams && matchesAnyFlag(parsed.flag, generic);
      if (!isGeneric && !isParams) continue;
      const isGreedy = isParams || matchesAnyFlag(parsed.flag, greedy);

      const values: string[] = [];
      if (parsed.value !== undefined) {
        values.push(parsed.value);
      } else if (isGreedy) {
        let j = i + 1;
        while (j < argv.length && !argv[j].startsWith("-")) values.push(argv[j++]);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        values.push(argv[i + 1]);
      }

      for (const value of values) {
        if (value.startsWith("@")) continue; // handled by the @file scan
        if (isParams && !paramsIsPath(value)) continue;
        const result = check(value, label);
        if (result) return result;
      }
    }
  }

  // acr build / acr run: a local positional source must resolve inside the workdir.
  if (positional && argv[0] === "acr" && (argv[1] === "build" || argv[1] === "run")) {
    for (const idx of positionalIndexes(argv, 2)) {
      const value = argv[idx];
      const lower = value.toLowerCase();
      if (ABSOLUTE_URL.test(value) || lower.startsWith("git@") || lower.startsWith("github.com/")) {
        continue; // a remote source: handled by the URL rule
      }
      if (value.toLowerCase() === "/dev/null") continue; // ACR's null context
      const result = check(value, "the `acr` source");
      if (result) return result;
    }
  }

  // Safety net. Some arguments az does not annotate as files are still opened by az when
  // their value names an existing path: AAZ structured arguments (`--tags`, `--settings`, ...) read
  // JSON/YAML through `os.path.exists`, and so do `validate_file_or_dict` arguments. The generated
  // table cannot list them (az gives no file marker), so we mirror az's own gate: any value that
  // resolves to an existing file must satisfy the same containment check. Values that are inline
  // (`key=value`, `[...]`) or name no existing file are left exactly as az leaves them, so ordinary
  // tags and names keep working. Write targets that need not exist are handled by the table above.
  for (const token of argv) {
    if (token.startsWith("@")) continue; // handled by the @file scan
    const value = token.startsWith("-") ? parseOption(token).value : token;
    if (value === undefined || value === "" || value.startsWith("@")) continue;
    if (!valueNamesExistingPath(value, opts)) continue;
    const result = check(value, "a file argument");
    if (result) return result;
  }

  return null;
}

/**
 * True when `rawValue`, resolved the way az resolves it (relative to the workdir, with `~` as the
 * tool's private home), names an existing FILE. az's own gate is `os.path.exists(expanduser(v))`
 * followed by `get_file_json/yaml`, which fails on a directory without reading anything, so only
 * a file can leak content. Checking files only keeps remote paths that happen to name a local
 * directory out of the net (`afd origin-group create --probe-path /` is the filesystem root: the
 * L2 matrix's policy check caught that). ARM ids and the empty/`-` values are never local paths.
 */
function valueNamesExistingPath(rawValue: string, opts: PolicyOptions): boolean {
  const value = stripAt(rawValue);
  if (value === "" || value === "-" || ARM_ID.test(value)) return false;
  const P = effectivePlatform(opts) === "win32" ? path.win32 : path.posix;
  const isTilde = value === "~" || value.startsWith("~/") || value.startsWith("~\\");
  const base = isTilde ? (opts.homeDir ?? opts.workdir) : opts.workdir;
  const expanded = isTilde && opts.homeDir ? opts.homeDir + value.slice(1) : value;
  try {
    return fs.statSync(P.resolve(base, expanded)).isFile();
  } catch {
    return false; // absent, unreadable or not a path at all: az would not read it either
  }
}

/** The path a token loads with `@` (a leading `@`, or `--flag=@path`), else undefined. */
function atFileValue(token: string): string | undefined {
  if (token.startsWith("@") && token.length > 1) return token.slice(1);
  if (token.startsWith("-")) {
    const eq = token.indexOf("=");
    if (eq >= 0) {
      const value = token.slice(eq + 1);
      if (value.startsWith("@") && value.length > 1) return value.slice(1);
    }
  }
  return undefined;
}

/** A `.bicep`/`.bicepparam` argument, or the `bicep` group, needs the Bicep binary. */
function detectBicep(argv: string[]): boolean {
  if (argv[0] === "bicep") return true;
  for (const token of argv) {
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    const bare = stripAt(value);
    if (/\.(bicep|bicepparam)$/i.test(bare)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Analytics: value-free fields derived from the command and the verdict.
// ---------------------------------------------------------------------------

/**
 * Derive the value-free analytics fields. A secret value must never appear in any of
 * them: `command_path` is only the leading command words (values come after a flag or are
 * quoted), and `flag_names` cuts every flag at its first `=`.
 */
export function analyticsFields(
  command: string,
  policy: PolicyResult
): { command_path: string; flag_names: string; policy_outcome: string } {
  const argv = policy.argv ?? argvForAnalytics(command);

  // command_path: only the leading command words. Values sit after a flag or a quote, so they
  // never reach here (and the strict word shape excludes anything with a symbol or upper case).
  const commandWords: string[] = [];
  for (const token of argv) {
    if (START_TOKEN.test(token)) commandWords.push(token);
    else break;
  }

  // flag_names: the flag tokens, each cut at its first `=`. A value that itself starts with `-`
  // is indistinguishable from a flag, so the token right after a space-separated option is always
  // treated as that option's value and dropped. This can undercount store-true flags, but it
  // guarantees no secret value is ever emitted (a property test in policy.test.ts checks it).
  const flagNames: string[] = [];
  let expectValue = false;
  for (const token of argv) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (token === "--" || !token.startsWith("-")) continue;
    flagNames.push(token.split("=")[0]);
    if (!token.includes("=")) expectValue = true; // its value is the next token
  }

  return {
    command_path: commandWords.join(" "),
    flag_names: flagNames.join(","),
    policy_outcome: policyOutcome(policy),
  };
}

/** A tokenizer-free split for the analytics path when the real tokenizer failed (syntax error). */
function argvForAnalytics(command: string): string[] {
  let body = command.trim();
  const azStrip = body.match(/^az(\s+|$)/);
  if (azStrip) body = body.slice(azStrip[0].length).trim();
  return body.split(/\s+/).filter(Boolean);
}

function policyOutcome(policy: PolicyResult): string {
  if (policy.ok) {
    if (policy.local === "version") return "local";
    return policy.outcome === "rewritten" ? "rewritten" : "ok";
  }
  if (policy.ruleId === "syntax") return "syntax";
  return policy.ruleId.startsWith("denied:") ? policy.ruleId : `denied:${policy.ruleId}`;
}

// ---------------------------------------------------------------------------
// Bicep module scan (handler-side I/O, for `bicep-registry`).
// ---------------------------------------------------------------------------

// A registry reference is a single-quoted string after `module <name>`, `using` or `extends`
// (.bicepparam), or `import ... from`. A bare `br:`/`ts:` anywhere in the file is not: property
// names such as `subnets:` contain `ts:`, and matching them refused every VNet template (L2).
const REGISTRY_MODULE =
  /(?:\bmodule\s+[A-Za-z_]\w*|\busing|\bextends|\bfrom)\s+'((?:br:|br\/|ts:)[^'\r\n]*)'/;

/**
 * Read the `.bicep` inputs named in argv (inside the workdir only) and return the first registry
 * module reference (`br:`, `br/`, `ts:`) found, else undefined. Registry modules cannot be
 * restored against the emulator, so the handler answers before spawning az. This does I/O;
 * the tokenizer-level policy (evaluateAzCommand) does not call it.
 */
export function scanBicepModules(
  argv: string[],
  workdir: string,
  readFile?: (p: string) => string | undefined
): string | undefined {
  const read =
    readFile ??
    ((p: string): string | undefined => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    });

  for (const token of argv) {
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    const bare = stripAt(value);
    if (!/\.(bicep|bicepparam)$/i.test(bare)) continue;

    const resolved = path.resolve(workdir, bare);
    const rel = path.relative(workdir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // outside the workdir

    const content = read(resolved);
    if (!content) continue;
    const match = content.match(REGISTRY_MODULE);
    if (match) return match[1];
  }
  return undefined;
}
