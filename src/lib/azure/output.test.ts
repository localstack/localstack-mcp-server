import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import {
  GUARD_OFF_NOTE,
  STDERR_FAILURE_CHARS,
  bicepMissing,
  bicepRegistryUnsupported,
  classifyFailure,
  commandTooLong,
  cutHelpPage,
  formatAzResult,
  headCut,
  prepareStderr,
  redactProxyUrls,
  reflowHelp,
  tailCut,
  type FormatOptions,
  type ResultEnvelope,
} from "./output";
import { extensionFor } from "./extension-map";
import type { AzFailureClass, AzRunResult, EgressRecords } from "./types";

// Byte copies of raw az streams, stored base64 so that git cannot rewrite their CRLFs.
interface Stream {
  bytes: number;
  sha256: string;
  encoding: "base64" | "gzip+base64";
  data: string;
}

interface Fixture {
  id: string;
  classId: AzFailureClass | null;
  guardOn: boolean;
  argv: string[];
  exitCode: number;
  synthetic: boolean;
  basis?: string;
  isHelp?: boolean;
  program?: string;
  egress?: EgressRecords;
  stdout?: Stream;
  stderr?: Stream;
  reflowed?: { chars: number; sha256: string };
}

const INDEX = path.join(__dirname, "../../../tests/fixtures/azure/stderr/index.json");
const FIXTURES: Fixture[] = JSON.parse(fs.readFileSync(INDEX, "utf8")).fixtures;

function bytesOf(stream: Stream): Buffer {
  const raw = Buffer.from(stream.data, "base64");
  return stream.encoding === "gzip+base64" ? zlib.gunzipSync(raw) : raw;
}

// The runner decodes both streams with StringDecoder("utf8"); these are the same strings.
const text = (stream?: Stream) => (stream ? bytesOf(stream).toString("utf8") : "");
const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

function fixture(id: string): Fixture {
  const found = FIXTURES.find((f) => f.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
}

const NO_EGRESS: EgressRecords = { refused: [], upstream: [], housekeeping: [], allowed: 0 };

function run(overrides: Partial<AzRunResult> = {}): AzRunResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 1_000,
    egress: NO_EGRESS,
    ...overrides,
  };
}

function runOf(f: Fixture, overrides: Partial<AzRunResult> = {}): AzRunResult {
  return run({
    exitCode: f.exitCode,
    stdout: text(f.stdout),
    stderr: text(f.stderr),
    egress: f.egress ?? NO_EGRESS,
    ...overrides,
  });
}

function options(overrides: Partial<FormatOptions> = {}): FormatOptions {
  return {
    argv: [],
    notes: [],
    isHelp: false,
    guardOn: true,
    port: 4566,
    timeoutSeconds: 300,
    maxOutputChars: 30_000,
    maxHelpChars: 30_000,
    envelope: false,
    inDocker: false,
    ...overrides,
  };
}

function format(f: Fixture, opts: Partial<FormatOptions> = {}, result?: Partial<AzRunResult>) {
  const response = formatAzResult(
    runOf(f, result),
    options({ argv: f.argv, guardOn: f.guardOn, ...opts })
  );
  return response.content[0].text;
}

const firstLineOf = (s: string) => s.split("\n")[0];
const FIRST_LINE = /^❌ \*\*Command Failed\*\* \(exit (\d+|none), ([a-z-]+)\)$/;

/** True when a string holds a lone surrogate, i.e. a cut split a code point. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("fixtures (tests/fixtures/azure/stderr/index.json)", () => {
  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s decodes to its recorded bytes", (_id, f) => {
    const streams = [f.stdout, f.stderr].filter((s): s is Stream => s !== undefined);
    expect(streams.length).toBeGreaterThan(0);
    for (const stream of streams) {
      const bytes = bytesOf(stream);
      expect(bytes.length).toBe(stream.bytes);
      expect(sha256(bytes)).toBe(stream.sha256);
      // Valid UTF-8, as az prints it with -X utf8.
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
    }
  });

  it("keeps Windows line endings byte for byte", () => {
    const raw = bytesOf(fixture("not-implemented-native").stderr!).toString("latin1");
    expect(raw).toContain("\r\n");
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("covers every class az's output can show (too-long and timeout are flags, tested below)", () => {
    const classes = new Set(
      FIXTURES.map((f) => f.classId).filter((c) => c !== null && c !== "other")
    );
    expect([...classes].sort()).toEqual(
      [
        "login",
        "conn-refused",
        "dns",
        "discovery",
        "not-implemented",
        "provider",
        "no-route",
        "extension",
        "unknown-command",
        "argument",
        "not-found",
        "cli-error",
        "emulator-error",
        "needs-yes",
        "egress-refused",
        "guard-down",
        "bicep-missing",
        "bicep-registry",
        "azcopy",
      ].sort()
    );
  });

  it("marks reconstructed streams as synthetic and says what they are based on", () => {
    const synthetic = FIXTURES.filter((f) => f.synthetic).map((f) => f.id);
    expect(synthetic.sort()).toEqual(
      [
        "ok-update-check-warning",
        "emulator-error",
        "needs-yes",
        "egress-refused-rest",
        "egress-refused-sdk",
        "guard-down",
      ].sort()
    );
    for (const f of FIXTURES.filter((x) => x.synthetic))
      expect(f.basis!.length).toBeGreaterThan(60);
  });
});

describe("the first line of every failure", () => {
  const failures = FIXTURES.filter((f) => f.classId !== null);

  it.each(failures.map((f) => [f.id, f] as const))(
    "%s: starts with ❌ and carries the exit code and class id",
    (_id, f) => {
      const out = format(f);
      expect(out.startsWith("❌")).toBe(true);
      const line = firstLineOf(out);
      expect(line).toMatch(FIRST_LINE);
      expect(line).toBe(`❌ **Command Failed** (exit ${f.exitCode}, ${f.classId})`);
      expect(out).not.toContain("\r");
      expect(out).not.toContain("Traceback (most recent call last)");
    }
  );

  it("never names a host or a path, only the code and the class id", () => {
    const sdk = format(fixture("egress-refused-sdk"));
    expect(firstLineOf(sdk)).toBe("❌ **Command Failed** (exit 1, egress-refused)");
    expect(sdk.indexOf("mcpzzzz.blob.core.windows.net")).toBeGreaterThan(firstLineOf(sdk).length);
  });

  it("is `exit none` when the tool stopped az or never started it", () => {
    const n1 = fixture("not-implemented-native");
    const cases: Array<[Partial<AzRunResult>, string]> = [
      [{ timedOut: true }, "timeout"],
      [{ aborted: true }, "cancelled"],
      [{ exitCode: null }, "not-implemented"],
      [{ failFast: "refused", egress: { ...NO_EGRESS, refused: ["x.example"] } }, "egress-refused"],
      [{ exitCode: null, tooLong: true, stderr: "" }, "too-long"],
      [{ exitCode: null, spawnError: "spawn python ENOENT", stderr: "" }, "spawn-error"],
    ];
    for (const [overrides, classId] of cases) {
      expect(firstLineOf(format(n1, {}, overrides))).toBe(
        `❌ **Command Failed** (exit none, ${classId})`
      );
    }
  });

  it("is the same contract for the answers given before spawning", () => {
    expect(firstLineOf(commandTooLong().content[0].text)).toBe(
      "❌ **Command Failed** (exit none, too-long)"
    );
    const bicep = bicepMissing({ inDocker: false }).content[0].text;
    expect(firstLineOf(bicep)).toBe("❌ **Command Failed** (exit none, bicep-missing)");
    const registry = bicepRegistryUnsupported("br/public:avm/res/storage/storage-account:0.9.1");
    expect(firstLineOf(registry.content[0].text)).toBe(
      "❌ **Command Failed** (exit none, bicep-registry)"
    );
  });
});

describe("the failure classes", () => {
  it("login: not logged in, after the self-heal retry", () => {
    const out = format(fixture("login-group-list"));
    expect(out).toBe(
      "❌ **Command Failed** (exit 1, login)\n\n" +
        "ERROR: Please run 'az login' to setup account.\n\n" +
        "The tool's Azure CLI profile could not log in to the LocalStack emulator. Check that the " +
        "emulator is running and healthy (`localstack-management` action `status`, service `azure`)."
    );
  });

  it("conn-refused with the guard off: host and port come from the stderr", () => {
    const out = format(fixture("conn-native-group-list"));
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 1, conn-refused)");
    expect(out).toContain(
      "Could not connect to the LocalStack Azure emulator at `azure.localhost.localstack.cloud:4599`: " +
        "nothing is listening. Start it with `localstack-management` (`action: start`, `service: azure`), " +
        "or `lstk start --type azure`, then retry. If it runs on another port, set `LOCALSTACK_PORT` " +
        "(`LOCALSTACK_AZURE_PORT` only when it runs beside an AWS emulator)."
    );
    expect(out).toContain(GUARD_OFF_NOTE);
  });

  it("conn-refused: the `az rest` traceback is stripped to its ERROR lines", () => {
    const f = fixture("conn-rest-traceback");
    expect(f.stderr!.bytes).toBe(5_123);
    const out = format(f);
    const stderr = prepareStderr(text(f.stderr));
    expect(stderr.split("\n")).toEqual([
      "ERROR: The command failed with an unexpected error. Here is the traceback:",
      expect.stringMatching(
        /^ERROR: HTTPSConnectionPool\(host='azure\.localhost\.localstack\.cloud', port=4599\)/
      ),
      "(Python traceback omitted)",
    ]);
    expect(out).toContain(stderr);
    expect(out).not.toContain('File "D:\\a\\_work');
    expect(out).not.toContain("To check existing issues");
    expect(out).toContain("`azure.localhost.localstack.cloud:4599`");
  });

  it("conn-refused: a failed `az login` connect exits 2", () => {
    expect(firstLineOf(format(fixture("conn-login")))).toBe(
      "❌ **Command Failed** (exit 2, conn-refused)"
    );
  });

  it("conn-refused with the guard on: only the guard's upstream record counts", () => {
    // The guard answers 502 and records the host; its stderr regex is for the guard-off case.
    const guardOn = format(fixture("conn-native-group-list"), { guardOn: true });
    expect(firstLineOf(guardOn)).not.toContain("conn-refused");

    const out = formatAzResult(
      run({
        exitCode: 1,
        failFast: "upstream",
        egress: { ...NO_EGRESS, upstream: ["azure.localhost.localstack.cloud"] },
      }),
      options({ argv: ["group", "list"] })
    ).content[0].text;
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit none, conn-refused)");
    expect(out).toContain("at `azure.localhost.localstack.cloud:4566`: nothing is listening");
    expect(out).not.toContain(GUARD_OFF_NOTE);
  });

  it("dns: a name outside LocalStack gets the containment answer", () => {
    for (const id of ["dns-rest-traceback", "dns-native"]) {
      const f = fixture(id);
      const c = classifyFailure(runOf(f), { guardOn: false, argv: f.argv });
      expect(c.classId).toBe("dns");
      expect(c.details.host).toBe("mcp-nxdomain.invalid");
      expect(c.hint).toBe("`az` can only reach the LocalStack emulator from this tool.");
    }
    const out = format(fixture("dns-rest-traceback"));
    // The warning before the error stays; the 4.6 KB traceback goes.
    expect(out).toContain("WARNING: Can't derive appropriate Azure AD resource from --url");
    expect(out.length).toBeLessThan(1_500);
  });

  it("dns: a LocalStack name that did not resolve gets the resolver advice", () => {
    // C8d-group-list-nxdomain with the emulator's own name in place of the .invalid host.
    const stderr = text(fixture("dns-native").stderr).replace(
      /mcp-nxdomain\.invalid/g,
      "azure.localhost.localstack.cloud"
    );
    const off = classifyFailure(run({ stderr }), { guardOn: false });
    expect(off.hint).toBe(
      "`azure.localhost.localstack.cloud` did not resolve. It is a public DNS name for 127.0.0.1, " +
        "and some routers and corporate resolvers block such answers (DNS-rebinding protection). " +
        "Turn the egress guard back on (it needs no DNS), allow `localhost.localstack.cloud`, or " +
        "add `127.0.0.1 azure.localhost.localstack.cloud` to your hosts file."
    );
    const on = classifyFailure(run({ stderr }), { guardOn: true });
    expect(on.classId).toBe("dns");
    expect(on.hint).not.toContain("Turn the egress guard back on");
  });

  it("discovery: endpoint discovery maps through conn-refused with its Error detail", () => {
    const f = fixture("discovery-register");
    const on = classifyFailure(runOf(f), { guardOn: true, argv: f.argv });
    expect(on.classId).toBe("discovery");
    expect(on.hint).toContain("`azure.localhost.localstack.cloud:4599`: nothing is listening");
    // With the guard off, the conn-refused regex comes first.
    expect(classifyFailure(runOf(f), { guardOn: false }).classId).toBe("conn-refused");
    // A detail that is neither conn-refused nor dns still gets an answer.
    const other = classifyFailure(
      run({
        stderr:
          "ERROR: Unable to get endpoints from the cloud.\r\nPlease ensure you have network connection. Error detail: SSLError\r\n",
      }),
      { guardOn: true }
    );
    expect(other.classId).toBe("discovery");
    expect(other.hint).toContain("`/metadata/endpoints`");
  });

  it("not-implemented: the unimplemented operation, the coverage list and the port", () => {
    const out = format(fixture("not-implemented-native"), { port: 4666 });
    expect(out).toContain(
      "The LocalStack Azure emulator does not implement `GET /subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/locks` yet. " +
        "This is an emulator limitation, so retrying will not help. See the implemented operations at " +
        "http://127.0.0.1:4666/_localstack/coverage and https://docs.localstack.cloud/azure/."
    );
    expect(out).not.toContain("register a provider");
    const rest = classifyFailure(runOf(fixture("not-implemented-rest")), { guardOn: true });
    expect(rest.details).toEqual({
      method: "GET",
      path: "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/locks",
    });
  });

  it("not-implemented: a provider registration the CLI made on its own", () => {
    const out = format(fixture("not-implemented-register"));
    expect(out).toContain(
      "The path ends in `/providers/Microsoft.Management/register`: the CLI tried to register a " +
        "provider the emulator does not emulate."
    );
  });

  it("provider: the namespace, native (exit 3) and `az rest`", () => {
    const native = fixture("provider-native");
    expect(firstLineOf(format(native))).toBe("❌ **Command Failed** (exit 3, provider)");
    expect(format(native)).toContain(
      "The LocalStack Azure emulator does not emulate the `Microsoft.Cache` resource provider. " +
        "Supported providers: http://127.0.0.1:4566/_localstack/coverage."
    );
    expect(classifyFailure(runOf(fixture("provider-rest")), { guardOn: true }).details).toEqual({
      namespace: "Microsoft.McpFake",
    });
  });

  it("no-route: no route says the operation may not be emulated", () => {
    for (const id of [
      "no-route-bogus-type",
      "no-route-wrong-method",
      "no-route-unimplemented-post",
    ]) {
      expect(format(fixture(id))).toContain(
        "The emulator has no route for this request. Check the URL path, HTTP method and " +
          "api-version. If they are right, the operation may not be emulated: see " +
          "http://127.0.0.1:4566/_localstack/coverage."
      );
    }
  });

  it("extension: a missing curated extension, named by the command-to-extension map", () => {
    const cases: Array<[string, string, string]> = [
      ["extension-graph", "graph", "resource-graph"],
      ["extension-app-insights", "monitor app-insights", "application-insights"],
      ["extension-k8s-extension", "k8s-extension", "k8s-extension"],
    ];
    for (const [id, group, extension] of cases) {
      const f = fixture(id);
      const c = classifyFailure(runOf(f), { guardOn: true, argv: f.argv });
      expect(c.classId).toBe("extension");
      expect(c.details).toMatchObject({ group, extension });
      expect(c.hint).toBe(
        `\`az ${group}\` comes from the \`${extension}\` Azure CLI extension, which is not ` +
          "installed for this tool (automatic installs are disabled). Install the tool's " +
          "extensions once with `npx -y @localstack/localstack-mcp-server install-azure-addons`; " +
          "meanwhile `rest` with a relative URL usually works."
      );
    }
    const f = fixture("extension-graph");
    const image = classifyFailure(runOf(f), { guardOn: true, argv: f.argv, inDocker: true });
    expect(image.hint).toBe(
      "`resource-graph` is not in this image's curated set; use `rest` with a relative URL."
    );
  });

  it("extension vs unknown-command: an installed extension or a typo under a core group is not a missing extension", () => {
    const f = fixture("extension-graph");
    const installed = new Set(["resource-graph"]);
    const c = classifyFailure(runOf(f), {
      guardOn: true,
      argv: f.argv,
      extensionFor: (tokens) => extensionFor(tokens, installed),
    });
    expect(c.classId).toBe("unknown-command");
    // `afd` and `containerapp` are core in 2.85 and 2.87: a bad verb under them is a typo.
    const typo = (argv: string[], token: string) =>
      classifyFailure(
        run({
          exitCode: 2,
          stderr: `ERROR: '${token}' is misspelled or not recognized by the system.\r\n`,
        }),
        { guardOn: true, argv }
      ).classId;
    expect(typo(["afd", "profle", "list"], "profle")).toBe("unknown-command");
    expect(typo(["containerapp", "lst"], "lst")).toBe("unknown-command");
    // On 2.90 the whole `afd` group is the cdn extension's.
    expect(typo(["afd", "profile", "list", "-g", "x"], "afd")).toBe("extension");
  });

  it("unknown-command: an unknown command keeps the CLI's own suggestion and adds no hint", () => {
    const f = fixture("unknown-command-typo");
    const c = classifyFailure(runOf(f), { guardOn: true, argv: f.argv });
    expect(c).toEqual({
      classId: "unknown-command",
      hint: undefined,
      details: { token: "lst", suggestion: "list" },
    });
    expect(format(f)).toBe(
      `❌ **Command Failed** (exit 2, unknown-command)\n\n${prepareStderr(text(f.stderr))}`
    );
    expect(
      classifyFailure(runOf(fixture("unknown-command-subcommand")), { guardOn: true }).classId
    ).toBe("unknown-command");
  });

  it("argument: argument errors point at --help and keep the CLI's examples", () => {
    for (const id of [
      "argument-required",
      "argument-unrecognized",
      "argument-required-location",
      "argument-choice",
      "argument-jmespath",
    ]) {
      const out = format(fixture(id));
      expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 2, argument)");
      expect(out.endsWith("Run the command with `--help` to see its arguments.")).toBe(true);
    }
    expect(format(fixture("argument-required"))).toContain("Examples from AI knowledge base:");
  });

  it("not-found: not found adds nothing, and never says resource group not found", () => {
    for (const id of ["not-found-group", "not-found-storage", "not-found-rest"]) {
      const f = fixture(id);
      const out = format(f);
      expect(out).toBe(
        `❌ **Command Failed** (exit ${f.exitCode}, not-found)\n\n${prepareStderr(text(f.stderr))}`
      );
      expect(out).not.toMatch(/ResourceGroupNotFound|resource group not found/i);
    }
  });

  it("cli-error: an unexpected CLI error is matched on after its traceback is stripped", () => {
    const f = fixture("cli-error-traceback");
    // The stripped traceback holds a row-7 text; it must not decide the class.
    expect(text(f.stderr)).toContain("The requested URL was not found on the server");
    const out = format(f);
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 1, cli-error)");
    expect(out).toBe(
      "❌ **Command Failed** (exit 1, cli-error)\n\n" +
        "ERROR: The command failed with an unexpected error. Here is the traceback:\n" +
        "ERROR: 'error'\n(Python traceback omitted)"
    );
  });

  it("cli-error lets a later class answer", () => {
    const stderr =
      "ERROR: The command failed with an unexpected error. Here is the traceback:\r\n" +
      "ERROR: Unable to prompt for confirmation as no tty available. Use --yes.\r\n" +
      'Traceback (most recent call last):\r\n  File "x.py", line 1, in <module>\r\nEOFError\r\n';
    expect(classifyFailure(run({ stderr }), { guardOn: true }).classId).toBe("needs-yes");
  });

  it("emulator-error (synthetic): an emulator internal error points at the emulator logs", () => {
    const out = format(fixture("emulator-error"));
    expect(out).toContain(
      "The LocalStack Azure emulator hit an internal error while handling `GET /subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Storage/storageAccounts`. " +
        "This is an emulator bug; the details are in the emulator logs (`localstack-logs-analysis`, analysisType `logs`)."
    );
  });

  it("needs-yes (synthetic): a prompt without --yes", () => {
    expect(format(fixture("needs-yes"))).toContain(
      "This command asks for confirmation. Re-run it with `--yes`."
    );
  });

  it("egress-refused: a refused egress host replaces az's text with the tool's line", () => {
    const sdk = format(fixture("egress-refused-sdk"));
    expect(sdk).toBe(
      "❌ **Command Failed** (exit 1, egress-refused)\n\n" +
        "Blocked a connection to `mcpzzzz.blob.core.windows.net`: this tool only lets `az` " +
        "talk to the local emulator. Use a relative URL with `rest`, or a command that stays on the emulator."
    );
    const rest = format(fixture("egress-refused-rest"));
    expect(rest).toContain("Blocked a connection to `management.azure.com`");
    expect(rest).not.toContain("Unable to connect to proxy");
    expect(rest).not.toContain("WARNING");
  });

  it("egress-refused: the backup regex, which never reports a housekeeping host", () => {
    const sdkText = text(fixture("egress-refused-sdk").stderr);
    const lost = classifyFailure(run({ stderr: sdkText }), { guardOn: true });
    expect(lost.classId).toBe("egress-refused");
    expect(format(fixture("egress-refused-sdk"), {}, { egress: NO_EGRESS })).toContain(
      "Blocked a connection to a host outside the emulator"
    );
    const housekeeping = classifyFailure(
      run({ stderr: sdkText, egress: { ...NO_EGRESS, housekeeping: ["aka.ms"] } }),
      { guardOn: true }
    );
    expect(housekeeping.classId).not.toBe("egress-refused");
    // With the guard off a 403 came from someone else's proxy.
    expect(classifyFailure(run({ stderr: sdkText }), { guardOn: false }).classId).toBe("other");
  });

  it("too-long: too long for Windows, before spawning or from the spawn error", () => {
    const hint =
      "The command is too long for Windows (limit 32,767 characters). Put large values, such as " +
      "JSON bodies or templates, in a file inside the working directory and pass `@<file>`.";
    expect(commandTooLong().content[0].text).toBe(
      `❌ **Command Failed** (exit none, too-long)\n\n${hint}`
    );
    expect(classifyFailure(run({ exitCode: null, tooLong: true }), { guardOn: true })).toEqual({
      classId: "too-long",
      hint,
      details: {},
    });
    expect(
      classifyFailure(run({ exitCode: null, spawnError: "spawn ENAMETOOLONG" }), { guardOn: true })
        .classId
    ).toBe("too-long");
  });

  it("timeout: a timeout whose stderr holds a not-implemented message is answered as a timeout", () => {
    const f = fixture("not-implemented-native");
    const out = format(f, {}, { timedOut: true });
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit none, timeout)");
    expect(out).toContain(
      "`az` did not finish within 300 s and was stopped. For long-running creates, run the " +
        "command with `--no-wait`, then poll with `show`."
    );
    expect(out).not.toContain("does not implement");
    expect(out).not.toContain("Claude Desktop");
  });

  it("timeout: the hint names Claude Desktop's ~60 s limit", () => {
    const f = fixture("not-implemented-native");
    const desktop = format(
      f,
      { client: { name: "claude-ai", version: "0.1.0" } },
      { timedOut: true }
    );
    expect(desktop).toContain("Claude Desktop also stops waiting for a tool call after about 60 s");
    const code = format(
      f,
      { client: { name: "claude-code", version: "2.1.0" } },
      { timedOut: true }
    );
    expect(code).not.toContain("Claude Desktop");
  });

  it("guard-down: the guard-down text is not answered as conn-refused", () => {
    const f = fixture("guard-down");
    const on = format(f);
    expect(firstLineOf(on)).toBe("❌ **Command Failed** (exit 1, guard-down)");
    expect(on).toContain(
      "Internal error: the tool's egress guard was not running. Restart the MCP server; if it happens again, report it."
    );
    expect(on).not.toContain("Could not connect to the LocalStack Azure emulator");
    // With the guard off the child has no proxy variables: a proxy error is the system proxy's.
    const off = classifyFailure(runOf(f), { guardOn: false });
    expect(off.classId).not.toBe("guard-down");
    expect(off.classId).not.toBe("conn-refused");
  });

  it("bicep-missing: the three texts az prints", () => {
    const hint =
      "Bicep templates need the Bicep CLI, which the LocalStack Azure tool could not find. " +
      "Install it with `npx -y @localstack/localstack-mcp-server install-azure-addons`, or put Bicep on your PATH " +
      "(https://learn.microsoft.com/azure/azure-resource-manager/bicep/install), or set `LOCALSTACK_AZ_BICEP_PATH` " +
      "to a bicep binary, then retry. " +
      "Or deploy compiled ARM JSON: `--template-file main.json`. (`az bicep install` and `az config set` are not available through this tool.)";
    for (const id of [
      "bicep-missing-path-mode",
      "bicep-missing-version",
      "bicep-missing-latest-lookup",
    ]) {
      const out = format(fixture(id));
      expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 1, bicep-missing)");
      expect(out).toContain(hint);
    }
    // The aka.ms lookup failed through the guard: a housekeeping block, not egress-refused.
    expect(format(fixture("bicep-missing-latest-lookup"))).toContain(
      "Note: the egress guard also blocked `aka.ms`"
    );
  });

  it("bicep-missing: the host and image variants of the hint, and the pre-spawn answer", () => {
    const host = bicepMissing({ inDocker: false }).content[0].text;
    expect(host).toContain(
      "Install it with `npx -y @localstack/localstack-mcp-server install-azure-addons`, or put " +
        "Bicep on your PATH (https://learn.microsoft.com/azure/azure-resource-manager/bicep/install), " +
        "or set `LOCALSTACK_AZ_BICEP_PATH` to a bicep binary, then retry."
    );
    expect(host).not.toMatch(/wizard|\binit\b/);
    expect(bicepMissing({ inDocker: true }).content[0].text).toBe(
      "❌ **Command Failed** (exit none, bicep-missing)\n\n" +
        "This image's Bicep CLI is missing. Set `LOCALSTACK_AZ_BICEP_PATH` to a mounted Linux bicep " +
        "binary, or deploy compiled ARM JSON (`--template-file main.json`)."
    );
    // Pre-spawn checks come first in the evaluation order.
    const c = classifyFailure(run({ timedOut: true }), { guardOn: true, bicepFound: false });
    expect(c.classId).toBe("bicep-missing");
  });

  it("bicep-registry: BCP192 prints the proxy URL, which is redacted with its tag", () => {
    const f = fixture("bicep-registry-bcp192");
    expect(text(f.stderr)).toContain("http://call-0025:x@127.0.0.1:56739/");
    const out = format(f);
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 1, bicep-registry)");
    expect(out).not.toContain("call-0025");
    expect(out).toContain("http://[redacted]@127.0.0.1:56739/");
    expect(out).toContain(
      "Bicep registry modules (`br:`, `br/public:`) cannot be restored: the tool only reaches the " +
        "local emulator. Copy the module into the workdir, and reference it by relative path."
    );
    expect(classifyFailure(runOf(f), { guardOn: true }).details).toEqual({
      reference: "br:mcr.microsoft.com/bicep/avm/res/storage/storage-account:0.9.1",
    });
    const direct = format(fixture("bicep-registry-bcp192-direct"));
    expect(direct).not.toContain("bicep-1790513910081");
    expect(direct).toContain("http://[redacted]@127.0.0.1:52336/");
  });

  it("bicep-registry: BCP446 and the pre-spawn answer", () => {
    const f = fixture("bicep-registry-bcp446");
    expect(classifyFailure(runOf(f), { guardOn: true })).toMatchObject({
      classId: "bicep-registry",
      details: { reference: "mcp.invalid" },
    });
    const ref = "br/public:avm/res/storage/storage-account:0.9.1";
    expect(bicepRegistryUnsupported(ref).content[0].text).toBe(
      "❌ **Command Failed** (exit none, bicep-registry)\n\n" +
        `The template uses the registry module \`${ref}\`.\n\n` +
        "Bicep registry modules (`br:`, `br/public:`) cannot be restored: the tool only reaches the " +
        "local emulator. Copy the module into the workdir, and reference it by relative path."
    );
  });

  it("azcopy: azcopy download", () => {
    const out = format(fixture("azcopy"));
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 1, azcopy)");
    expect(out).toContain(
      "This command needs azcopy, which `az` would download from the internet. Use " +
        "`storage blob upload-batch`, `download-batch` or `delete-batch` instead."
    );
  });

  it("no match: other, with the trimmed stderr and no hint", () => {
    const f = fixture("prep-image-alias-warning");
    const out = format(f);
    expect(firstLineOf(out)).toBe("❌ **Command Failed** (exit 1, other)");
    expect(out).toContain("ERROR: Proximity Placement Group 'mcp-no-such-ppg' does not exist.");
    expect(out.trim().endsWith("does not exist.")).toBe(true);
  });

  it("says so when az failed without a message", () => {
    const out = formatAzResult(run({ exitCode: 1 }), options()).content[0].text;
    expect(out).toBe(
      "❌ **Command Failed** (exit 1, other)\n\n`az` exited without printing an error message."
    );
  });

  it("cancelled and spawn errors", () => {
    const cancelled = formatAzResult(run({ aborted: true, timedOut: true }), options()).content[0]
      .text;
    expect(firstLineOf(cancelled)).toBe("❌ **Command Failed** (exit none, cancelled)");
    expect(cancelled).toContain("The client cancelled the call, and `az` was stopped.");
    const spawn = formatAzResult(
      run({ exitCode: null, spawnError: "spawn C:\\az\\python.exe ENOENT" }),
      options()
    );
    expect(spawn.content[0].text).toBe(
      "❌ **Command Failed** (exit none, spawn-error)\n\n" +
        "The tool could not start the Azure CLI: spawn C:\\az\\python.exe ENOENT\n\n" +
        "Check the `az` installation, or set `LOCALSTACK_AZ_PATH` to the `az` launcher or its Python."
    );
  });

  it("evaluates the runner flags and the guard's records before the stderr rows", () => {
    const n1 = runOf(fixture("not-implemented-native"));
    const refused = {
      ...NO_EGRESS,
      refused: ["x.example"],
      upstream: ["azure.localhost.localstack.cloud"],
    };
    expect(
      classifyFailure({ ...n1, aborted: true, timedOut: true }, { guardOn: true }).classId
    ).toBe("cancelled");
    expect(
      classifyFailure({ ...n1, timedOut: true, egress: refused }, { guardOn: true }).classId
    ).toBe("timeout");
    expect(classifyFailure({ ...n1, egress: refused }, { guardOn: true }).classId).toBe(
      "egress-refused"
    );
    expect(
      classifyFailure(
        { ...n1, egress: { ...NO_EGRESS, upstream: ["localhost.localstack.cloud"] } },
        { guardOn: true }
      ).classId
    ).toBe("conn-refused");
  });
});

describe("stderr preparation", () => {
  it("normalises CRLF in every fixture", () => {
    for (const f of FIXTURES) expect(prepareStderr(text(f.stderr))).not.toContain("\r");
  });

  it("keeps ERROR lines that follow a traceback", () => {
    const raw =
      'ERROR: first\r\nTraceback (most recent call last):\r\n  File "a"\r\nValueError\r\nERROR: second\r\nplain\r\n';
    expect(prepareStderr(raw)).toBe("ERROR: first\n(Python traceback omitted)\nERROR: second");
  });

  it("drops the image-alias warning and keeps the others", () => {
    const f = fixture("prep-image-alias-warning");
    expect(text(f.stderr)).toContain("WARNING: Failed to retrieve image alias doc");
    const prepared = prepareStderr(text(f.stderr));
    expect(prepared).not.toContain("image alias");
    expect(prepared).toContain("WARNING: The default value of '--size' will be changed");
    expect(prepared).toContain("WARNING: SSH key files");
    // A different error name is not the refused-host fallback, so it stays.
    const other =
      "WARNING: Failed to retrieve image alias doc 'x'. Error: 'JSONDecodeError'. Use local copy instead.";
    expect(prepareStderr(other)).toBe(other);
  });

  it("drops the update-check warning", () => {
    const f = fixture("ok-update-check-warning");
    expect(prepareStderr(text(f.stderr))).toBe("");
    expect(format(f)).not.toContain("WARNING");
  });

  it("caps at about 4,000 characters, keeping the head", () => {
    const raw = `ERROR: head\n${"x".repeat(80)}\n`.repeat(200);
    const prepared = prepareStderr(raw);
    expect(prepared.length).toBeLessThanOrEqual(STDERR_FAILURE_CHARS);
    expect(prepared.length).toBeGreaterThan(STDERR_FAILURE_CHARS - 200);
    expect(prepared.startsWith("ERROR: head\n")).toBe(true);
    expect(prepared).toMatch(/\n\[\.\.\. [\d,]+ more characters cut\]$/);
    expect(prepareStderr(raw, { maxChars: 500 }).length).toBeLessThanOrEqual(500);
  });

  it("never splits a surrogate pair at the cap", () => {
    for (let n = 3_990; n < 4_000; n++) {
      const raw = `${"a".repeat(n)}${"😀".repeat(40)}`;
      expect(hasLoneSurrogate(prepareStderr(raw))).toBe(false);
    }
  });
});

describe("redactProxyUrls", () => {
  it("removes the call tag from loopback proxy URLs", () => {
    expect(redactProxyUrls("proxy 'http://call-0025:x@127.0.0.1:56739/' failed")).toBe(
      "proxy 'http://[redacted]@127.0.0.1:56739/' failed"
    );
    expect(redactProxyUrls("http://2f1c1a0e-8e4b-4c7e-9a7b-8b0c1d2e3f40:x@127.0.0.1:61234")).toBe(
      "http://[redacted]@127.0.0.1:61234"
    );
    expect(redactProxyUrls("HTTP://tag:x@LOCALHOST:1 and http://tag:x@[::1]:2")).toBe(
      "HTTP://[redacted]@LOCALHOST:1 and http://[redacted]@[::1]:2"
    );
  });

  it("leaves other URLs alone", () => {
    const s =
      "https://azure.localhost.localstack.cloud:4566/x and http://127.0.0.1:4566/_localstack/health";
    expect(redactProxyUrls(s)).toBe(s);
    expect(redactProxyUrls("https://user@example.com/")).toBe("https://user@example.com/");
  });
});

describe("success output", () => {
  it("is az's stdout with LF line endings", () => {
    const f = fixture("ok-group-list");
    const out = format(f);
    expect(out).toBe(text(f.stdout).replace(/\r\n/g, "\n").replace(/\n+$/, ""));
    expect(out.startsWith("❌")).toBe(false);
  });

  it("puts notes first, then the output, then the warnings", () => {
    const f = fixture("ok-warning-storage-create");
    const note = "Rewrote the management.azure.com URL to a relative one.";
    const out = format(f, { notes: [note] });
    expect(out).toBe(
      `${note}\n\nSucceeded\n\n` +
        "WARNING: The --min-tls-version argument values TLS1_0 and TLS1_1 have been retired on 2026/02/03 and will be removed on 2026/03/03."
    );
  });

  it("caps the warnings at 2,000 characters", () => {
    const stderr = `WARNING: ${"w".repeat(3_000)}\r\n`;
    const out = formatAzResult(run({ exitCode: 0, stdout: "ok\r\n", stderr }), options()).content[0]
      .text;
    const warnings = out.slice(out.indexOf("WARNING"));
    expect(warnings.length).toBeLessThanOrEqual(2_000);
    expect(warnings).toMatch(/more characters cut\]$/);
  });

  it("says so when az printed nothing", () => {
    const out = formatAzResult(run({ exitCode: 0 }), options()).content[0].text;
    expect(out).toBe("The command succeeded and printed no output.");
  });

  it("carries the guard-off note on successes and failures, and only then", () => {
    const ok = formatAzResult(run({ exitCode: 0, stdout: "[]\r\n" }), options({ guardOn: false }))
      .content[0].text;
    expect(ok).toBe(`${GUARD_OFF_NOTE}\n\n[]`);
    const failed = format(fixture("not-implemented-native"), { guardOn: false });
    expect(failed.endsWith(GUARD_OFF_NOTE)).toBe(true);
    expect(format(fixture("not-implemented-native"))).not.toContain("egress guard");
  });

  it("notes a refused host even when the command still succeeded", () => {
    const out = formatAzResult(
      run({ exitCode: 0, stdout: "{}\r\n", egress: { ...NO_EGRESS, refused: ["example.com"] } }),
      options()
    ).content[0].text;
    expect(out).toBe(
      "Note: the egress guard blocked a connection to `example.com`; the command still succeeded.\n\n{}"
    );
  });

  describe("functionapp create without --workspace (the App Insights region map)", () => {
    // az's own warning when its App Insights setup fails (appservice/custom.py), after the
    // function app itself was created.
    const warning =
      "WARNING: Error while trying to create and configure an Application Insights for the Function App. " +
      "Please use the Azure Portal to create and configure the Application Insights, if needed.\r\n";
    const created = (egress: EgressRecords) =>
      formatAzResult(
        run({ exitCode: 0, stdout: '{"name": "fa"}\r\n', stderr: warning, egress }),
        options()
      ).content[0].text;

    it("is a success, with a note on getting Application Insights, when the refused host was the region map", () => {
      const out = created({ ...NO_EGRESS, housekeeping: ["appinsights.azureedge.net"] });
      expect(out.startsWith("❌")).toBe(false);
      expect(out).toContain("the function app was created without Application Insights");
      expect(out).toContain("--workspace <its name>");
      expect(out).toContain("--disable-app-insights true");
      expect(out).toContain('{"name": "fa"}');
    });

    it("adds no note when App Insights failed for another reason", () => {
      expect(created(NO_EGRESS)).not.toContain("appinsights.azureedge.net");
    });

    it("the region-map host is a housekeeping host: named in stderr, it never counts as a refusal", () => {
      // requests' text for the guard's 403, with no guard records: only the static list decides.
      const stderr =
        "ERROR: HTTPSConnectionPool(host='appinsights.azureedge.net', port=443): Max retries exceeded " +
        "with url: /portal/regionMapping.json (Caused by ProxyError('Unable to connect to proxy', " +
        "OSError('Tunnel connection failed: 403 blocked by egress guard: appinsights.azureedge.net')))\r\n";
      const failed = classifyFailure(run({ exitCode: 1, stderr }), { guardOn: true });
      expect(failed.classId).not.toBe("egress-refused");
    });
  });

  it("lists housekeeping blocks as expected when the command failed for another reason", () => {
    const out = format(
      fixture("not-implemented-native"),
      {},
      {
        egress: { ...NO_EGRESS, housekeeping: ["azcliprod.blob.core.windows.net"] },
      }
    );
    expect(out.split("\n\n").pop()).toBe(
      "Note: the egress guard also blocked `azcliprod.blob.core.windows.net`, which the tool always " +
        "refuses (housekeeping calls such as update checks); these blocks are expected."
    );
  });

  it("puts the failure's parts in order: first line, stderr, output, hint, notes", () => {
    const f = fixture("not-implemented-native");
    const out = format(f, { notes: ["policy note"] }, { stdout: "partial\r\n" });
    const parts = out.split("\n\n");
    expect(parts[0]).toBe("❌ **Command Failed** (exit 1, not-implemented)");
    expect(parts[1]).toMatch(/^ERROR: \(NotImplemented\)/);
    expect(parts[2]).toBe("Output:\npartial");
    expect(parts[3]).toMatch(/^The LocalStack Azure emulator does not implement/);
    expect(parts[4]).toBe("policy note");
  });
});

describe("truncation", () => {
  it("caps `account list-locations` (31 KB, just over the cap) and keeps its UTF-8", () => {
    const f = fixture("ok-list-locations-utf8");
    const all = text(f.stdout).replace(/\r\n/g, "\n").replace(/\n+$/, "");
    expect(all).toContain("Querétaro");
    expect(all.length).toBe(30_158);
    const out = format(f);
    const [shown, note] = out.split("\n\n");
    expect(shown.length).toBeLessThanOrEqual(30_000);
    expect(all.startsWith(shown)).toBe(true);
    expect(note).toBe(
      `[Output truncated: showing the first ${shown.length.toLocaleString("en-US")} of 30,158 characters. ` +
        'Narrow it with --query and -o tsv, for example --query "[].name" -o tsv.]'
    );
  });

  it("keeps output of exactly the cap, and cuts one character more", () => {
    const at = formatAzResult(
      run({ exitCode: 0, stdout: "x".repeat(1_000) }),
      options({ maxOutputChars: 1_000 })
    );
    expect(at.content[0].text).toBe("x".repeat(1_000));
    const over = formatAzResult(
      run({ exitCode: 0, stdout: "x".repeat(1_001) }),
      options({ maxOutputChars: 1_000 })
    );
    expect(over.content[0].text).toMatch(
      /^x{1000}\n\n\[Output truncated: showing the first 1,000 of 1,001 characters\./
    );
  });

  it("handles 4.5 MB of `provider list` output", () => {
    // The size of a recorded `provider list -o json`: 4,521,778 bytes with CRLF line endings.
    const block =
      '  {\r\n    "id": "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Example",\r\n' +
      '    "namespace": "Microsoft.Example",\r\n    "registrationState": "Registered",\r\n    "resourceTypes": []\r\n  },\r\n';
    let stdout = `[\r\n${block.repeat(Math.ceil(4_521_778 / block.length))}]\r\n`;
    stdout = stdout.slice(0, 4_521_775) + "]\r\n";
    expect(stdout.length).toBeGreaterThanOrEqual(4_500_000);
    const started = Date.now();
    const response = formatAzResult(run({ exitCode: 0, stdout }), options({ envelope: true }));
    // ~150 ms alone; a loaded full-suite run on WSL took over 2 s. The bound only has to
    // catch a quadratic regression.
    expect(Date.now() - started).toBeLessThan(10_000);
    const out = response.content[0].text;
    const total = stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "").length;
    expect(out.length).toBeLessThan(30_300);
    expect(out).toContain(`of ${total.toLocaleString("en-US")} characters`);
    // The envelope still carries every byte.
    const envelope: ResultEnvelope = JSON.parse(response.content[1].text);
    expect(envelope.stdout).toBe(stdout);
  });

  it("never splits a surrogate pair in the output cap", () => {
    for (let n = 990; n < 1_000; n++) {
      const stdout = `${"a".repeat(n)}${"😀".repeat(20)}`;
      const out = formatAzResult(run({ exitCode: 0, stdout }), options({ maxOutputChars: 1_000 }))
        .content[0].text;
      expect(hasLoneSurrogate(out)).toBe(false);
    }
    expect(headCut("ab😀", 3)).toBe("ab");
    expect(tailCut("😀ab", 3)).toBe("ab");
    expect(headCut("ab😀", 4)).toBe("ab😀");
  });
});

describe("help pages", () => {
  const reflowOf = (f: Fixture) => reflowHelp(text(f.stdout));

  it("re-flows each recorded help page to its expected length and hash", () => {
    for (const id of ["help-az", "help-vm-create", "help-aks-create"]) {
      const f = fixture(id);
      const reflowed = reflowOf(f);
      expect(reflowed.length).toBe(f.reflowed!.chars);
      expect(sha256(reflowed)).toBe(f.reflowed!.sha256);
    }
  });

  // The recorded sizes count the blank line that starts every page and the two newlines that end it;
  // the response drops them.
  const page = (f: Fixture) => reflowOf(f).replace(/^\n+/, "").replace(/\n+$/, "");

  it("vm create is 28.7 KB after re-flow and is not cut", () => {
    const f = fixture("help-vm-create");
    expect(f.stdout!.bytes).toBe(116_394);
    expect(reflowOf(f).length).toBe(28_742);
    const out = format(f, { isHelp: true });
    expect(out).toBe(page(f));
    expect(out.length).toBe(28_739);
    expect(out).not.toContain("characters of this help page cut");
  });

  it("aks create is 43 KB after re-flow and is cut in the middle, keeping head and Examples", () => {
    const f = fixture("help-aks-create");
    expect(reflowOf(f).length).toBe(43_240);
    const reflowed = page(f);
    const out = format(f, { isHelp: true });
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out.length).toBeGreaterThan(29_000);
    const examples = reflowed.slice(reflowed.lastIndexOf("\nExamples\n") + 1);
    expect(examples.length).toBe(10_028);
    expect(out.endsWith(examples)).toBe(true);
    expect(out.startsWith(reflowed.slice(0, 2_000))).toBe(true);
    expect(out).toMatch(
      /\n\n\[\.\.\. [\d,]+ characters of this help page cut here; the head and the Examples are kept \.\.\.\]\n\n/
    );
    const head = out.slice(0, out.indexOf("\n\n[..."));
    expect(reflowed.startsWith(head)).toBe(true);
  });

  it("appends az's warnings after the page", () => {
    const f = fixture("help-az");
    const out = format(f, { isHelp: true });
    expect(out.startsWith(`${page(f)}\n\n`)).toBe(true);
    expect(
      out.endsWith(
        "\n\nWARNING: You have 2 update(s) available. Consider updating your CLI installation with 'az upgrade'\nWARNING:"
      )
    ).toBe(true);
  });

  it("joins lines indented 20 or more spaces and collapses runs of spaces", () => {
    const page = [
      "Arguments",
      "    --name -n                      [Required] : The storage account name. It must",
      "                                                be unique.",
      "                   not joined: 19 spaces",
      "",
      "                                                after a blank line",
      "    a   b   c  d e",
    ].join("\r\n");
    expect(reflowHelp(page).split("\n")).toEqual([
      "Arguments",
      "    --name -n  [Required] : The storage account name. It must be unique.",
      "                   not joined: 19 spaces",
      "",
      "                                                after a blank line",
      "    a  b  c  d e",
    ]);
  });

  it("falls back to the last part of the page when there is no small Examples section", () => {
    const page = Array.from({ length: 400 }, (_, i) => `line ${i} ${"z".repeat(60)}`).join("\n");
    const cut = cutHelpPage(page, 5_000);
    expect(cut.length).toBeLessThanOrEqual(5_000);
    expect(cut.startsWith("line 0 ")).toBe(true);
    expect(cut.endsWith(`line 399 ${"z".repeat(60)}`)).toBe(true);
    expect(hasLoneSurrogate(cutHelpPage("😀".repeat(3_000), 1_001))).toBe(false);
  });
});

describe("test envelope", () => {
  it("is present only with envelope: true", () => {
    const f = fixture("ok-warning-storage-create");
    expect(formatAzResult(runOf(f), options()).content).toHaveLength(1);
    const withEnvelope = formatAzResult(runOf(f), options({ envelope: true }));
    expect(withEnvelope.content).toHaveLength(2);
    expect(withEnvelope.content[0].text).toBe(formatAzResult(runOf(f), options()).content[0].text);
  });

  it("carries az's stdout byte for byte, warnings excluded", () => {
    // A success with a warning round-trips through $(…).
    for (const id of ["ok-warning-storage-create", "ok-list-locations-utf8", "ok-group-list"]) {
      const f = fixture(id);
      const response = formatAzResult(runOf(f), options({ envelope: true, notes: ["n1"] }));
      const envelope: ResultEnvelope = JSON.parse(response.content[1].text);
      expect(Buffer.from(envelope.stdout, "utf8").equals(bytesOf(f.stdout!))).toBe(true);
      expect(envelope).toMatchObject({
        exitCode: 0,
        classId: null,
        truncated: false,
        notes: ["n1"],
      });
    }
  });

  it("carries the class id, the exit code, redacted stderr and the runner's truncation", () => {
    const f = fixture("bicep-registry-bcp192");
    const response = formatAzResult(
      runOf(f, { truncated: true }),
      options({ envelope: true, argv: f.argv })
    );
    const envelope: ResultEnvelope = JSON.parse(response.content[1].text);
    expect(envelope.classId).toBe("bicep-registry");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.truncated).toBe(true);
    expect(envelope.stderr).toContain("\r\n");
    expect(envelope.stderr).not.toContain("call-0025");
    expect(envelope.stderr).toBe(redactProxyUrls(text(f.stderr)));
    expect(envelope.notes).toEqual([expect.stringContaining("more than the tool captures")]);
  });
});

describe("classifyFailure: az's own not-found exit code", () => {
  // az exits 3 for ResourceNotFoundError. The emulator words some not-found answers with codes
  // the text pattern does not know (Event Hubs, Service Bus, Cosmos, Key Vault, subnets, ...), so
  // a `show` of a missing child came back as the vague "other". The exit code is az's own verdict.
  const unknownNotFound =
    "ERROR: (NotFound) The resource 'hub1' was not found.\nCode: NotFound\nMessage: The resource 'hub1' was not found.";

  test("exit code 3 with an unrecognised not-found text is classified not-found", () => {
    const c = classifyFailure(run({ exitCode: 3, stderr: unknownNotFound }), { guardOn: false });
    expect(c.classId).toBe("not-found");
  });

  test("the same text with a generic exit code 1 is still other (the exit code decides)", () => {
    const c = classifyFailure(run({ exitCode: 1, stderr: unknownNotFound }), { guardOn: false });
    expect(c.classId).toBe("other");
  });

  test("exit code 3 does not override a more specific class", () => {
    const c = classifyFailure(
      run({ exitCode: 3, stderr: "ERROR: unrecognized arguments: --nope" }),
      { guardOn: false }
    );
    expect(c.classId).toBe("argument");
  });
});

describe("classifyFailure: Bicep readEnvironmentVariable", () => {
  test("BCP427 gets its own class, naming the variable and how to pass it", () => {
    const stderr =
      'ERROR: C:\\work\\main.bicepparam(11,47) : Error BCP427: Environment variable "BACKEND_SECRET" does not exist and there\'s no default value set. [https://aka.ms/bicep/core-diagnostics#BCP427]';
    const c = classifyFailure(run({ exitCode: 1, stderr }), { guardOn: false });
    expect(c.classId).toBe("bicep-env");
    expect(c.hint).toContain("BACKEND_SECRET");
    expect(c.hint).toContain("LOCALSTACK_AZ_BICEP_ENV");
    expect(c.details).toEqual({ variable: "BACKEND_SECRET" });
  });
});
