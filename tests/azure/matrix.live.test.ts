// L2: the per-provider command matrix.
//
//   AZURE_LIVE=1 npx jest -c jest.azure-live.config.js --selectProjects matrix-subset --runInBand
//
// The cases live in tests/azure/matrix/*.yaml, one file per emulator provider. Each case runs
// setup -> command -> expect -> cleanup through the real tool handler (the harness's `az()`), and
// reads az's stdout from the test envelope, never from the tool's prose.
//
// This file also exports the matrix model (loader, validator, renderer, selection, sharding):
// the schema test (tests/azure/matrix/schema.test.ts) imports it, so the live tests below
// register only when Jest runs this file itself.
//
// Knobs (tests/azure/matrix/README.md has the full list):
//   AZURE_MATRIX=pr|full       set by the project's setup file (matrix-subset / matrix-full)
//   AZURE_MATRIX_BACKING=1     also run `backing: true` cases (emulator side-car containers)
//   AZURE_MATRIX_SHARD=i/n     run shard i of n (Jest's --shard splits files, and this is one file)
//   AZURE_MATRIX_GAPS=run|skip run known gaps as expected failures (default) or skip them
//   AZURE_MATRIX_ONLY=a,b      run only these case ids or file stems (local debugging)
//   AZURE_MATRIX_RESULTS       JSONL of case results, appended as they land
//   AZURE_OP_CATALOGUE_OUT     the per-operation catalogue for the portal
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { EXTENSION_COMMANDS, listInstalledExtensions } from "../../src/lib/azure/extension-map";
import {
  az,
  describeLive,
  LIVE,
  names,
  recordEgress,
  runId,
  setupLiveEnv,
  type AzCall,
  type EgressLog,
} from "./live/harness";

// ---------------------------------------------------------------------------------------------
// The matrix model (shared with the schema test)

export const MATRIX_DIR = path.join(__dirname, "matrix");
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const BICEP_FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "azure", "bicep");

/** The 29 providers of the emulator's coverage list (`/_localstack/coverage`, 2026-09-27). */
export const PROVIDERS = [
  "Microsoft.ApiManagement",
  "Microsoft.App",
  "Microsoft.AppConfiguration",
  "Microsoft.Authorization",
  "Microsoft.Cdn",
  "Microsoft.Compute",
  "Microsoft.ContainerInstance",
  "Microsoft.ContainerRegistry",
  "Microsoft.ContainerService",
  "Microsoft.DBforMySQL",
  "Microsoft.DBforPostgreSQL",
  "Microsoft.DocumentDB",
  "Microsoft.EventGrid",
  "Microsoft.EventGrid.DataPlane",
  "Microsoft.EventHub",
  "Microsoft.Insights",
  "Microsoft.Insights.DataPlane",
  "Microsoft.KeyVault",
  "Microsoft.KubernetesConfiguration",
  "Microsoft.ManagedIdentity",
  "Microsoft.Network",
  "Microsoft.OperationalInsights",
  "Microsoft.ResourceGraph",
  "Microsoft.Resources",
  "Microsoft.ServiceBus",
  "Microsoft.ServiceBus.DataPlane",
  "Microsoft.Sql",
  "Microsoft.Storage",
  "Microsoft.Web",
] as const;

/** `Microsoft.EventGrid.DataPlane` -> `eventgrid-dataplane.yaml`. */
export function fileForProvider(provider: string): string {
  return `${provider
    .replace(/^Microsoft\./, "")
    .toLowerCase()
    .replace(/\./g, "-")}.yaml`;
}

/** The answer classes (src/lib/azure/types.ts AzFailureClass). */
export const CLASS_IDS = [
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
  "too-long",
  "timeout",
  "guard-down",
  "bicep-missing",
  "bicep-registry",
  "bicep-env",
  "azcopy",
  "cancelled",
  "spawn-error",
  "other",
];

/** Classes retried once, with the retry logged. */
export const TRANSIENT_CLASSES = new Set(["conn-refused", "discovery", "emulator-error"]);

/** Failures that polling cannot outwait: an `until` step stops at once on them. */
export const DETERMINISTIC_CLASSES = new Set([
  "emulator-error",
  "not-implemented",
  "argument",
  "unknown-command",
  "extension",
  "egress-refused",
  "cli-error",
  "provider",
  "no-route",
]);

export interface Check {
  path?: string;
  equals?: unknown;
  contains?: unknown;
  matches?: string;
  exists?: boolean;
  length?: number;
}

export interface Expect {
  exitCode?: number;
  classId?: string;
  json?: Check | Check[];
  stdout?: Check | Check[];
}

export interface Step {
  run: string;
  /** A name: the trimmed stdout; a map: variable -> JSON path of the step's stdout. */
  capture?: string | Record<string, string>;
  /** Poll the step (every 5 s) until this holds. */
  until?: Expect;
  /** Seconds to poll for `until` (default 180). */
  wait?: number;
}

export interface KnownGap {
  reason: string;
  /** The operations of the case that are the gap (default: all of them). */
  operations?: string[];
  /** When the gap was last seen (YYYY-MM-DD). */
  date?: string;
}

export interface MatrixCase {
  id: string;
  file: string;
  provider: string;
  operations: string[];
  pr: boolean;
  backing: boolean;
  note?: string;
  /** Seconds each step and the command may take before the runner cancels it. */
  timeout?: number;
  setup: Step[];
  command: string;
  expect: Expect;
  cleanup: Step[];
  known_gap?: KnownGap;
}

export interface LoadedMatrix {
  cases: MatrixCase[];
  /** Problems found while loading; the schema test fails on any. */
  problems: string[];
  files: string[];
}

const CASE_KEYS = new Set([
  "id",
  "operations",
  "pr",
  "backing",
  "note",
  "timeout",
  "setup",
  "command",
  "expect",
  "cleanup",
  "known_gap",
]);
const STEP_KEYS = new Set(["run", "capture", "until", "wait"]);
const EXPECT_KEYS = new Set(["exitCode", "classId", "json", "stdout"]);
const CHECK_PREDICATES = ["equals", "contains", "matches", "exists", "length"] as const;
const GAP_KEYS = new Set(["reason", "operations", "date"]);
const OPERATION_KEY = /^(Microsoft\.[A-Za-z]+(?:\.[A-Za-z]+)*) ([A-Za-z0-9_.]+) ([A-Za-z0-9_]+)$/;
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)(?::([a-z0-9-]+))?\}/g;

/** Placeholders every case has; `name` and `alnum` take a kind (`{name:ns}`, `{alnum:acr}`). */
export const BUILTIN_VARS = [
  "id",
  "rg",
  "location",
  "sub",
  "tenant",
  "uuid",
  "storage",
  "vault",
  "container",
  "port",
];
const FAMILY_VARS = new Set(["name", "alnum"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The placeholders of a template: `{rg}` -> {name: "rg"}, `{name:ns}` -> {name, arg}. */
export function placeholdersOf(template: string): Array<{ name: string; arg?: string }> {
  const out: Array<{ name: string; arg?: string }> = [];
  for (const m of template.matchAll(PLACEHOLDER)) out.push({ name: m[1], arg: m[2] });
  return out;
}

export interface Vars {
  id: string;
  values: Record<string, string>;
}

/** The built-in values of one case run (names from the harness, so they respect each provider). */
export function caseVars(
  id: string,
  base: { sub: string; tenant: string; location: string; uuid?: string; port?: number }
): Vars {
  return {
    id,
    values: {
      id,
      rg: names.group(id),
      location: base.location,
      sub: base.sub,
      tenant: base.tenant,
      uuid: base.uuid ?? randomUUID(),
      storage: names.storage(id),
      vault: names.vault(id),
      container: names.container(id),
      // The emulator gateway port, for data-plane hosts the case builds itself.
      port: String(base.port ?? 4566),
    },
  };
}

/** Fill a template's placeholders; an unknown one throws, so a typo never reaches az. */
export function render(template: string, vars: Vars): string {
  return template.replace(PLACEHOLDER, (_m, name: string, arg: string | undefined) => {
    if (name === "name") {
      if (!arg) throw new Error("`{name:<kind>}` needs a kind, e.g. {name:ns}");
      return names.generic(vars.id, arg);
    }
    if (name === "alnum") {
      if (!arg) throw new Error("`{alnum:<kind>}` needs a kind, e.g. {alnum:acr}");
      return `mcp${vars.id}${arg}`.replace(/[^a-z0-9]/g, "").slice(0, 24);
    }
    if (arg !== undefined) throw new Error(`placeholder {${name}:${arg}} takes no kind`);
    const value = vars.values[name];
    if (value === undefined) throw new Error(`unknown placeholder {${name}}`);
    return value;
  });
}

/** Render every string inside a value (the expectation values). */
function renderDeep<T>(value: T, vars: Vars): T {
  if (typeof value === "string") return render(value, vars) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, vars);
    return out as T;
  }
  return value;
}

/**
 * The tiny path resolver of the `json` checks: `a.b[0].c`, `[0].name`, `items[-1]` (the last
 * element); "" or "." is the whole document. No wildcards: narrow with `--query` instead.
 */
export function resolvePath(root: unknown, p: string): { found: boolean; value?: unknown } {
  if (p === "" || p === ".") return { found: true, value: root };
  let current: unknown = root;
  let rest = p;
  let first = true;
  while (rest.length > 0) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\[(-?\d+)\]/))) {
      if (!Array.isArray(current)) return { found: false };
      const index = Number(m[1]);
      const at = index < 0 ? current.length + index : index;
      if (at < 0 || at >= current.length) return { found: false };
      current = current[at];
    } else if ((m = rest.match(first ? /^\.?([^.[\]]+)/ : /^\.([^.[\]]+)/))) {
      if (!isPlainObject(current) || !(m[1] in current)) return { found: false };
      current = current[m[1]];
    } else {
      throw new Error(`bad path "${p}" at "${rest}"`);
    }
    rest = rest.slice(m[0].length);
    first = false;
  }
  return { found: true, value: current };
}

/** True when `p` is a path resolvePath accepts. */
export function isValidPath(p: string): boolean {
  try {
    resolvePath({}, p);
    return true;
  } catch {
    return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Evaluate one check on a resolved value; the problem text, or undefined when it holds. */
export function checkValue(
  found: boolean,
  value: unknown,
  check: Check,
  label: string
): string | undefined {
  const shown = () => (found ? JSON.stringify(value)?.slice(0, 300) : "(missing)");
  if (check.exists !== undefined) {
    return found === check.exists
      ? undefined
      : `${label}: expected ${check.exists ? "a value" : "no value"}, got ${shown()}`;
  }
  if (!found) return `${label}: no value at this path`;
  if (check.equals !== undefined) {
    return deepEqual(value, check.equals)
      ? undefined
      : `${label}: expected ${JSON.stringify(check.equals)}, got ${shown()}`;
  }
  if (check.contains !== undefined) {
    const want = check.contains;
    let ok = false;
    if (typeof value === "string") ok = value.includes(String(want));
    else if (Array.isArray(value)) ok = value.some((el) => deepEqual(el, want));
    else if (isPlainObject(value)) ok = typeof want === "string" && want in value;
    return ok
      ? undefined
      : `${label}: expected it to contain ${JSON.stringify(want)}, got ${shown()}`;
  }
  if (check.matches !== undefined) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return new RegExp(check.matches).test(text)
      ? undefined
      : `${label}: expected it to match /${check.matches}/, got ${shown()}`;
  }
  if (check.length !== undefined) {
    const len = Array.isArray(value) || typeof value === "string" ? value.length : undefined;
    return len === check.length
      ? undefined
      : `${label}: expected length ${check.length}, got ${len === undefined ? shown() : len}`;
  }
  return `${label}: no predicate`;
}

const asList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The problems of an answer against an expectation ([] when it holds). */
export function evaluate(call: AzCall, expect: Expect): string[] {
  const problems: string[] = [];
  const exitCode = expect.exitCode ?? 0;
  if (!call.envelope) {
    problems.push(`the tool answered without running az: ${firstLines(call.text, 4)}`);
    return problems;
  }
  if (call.exitCode !== exitCode) {
    problems.push(
      `exit ${call.exitCode} (${call.classId ?? "no class"}), expected ${exitCode}: ${firstLines(call.text, 6)}`
    );
    return problems;
  }
  if (expect.classId !== undefined && call.classId !== expect.classId) {
    problems.push(`class ${call.classId}, expected ${expect.classId}`);
  }
  const jsonChecks = asList(expect.json);
  if (jsonChecks.length > 0) {
    let doc: unknown;
    let parsed = false;
    try {
      doc = JSON.parse(call.stdout);
      parsed = true;
    } catch {
      problems.push(`stdout is not JSON: ${call.stdout.slice(0, 200)}`);
    }
    if (parsed) {
      for (const check of jsonChecks) {
        const p = check.path ?? "";
        const { found, value } = resolvePath(doc, p);
        const problem = checkValue(found, value, check, `json ${p || "."}`);
        if (problem) problems.push(problem);
      }
    }
  }
  const out = call.stdout.replace(/\r\n/g, "\n").trim();
  for (const check of asList(expect.stdout)) {
    const problem = checkValue(true, out, check, "stdout");
    if (problem) problems.push(problem);
  }
  // What az printed, so a wrong path or value can be fixed from the record alone.
  if (problems.length > 0 && out)
    problems.push(`stdout was: ${out.replace(/\s+/g, " ").slice(0, 400)}`);
  return problems;
}

function firstLines(text: string, n: number): string {
  return text.split("\n").slice(0, n).join(" | ").slice(0, 800);
}

// ---------------------------------------------------------------------------------------------
// Loading and validation

function validateCheck(value: unknown, where: string, withPath: boolean, out: string[]): void {
  for (const check of asList(value)) {
    if (!isPlainObject(check)) {
      out.push(`${where}: a check must be a mapping`);
      continue;
    }
    for (const key of Object.keys(check)) {
      if (key !== "path" && !(CHECK_PREDICATES as readonly string[]).includes(key)) {
        out.push(`${where}: unknown check key "${key}"`);
      }
    }
    if (withPath) {
      if (check.path !== undefined && typeof check.path !== "string") {
        out.push(`${where}: path must be a string`);
      } else if (typeof check.path === "string" && !isValidPath(check.path)) {
        out.push(`${where}: bad path "${check.path}"`);
      }
    } else if (check.path !== undefined) {
      out.push(`${where}: stdout checks take no path`);
    }
    const predicates = CHECK_PREDICATES.filter((k) => check[k] !== undefined);
    if (predicates.length !== 1) {
      out.push(`${where}: exactly one of ${CHECK_PREDICATES.join("/")} (got ${predicates.length})`);
    }
    if (check.matches !== undefined) {
      try {
        new RegExp(String(check.matches));
      } catch {
        out.push(`${where}: matches is not a valid regular expression`);
      }
    }
    if (check.exists !== undefined && typeof check.exists !== "boolean") {
      out.push(`${where}: exists must be true or false`);
    }
    if (check.length !== undefined && !Number.isInteger(check.length)) {
      out.push(`${where}: length must be an integer`);
    }
  }
}

function validateExpect(value: unknown, where: string, out: string[]): void {
  if (!isPlainObject(value)) {
    out.push(`${where}: must be a mapping`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!EXPECT_KEYS.has(key)) out.push(`${where}: unknown key "${key}"`);
  }
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) {
    out.push(`${where}: exitCode must be an integer`);
  }
  if (value.classId !== undefined && !CLASS_IDS.includes(String(value.classId))) {
    out.push(`${where}: unknown classId "${String(value.classId)}"`);
  }
  if (value.json !== undefined) validateCheck(value.json, `${where}.json`, true, out);
  if (value.stdout !== undefined) validateCheck(value.stdout, `${where}.stdout`, false, out);
}

function normalizeStep(raw: unknown, where: string, out: string[]): Step | undefined {
  if (typeof raw === "string") {
    if (!raw.trim()) out.push(`${where}: empty command`);
    return { run: raw };
  }
  if (!isPlainObject(raw)) {
    out.push(`${where}: a step is a command string or a mapping with \`run\``);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.has(key)) out.push(`${where}: unknown step key "${key}"`);
  }
  if (typeof raw.run !== "string" || !raw.run.trim()) {
    out.push(`${where}: \`run\` must be a command string`);
    return undefined;
  }
  const step: Step = { run: raw.run };
  if (raw.capture !== undefined) {
    if (typeof raw.capture === "string") {
      step.capture = raw.capture;
    } else if (isPlainObject(raw.capture)) {
      const capture: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.capture)) {
        if (typeof v !== "string" || !isValidPath(v)) out.push(`${where}: capture ${k}: bad path`);
        else capture[k] = v;
      }
      step.capture = capture;
    } else {
      out.push(`${where}: capture must be a name or a mapping of name -> JSON path`);
    }
  }
  if (raw.until !== undefined) {
    validateExpect(raw.until, `${where}.until`, out);
    step.until = raw.until as Expect;
  }
  if (raw.wait !== undefined) {
    if (!Number.isInteger(raw.wait) || (raw.wait as number) <= 0) {
      out.push(`${where}: wait must be a positive number of seconds`);
    }
    if (raw.until === undefined) out.push(`${where}: wait needs until`);
    step.wait = raw.wait as number;
  }
  return step;
}

/** Names a step captures. */
export function capturedNames(step: Step): string[] {
  if (step.capture === undefined) return [];
  return typeof step.capture === "string" ? [step.capture] : Object.keys(step.capture);
}

/** Every command string of a case, in run order, with its phase. */
export function commandsOf(c: MatrixCase): Array<{ phase: string; command: string }> {
  return [
    ...c.setup.map((s) => ({ phase: "setup", command: s.run })),
    { phase: "command", command: c.command },
    ...c.cleanup.map((s) => ({ phase: "cleanup", command: s.run })),
  ];
}

function validatePlaceholders(c: MatrixCase, where: string, out: string[]): void {
  const known = new Set(BUILTIN_VARS);
  const checkTemplate = (template: string, label: string) => {
    for (const ph of placeholdersOf(template)) {
      if (FAMILY_VARS.has(ph.name)) {
        if (!ph.arg) out.push(`${where} ${label}: {${ph.name}} needs a kind, e.g. {${ph.name}:x}`);
      } else if (ph.arg !== undefined) {
        out.push(`${where} ${label}: {${ph.name}:${ph.arg}} takes no kind`);
      } else if (!known.has(ph.name)) {
        out.push(`${where} ${label}: unknown or not yet captured placeholder {${ph.name}}`);
      }
    }
  };
  c.setup.forEach((step, i) => {
    checkTemplate(step.run, `setup[${i}]`);
    for (const name of capturedNames(step)) {
      if (!/^[a-z][a-z0-9_]*$/.test(name) || known.has(name) || FAMILY_VARS.has(name)) {
        out.push(`${where} setup[${i}]: capture name "${name}" is invalid or taken`);
      }
      known.add(name);
    }
  });
  checkTemplate(c.command, "command");
  c.cleanup.forEach((step, i) => checkTemplate(step.run, `cleanup[${i}]`));
  const strings: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (isPlainObject(v)) Object.values(v).forEach(collect);
  };
  collect(c.expect);
  c.setup.forEach((s) => collect(s.until));
  for (const s of strings) checkTemplate(s, "expect");
}

/** Safety lints: what a case creates, it cleans up. */
function validateCleanup(c: MatrixCase, where: string, out: string[]): void {
  const created = [...c.setup.map((s) => s.run), c.command].join("\n");
  const cleanup = c.cleanup.map((s) => s.run);
  if (/(^|\n)group create --name \{rg\}/.test(created)) {
    if (!cleanup.some((cmd) => /^group delete --name \{rg\} --yes --no-wait$/.test(cmd))) {
      out.push(
        `${where}: creates {rg}, so cleanup needs \`group delete --name {rg} --yes --no-wait\``
      );
    }
  }
  for (const m of created.matchAll(/(?:^|\n)keyvault create --name (\S+)/g)) {
    const vault = m[1];
    const del = cleanup.findIndex((cmd) => cmd.startsWith(`keyvault delete --name ${vault}`));
    const purge = cleanup.findIndex((cmd) => cmd.startsWith(`keyvault purge --name ${vault}`));
    const group = cleanup.findIndex((cmd) => cmd.startsWith("group delete"));
    if (del < 0 || purge < 0 || purge < del || (group >= 0 && group < purge)) {
      out.push(
        `${where}: creates vault ${vault}, so cleanup needs \`keyvault delete --name ${vault}\`, ` +
          `then \`keyvault purge --name ${vault}\`, before the group delete`
      );
    }
  }
  // A lock blocks the group delete, and `lock delete` does not work on the emulator (it lists the
  // subscription's locks), so a created lock is removed through its group-level REST route.
  for (const m of created.matchAll(/(?:^|\n)lock create --name (\S+)/g)) {
    const lock = m[1];
    const del = cleanup.findIndex(
      (cmd) =>
        /^rest --method delete /.test(cmd) &&
        cmd.includes(`/Microsoft.Authorization/locks/${lock}?`)
    );
    const group = cleanup.findIndex((cmd) => cmd.startsWith("group delete"));
    if (del < 0 || (group >= 0 && group < del)) {
      out.push(
        `${where}: creates lock ${lock}, so cleanup needs a \`rest --method delete\` of ` +
          `.../Microsoft.Authorization/locks/${lock}?... before the group delete`
      );
    }
  }
  for (const cmd of cleanup) {
    if (/^group delete/.test(cmd) && !/--no-wait/.test(cmd)) {
      out.push(`${where}: a group delete in cleanup must use --no-wait`);
    }
  }
}

function validateCase(raw: Record<string, unknown>, file: string, provider: string, out: string[]) {
  const id = typeof raw.id === "string" ? raw.id : "(no id)";
  const where = `${file}#${id}`;
  for (const key of Object.keys(raw)) {
    if (!CASE_KEYS.has(key)) out.push(`${where}: unknown key "${key}"`);
  }
  if (typeof raw.id !== "string" || !CASE_ID.test(raw.id)) {
    out.push(`${where}: id must match ${CASE_ID}`);
  }
  const operations: string[] = [];
  if (!Array.isArray(raw.operations)) {
    out.push(`${where}: operations must be a list (may be empty, with a note)`);
  } else {
    for (const op of raw.operations) {
      const m = typeof op === "string" ? op.match(OPERATION_KEY) : null;
      if (!m) {
        out.push(
          `${where}: operation "${String(op)}" is not "<resource_provider> <service> <operation>"`
        );
        continue;
      }
      if (m[1] !== provider) out.push(`${where}: operation "${op}" is not of ${provider}`);
      if (operations.includes(op as string)) out.push(`${where}: operation "${op}" listed twice`);
      operations.push(op as string);
    }
    if (raw.operations.length === 0 && (typeof raw.note !== "string" || !raw.note.trim())) {
      out.push(`${where}: an empty operations list needs a note saying why`);
    }
  }
  for (const flag of ["pr", "backing"]) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") {
      out.push(`${where}: ${flag} must be true or false`);
    }
  }
  if (raw.note !== undefined && typeof raw.note !== "string")
    out.push(`${where}: note must be text`);
  if (
    raw.timeout !== undefined &&
    (!Number.isInteger(raw.timeout) ||
      (raw.timeout as number) < 5 ||
      (raw.timeout as number) > 3600)
  ) {
    out.push(`${where}: timeout must be 5-3600 seconds`);
  }
  if (typeof raw.command !== "string" || !raw.command.trim()) {
    out.push(`${where}: command must be a command string`);
  }
  const steps = (key: "setup" | "cleanup"): Step[] => {
    const value = raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      out.push(`${where}: ${key} must be a list`);
      return [];
    }
    const list: Step[] = [];
    value.forEach((s, i) => {
      const step = normalizeStep(s, `${where} ${key}[${i}]`, out);
      if (step) list.push(step);
    });
    return list;
  };
  const setup = steps("setup");
  const cleanup = steps("cleanup");
  for (const step of cleanup) {
    if (step.capture || step.until) out.push(`${where}: cleanup steps are plain commands`);
  }
  if (raw.expect !== undefined) validateExpect(raw.expect, `${where} expect`, out);
  let knownGap: KnownGap | undefined;
  if (raw.known_gap !== undefined) {
    const gap = raw.known_gap;
    if (!isPlainObject(gap)) {
      out.push(`${where}: known_gap must be a mapping`);
    } else {
      for (const key of Object.keys(gap)) {
        if (!GAP_KEYS.has(key)) out.push(`${where}: unknown known_gap key "${key}"`);
      }
      if (typeof gap.reason !== "string" || !gap.reason.trim()) {
        out.push(`${where}: known_gap needs a reason`);
      }
      if (gap.operations !== undefined) {
        if (!Array.isArray(gap.operations) || gap.operations.length === 0) {
          out.push(`${where}: known_gap.operations must be a non-empty list`);
        } else {
          for (const op of gap.operations) {
            if (!operations.includes(op)) {
              out.push(
                `${where}: known_gap operation "${String(op)}" is not in the case's operations`
              );
            }
          }
        }
      }
      if (gap.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(gap.date))) {
        out.push(`${where}: known_gap.date must be YYYY-MM-DD`);
      }
      knownGap = {
        reason: String(gap.reason ?? ""),
        operations: Array.isArray(gap.operations) ? (gap.operations as string[]) : undefined,
        date: gap.date === undefined ? undefined : String(gap.date),
      };
    }
  }
  const c: MatrixCase = {
    id,
    file,
    provider,
    operations,
    pr: raw.pr === true,
    backing: raw.backing === true,
    note: typeof raw.note === "string" ? raw.note : undefined,
    timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    setup,
    command: typeof raw.command === "string" ? raw.command : "",
    expect: isPlainObject(raw.expect) ? (raw.expect as Expect) : {},
    cleanup,
    known_gap: knownGap,
  };
  if (c.pr && c.known_gap)
    out.push(`${where}: a pr case cannot be a known gap (the PR subset is green)`);
  if (c.pr && c.backing)
    out.push(`${where}: a pr case cannot be backing (the PR subset stays light)`);
  for (const { phase, command } of commandsOf(c)) {
    if (/^\s*az\s/.test(command)) out.push(`${where} ${phase}: drop the leading \`az\``);
    if (/[\r\n]/.test(command)) out.push(`${where} ${phase}: a command is one line`);
  }
  if (
    asList(c.expect.json).length > 0 &&
    /(^|\s)(-o|--output)\s+(tsv|table|none|yaml)\b/.test(c.command)
  ) {
    out.push(`${where}: json checks need JSON output`);
  }
  validatePlaceholders(c, where, out);
  validateCleanup(c, where, out);
  return c;
}

/** Load and validate every matrix file. */
export function loadMatrix(dir: string = MATRIX_DIR): LoadedMatrix {
  const problems: string[] = [];
  const cases: MatrixCase[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  const ids = new Map<string, string>();
  const providers = new Map<string, string>();
  for (const file of files) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(path.join(dir, file), "utf8"));
    } catch (error) {
      problems.push(`${file}: does not parse: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (!isPlainObject(doc)) {
      problems.push(`${file}: must be a mapping with provider and cases`);
      continue;
    }
    for (const key of Object.keys(doc)) {
      if (key !== "provider" && key !== "cases") problems.push(`${file}: unknown key "${key}"`);
    }
    const provider = String(doc.provider ?? "");
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      problems.push(`${file}: provider "${provider}" is not one of the coverage list's providers`);
    } else if (fileForProvider(provider) !== file) {
      problems.push(`${file}: the file for ${provider} is ${fileForProvider(provider)}`);
    }
    if (providers.has(provider))
      problems.push(`${file}: ${provider} already has ${providers.get(provider)}`);
    providers.set(provider, file);
    if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
      problems.push(`${file}: cases must be a non-empty list`);
      continue;
    }
    for (const raw of doc.cases) {
      if (!isPlainObject(raw)) {
        problems.push(`${file}: every case must be a mapping`);
        continue;
      }
      const c = validateCase(raw, file, provider, problems);
      if (ids.has(c.id)) problems.push(`${file}#${c.id}: id already used in ${ids.get(c.id)}`);
      ids.set(c.id, file);
      cases.push(c);
    }
  }
  return { cases, problems, files };
}

// ---------------------------------------------------------------------------------------------
// Selection and sharding

export interface Selection {
  /** Cases this run executes, in order. */
  run: MatrixCase[];
  /** Cases of this shard that are skipped, with the reason (recorded, never silent). */
  skipped: Array<{ c: MatrixCase; reason: string }>;
}

export interface SelectOptions {
  matrix: "pr" | "full";
  backing: boolean;
  gaps: "run" | "skip";
  shard?: { index: number; total: number };
  only?: string[];
}

/** `2/4` -> {index: 2, total: 4}; undefined when unset. */
export function parseShard(
  value: string | undefined
): { index: number; total: number } | undefined {
  if (!value) return undefined;
  const m = value.match(/^(\d+)\/(\d+)$/);
  const index = m ? Number(m[1]) : NaN;
  const total = m ? Number(m[2]) : NaN;
  if (!m || total < 1 || index < 1 || index > total) {
    throw new Error(`AZURE_MATRIX_SHARD must be i/n with 1 <= i <= n, got "${value}"`);
  }
  return { index, total };
}

/** A case's share of a shard's time: backing cases start side-car containers. */
export const caseWeight = (c: MatrixCase): number => (c.backing ? 5 : 1);

/**
 * Deterministic longest-processing-time split: heaviest first, each case to the lightest shard
 * (ties to the lowest index); cases keep their file order inside a shard.
 */
export function shardCases(cases: MatrixCase[], total: number): MatrixCase[][] {
  const order = cases.map((c, i) => ({ c, i }));
  order.sort((a, b) => caseWeight(b.c) - caseWeight(a.c) || a.c.id.localeCompare(b.c.id));
  const load = new Array<number>(total).fill(0);
  const assigned: Array<Array<{ c: MatrixCase; i: number }>> = Array.from(
    { length: total },
    () => []
  );
  for (const entry of order) {
    let best = 0;
    for (let s = 1; s < total; s++) if (load[s] < load[best]) best = s;
    assigned[best].push(entry);
    load[best] += caseWeight(entry.c);
  }
  return assigned.map((list) => list.sort((a, b) => a.i - b.i).map((e) => e.c));
}

/** The cases of a subset; `pr` is a filter of `full`, so every pr case is in the full run. */
export function subsetCases(cases: MatrixCase[], matrix: "pr" | "full"): MatrixCase[] {
  return matrix === "pr" ? cases.filter((c) => c.pr) : cases.slice();
}

export function selectCases(cases: MatrixCase[], opts: SelectOptions): Selection {
  let pool = subsetCases(cases, opts.matrix);
  // `only` names case ids or file stems (`storage` selects storage.yaml).
  if (opts.only && opts.only.length > 0) {
    const only = new Set(opts.only);
    pool = pool.filter((c) => only.has(c.id) || only.has(c.file.replace(/\.yaml$/, "")));
  }
  if (opts.shard && opts.shard.total > 1) {
    pool = shardCases(pool, opts.shard.total)[opts.shard.index - 1];
  }
  const selection: Selection = { run: [], skipped: [] };
  for (const c of pool) {
    if (c.backing && !opts.backing)
      selection.skipped.push({ c, reason: "backing (set AZURE_MATRIX_BACKING=1)" });
    else if (c.known_gap && opts.gaps === "skip")
      selection.skipped.push({ c, reason: "known gap (AZURE_MATRIX_GAPS=skip)" });
    else selection.run.push(c);
  }
  return selection;
}

/** The curated extensions a command needs, from the extension map (longest command prefix). */
export function extensionsFor(command: string): string[] {
  const words: string[] = [];
  for (const token of command.trim().split(/\s+/)) {
    if (!/^[a-z][a-z0-9-]*$/.test(token)) break;
    words.push(token);
  }
  let best: { ext: string; len: number } | undefined;
  for (const [ext, groups] of Object.entries(EXTENSION_COMMANDS)) {
    for (const group of groups) {
      const g = group.split(" ");
      if (g.length <= words.length && g.every((w, i) => words[i] === w)) {
        if (!best || g.length > best.len) best = { ext, len: g.length };
      }
    }
  }
  return best ? [best.ext] : [];
}

export function caseExtensions(c: MatrixCase): string[] {
  const set = new Set<string>();
  for (const { command } of commandsOf(c)) for (const ext of extensionsFor(command)) set.add(ext);
  return [...set].sort();
}

// ---------------------------------------------------------------------------------------------
// The live run

type ResultKind = "pass" | "fail" | "setup_failed" | "known_gap" | "gap_fixed" | "skipped";

interface StepRecord {
  phase: string;
  command: string;
  exitCode: number | null;
  classId: string | null;
  ms: number;
  retried?: boolean;
}

interface CaseRecord {
  at: string;
  run: string;
  matrix: string;
  shard: string;
  file: string;
  id: string;
  operations: string[];
  pr: boolean;
  backing: boolean;
  knownGap: boolean;
  result: ResultKind;
  reason?: string;
  classId?: string | null;
  exitCode?: number | null;
  ms?: number;
  problems?: string[];
  steps?: StepRecord[];
  extensions?: string[];
  egress?: { refused: string[]; housekeeping: string[]; upstream: string[] };
}

interface CatalogueEntry {
  case: string;
  file: string;
  command: string;
  result: ResultKind;
  classId: string | null;
  gap: boolean;
  checked: string;
}

const RESULT_RANK: Record<ResultKind, number> = {
  pass: 6,
  gap_fixed: 5,
  known_gap: 4,
  fail: 3,
  setup_failed: 2,
  skipped: 1,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

class SetupError extends Error {}

interface RunContext {
  run: string;
  matrix: string;
  shard: string;
  sub: string;
  tenant: string;
  location: string;
  port: number;
  resultsPath: string;
  cataloguePath: string;
  catalogue: Map<string, CatalogueEntry[]>;
  implemented?: Map<string, boolean>;
  egress?: EgressLog;
  /** Egress event index ranges [from, to) of known-gap cases: their refusals are documented. */
  gapEgressRanges: Array<[number, number]>;
  installedExtensions: Set<string>;
  backing: boolean;
}

function appendRecord(ctx: RunContext, record: CaseRecord): void {
  mkdirSync(path.dirname(ctx.resultsPath), { recursive: true });
  appendFileSync(ctx.resultsPath, JSON.stringify(record) + "\n");
}

function writeCatalogue(ctx: RunContext): void {
  const operations: Record<string, unknown> = {};
  const summary: Record<string, number> = { operations: 0 };
  for (const key of [...ctx.catalogue.keys()].sort()) {
    const entries = ctx.catalogue.get(key)!;
    const best = entries.reduce((a, b) => (RESULT_RANK[b.result] > RESULT_RANK[a.result] ? b : a));
    const verified = entries.find((e) => e.result === "pass" || e.result === "gap_fixed");
    operations[key] = {
      implemented: ctx.implemented?.get(key) ?? null,
      result: best.result,
      verified: verified ? verified.checked : null,
      command: (verified ?? best).command,
      cases: entries,
    };
    summary.operations++;
    summary[best.result] = (summary[best.result] ?? 0) + 1;
  }
  mkdirSync(path.dirname(ctx.cataloguePath), { recursive: true });
  writeFileSync(
    ctx.cataloguePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        run: ctx.run,
        matrix: ctx.matrix,
        shard: ctx.shard,
        backing: ctx.backing,
        coverageChecked: Boolean(ctx.implemented),
        extensionsInstalled: [...ctx.installedExtensions].sort(),
        summary,
        operations,
      },
      null,
      2
    ) + "\n"
  );
}

function catalogue(ctx: RunContext, c: MatrixCase, result: ResultKind, classId: string | null) {
  const gapOps = new Set(c.known_gap ? (c.known_gap.operations ?? c.operations) : []);
  for (const op of c.operations) {
    const list = ctx.catalogue.get(op) ?? [];
    list.push({
      case: c.id,
      file: c.file,
      command: c.command,
      result,
      classId,
      gap: gapOps.has(op),
      checked: today(),
    });
    ctx.catalogue.set(op, list);
  }
  writeCatalogue(ctx);
}

/** One call with the case's timeout, retried once on a transient class. */
async function call(
  command: string,
  timeoutSeconds?: number
): Promise<{ call: AzCall; retried: boolean }> {
  const once = async () => {
    if (!timeoutSeconds) return az(command);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      return await az(command, { signal: controller.signal } as never);
    } finally {
      clearTimeout(timer);
    }
  };
  // The readiness window: the tool's health preflight got no answer in time, so az never ran.
  // A busy emulator stops answering its health check for 20-40 s at a time (seen 2026-09-27),
  // so this waits with backoff (about 65 s in all); az has not run, so nothing runs twice.
  const notReady = (res: AzCall) =>
    !res.envelope && /Emulator Not Ready/.test(res.text.split("\n")[0]);
  let res = await once();
  let retried = false;
  for (const delay of [5_000, 10_000, 20_000, 30_000]) {
    if (!notReady(res)) break;
    process.stderr.write(
      `[matrix] emulator not ready, retrying in ${delay / 1000} s: az ${command}\n`
    );
    await sleep(delay);
    res = await once();
    retried = true;
  }
  if (retried) return { call: res, retried };
  // A transient class after az ran: one retry, logged in the step record.
  if (res.envelope && res.exitCode !== 0 && TRANSIENT_CLASSES.has(res.classId ?? "")) {
    process.stderr.write(`[matrix] retrying once after ${res.classId}: az ${command}\n`);
    await sleep(5_000);
    return { call: await once(), retried: true };
  }
  return { call: res, retried: false };
}

/**
 * The values a step captures from az's stdout. An empty value fails the step: acr-run once
 * captured nothing and then "passed" against a URL with an empty run id.
 */
export function capturedValues(step: Step, stdout: string): Record<string, string> {
  if (step.capture === undefined) return {};
  if (typeof step.capture === "string") {
    const value = stdout.replace(/\r\n/g, "\n").trim();
    if (!value) throw new SetupError(`capture ${step.capture}: az printed nothing to capture`);
    return { [step.capture]: value };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new SetupError(`capture: stdout is not JSON: ${stdout.slice(0, 200)}`);
  }
  const values: Record<string, string> = {};
  for (const [name, p] of Object.entries(step.capture)) {
    const { found, value } = resolvePath(doc, p);
    if (!found) throw new SetupError(`capture ${name}: nothing at ${p}`);
    if (value === null || value === "")
      throw new SetupError(`capture ${name}: empty value at ${p}`);
    values[name] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return values;
}

function capture(step: Step, result: AzCall, vars: Vars): void {
  Object.assign(vars.values, capturedValues(step, result.stdout));
}

/** Wait until nothing in the group is still being created, so side-cars are not leaked. */
async function settle(rg: string, backing: boolean, steps: StepRecord[]): Promise<void> {
  if (backing) await sleep(10_000);
  const query =
    "[?provisioningState && provisioningState!='Succeeded' && provisioningState!='Failed' && provisioningState!='Canceled'].id";
  const deadline = Date.now() + (backing ? 180_000 : 60_000);
  for (;;) {
    const started = Date.now();
    const { call: res } = await call(
      `resource list --resource-group ${rg} --query "${query}" -o tsv`
    );
    steps.push({
      phase: "settle",
      command: "resource list",
      exitCode: res.exitCode,
      classId: res.classId,
      ms: Date.now() - started,
    });
    if (res.exitCode !== 0 || res.stdout.trim() === "" || Date.now() > deadline) return;
    await sleep(5_000);
  }
}

async function runCase(ctx: RunContext, c: MatrixCase): Promise<void> {
  const started = Date.now();
  const id = runId();
  const vars = caseVars(id, ctx);
  const steps: StepRecord[] = [];
  const egressFrom = ctx.egress?.events.length ?? 0;
  const record: CaseRecord = {
    at: new Date().toISOString(),
    run: ctx.run,
    matrix: ctx.matrix,
    shard: ctx.shard,
    file: c.file,
    id: c.id,
    operations: c.operations,
    pr: c.pr,
    backing: c.backing,
    knownGap: Boolean(c.known_gap),
    result: "fail",
    extensions: caseExtensions(c),
  };

  const usesGroup = commandsOf(c).some(({ command }) => command.includes("{rg}"));
  let problems: string[] = [];
  let failure: string | undefined;
  let commandCall: AzCall | undefined;
  let setupFailed = false;
  let phase: "setup" | "command" = "setup";
  try {
    for (const [i, step] of c.setup.entries()) {
      const command = render(step.run, vars);
      const deadline = Date.now() + (step.wait ?? 180) * 1000;
      for (;;) {
        const t = Date.now();
        const { call: res, retried } = await call(command, c.timeout);
        steps.push({
          phase: `setup[${i}]`,
          command,
          exitCode: res.exitCode,
          classId: res.classId,
          ms: Date.now() - t,
          retried,
        });
        const stepProblems = evaluate(res, renderDeep(step.until ?? {}, vars));
        if (stepProblems.length === 0) {
          capture(step, res, vars);
          break;
        }
        const hopeless = res.exitCode !== 0 && DETERMINISTIC_CLASSES.has(res.classId ?? "");
        if (!step.until || hopeless || Date.now() > deadline) {
          throw new SetupError(`setup[${i}] \`${command}\`: ${stepProblems.join("; ")}`);
        }
        await sleep(5_000);
      }
    }
    phase = "command";
    const command = render(c.command, vars);
    const t = Date.now();
    const { call: res, retried } = await call(command, c.timeout);
    commandCall = res;
    steps.push({
      phase: "command",
      command,
      exitCode: res.exitCode,
      classId: res.classId,
      ms: Date.now() - t,
      retried,
    });
    problems = evaluate(res, renderDeep(c.expect, vars));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    // Anything that breaks before the command runs is a setup failure, never the gap itself.
    setupFailed = phase === "setup";
    if (!setupFailed) problems = [failure];
  } finally {
    try {
      if (usesGroup) await settle(vars.values.rg, c.backing, steps);
    } catch {
      // never fail a case on the settle poll
    }
    for (const step of c.cleanup) {
      let command = step.run;
      try {
        command = render(step.run, vars);
        const t = Date.now();
        const { call: res, retried } = await call(command);
        steps.push({
          phase: "cleanup",
          command,
          exitCode: res.exitCode,
          classId: res.classId,
          ms: Date.now() - t,
          retried,
        });
      } catch {
        steps.push({ phase: "cleanup", command, exitCode: null, classId: "runner-error", ms: 0 });
      }
    }
  }

  // A curated extension that is not installed (az: "misspelled or not recognized", class
  // `extension`): a recorded skip on a developer machine, a failure in CI, which installs them.
  const missingExtension = steps.some(
    (s) => s.classId === "extension" && !s.phase.startsWith("cleanup")
  );
  if (missingExtension && !process.env.CI) {
    record.result = "skipped";
    record.reason = `a curated extension is not installed (${(record.extensions ?? []).join(", ") || "see the steps"})`;
  } else if (setupFailed) record.result = "setup_failed";
  else if (problems.length > 0) record.result = c.known_gap ? "known_gap" : "fail";
  else record.result = c.known_gap ? "gap_fixed" : "pass";
  record.classId = commandCall?.classId ?? null;
  record.exitCode = commandCall?.exitCode ?? null;
  record.ms = Date.now() - started;
  record.steps = steps;
  if (problems.length > 0) record.problems = problems.map((p) => p.slice(0, 600));
  if (setupFailed) record.reason = failure?.slice(0, 800);
  if (ctx.egress) {
    const events = ctx.egress.events.slice(egressFrom);
    const hosts = (kind: string) => [
      ...new Set(events.filter((e) => e.kind === kind).map((e) => e.host)),
    ];
    record.egress = {
      refused: hosts("refused"),
      housekeeping: hosts("housekeeping"),
      upstream: hosts("upstream"),
    };
    // A known gap's refusal is its documented failure (e.g. a command whose endpoint the tool's
    // cloud does not map); the egress gate counts only the refusals of the other cases.
    if (record.result === "known_gap")
      ctx.gapEgressRanges.push([egressFrom, ctx.egress.events.length]);
  }
  appendRecord(ctx, record);
  catalogue(ctx, c, record.result, record.classId ?? null);
  process.stderr.write(
    `[matrix] ${record.result.toUpperCase()} ${c.file}#${c.id} (${Math.round(record.ms / 1000)} s)` +
      `${record.classId ? ` class=${record.classId}` : ""}\n`
  );

  if (record.result === "setup_failed") throw new Error(`setup failed: ${failure}`);
  if (record.result === "fail") throw new Error(problems.join("\n"));
  if (record.result === "gap_fixed") {
    throw new Error(
      `known gap no longer reproduces: ${c.file}#${c.id} passed. Remove its known_gap ` +
        `(reason: ${c.known_gap?.reason.slice(0, 200)})`
    );
  }
}

/** Command lines of running processes that contain `marker` (read-only; never used to kill). */
export async function processesWith(marker: string): Promise<string[]> {
  if (process.platform === "linux") {
    const out: string[] = [];
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        if (cmdline.includes(marker)) out.push(`${pid} ${cmdline}`);
      } catch {
        // the process ended while listing
      }
    }
    return out;
  }
  const [file, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
        ]
      : ["ps", ["-axww", "-o", "pid=,command="]];
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      file,
      args,
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, out) => (err ? reject(err) : resolve(out))
    )
  );
  return stdout.split(/\r?\n/).filter((line) => line.includes(marker));
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await fn();
  while (!done(value) && Date.now() < deadline) {
    await sleep(1_000);
    value = await fn();
  }
  return value;
}

function registerLiveTests(): void {
  const matrix = (process.env.AZURE_MATRIX === "full" ? "full" : "pr") as "pr" | "full";
  const shard = parseShard(process.env.AZURE_MATRIX_SHARD);
  const loaded = loadMatrix();
  const selection = selectCases(loaded.cases, {
    matrix,
    backing: process.env.AZURE_MATRIX_BACKING === "1",
    gaps: process.env.AZURE_MATRIX_GAPS === "skip" ? "skip" : "run",
    shard,
    only: process.env.AZURE_MATRIX_ONLY?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  const firstShard = !shard || shard.index === 1;
  const onlyMode = Boolean(process.env.AZURE_MATRIX_ONLY);
  const shardLabel = shard ? `${shard.index}/${shard.total}` : "1/1";

  describeLive(`L2 command matrix (AZURE_MATRIX=${matrix}, shard ${shardLabel})`, () => {
    const ctx: RunContext = {
      run: runId(),
      matrix,
      shard: shardLabel,
      sub: "",
      tenant: "",
      location: process.env.AZURE_MATRIX_LOCATION || "westeurope",
      port: 4566,
      resultsPath: path.resolve(
        process.env.AZURE_MATRIX_RESULTS || "test-results/azure-matrix.jsonl"
      ),
      cataloguePath: path.resolve(
        process.env.AZURE_OP_CATALOGUE_OUT || "test-results/azure-op-catalogue.json"
      ),
      catalogue: new Map(),
      gapEgressRanges: [],
      installedExtensions: new Set(),
      backing: process.env.AZURE_MATRIX_BACKING === "1",
    };

    beforeAll(async () => {
      if (loaded.problems.length > 0) {
        throw new Error(`the matrix does not validate:\n${loaded.problems.join("\n")}`);
      }
      const env = setupLiveEnv();
      // The workdir holds the Bicep fixtures and a small file for the upload cases.
      mkdirSync(path.join(env.workdir, "bicep"), { recursive: true });
      for (const f of readdirSync(BICEP_FIXTURES).filter((n) => n.endsWith(".bicep"))) {
        copyFileSync(path.join(BICEP_FIXTURES, f), path.join(env.workdir, "bicep", f));
      }
      writeFileSync(path.join(env.workdir, "hello.txt"), "hello from the L2 matrix\n");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const services =
        require("../../src/lib/azure/services") as typeof import("../../src/lib/azure/services");
      ctx.installedExtensions = listInstalledExtensions(services.azureConfig().extensionDir);
      ctx.egress = await recordEgress();
      // The subscription and tenant, and the first call bootstraps the tool's CLI profile.
      const { call: account } = await call("account show -o json");
      process.stderr.write(`[matrix] account show (with the bootstrap): ${account.ms} ms\n`);
      if (account.exitCode !== 0)
        throw new Error(`account show failed:\n${account.text.slice(0, 2000)}`);
      const info = JSON.parse(account.stdout) as { id: string; tenantId: string };
      ctx.sub = info.id;
      ctx.tenant = info.tenantId;
      // The emulator's coverage list, read through the tool (a local URL the policy allows).
      const port = services.azureConfig().port;
      ctx.port = port;
      const { call: coverage } = await call(
        `rest --method get --url http://127.0.0.1:${port}/_localstack/coverage`
      );
      process.stderr.write(
        `[matrix] coverage list: exit ${coverage.exitCode}, ${coverage.ms} ms\n`
      );
      if (coverage.exitCode === 0) {
        try {
          const list = JSON.parse(coverage.stdout) as Array<{
            resource_provider: string;
            service: string;
            operation: string;
            implemented: boolean;
          }>;
          ctx.implemented = new Map(
            list.map((e) => [`${e.resource_provider} ${e.service} ${e.operation}`, e.implemented])
          );
        } catch {
          ctx.implemented = undefined;
        }
      }
      for (const { c, reason } of selection.skipped) {
        appendRecord(ctx, {
          at: new Date().toISOString(),
          run: ctx.run,
          matrix,
          shard: shardLabel,
          file: c.file,
          id: c.id,
          operations: c.operations,
          pr: c.pr,
          backing: c.backing,
          knownGap: Boolean(c.known_gap),
          result: "skipped",
          reason,
        });
        catalogue(ctx, c, "skipped", null);
      }
      process.stderr.write(
        `[matrix] run ${ctx.run}: ${selection.run.length} cases, ${selection.skipped.length} skipped; ` +
          `results -> ${ctx.resultsPath}\n`
      );
    }, 600_000);

    // The shared teardown (tests/azure/live/teardown.ts) closes the egress guard afterwards.
    afterAll(() => {
      ctx.egress?.stop();
      writeCatalogue(ctx);
    });

    for (const c of selection.run) {
      const title = `${c.file.replace(/\.yaml$/, "")}/${c.id}${c.known_gap ? " [known gap]" : ""}`;
      test(title, () => runCase(ctx, c), c.backing ? 1_800_000 : 900_000);
    }
    for (const { c, reason } of selection.skipped) {
      test.skip(`${c.file.replace(/\.yaml$/, "")}/${c.id} (${reason})`, () => undefined);
    }

    if (firstShard && !onlyMode) {
      test("operation keys are in the emulator's coverage list", () => {
        if (!ctx.implemented) {
          process.stderr.write(
            "[matrix] coverage list not readable through the tool; key check skipped\n"
          );
          return;
        }
        const unknown = [...new Set(loaded.cases.flatMap((c) => c.operations))].filter(
          (op) => !ctx.implemented!.has(op)
        );
        if (unknown.length > 0 && matrix === "full") {
          throw new Error(
            `operation keys missing from /_localstack/coverage:\n${unknown.join("\n")}`
          );
        }
        if (unknown.length > 0)
          process.stderr.write(`[matrix] unknown keys: ${unknown.join(", ")}\n`);
      });

      // Task 2.12, live: a client cancel reaches the runner and kills the az tree.
      test("cancel: an aborted in-flight command answers `cancelled` and leaves nothing running", async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const runner =
          require("../../src/lib/azure/runner") as typeof import("../../src/lib/azure/runner");
        const marker = names.generic(runId(), "never");
        // With the warm worker the command runs inside a long-lived Python process: the
        // marker is in its stdin, not in any command line, and idle workers stay alive by design.
        // So there only the answer is checked here; worker-runner.test.ts covers the kill.
        const workerMode = process.env.LOCALSTACK_AZ_RUNNER === "worker";
        const controller = new AbortController();
        const started = Date.now();
        const pending = az(`group wait --created --name ${marker} --timeout 120 --interval 5`, {
          signal: controller.signal,
        } as never);
        // The probe must see the live az first, or an empty listing afterwards would prove nothing.
        const before = workerMode
          ? []
          : await pollUntil(
              () => processesWith(marker),
              (l) => l.length > 0,
              90_000
            );
        await sleep(workerMode ? 5_000 : 2_000);
        controller.abort();
        const answer = await pending;
        const after = workerMode
          ? []
          : await pollUntil(
              () => processesWith(marker),
              (l) => l.length === 0,
              30_000
            );
        const record = {
          at: new Date().toISOString(),
          run: ctx.run,
          id: "cancel-in-flight",
          result: answer.classId === "cancelled" && after.length === 0 ? "pass" : "fail",
          classId: answer.classId,
          stoppedByTool: answer.envelope?.stoppedByTool ?? null,
          firstLine: answer.text.split("\n")[0],
          ms: Date.now() - started,
          processesBefore: before.length,
          processesAfter: after.length,
          liveChildren: runner.liveChildCount(),
        };
        mkdirSync(path.dirname(ctx.resultsPath), { recursive: true });
        appendFileSync(ctx.resultsPath, JSON.stringify(record) + "\n");
        if (!workerMode) expect(before.length).toBeGreaterThan(0);
        expect(answer.ok).toBe(false);
        expect(answer.classId).toBe("cancelled");
        // The envelope says the tool ended az, so its exit code is not az's own.
        expect(answer.envelope?.stoppedByTool).toBe(true);
        expect(Date.now() - started).toBeLessThan(110_000);
        if (!workerMode) {
          expect(runner.liveChildCount()).toBe(0);
          expect(after).toEqual([]);
        }
      }, 300_000);
    }

    // L3 (a): refused hosts fail the run, except inside a known-gap case, whose refusal is its
    // documented failure; housekeeping ones only when they are app.aladdin (a regression of the
    // bootstrap's core.error_recommendation=off).
    test("egress: no unexpected refusals during the matrix", () => {
      if (!ctx.egress) {
        process.stderr.write("[matrix] egress guard off; nothing recorded\n");
        return;
      }
      const inGap = (i: number) => ctx.gapEgressRanges.some(([from, to]) => i >= from && i < to);
      const refusedEvents = ctx.egress.events.filter((e) => e.kind === "refused");
      const refused = [
        ...new Set(
          ctx.egress.events
            .map((e, i) => ({ e, i }))
            .filter(({ e, i }) => e.kind === "refused" && !inGap(i))
            .map(({ e }) => e.host)
        ),
      ];
      const inKnownGaps = [...new Set(refusedEvents.map((e) => e.host))].filter(
        (h) => !refused.includes(h)
      );
      const aladdin = ctx.egress.events.some(
        (e) => e.kind === "housekeeping" && e.host.toLowerCase() === "app.aladdin.microsoft.com"
      );
      mkdirSync(path.dirname(ctx.resultsPath), { recursive: true });
      appendFileSync(
        ctx.resultsPath,
        JSON.stringify({
          at: new Date().toISOString(),
          run: ctx.run,
          id: "egress-summary",
          refused,
          refusedInKnownGaps: inKnownGaps,
          aladdin,
          housekeeping: [
            ...new Set(
              ctx.egress.events.filter((e) => e.kind === "housekeeping").map((e) => e.host)
            ),
          ],
          allowed: ctx.egress.events.filter((e) => e.kind === "allowed").length,
        }) + "\n"
      );
      expect(refused).toEqual([]);
      expect(aladdin).toBe(false);
    });
  });
}

/** True when Jest runs this file itself (and not the schema test importing its model). */
function runningThisFile(): boolean {
  const testPath = (expect.getState() as { testPath?: string }).testPath;
  if (!testPath) return false;
  const norm = (p: string) =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(testPath) === norm(__filename);
}

if (runningThisFile()) {
  // Before the tool module loads: it reads its configuration once per process.
  if (LIVE) setupLiveEnv();
  registerLiveTests();
}
