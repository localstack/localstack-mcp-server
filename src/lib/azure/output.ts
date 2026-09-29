/**
 * Output formatting and error hints of the Azure client.
 *
 * Every failure starts with `❌ **Command Failed** (exit N, <class id>)`. The repo's analytics
 * record the first line of an ❌ response as `error_message`, so that line carries only the exit
 * code and the class id, never a value from the command. N is az's exit code, or
 * `none` when az did not exit by itself: it never started, the handler answered before spawning,
 * or the tool stopped it (timeout, client cancel, egress fail-fast), where the code only reflects
 * the kill and differs between Windows and POSIX.
 *
 * Caps count UTF-16 code units (JS string length), and every cut keeps surrogate pairs whole.
 */
import { ResponseBuilder } from "../../core/response-builder";
import { HOUSEKEEPING_HOSTS as GUARD_HOUSEKEEPING_HOSTS } from "./egress-proxy";
import {
  commandWords,
  extensionFor as curatedExtensionFor,
  missingExtensionHint,
} from "./extension-map";
import type { AzFailureClass, AzRunResult, ToolTextResponse } from "./types";

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface ClassifyContext {
  guardOn: boolean;
  /**
   * Pass only for commands that need Bicep (`policy.needsBicep`): false means no binary was
   * found, which is answered before spawning with `bicep-missing`.
   */
  bicepFound?: boolean;
  /** The command-to-extension lookup bound to the installed set (`extension-map.ts`). */
  extensionFor?: (tokens: string[]) => string | undefined;
  /** The argv that ran, without the leading `az`. */
  argv?: string[];
  /** The rest are only for the hint texts. */
  port?: number;
  timeoutSeconds?: number;
  client?: ClientInfo;
  inDocker?: boolean;
}

export interface FailureClassification {
  classId: AzFailureClass;
  hint?: string;
  /**
   * What the hint was built from (hosts, paths, names). These can hold user values: never pass
   * them to analytics.
   */
  details: Record<string, string>;
}

export interface FormatOptions {
  argv: string[];
  /** Policy notes (for example a rewritten management.azure.com URL). */
  notes: string[];
  isHelp: boolean;
  guardOn: boolean;
  port: number;
  timeoutSeconds: number;
  maxOutputChars: number;
  maxHelpChars: number;
  client?: ClientInfo;
  /** Tests only (LOCALSTACK_AZ_TEST_ENVELOPE=1): append the JSON result envelope. */
  envelope: boolean;
  inDocker: boolean;
  extensionFor?: (tokens: string[]) => string | undefined;
}

/** The second content item with `envelope: true`. */
export interface ResultEnvelope {
  exitCode: number | null;
  /** az's stdout exactly as the runner decoded it: CRLF kept, never capped. */
  stdout: string;
  /** az's stderr with proxy URLs redacted, otherwise as decoded. */
  stderr: string;
  /** Policy and tool notes; display-only notes (truncation) are left out. */
  notes: string[];
  classId: AzFailureClass | null;
  /** The runner hit its capture cap, so stdout or stderr is incomplete. */
  truncated: boolean;
  /**
   * The tool ended az (timeout, cancel, a refused host, the output cap) or never started it:
   * exitCode is then not az's own (null on POSIX, 1 after taskkill, even 0). Always set by
   * this server; optional for readers of envelopes from older builds.
   */
  stoppedByTool?: boolean;
}

export const STDERR_FAILURE_CHARS = 4_000;
export const STDERR_SUCCESS_CHARS = 2_000;

/** Every response of a call with LOCALSTACK_AZ_EGRESS_GUARD=0 carries this note. */
export const GUARD_OFF_NOTE =
  "Note: the egress guard (containment layer 4) is off (`LOCALSTACK_AZ_EGRESS_GUARD=0`), so " +
  "`az` can reach hosts other than the emulator. Use this for debugging only.";

// The docs landing page of LocalStack for Azure; the emulator's own list is the coverage endpoint.
const AZURE_DOCS_URL = "https://docs.localstack.cloud/azure/";

// Refused on every run, never a failure: the guard's own list, for the backup regex
// of `egress-refused`, which must not report these.
const HOUSEKEEPING_HOSTS = new Set<string>(GUARD_HOUSEKEEPING_HOSTS);

// `functionapp create` catches a failed App Insights setup and warns with this line
// (appservice/custom.py). Without --workspace, the failure is its refused region-map download.
const APP_INSIGHTS_SKIPPED =
  /^WARNING: Error while trying to create and configure an Application Insights for the Function App\./m;
const APP_INSIGHTS_REGION_HOST = "appinsights.azureedge.net";
const APP_INSIGHTS_NOTE =
  "Note: the function app was created without Application Insights. Without `--workspace`, " +
  "az first downloads Application Insights' region map from appinsights.azureedge.net, which " +
  "this tool never contacts. To get an Application Insights component, create a Log Analytics " +
  "workspace (`monitor log-analytics workspace create`) and pass `--workspace <its name>`; " +
  "`--disable-app-insights true` skips it without a warning.";

// Warnings caused only by refused housekeeping hosts, which prepareStderr drops.
const HOUSEKEEPING_WARNINGS = [
  /^WARNING: Unable to check if your CLI is up-to-date\. Check your internet connection\.\s*$/,
  /^WARNING: Failed to retrieve image alias doc '[^']*'\. Error: 'ConnectionError'\. Use local copy instead\.\s*$/,
];

const TRACEBACK_START = /^Traceback \(most recent call last\):\s*$/;
const TRACEBACK_OMITTED = "(Python traceback omitted)";

// The guard's per-call URL `http://<callId>:x@127.0.0.1:<port>`; Bicep's BCP192 prints it.
const PROXY_URL = /\b(https?:\/\/)[^\s'"<>@/]+@(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/gi;

// The stderr detectors, all with the m flag: stderr often starts with a WARNING line.
const RE = {
  login: /^ERROR: Please run 'az login' to setup account\./m,
  connRefused:
    /Failed to establish a new connection: .*(actively refused|Connection refused|WinError 10061|Errno 111)/m,
  connHostPort: /HTTPS?Connection\(host='([^']+)', port=(\d+)\)/,
  viaProxy: /Unable to connect to proxy/,
  // Alternations report the leftmost match, so the values come from separate expressions.
  dns: /Failed to resolve '|NameResolutionError/m,
  dnsHost: /Failed to resolve '([^']+)'/,
  hostInText: /host='([^']+)'/,
  discovery: /^ERROR: Unable to get endpoints from the cloud\./m,
  notImplemented: /The API operation '([A-Z]+) ([^']+)' is not yet implemented in LocalStack\./m,
  notImplementedCode: /\(NotImplemented\)|"code": "NotImplemented"/m,
  provider: /The resource namespace '[^']+' is invalid\.|InvalidResourceNamespace/m,
  providerNamespace: /The resource namespace '([^'/]+)(\/[^']*)?' is invalid\./,
  noRoute: /The requested URL was not found on the server/m,
  notRecognized: /'([\w-]+)' is misspelled or not recognized by the system\./m,
  didYouMean: /Did you mean '([\w-]+)' \?/m,
  argument:
    /^ERROR: (the following arguments are required: |unrecognized arguments: |argument [^:]+: invalid )|is not a valid value for '/m,
  notFound:
    /\((ResourceNotFound|ResourceGroupNotFound|ParentResourceNotFound)\)|"code": "Resource\w*NotFound"/m,
  cliError: /The command failed with an unexpected error\. Here is the traceback:/m,
  emulatorError: /An unexpected error occurred while processing '([A-Z]+) ([^']+)'/m,
  needsYes: /Unable to prompt for confirmation as no tty available\. Use --yes\./m,
  bicepMissing:
    /Could not find the "bicep" executable on PATH|Bicep CLI not found\. Install it now by running "az bicep install"\.|Error while attempting to retrieve the latest Bicep version:/m,
  bicepRegistry:
    /Error BCP192: Unable to restore the artifact with reference "br:|Error BCP446: Restore from registry "([^"]+)" is blocked/m,
  bicepReference: /reference "(br:[^"]+)"/,
  bicepEnv: /Error BCP427: Environment variable "([^"]+)" does not exist/m,
  azcopy: /Error while attempting to download azcopy\./m,
  guardDown: /Unable to connect to proxy', NewConnectionError\(/m,
  guardDownErrno: /10061|Connection refused|Errno 111/m,
  tunnel403: /Tunnel connection failed: 403 Forbidden/m,
  register: /\/providers\/([^/]+)\/register$/i,
};

// Clients that stop waiting for a tool call long before LOCALSTACK_AZ_TIMEOUT_SECONDS.
// Claude Desktop (and claude.ai) identify themselves as `claude-ai`.
const SHORT_LIMIT_CLIENTS: Array<{ match: RegExp; label: string; seconds: number }> = [
  { match: /^claude-ai$|claude[\s-]?desktop/i, label: "Claude Desktop", seconds: 60 },
];

// ---------------------------------------------------------------------------------------------
// Text helpers

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const fmt = (n: number) => n.toLocaleString("en-US");

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** The first `max` code units, never ending inside a surrogate pair. */
export function headCut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, Math.floor(max));
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** The last `max` code units, never starting inside a surrogate pair. */
export function tailCut(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - Math.max(0, Math.floor(max));
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/** Like headCut, but back to the last line break when one is within `slack` of the cut. */
function headCutAtLine(text: string, max: number, slack: number): string {
  const head = headCut(text, max);
  if (head.length === text.length) return head;
  const newline = head.lastIndexOf("\n");
  return newline > 0 && newline >= head.length - slack ? head.slice(0, newline) : head;
}

/** Cuts to at most `max` characters, the marker included; the marker gets the cut count. */
function capWithMarker(text: string, max: number, marker: (cut: number) => string): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - marker(text.length).length);
  const head = headCutAtLine(text, room, Math.min(200, Math.floor(room / 10)));
  return head + marker(text.length - head.length);
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

const unique = (items: readonly string[]) => [...new Set(items.filter(Boolean))];
/** Markdown inline code; the value comes from az or the user, so no backtick may close it. */
const inlineCode = (value: string) => `\`${value.replace(/`/g, "'").replace(/\s+/g, " ")}\``;

/** Replaces the userinfo of loopback proxy URLs (the guard's per-call tag) with `[redacted]`. */
export function redactProxyUrls(text: string): string {
  return text.replace(PROXY_URL, (_match, scheme: string, host: string, port?: string) => {
    return `${scheme}[redacted]@${host}${port ?? ""}`;
  });
}

function prepareLines(raw: string): string {
  const kept: string[] = [];
  let inTraceback = false;
  for (const line of normalizeNewlines(raw).split("\n")) {
    if (TRACEBACK_START.test(line)) {
      if (!inTraceback) kept.push(TRACEBACK_OMITTED);
      inTraceback = true;
      continue;
    }
    // After a traceback only az's own ERROR: lines are worth keeping.
    if (inTraceback && !line.startsWith("ERROR:")) continue;
    if (HOUSEKEEPING_WARNINGS.some((re) => re.test(line))) continue;
    kept.push(line);
  }
  return redactProxyUrls(trimBlankLines(kept.join("\n")));
}

/**
 * The stderr preparation: CRLF to LF, Python tracebacks stripped (the ERROR: lines
 * stay), the two housekeeping warnings dropped, proxy URLs redacted, capped keeping the head.
 */
export function prepareStderr(raw: string, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? STDERR_FAILURE_CHARS;
  return capWithMarker(prepareLines(raw), max, (cut) => `\n[... ${fmt(cut)} more characters cut]`);
}

/**
 * Re-flows an az help page: a line indented 20 or more spaces is a wrapped part of
 * the description column and joins the previous line, and runs of spaces inside a line collapse
 * to two. Pages shrink to 25-78 % and stay readable.
 */
export function reflowHelp(text: string): string {
  // No lookbehind (the compile target is ES2016); the lookahead leaves the next word unconsumed.
  const collapse = (line: string) => line.replace(/(\S) {3,}(?=\S)/g, "$1  ");
  const out: string[] = [];
  for (const raw of normalizeNewlines(text).split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    const content = line.trim();
    const indent = line.length - line.replace(/^ +/, "").length;
    const previous = out.length > 0 ? out[out.length - 1] : undefined;
    if (content && indent >= 20 && previous !== undefined && previous.trim() !== "") {
      out[out.length - 1] = `${previous} ${collapse(content)}`;
    } else {
      out.push(collapse(line));
    }
  }
  return out.join("\n");
}

function lastMatchIndex(text: string, re: RegExp): number {
  let index = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) index = m.index;
  return index;
}

/**
 * Cuts a re-flowed help page to `max` characters, keeping the head (the command and its
 * required arguments) and the tail (the Examples, which az prints last). The Examples section is
 * kept whole when it fits in half the room, else the last 40 % of the room is kept.
 */
export function cutHelpPage(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (cut: number) =>
    `\n\n[... ${fmt(cut)} characters of this help page cut here; ` +
    `the head and the Examples are kept ...]\n\n`;
  const room = Math.max(0, max - marker(text.length).length);
  const examples = lastMatchIndex(text, /^Examples[ \t]*$/gm);
  let tail = examples >= 0 && text.length - examples <= room / 2 ? text.slice(examples) : "";
  if (!tail) {
    const rough = tailCut(text, Math.floor(room * 0.4));
    const lineStart = rough.indexOf("\n");
    tail = lineStart >= 0 && lineStart < rough.length - 1 ? rough.slice(lineStart + 1) : rough;
  }
  const headRoom = room - tail.length;
  const head = headCutAtLine(text, headRoom, Math.min(2_000, Math.floor(headRoom / 5)));
  return head.replace(/\n+$/, "") + marker(text.length - head.length - tail.length) + tail;
}

// ---------------------------------------------------------------------------------------------
// Hints. They say "may not be implemented" unless the emulator itself said so, and
// never assume Azure's error codes: the emulator reports a missing group as ResourceNotFound.

const coverageUrl = (port: number) => `http://127.0.0.1:${port}/_localstack/coverage`;

const LOGIN_HINT =
  "The tool's Azure CLI profile could not log in to the LocalStack emulator. Check that the " +
  "emulator is running and healthy (`localstack-management` action `status`, service `azure`).";

function connRefusedHint(hostPort: string): string {
  return (
    `Could not connect to the LocalStack Azure emulator at ${inlineCode(hostPort)}: nothing is ` +
    "listening. Start it with `localstack-management` (`action: start`, `service: azure`), or " +
    "`lstk start --type azure`, then retry. If it runs on another port, set " +
    "`LOCALSTACK_AZURE_PORT`."
  );
}

function dnsHint(host: string | undefined, guardOn: boolean): string {
  if (host && /(^|\.)localhost\.localstack\.cloud$/i.test(host)) {
    const fixes = guardOn
      ? "Allow `localhost.localstack.cloud`"
      : "Turn the egress guard back on (it needs no DNS), allow `localhost.localstack.cloud`";
    return (
      `${inlineCode(host)} did not resolve. It is a public DNS name for 127.0.0.1, and some routers ` +
      "and corporate resolvers block such answers (DNS-rebinding protection). " +
      `${fixes}, or add ${inlineCode(`127.0.0.1 ${host}`)} to your hosts file.`
    );
  }
  return "`az` can only reach the LocalStack emulator from this tool.";
}

function notImplementedHint(port: number, method?: string, opPath?: string): string {
  const what = method && opPath ? inlineCode(`${method} ${opPath}`) : "this operation";
  let hint =
    `The LocalStack Azure emulator does not implement ${what} yet. This is an emulator ` +
    "limitation, so retrying will not help. See the implemented operations at " +
    `${coverageUrl(port)} and ${AZURE_DOCS_URL}.`;
  const register = opPath ? RE.register.exec(opPath) : null;
  if (register) {
    hint +=
      ` The path ends in ${inlineCode(`/providers/${register[1]}/register`)}: the CLI tried to ` +
      "register a provider the emulator does not emulate.";
  }
  return hint;
}

function providerHint(port: number, namespace?: string): string {
  const which = namespace
    ? `the ${inlineCode(namespace)} resource provider`
    : "this resource provider";
  return (
    `The LocalStack Azure emulator does not emulate ${which}. Supported providers: ` +
    `${coverageUrl(port)}.`
  );
}

function noRouteHint(port: number): string {
  return (
    "The emulator has no route for this request. Check the URL path, HTTP method and " +
    "api-version. If they are right, the operation may not be emulated: see " +
    `${coverageUrl(port)}.`
  );
}

const ARGUMENT_HINT = "Run the command with `--help` to see its arguments.";

function emulatorErrorHint(method?: string, opPath?: string): string {
  const what = method && opPath ? inlineCode(`${method} ${opPath}`) : "this request";
  return (
    `The LocalStack Azure emulator hit an internal error while handling ${what}. This is an ` +
    "emulator bug; the details are in the emulator logs (`localstack-logs-analysis`, " +
    "analysisType `logs`)."
  );
}

const NEEDS_YES_HINT = "This command asks for confirmation. Re-run it with `--yes`.";

function egressRefusedMessage(hosts: string[]): string {
  const target =
    hosts.length === 0
      ? "a connection to a host outside the emulator"
      : `a connection to ${hosts.map(inlineCode).join(", ")}`;
  return (
    `Blocked ${target}: this tool only lets \`az\` talk to the local emulator. Use a relative ` +
    "URL with `rest`, or a command that stays on the emulator."
  );
}

const TOO_LONG_HINT =
  "The command is too long for Windows (limit 32,767 characters). Put large values, such as " +
  "JSON bodies or templates, in a file inside the working directory and pass `@<file>`.";

function timeoutHint(timeoutSeconds?: number, client?: ClientInfo): string {
  const within = timeoutSeconds ? `within ${fmt(timeoutSeconds)} s` : "in time";
  let hint =
    `\`az\` did not finish ${within} and was stopped. For long-running creates, run the ` +
    "command with `--no-wait`, then poll with `show`.";
  const limited = SHORT_LIMIT_CLIENTS.find((c) => client?.name && c.match.test(client.name));
  if (limited) {
    hint +=
      ` ${limited.label} also stops waiting for a tool call after about ${limited.seconds} s, ` +
      "so use `--no-wait` for anything that can take longer.";
  }
  return hint;
}

const CANCELLED_HINT =
  "The client cancelled the call, and `az` was stopped. The operation may have partly run on " +
  "the emulator: check its state with `show` or `list` before retrying.";

const GUARD_DOWN_HINT =
  "Internal error: the tool's egress guard was not running. Restart the MCP server; if it " +
  "happens again, report it.";

const SPAWN_ERROR_HINT =
  "Check the `az` installation, or set `LOCALSTACK_AZ_PATH` to the `az` launcher or its Python.";

const BICEP_INSTALL_URL = "https://learn.microsoft.com/azure/azure-resource-manager/bicep/install";

function bicepMissingHint(inDocker: boolean): string {
  if (inDocker) {
    return (
      "This image's Bicep CLI is missing. Set `LOCALSTACK_AZ_BICEP_PATH` to a mounted Linux " +
      "bicep binary, or deploy compiled ARM JSON (`--template-file main.json`)."
    );
  }
  const install =
    "Install it with `npx -y @localstack/localstack-mcp-server install-azure-addons`, or put " +
    `Bicep on your PATH (${BICEP_INSTALL_URL}), or set \`LOCALSTACK_AZ_BICEP_PATH\` to a bicep ` +
    "binary, then retry.";
  return (
    "Bicep templates need the Bicep CLI, which the LocalStack Azure tool could not find. " +
    `${install} Or deploy compiled ARM JSON: \`--template-file main.json\`. ` +
    "(`az bicep install` and `az config set` are not available through this tool.)"
  );
}

const BICEP_REGISTRY_HINT =
  "Bicep registry modules (`br:`, `br/public:`) cannot be restored: the tool only reaches the " +
  "local emulator. Copy the module into the workdir, and reference it by relative path.";

/** BCP427: a `.bicepparam` reads a variable that az's clean environment does not have. */
function bicepEnvHint(variable: string): string {
  return (
    `The parameter file reads \`${variable}\` with readEnvironmentVariable(), but az (and so ` +
    "Bicep) runs with a clean environment: the tool passes only the variables listed in " +
    `LOCALSTACK_AZ_BICEP_ENV. Add \`${variable}\` to LOCALSTACK_AZ_BICEP_ENV in this MCP server's ` +
    "configuration and set it there too, or pass the value as a parameter instead " +
    "(`--parameters <name>=<value>`)."
  );
}

const AZCOPY_HINT =
  "This command needs azcopy, which `az` would download from the internet. Use " +
  "`storage blob upload-batch`, `download-batch` or `delete-batch` instead.";

/** `discovery` gets the `conn-refused` or `dns` hint, from the `Error detail` az prints after it. */
function discoveryHint(text: string, guardOn: boolean, port: number): string {
  const detail = text.slice(text.search(RE.discovery));
  if (RE.connRefused.test(detail)) {
    const m = RE.connHostPort.exec(detail);
    return connRefusedHint(m ? `${m[1]}:${m[2]}` : `127.0.0.1:${port}`);
  }
  if (RE.dns.test(detail)) {
    return dnsHint(RE.dnsHost.exec(detail)?.[1] ?? RE.hostInText.exec(detail)?.[1], guardOn);
  }
  return (
    "The CLI could not read the emulator's endpoints (`/metadata/endpoints`). Check that the " +
    "LocalStack Azure emulator is running and healthy (`localstack-management` action " +
    "`status`, service `azure`)."
  );
}

// ---------------------------------------------------------------------------------------------
// Classification

const failure = (
  classId: AzFailureClass,
  hint?: string,
  details: Record<string, string> = {}
): FailureClassification => ({ classId, hint, details });

/**
 * The failure class of a run; the first match wins.
 * 1. pre-spawn: command too long (`too-long`), no Bicep binary (`bicep-missing`, only with
 *    `bicepFound`), and a failed spawn;
 * 2. runner flags: aborted (`cancelled`), then `timedOut` (`timeout`);
 * 3. the guard's record: a refused host (`egress-refused`), then an upstream failure
 *    (`conn-refused`);
 * 4. `guard-down`, only with the guard on (with it off, a proxy error is the system proxy's);
 * 5. the stderr detectors on the prepared stderr: `login`, `conn-refused` (guard off only),
 *    `dns`, `discovery`, `not-implemented`, `provider`, `no-route`, `extension` or
 *    `unknown-command`, `argument`, `not-found`, `emulator-error`, `needs-yes`,
 *    `bicep-missing`, `bicep-registry`, `bicep-env` and `azcopy`. `cli-error` has no hint of
 *    its own and matching goes on; it is the class only when nothing else matches. The backup
 *    regex of `egress-refused` comes last, and never reports a housekeeping host;
 * 6. no match: `other`.
 * Matching sees the prepared stderr before the display cap, so a long warning cannot hide it.
 */
export function classifyFailure(result: AzRunResult, ctx: ClassifyContext): FailureClassification {
  const port = ctx.port ?? 4566;
  const inDocker = ctx.inDocker ?? false;

  if (result.tooLong || /ENAMETOOLONG/.test(result.spawnError ?? "")) {
    return failure("too-long", TOO_LONG_HINT);
  }
  if (ctx.bicepFound === false) {
    return failure("bicep-missing", bicepMissingHint(inDocker), {
      source: "precheck",
    });
  }
  if (result.spawnError) {
    return failure("spawn-error", SPAWN_ERROR_HINT, { error: result.spawnError });
  }

  if (result.aborted) return failure("cancelled", CANCELLED_HINT);
  if (result.timedOut) {
    return failure("timeout", timeoutHint(ctx.timeoutSeconds, ctx.client), {
      timeoutSeconds: String(ctx.timeoutSeconds ?? ""),
      client: ctx.client?.name ?? "",
    });
  }

  const refused = unique(result.egress.refused);
  if (refused.length > 0 || result.failFast === "refused") {
    return failure("egress-refused", undefined, { hosts: refused.join(",") });
  }
  const upstream = unique(result.egress.upstream);
  if (upstream.length > 0 || result.failFast === "upstream") {
    const host = upstream[0] ?? "127.0.0.1";
    const hostPort = /:\d+$/.test(host) ? host : `${host}:${port}`;
    return failure("conn-refused", connRefusedHint(hostPort), { hostPort, source: "guard" });
  }

  const text = prepareLines(result.stderr);
  if (ctx.guardOn && RE.guardDown.test(text) && RE.guardDownErrno.test(text)) {
    return failure("guard-down", GUARD_DOWN_HINT);
  }

  let m: RegExpExecArray | null;
  if (RE.login.test(text)) return failure("login", LOGIN_HINT);
  if (!ctx.guardOn && RE.connRefused.test(text) && !RE.viaProxy.test(text)) {
    m = RE.connHostPort.exec(text);
    const hostPort = m ? `${m[1]}:${m[2]}` : `127.0.0.1:${port}`;
    return failure("conn-refused", connRefusedHint(hostPort), { hostPort, source: "stderr" });
  }
  if (RE.dns.test(text)) {
    const host = RE.dnsHost.exec(text)?.[1] ?? RE.hostInText.exec(text)?.[1];
    return failure("dns", dnsHint(host, ctx.guardOn), host ? { host } : {});
  }
  if (RE.discovery.test(text)) {
    return failure("discovery", discoveryHint(text, ctx.guardOn, port));
  }
  if ((m = RE.notImplemented.exec(text))) {
    return failure("not-implemented", notImplementedHint(port, m[1], m[2]), {
      method: m[1],
      path: m[2],
    });
  }
  if (RE.notImplementedCode.test(text)) {
    return failure("not-implemented", notImplementedHint(port));
  }
  if (RE.provider.test(text)) {
    const namespace = RE.providerNamespace.exec(text)?.[1];
    return failure("provider", providerHint(port, namespace), namespace ? { namespace } : {});
  }
  if (RE.noRoute.test(text)) return failure("no-route", noRouteHint(port));
  if ((m = RE.notRecognized.exec(text))) {
    const token = m[1];
    const group = pathUpTo(ctx.argv, token);
    const lookup = ctx.extensionFor ?? ((tokens: string[]) => curatedExtensionFor(tokens));
    const extension = lookup(group);
    if (extension) {
      const joined = group.join(" ");
      return failure("extension", missingExtensionHint(joined, extension, inDocker), {
        token,
        group: joined,
        extension,
      });
    }
    const suggestion = RE.didYouMean.exec(text)?.[1];
    return failure("unknown-command", undefined, suggestion ? { token, suggestion } : { token });
  }
  if (RE.argument.test(text)) return failure("argument", ARGUMENT_HINT);
  // az exits 3 for its ResourceNotFoundError, whatever the service's error wording: the emulator
  // words some not-found answers with codes the text pattern does not know (Event Hubs, Service
  // Bus, Cosmos, Key Vault, subnets, ...), so the exit code is the reliable signal. The
  // more specific classes above still win.
  if (RE.notFound.test(text) || result.exitCode === 3) return failure("not-found");
  const cliError = RE.cliError.test(text);
  if ((m = RE.emulatorError.exec(text))) {
    return failure("emulator-error", emulatorErrorHint(m[1], m[2]), { method: m[1], path: m[2] });
  }
  if (RE.needsYes.test(text)) return failure("needs-yes", NEEDS_YES_HINT);
  if (RE.bicepMissing.test(text)) {
    return failure("bicep-missing", bicepMissingHint(inDocker), {
      source: "stderr",
    });
  }
  if ((m = RE.bicepRegistry.exec(text))) {
    const reference = RE.bicepReference.exec(text)?.[1] ?? m[1];
    return failure("bicep-registry", BICEP_REGISTRY_HINT, reference ? { reference } : {});
  }
  if ((m = RE.bicepEnv.exec(text))) {
    return failure("bicep-env", bicepEnvHint(m[1]), { variable: m[1] });
  }
  if (RE.azcopy.test(text)) return failure("azcopy", AZCOPY_HINT);
  if (ctx.guardOn && RE.tunnel403.test(text)) {
    const host = RE.hostInText.exec(text)?.[1];
    const housekeeping = new Set([...HOUSEKEEPING_HOSTS, ...result.egress.housekeeping]);
    const onlyHousekeeping = host
      ? housekeeping.has(host.toLowerCase())
      : result.egress.housekeeping.length > 0;
    if (!onlyHousekeeping) {
      return failure("egress-refused", undefined, { hosts: host ?? "", source: "stderr" });
    }
  }
  return cliError ? failure("cli-error") : failure("other");
}

/** The command path up to and including `token`, the word az did not recognise. */
function pathUpTo(argv: string[] | undefined, token: string): string[] {
  const words = commandWords(argv ?? []);
  const index = words.indexOf(token);
  return index >= 0 ? words.slice(0, index + 1) : [token];
}

// ---------------------------------------------------------------------------------------------
// Responses

function firstLine(exit: string, classId: AzFailureClass): string {
  return `❌ **Command Failed** (exit ${exit}, ${classId})`;
}

function stoppedByTool(result: AzRunResult): boolean {
  return (
    result.exitCode === null ||
    result.timedOut ||
    result.aborted ||
    result.failFast !== undefined ||
    result.tooLong === true ||
    result.spawnError !== undefined
  );
}

function isSuccess(result: AzRunResult): boolean {
  return result.exitCode === 0 && !stoppedByTool(result);
}

function formatStdout(stdout: string, max: number): { text: string; note?: string } {
  const all = normalizeNewlines(stdout).replace(/\n+$/, "");
  if (all.length <= max) return { text: all };
  const shown = headCutAtLine(all, max, Math.min(1_000, Math.floor(max / 10)));
  return {
    text: shown,
    note:
      `[Output truncated: showing the first ${fmt(shown.length)} of ${fmt(all.length)} ` +
      'characters. Narrow it with --query and -o tsv, for example --query "[].name" -o tsv.]',
  };
}

const NO_OUTPUT = "The command succeeded and printed no output.";

function hostsNote(prefix: string, hosts: string[], suffix: string): string {
  return `${prefix} ${hosts.map(inlineCode).join(", ")}${suffix}`;
}

/** Formats a finished `az` run for the model. */
export function formatAzResult(result: AzRunResult, opts: FormatOptions): ToolTextResponse {
  const notes = [...opts.notes];
  if (!opts.guardOn) notes.push(GUARD_OFF_NOTE);
  if (result.truncated) {
    notes.push(
      "Note: `az` printed more than the tool captures, so it was stopped and its output is " +
        "incomplete. Narrow the output with `--query` or `-o tsv`."
    );
  }

  const blocks: string[] = [];
  let classId: AzFailureClass | null = null;

  if (isSuccess(result)) {
    const refused = unique(result.egress.refused);
    if (refused.length > 0) {
      const prefix = "Note: the egress guard blocked a connection to";
      notes.push(hostsNote(prefix, refused, "; the command still succeeded."));
    }
    if (
      APP_INSIGHTS_SKIPPED.test(result.stderr) &&
      result.egress.housekeeping.includes(APP_INSIGHTS_REGION_HOST)
    ) {
      notes.push(APP_INSIGHTS_NOTE);
    }
    if (notes.length > 0) blocks.push(notes.join("\n"));
    if (opts.isHelp) {
      const page = reflowHelp(result.stdout).replace(/^\n+/, "").replace(/\n+$/, "");
      blocks.push(cutHelpPage(page, opts.maxHelpChars));
    } else {
      const out = formatStdout(result.stdout, opts.maxOutputChars);
      blocks.push(out.text || NO_OUTPUT);
      if (out.note) blocks.push(out.note);
    }
    const warnings = prepareStderr(result.stderr, { maxChars: STDERR_SUCCESS_CHARS });
    if (warnings) blocks.push(warnings);
  } else {
    const c = classifyFailure(result, {
      guardOn: opts.guardOn,
      extensionFor: opts.extensionFor,
      argv: opts.argv,
      port: opts.port,
      timeoutSeconds: opts.timeoutSeconds,
      client: opts.client,
      inDocker: opts.inDocker,
    });
    classId = c.classId;
    blocks.push(firstLine(stoppedByTool(result) ? "none" : String(result.exitCode), c.classId));
    if (c.classId === "egress-refused") {
      // az's own text never names the refused host on SDK paths: the tool's line replaces it.
      const hosts = c.details.hosts ? c.details.hosts.split(",") : [];
      blocks.push(egressRefusedMessage(hosts));
    } else {
      const stderr = prepareStderr(result.stderr);
      if (stderr) blocks.push(stderr);
      if (c.classId === "spawn-error" && result.spawnError) {
        blocks.push(`The tool could not start the Azure CLI: ${result.spawnError}`);
      }
    }
    const out = formatStdout(result.stdout, opts.maxOutputChars);
    if (out.text) blocks.push(`Output:\n${out.text}${out.note ? `\n${out.note}` : ""}`);
    if (blocks.length === 1 && !c.hint) {
      blocks.push("`az` exited without printing an error message.");
    }
    if (c.hint) blocks.push(c.hint);
    const housekeeping = unique(result.egress.housekeeping);
    if (housekeeping.length > 0 && c.classId !== "egress-refused") {
      const suffix =
        ", which the tool always refuses (housekeeping calls such as update checks); these " +
        "blocks are expected.";
      notes.push(hostsNote("Note: the egress guard also blocked", housekeeping, suffix));
    }
    if (notes.length > 0) blocks.push(notes.join("\n"));
  }

  const response: ToolTextResponse = ResponseBuilder.markdown(blocks.join("\n\n"));
  if (opts.envelope) {
    const envelope: ResultEnvelope = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: redactProxyUrls(result.stderr),
      notes,
      classId,
      truncated: result.truncated,
      stoppedByTool: stoppedByTool(result),
    };
    response.content.push({ type: "text", text: JSON.stringify(envelope) });
  }
  return response;
}

/** `bicep-missing`, answered before spawning when a command needs Bicep and none was found. */
export function bicepMissing(opts: { inDocker: boolean }): ToolTextResponse {
  return ResponseBuilder.markdown(
    `${firstLine("none", "bicep-missing")}\n\n${bicepMissingHint(opts.inDocker)}`
  );
}

/**
 * `bicep-registry`, answered before spawning when a `.bicep` input references a registry
 * module. On Windows a successful restore would write the real %USERPROFILE%\.bicep.
 */
export function bicepRegistryUnsupported(ref: string): ToolTextResponse {
  return ResponseBuilder.markdown(
    `${firstLine("none", "bicep-registry")}\n\nThe template uses the registry module ${inlineCode(ref)}.` +
      `\n\n${BICEP_REGISTRY_HINT}`
  );
}

/** `too-long`: the Windows command line would exceed its limit, so az is not spawned. */
export function commandTooLong(): ToolTextResponse {
  return ResponseBuilder.markdown(`${firstLine("none", "too-long")}\n\n${TOO_LONG_HINT}`);
}
