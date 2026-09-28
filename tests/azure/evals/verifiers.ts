/**
 * The E2 verifier and fixture library: a port of the benchmark's harness/verifiers.py and
 * the helpers of harness/tasks.py (the CLI-vs-REST MCP benchmark's harness).
 *
 * Every verifier reads the outcome from the emulator at verification time, never from the
 * agent's report, through a `Query`: in a run that is a server session of the harness's
 * own (never the agent's), in the unit tests recorded answers with a fake clock. The seven
 * verifier defects the benchmark found after data collection (research file 19; the fixes
 * in benchmark/report/rescore.py) are fixed here: see `affirmedRights` (1),
 * `validationVerdict` (2), `untaggedVerdicts` (3), `hostOf` (4), `hostVerdicts` (5),
 * `membershipVerdicts` (6) and `tenantAccessVerdict` (7).
 *
 * Loaded unbundled by run.mjs through Node's type stripping, so this module has no runtime
 * import of another local module and no TypeScript syntax that needs a transform (no
 * enums, namespaces or parameter properties). The task modules get it as a parameter.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AzAnswer, Query, SetupContext, Slots, StepResult, Verdict, Verify } from "./types";

export const SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";
export const LOCATION = "westeurope";

// ── Python-compatible formatting ────────────────────────────────────────────

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python's str() for JSON values: True/False/None, as the benchmark compared them. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** Python's json.dumps() layout (", " and ": " separators, ASCII only). */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") {
    return JSON.stringify(v).replace(
      /[\u007f-\uffff]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
    );
  }
  if (Array.isArray(v)) return "[" + v.map(pyJson).join(", ") + "]";
  if (isDict(v)) {
    return (
      "{" +
      Object.entries(v)
        .map(([k, x]) => `${pyJson(k)}: ${pyJson(x)}`)
        .join(", ") +
      "}"
    );
  }
  return JSON.stringify(v);
}

/**
 * Python's str.format for `{name}` fields, with `{{` and `}}` as literal braces. An unknown
 * name throws, as Python's KeyError did.
 */
export function fmt(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    if (!(name in values)) throw new Error(`no value for {${name}} in: ${template.slice(0, 120)}`);
    return pyStr(values[name]);
  });
}

/** A path or command template filled with the subscription and the slots. */
export function fill(template: string, slots: Slots): string {
  return fmt(template, { sub: SUBSCRIPTION, ...slots });
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** The benchmark's _norm_text: no whitespace, underscores or hyphens; lower case. */
export function normText(s: unknown): string {
  return pyStr(s)
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
}

const SELECT = /^(\w*)\[(\w+)=([^\]]*)\]$/;

/**
 * A dotted path into a JSON body (the benchmark's _dotted). A numeric part indexes a list
 * (`containers.0.image`); `name[field=value]` picks the list element whose field equals
 * value (`keys[keyName=key1].value`). Missing parts give null, as Python's None.
 */
export function dotted(body: unknown, key: string): unknown {
  let cur: unknown = body;
  for (const part of key.split(".")) {
    const m = SELECT.exec(part);
    if (m) {
      if (m[1]) cur = isDict(cur) ? (cur[m[1]] ?? null) : null;
      cur = Array.isArray(cur)
        ? (cur.find((e) => isDict(e) && pyStr(e[m[2]]) === m[3]) ?? null)
        : null;
    } else if (Array.isArray(cur) && /^\d+$/.test(part)) {
      const i = Number(part);
      cur = i < cur.length ? cur[i] : null;
    } else if (isDict(cur)) {
      cur = part in cur ? (cur[part] ?? null) : null;
    } else {
      return null;
    }
  }
  return cur === undefined ? null : cur;
}

export function parseJson(text: string | undefined): unknown {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── base64 and random helpers ────────────────────────────────────────────────

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

export function b64std(data: Buffer | string): string {
  return Buffer.from(data).toString("base64");
}

/** Standard base64 with padding, from base64 or base64url (padded or not). */
export function toStdB64(value: string): string {
  const s = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

/** base64url without padding, from base64 or base64url. */
export function toB64url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function hex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString("hex")
    .slice(0, chars);
}

/** The context a task's setup runs with (the benchmark's builders and setup steps). */
export function makeSetupContext(q: Query, slots: Slots, rg: string): SetupContext {
  const random = () => Math.random();
  const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  return {
    q,
    slots,
    rg,
    name: (prefix: string) => `${prefix}${hex(6)}`,
    hex,
    uuid: () => randomUUID(),
    pick: <T>(options: readonly T[]) => options[Math.floor(random() * options.length)],
    sample: <T>(options: readonly T[], count: number) => {
      const pool = [...options];
      const out: T[] = [];
      while (out.length < count && pool.length > 0) {
        out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
      }
      return out;
    },
    randomInt,
    random,
  };
}

// ── ARM requests through `az rest` ───────────────────────────────────────────

const REASONS: Record<string, number> = {
  "BAD REQUEST": 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  "NOT FOUND": 404,
  "METHOD NOT ALLOWED": 405,
  CONFLICT: 409,
  GONE: 410,
  "PRECONDITION FAILED": 412,
  "UNPROCESSABLE ENTITY": 422,
  "TOO MANY REQUESTS": 429,
  "INTERNAL SERVER ERROR": 500,
  "NOT IMPLEMENTED": 501,
  "BAD GATEWAY": 502,
  "SERVICE UNAVAILABLE": 503,
  "GATEWAY TIMEOUT": 504,
};

/**
 * The HTTP status behind an `az rest` answer. az exits 0 on 2xx and prints
 * `ERROR: <REASON>(<body>)` otherwise (the emulator's reason phrases are upper case,
 * `NOT FOUND`); 0 means the command itself failed before any HTTP answer.
 */
export function httpStatus(a: AzAnswer): number {
  if (a.exitCode === 0 && !a.stoppedByTool) return 200;
  const m = /^ERROR: ([A-Za-z][A-Za-z ]*?)\s*\(/m.exec(a.stderr || "");
  if (m) {
    const code = REASONS[m[1].toUpperCase()];
    if (code) return code;
  }
  if (a.classId === "not-found") return 404;
  if (a.classId === "not-implemented") return 501;
  return 0;
}

export interface ArmResponse {
  status: number;
  body: unknown;
  answer: AzAnswer;
}

/** A JSON body for `--body '...'`; single quotes cannot travel inside it. */
export function jsonArg(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.includes("'"))
    throw new Error(`a request body cannot contain a single quote: ${text.slice(0, 80)}`);
  return text;
}

export function restCommand(method: string, path: string, api?: string, body?: unknown): string {
  const url = api ? `${path}${path.includes("?") ? "&" : "?"}api-version=${api}` : path;
  let cmd = `rest --method ${method.toLowerCase()} --url "${url}"`;
  if (body !== undefined) cmd += ` --body '${jsonArg(body)}'`;
  return cmd;
}

/** An ARM request (a relative path, as the tool rewrites it onto the emulator). */
export async function arm(
  q: Query,
  method: string,
  path: string,
  api?: string,
  body?: unknown
): Promise<ArmResponse> {
  const answer = await q.az(restCommand(method, path, api, body));
  return { status: httpStatus(answer), body: parseJson(answer.stdout), answer };
}

/** properties.provisioningState, when the body has one. */
export function provisioningState(body: unknown): string | null {
  const props = isDict(body) ? body.properties : null;
  const state = isDict(props) ? props.provisioningState : null;
  return typeof state === "string" ? state : null;
}

const TERMINAL = new Set(["Succeeded", "Failed", "Canceled"]);

/** Poll until GET is 200 and any provisioningState is terminal, or the deadline passes. */
export async function waitReady(
  q: Query,
  path: string,
  api: string,
  timeoutS?: number,
  intervalMs = 500
): Promise<ArmResponse> {
  const deadline = q.now() + 1000 * (timeoutS ?? q.waitS);
  for (;;) {
    const r = await arm(q, "GET", path, api);
    const state = r.status === 200 ? provisioningState(r.body) : null;
    if ((r.status === 200 && (state === null || TERMINAL.has(state))) || q.now() > deadline)
      return r;
    await q.sleep(intervalMs);
  }
}

/** Poll a GET until its status is in `want`, or the deadline passes. */
export async function waitStatus(
  q: Query,
  path: string,
  api: string,
  want: readonly number[],
  timeoutS?: number,
  intervalMs = 500
): Promise<ArmResponse> {
  const deadline = q.now() + 1000 * (timeoutS ?? q.waitS);
  for (;;) {
    const r = await arm(q, "GET", path, api);
    if (want.includes(r.status) || q.now() > deadline) return r;
    await q.sleep(intervalMs);
  }
}

/** Poll until a dotted field equals `want` (case-insensitive); the last value seen. */
export async function waitField(
  q: Query,
  path: string,
  api: string,
  key: string,
  want: string,
  timeoutS = 60,
  intervalMs = 500
): Promise<unknown> {
  const deadline = q.now() + 1000 * timeoutS;
  for (;;) {
    const r = await arm(q, "GET", path, api);
    const got = r.status === 200 ? dotted(r.body, key) : null;
    if (pyStr(got).toLowerCase() === want.toLowerCase() || q.now() > deadline) return got;
    await q.sleep(intervalMs);
  }
}

// ── fixture helpers ─────────────────────────────────────────────────────────

/** A setup step that did not work: the run records a setup error, not an agent failure. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

/** Run a fixture command; it must succeed. Returns az's JSON output (or null). */
export async function azOk(q: Query, command: string, what?: string): Promise<unknown> {
  const a = await q.az(command);
  if (a.exitCode !== 0 || a.stoppedByTool) {
    const detail = (a.stderr || a.text || "").trim().slice(0, 300);
    throw new FixtureError(
      `fixture: ${what ?? command.slice(0, 80)} failed (exit ${a.exitCode}): ${detail}`
    );
  }
  return parseJson(a.stdout);
}

/** PUT a resource; it must succeed (the benchmark's _put_ok). */
export async function putOk(
  q: Query,
  path: string,
  api: string,
  body: unknown,
  what: string
): Promise<unknown> {
  const r = await arm(q, "PUT", path, api, body);
  if (r.status >= 300 || r.status === 0) {
    const detail = (r.answer.stderr || r.answer.text || "").trim().slice(0, 300);
    throw new FixtureError(`fixture: ${what} PUT ${r.status}: ${detail}`);
  }
  return r.body;
}

/** A GET that must succeed; the body. */
export async function getOk(q: Query, path: string, api: string, what: string): Promise<unknown> {
  const r = await arm(q, "GET", path, api);
  if (r.status !== 200) {
    throw new FixtureError(
      `fixture: ${what} GET ${r.status}: ${(r.answer.stderr || "").trim().slice(0, 300)}`
    );
  }
  return r.body;
}

/**
 * The benchmark's snapshot setup step: record values before the task, as slots
 * `_before_<label>` (a POST such as listKeys by default). Nothing to snapshot is a
 * fixture error.
 */
export async function snapshot(
  q: Query,
  slots: Slots,
  path: string,
  api: string,
  fields: Record<string, string>,
  method = "POST"
): Promise<void> {
  const r = await arm(q, method, fill(path, slots), api);
  for (const [label, key] of Object.entries(fields)) {
    const v = dotted(r.body, key);
    if (v === null || v === "") {
      throw new FixtureError(
        `fixture: nothing to snapshot for ${label}: ${JSON.stringify(r.body).slice(0, 200)}`
      );
    }
    slots[`_before_${label}`] = v;
  }
}

// ── the oracle transcript ─────────────────────────────────────────────────────

/**
 * With the oracle there is no answer: the claim verifiers read the oracle's transcript,
 * one block per call, as the benchmark read its CLI arms' outputs. A block is a mark line
 * (`ORACLE ✅ az <command>`, or ❌ when the command failed) and az's output in a fence
 * (```json when it is JSON).
 */
export const ORACLE_MARK = /^ORACLE (\u2705|\u274c) az /gm;

export function oracleBlock(command: string, a: AzAnswer): string {
  const ok = a.exitCode === 0 && !a.stoppedByTool;
  const stdout = (a.stdout || "").replace(/\r\n/g, "\n").trim();
  const isJson = stdout !== "" && parseJson(stdout) !== null;
  const body = isJson ? stdout : (a.text || stdout || "").replace(/\r\n/g, "\n").trim();
  return `ORACLE ${ok ? "\u2705" : "\u274c"} az ${command}\n${isJson ? "```json" : "```"}\n${body}\n\`\`\``;
}

function oracleMarks(text: string): boolean[] {
  return [...(text || "").matchAll(ORACLE_MARK)].map((m) => m[1] === "\u2705");
}

/** JSON fenced blocks of a transcript (or the whole text), parsed. */
function jsonBlocks(text: string): unknown[] {
  const blocks = [...(text || "").matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const out: unknown[] = [];
  for (const block of blocks.length ? blocks : [text || ""]) {
    const v = parseJson(block);
    if (v !== null) out.push(v);
  }
  return out;
}

// ── generic verifiers (tasks.py and verifiers.py) ─────────────────────────────

function last(path: string): string {
  return path.split("?")[0].split("/").pop() || path;
}

/** The resource exists and is ready: GET 200 and a Succeeded (or no) provisioningState. */
export function exists(path: string, api: string): Verify {
  return async (q, slots) => {
    const p = fill(path, slots);
    const r = await waitReady(q, p, api);
    const state = provisioningState(r.body);
    const ok = r.status === 200 && (state === null || state === "Succeeded");
    return { passed: ok, reason: `GET ${last(p)} -> ${r.status}${state ? ` ${state}` : ""}` };
  };
}

export function gone(path: string, api: string): Verify {
  return async (q, slots) => {
    const p = fill(path, slots);
    const r = await waitStatus(q, p, api, [404, 410]);
    return {
      passed: r.status === 404 || r.status === 410,
      reason: `GET ${last(p)} -> ${r.status}`,
    };
  };
}

/** Read tasks: every expected fact appears in the answer (case-insensitive). */
export function claims(...templates: string[]): Verify {
  return async (_q, slots, text) => {
    const wanted = templates.map((t) => fmt(t, slots));
    const low = (text || "").toLowerCase();
    const missing = wanted.filter((w) => !low.includes(w.toLowerCase()));
    return {
      passed: missing.length === 0,
      reason: missing.length === 0 ? "all claims present" : `missing ${JSON.stringify(missing)}`,
    };
  };
}

/** Like claims, ignoring case, spaces, hyphens and underscores ("North Europe"). */
export function claimsNorm(...templates: string[]): Verify {
  return async (_q, slots, text) => {
    const t = normText(text || "");
    const wanted = templates.map((tpl) => fmt(tpl, slots));
    const missing = wanted.filter((w) => !t.includes(normText(w)));
    return {
      passed: missing.length === 0,
      reason: missing.length === 0 ? "all claims present" : `missing ${JSON.stringify(missing)}`,
    };
  };
}

/** At least one of the templates appears (compared as in claimsNorm). */
export function claimsAnyNorm(...templates: string[]): Verify {
  return async (_q, slots, text) => {
    const t = normText(text || "");
    const wanted = templates.map((tpl) => fmt(tpl, slots));
    const hit = wanted.filter((w) => t.includes(normText(w)));
    return {
      passed: hit.length > 0,
      reason: hit.length ? `states ${hit[0]}` : `states none of ${JSON.stringify(wanted)}`,
    };
  };
}

/** Ready (as exists), and every expected field (dotted key) has its value. */
export function readyWith(path: string, api: string, fields: Record<string, unknown>): Verify {
  const base = exists(path, api);
  return async (q, slots, text) => {
    const first = await base(q, slots, text);
    if (!first.passed || Object.keys(fields).length === 0) return first;
    const r = await arm(q, "GET", fill(path, slots), api);
    const wrong: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      const want = typeof v === "string" ? fmt(v, slots) : v;
      const got = dotted(r.body, k);
      if (pyStr(got) !== pyStr(want)) wrong[k] = got;
    }
    const ok = Object.keys(wrong).length === 0;
    return {
      passed: ok,
      reason: first.reason + (ok ? "" : `; fields differ ${JSON.stringify(wrong)}`),
    };
  };
}

/** Poll a GET until a dotted field has the wanted value (string compare, case-insensitive). */
export function fieldIs(
  path: string,
  api: string,
  key: string,
  want: unknown,
  waitS?: number
): Verify {
  return async (q, slots) => {
    const p = fill(path, slots);
    const deadline = q.now() + 1000 * (waitS ?? q.waitS);
    const wantS = (typeof want === "string" ? fill(want, slots) : pyStr(want)).toLowerCase();
    for (;;) {
      const r = await arm(q, "GET", p, api);
      const got = r.status === 200 ? dotted(r.body, key) : null;
      const ok = pyStr(got).toLowerCase() === wantS;
      if (ok || q.now() > deadline) return { passed: ok, reason: `${key} -> ${pyStr(got)}` };
      await q.sleep(500);
    }
  };
}

/**
 * The answer states every listed value of the resource, read from the emulator (matching
 * ignores case, whitespace, underscores and hyphens).
 */
export function answerHasFields(
  path: string,
  api: string,
  fields: string[],
  method = "GET",
  body?: unknown
): Verify {
  return async (q, slots, text) => {
    const r = await arm(q, method, fill(path, slots), api, body);
    if (r.status !== 200) return { passed: false, reason: `${method} -> ${r.status}` };
    const t = normText(text || "");
    const missing: Record<string, unknown> = {};
    for (const f of fields) {
      const v = dotted(r.body, f);
      if (v === null || v === "" || !t.includes(normText(v))) missing[f] = v;
    }
    const ok = Object.keys(missing).length === 0;
    return { passed: ok, reason: ok ? "all values stated" : `missing ${JSON.stringify(missing)}` };
  };
}

/** Every check passes (reasons joined). */
export function allOf(...checks: Verify[]): Verify {
  return async (q, slots, text) => {
    const results: Verdict[] = [];
    for (const c of checks) results.push(await c(q, slots, text));
    return {
      passed: results.every((r) => r.passed),
      reason: results.map((r) => r.reason).join("; "),
    };
  };
}

/** The answer matches a regular expression (slots filled regex-escaped, case-insensitive). */
export function textMatches(pattern: string, flags = "i"): Verify {
  return async (_q, slots, text) => {
    const escaped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(slots)) escaped[k] = escapeRegExp(pyStr(v));
    const rx = fmt(pattern, escaped);
    const ok = new RegExp(rx, flags).test(text || "");
    return { passed: ok, reason: ok ? "answer matches" : `answer does not match /${rx}/` };
  };
}

/** The `changed` value differs from its snapshot and the `kept` value equals its own. */
export function changedAndKept(
  path: string,
  api: string,
  changed: string,
  kept: string,
  method = "POST"
): Verify {
  return async (q, slots) => {
    const r = await arm(q, method, fill(path, slots), api);
    const nowC = dotted(r.body, changed);
    const nowK = dotted(r.body, kept);
    const okC = nowC !== null && pyStr(nowC) !== pyStr(slots._before_changed);
    const okK = nowK !== null && pyStr(nowK) === pyStr(slots._before_kept);
    return {
      passed: okC && okK,
      reason: `${changed} ${okC ? "rotated" : "unchanged"}, ${kept} ${okK ? "kept" : "CHANGED"}`,
    };
  };
}

/** A list-valued field holds every expected item (case-insensitive), in any order. */
export function listFieldContains(path: string, api: string, key: string, items: string[]): Verify {
  return async (q, slots) => {
    const p = fill(path, slots);
    const deadline = q.now() + 1000 * q.waitS;
    const want = items.map((i) => fill(i, slots).toLowerCase());
    for (;;) {
      const r = await arm(q, "GET", p, api);
      const got = r.status === 200 ? dotted(r.body, key) : null;
      const have = new Set(Array.isArray(got) ? got.map((g) => pyStr(g).toLowerCase()) : []);
      const ok = want.every((w) => have.has(w));
      if (ok || q.now() > deadline)
        return { passed: ok, reason: `${key} -> ${JSON.stringify(got)}` };
      await q.sleep(500);
    }
  };
}

// ── answers that state a yes/no per name ─────────────────────────────────────

const SENTENCES = /[\n.;]|\bbut\b|\bwhereas\b|\bhowever\b|\bwhile\b/i;

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length))
    out.push(i);
  return out;
}

/**
 * (name, text about it): per sentence, each mentioned name owns the text from where it
 * appears up to the next name; text before the first name goes to the first name.
 */
export function spans(text: string, names: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const sentence of (text || "").split(SENTENCES)) {
    const low = sentence.toLowerCase();
    const hits: Array<[number, string]> = [];
    for (const n of names)
      for (const start of occurrences(low, n.toLowerCase())) hits.push([start, n]);
    hits.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    hits.forEach(([start, name], i) => {
      const end = i + 1 < hits.length ? hits[i + 1][0] : low.length;
      const span = i === 0 ? low.slice(0, end) : low.slice(start, end);
      out.push([name, span.split(name.toLowerCase()).join(" ")]);
    });
  }
  return out;
}

/** What the answer says about each name; a negative wins over a positive within a stretch. */
export function statedBooleans(
  text: string,
  names: string[],
  positive: RegExp,
  negative: RegExp
): Map<string, Set<boolean>> {
  const out = new Map<string, Set<boolean>>();
  for (const [name, span] of spans(text, names)) {
    const verdict = negative.test(span) ? false : positive.test(span) ? true : null;
    if (verdict !== null) {
      if (!out.has(name)) out.set(name, new Set());
      out.get(name)!.add(verdict);
    }
  }
  return out;
}

export const EXIST_NEG =
  /\b(does\s*n[o']?t|do\s*n[o']?t|did\s*n[o']?t)\s+exist|\bnot\s+(exist|present|found|there)\b|\bmissing\b|\babsent\b|\bno\s+such\b|\bno\s+(key|setting|entry)\b|\bnon-?existent\b|\u274c/i;
export const EXIST_POS = /\bexists?\b|\bpresent\b|\bfound\b|\bis\s+there\b|\u2705/i;

function setEquals(a: Set<boolean> | undefined, b: boolean): boolean {
  return a !== undefined && a.size === 1 && a.has(b);
}

/**
 * The answer says, for each name (slot -> expected), whether it exists. `truth`, if given,
 * re-reads each name's existence from the emulator. With the oracle, the transcript must
 * hold exactly the names that exist as quoted JSON values.
 */
export function existsClaims(
  expect: Record<string, boolean>,
  truth?: (q: Query, slots: Slots, name: string) => Promise<boolean>
): Verify {
  return async (q, slots, text) => {
    const want = new Map<string, boolean>();
    for (const [slot, e] of Object.entries(expect)) want.set(pyStr(slots[slot]), e);
    if (truth) {
      const actual: Record<string, boolean> = {};
      let drift = false;
      for (const [n, e] of want) {
        actual[n] = await truth(q, slots, n);
        if (actual[n] !== e) drift = true;
      }
      if (drift)
        return { passed: false, reason: `fixture drift: emulator says ${JSON.stringify(actual)}` };
    }
    if (slots._oracle) {
      const low = (text || "").toLowerCase();
      const seen: Record<string, boolean> = {};
      let ok = true;
      for (const [n, e] of want) {
        seen[n] = low.includes(`"${n.toLowerCase()}"`);
        if (seen[n] !== e) ok = false;
      }
      return { passed: ok, reason: `oracle outputs hold ${JSON.stringify(seen)}` };
    }
    const stated = statedBooleans(text, [...want.keys()], EXIST_POS, EXIST_NEG);
    const wrong: Record<string, boolean[]> = {};
    for (const [n, e] of want) {
      if (!setEquals(stated.get(n), e)) wrong[n] = [...(stated.get(n) ?? [])].sort();
    }
    const ok = Object.keys(wrong).length === 0;
    return {
      passed: ok,
      reason: ok
        ? "all names reported correctly"
        : `stated ${JSON.stringify(wrong)}, expected ${JSON.stringify(Object.fromEntries(want))}`,
    };
  };
}

// ── workflows (T-B): several checks, partial credit ──────────────────────────

/** A goal of several steps passes when every step's check passes; per-step results are kept. */
export function workflow(...steps: Array<[string, Verify]>): Verify {
  return async (q, slots, text) => {
    const results: StepResult[] = [];
    for (const [label, verify] of steps) {
      let r: Verdict;
      try {
        r = await verify(q, slots, text);
      } catch (e) {
        r = {
          passed: false,
          reason: `verifier error: ${e instanceof Error ? e.name : "Error"}: ${String(e instanceof Error ? e.message : e).slice(0, 150)}`,
        };
      }
      results.push({
        step: label,
        passed: Boolean(r.passed),
        reason: String(r.reason).slice(0, 200),
      });
    }
    const n = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).map((r) => r.step);
    return {
      passed: n === results.length,
      reason:
        `${n}/${results.length} steps` + (failed.length ? `; failed: ${failed.join(", ")}` : ""),
      steps: results,
    };
  };
}

// ── a migration verdict (cdn-can-migrate) ────────────────────────────────────

const NO_ENDPOINTS =
  /\bno\s+endpoints?\b|NoEndpointsToMigrate|\b(?:does\s*n[o']?t|do\s*n[o']?t)\s+(?:have|contain)\s+(?:any\s+)?endpoints?\b|\bwithout\s+(?:any\s+)?endpoints?\b|\b(?:zero|0)\s+endpoints?\b|\blacks?\s+(?:any\s+|an\s+)?endpoints?\b|\bmissing\s+(?:an?\s+)?endpoints?\b|\bempty\b[^.\n]{0,30}\bendpoints?\b/i;
const CANNOT_MIGRATE =
  /\b(?:cannot|can\s*'?no?t|could\s*n[o']?t)\s+(?:currently\s+|yet\s+)?(?:be\s+)?migrat|\bnot\s+(?:currently\s+|yet\s+)?(?:eligible|compatible|migratable|possible)\b|\bineligible\b|\bincompatible\b|canMigrate\W{0,4}false/i;
const CAN_MIGRATE =
  /\bcan\s+be\s+migrated\b|\bis\s+(?:eligible|compatible|migratable|ready)\b|\beligible\b|\bcompatible\b|canMigrate\W{0,4}true|\bmigration\s+is\s+possible\b|\bready\s+(?:to|for)\s+(?:be\s+)?migrat|\byes\b|\bnothing\s+(?:is\s+)?blocking\b|\bno\s+block(?:ers?|ing\s+issues?)\b/i;

/**
 * The answer gives the migration check's verdict (slot: true when the profile can
 * migrate). A "no" must name the blocker (no endpoints); a "yes" must say it can migrate
 * and name no blocker. With the oracle, the transcript must carry canMigrate itself.
 */
export function migrationVerdict(slot: string): Verify {
  return async (_q, slots, text) => {
    const want = Boolean(slots[slot]);
    const t = text || "";
    if (slots._oracle) {
      const m = /"canMigrate"\s*:\s*(true|false)/i.exec(t);
      const got = m ? m[1].toLowerCase() === "true" : null;
      return {
        passed: got === want,
        reason: `oracle outputs say canMigrate=${got}, expected ${want}`,
      };
    }
    const blocker = NO_ENDPOINTS.test(t);
    if (!want)
      return {
        passed: blocker,
        reason: blocker ? "names the blocker" : "does not name the blocker (no endpoints)",
      };
    const ok = CAN_MIGRATE.test(t) && !CANNOT_MIGRATE.test(t) && !blocker;
    return {
      passed: ok,
      reason: ok ? "says it can migrate" : "does not say it can migrate, or names a blocker",
    };
  };
}

// ── verifier defect 1: eventhub-hub-auth-rule-rights ──────────────────────────
// The benchmark's negation pattern was \b(...|n't)\b: the boundary before "n't" never
// matches inside "doesn't", so "grants only Send. It doesn't include Listen or Manage"
// affirmed all three. Fixed reading (rescore.py fix 1): the answer's grant statement.

const RIGHTS = ["listen", "send", "manage"] as const;
const RIGHTS_NEG = /(?:\b(?:not|no|without|lacks?|lacking|excluding|except|neither|nor)\b|n't\b)/;

function firstRight(line: string): { right: string; start: number } | null {
  let best: { right: string; start: number } | null = null;
  for (const x of RIGHTS) {
    const m = new RegExp(`\\b${x}\\b`).exec(line);
    if (m && (best === null || m.index < best.start)) best = { right: x, start: m.index };
  }
  return best;
}

/** The rights an answer affirms (lower case), read from its grant statement. */
export function affirmedRights(text: string): Set<string> {
  const low = (text || "").toLowerCase();
  // A grant statement ending in ':' and a bullet list: each bullet affirms the right it
  // opens with unless the bullet negates it.
  const head = /\b(grant|grants|granted|gives|give|has|have)\b[^.\n]*\brights?\b[^.\n]*:\s*\n/.exec(
    low
  );
  if (head) {
    const affirmed = new Set<string>();
    for (const raw of low.slice(head.index + head[0].length).split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (!line) {
        if (affirmed.size) break;
        continue;
      }
      if (!/^([-*\u2022]|\d+[.)])\s/.test(line)) break;
      const hit = firstRight(line);
      if (!hit) continue;
      const negated =
        RIGHTS_NEG.test(line.slice(Math.max(0, hit.start - 40), hit.start)) ||
        /\b(not|isn't|is not|n't be)\s+(granted|included|allowed)\b/.test(line);
      if (!negated) affirmed.add(hit.right);
    }
    if (affirmed.size) return affirmed;
  }
  // The first sentence that says what the rule grants and names a right.
  for (const sentence of low.split(/(?<=[.!?])\s+|\n+/)) {
    if (
      /\b(grant|grants|granted|gives|give|has|have|rights?)\b/.test(sentence) &&
      RIGHTS.some((x) => new RegExp(`\\b${x}\\b`).test(sentence))
    ) {
      const affirmed = new Set<string>();
      for (const x of RIGHTS) {
        for (const m of sentence.matchAll(new RegExp(`\\b${x}\\b`, "g"))) {
          if (!RIGHTS_NEG.test(sentence.slice(Math.max(0, m.index! - 40), m.index!))) {
            affirmed.add(x);
            break;
          }
        }
      }
      return affirmed;
    }
  }
  const affirmed = new Set<string>();
  for (const x of RIGHTS) {
    for (const m of low.matchAll(new RegExp(`\\b${x}\\b`, "g"))) {
      if (!RIGHTS_NEG.test(low.slice(Math.max(0, m.index! - 40), m.index!))) {
        affirmed.add(x);
        break;
      }
    }
  }
  return affirmed;
}

/** The answer names exactly the rights the rule grants (read from the emulator). */
export function rightsClaim(path: string, api: string): Verify {
  return async (q, slots, text) => {
    const r = await arm(q, "GET", fill(path, slots), api);
    const rights = r.status === 200 ? dotted(r.body, "properties.rights") : null;
    const present = new Set(Array.isArray(rights) ? rights.map((x) => pyStr(x).toLowerCase()) : []);
    const affirmed = affirmedRights(text);
    const ok = affirmed.size === present.size && [...affirmed].every((x) => present.has(x));
    return {
      passed: ok,
      reason: `answer affirms ${JSON.stringify([...affirmed].sort())}, rule grants ${JSON.stringify([...present].sort())}`,
    };
  };
}

// ── verifier defect 2: deployment-sub-validate ────────────────────────────────
// validation_claim failed any answer containing "error(s)" or "fail" anywhere, so "The
// template passed validation ... no errors" was wrong. Fixed (rescore.py fix 2): the
// verdict comes from the answer's validity statement.

const VALID_POS =
  /\bpass(?:ed|es)?\s+validation\b|\bvalidation\s+(?:passed|succeeded|was\s+successful)\b|\b(?:is|was)\s+valid\b|\bvalid(?:ates|ated)?\s+(?:successfully|cleanly|fine)\b|\bwould\s+deploy\s+cleanly\b|\bcan\s+be\s+deployed\b/i;
const VALID_NEG =
  /\b(?:is|was)\s+(?:invalid|not\s+valid)\b|\bfailed\s+validation\b|\bvalidation\s+failed\b|\bcannot\s+be\s+deployed\b|\bwould\s+not\s+deploy\b/i;

/** True when the answer says the template is valid (and does not say it is invalid). */
export function validationVerdict(text: string): boolean {
  return VALID_POS.test(text || "") && !VALID_NEG.test(text || "");
}

/** The answer says the template validated, and the validation deployed nothing. */
export function validationClaim(deploymentPath: string, api: string): Verify {
  return async (q, slots, text) => {
    const r = await arm(q, "GET", fill(deploymentPath, slots), api);
    if (r.status === 200)
      return { passed: false, reason: "a deployment was created (validation must not deploy)" };
    if (slots._oracle) return { passed: true, reason: "validated without deploying" };
    const ok = validationVerdict(text);
    return {
      passed: ok,
      reason: ok ? "answer says valid" : "answer does not say the template is valid",
    };
  };
}

// ── verifier defect 3: tb-tag-audit ───────────────────────────────────────────
// untagged_reported read each name's stretch up to the next name, so a correct table
// ("| tbpip-x | ... | ❌ **missing** (no tags) |") followed by summary lines read as mixed.
// Fixed (rescore.py fix 3): per line.

const TAG_NEG =
  /\u274c|\bmissing\b|\bno\s+(?:`?owner`?\s+)?tags?\b|\bno\s+`?owner\b|\buntagged\b|\bwithout\b/i;
const TAG_POS = /\u2705|\bowner\s*[=:]|\bhas\s+(?:an?\s+)?`?owner|\bowner\s*=\s*|`owner=/i;

/** Per resource name: the verdicts (true = tagged) of the lines that name it. */
export function untaggedVerdicts(text: string, names: string[]): Map<string, Set<boolean>> {
  const lines = (text || "").split(/\r\n|\r|\n/);
  const out = new Map<string, Set<boolean>>();
  for (const name of names) {
    const verdicts = new Set<boolean>();
    for (const line of lines) {
      if (!line.toLowerCase().includes(name.toLowerCase())) continue;
      const neg = TAG_NEG.test(line);
      const pos = TAG_POS.test(line);
      if (neg && !pos) verdicts.add(false);
      else if (pos && !neg) verdicts.add(true);
    }
    out.set(name, verdicts);
  }
  return out;
}

/** Oracle mode: whether each named resource carries an owner tag, from the JSON output. */
export function ownerTags(text: string, names: string[]): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const root of jsonBlocks(text)) {
    const stack: unknown[] = [root];
    while (stack.length) {
      const x = stack.pop();
      if (isDict(x)) {
        const name = typeof x.name === "string" ? x.name : null;
        if (name && names.includes(name) && ("tags" in x || "properties" in x)) {
          const tags = isDict(x.tags) ? x.tags : {};
          found.set(name, (found.get(name) ?? false) || Boolean(tags.owner));
        }
        stack.push(...Object.values(x));
      } else if (Array.isArray(x)) {
        stack.push(...x);
      }
    }
  }
  return found;
}

/** The answer says each untagged resource lacks the owner tag, and none of the tagged ones. */
export function untaggedReported(untagged: string[], tagged: string[]): Verify {
  return async (_q, slots, text) => {
    const u = untagged.map((s) => pyStr(slots[s]));
    const t = tagged.map((s) => pyStr(slots[s]));
    let missing: string[];
    let wrong: string[];
    if (slots._oracle) {
      const has = ownerTags(text, [...u, ...t]);
      missing = u.filter((n) => has.get(n) !== false);
      wrong = t.filter((n) => has.get(n) === false);
    } else {
      const v = untaggedVerdicts(text, [...u, ...t]);
      missing = u.filter((n) => !v.get(n)!.has(false));
      wrong = t.filter((n) => v.get(n)!.has(false));
    }
    return {
      passed: missing.length === 0 && wrong.length === 0,
      reason: `untagged not reported: ${JSON.stringify(missing)}; tagged reported as untagged: ${JSON.stringify(wrong)}`,
    };
  };
}

// ── verifier defect 4: tb-mysql-firewall ──────────────────────────────────────
// The step "host name reported" demanded the emulator's fullyQualifiedDomainName
// verbatim, which carries a port (":4514"); a domain name has none. Fixed (rescore.py
// fix 4): the name with or without the port counts.

/** The host of an FQDN or URL: no scheme, no trailing slash, no port; lower case. */
export function hostOf(value: string): string {
  const noSlash = (value || "").replace(/\/+$/, "");
  const noScheme = noSlash.split("://").pop() || "";
  const colon = noScheme.lastIndexOf(":");
  return (colon >= 0 ? noScheme.slice(0, colon) : noScheme).toLowerCase();
}

/** The answer names the host `want` computes (with or without a port). */
export function hostStated(want: (q: Query, slots: Slots) => Promise<string>): Verify {
  return async (q, slots, text) => {
    const host = hostOf(await want(q, slots));
    const ok = host !== "" && (text || "").toLowerCase().includes(host);
    return {
      passed: ok,
      reason: `answer ${ok ? "states" : "does not state"} ${host || "(no host)"} (with or without the port)`,
    };
  };
}

// ── verifier defect 5: td-afd-hostname-check (T-D; no E2 task uses it) ────────
// The pilot's availability parser read no verdict from answers giving one per host in a
// table or a sentence. Fixed (rescore.py fix 5): per line, the text after each host name
// up to the next one; the first verdict word decides.

const AVAIL_NEG =
  /\u274c|\bno\b|\btaken\b|\balready\b|\bnot\s+available\b|\bunavailable\b|\bcan(?:no|')t\b|\bcannot\b|\bfalse\b|\bin\s+use\b|\bexists?\b/i;
const AVAIL_POS =
  /\u2705|\byes\b|\bavailable\b|\bfree\b|\bcan\s+(?:still\s+)?be\s+used\b|\btrue\b/i;

type Hit = [number, string];

function lineHits(low: string, names: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const n of names)
    for (const start of occurrences(low, n.toLowerCase())) hits.push([start, n]);
  return hits.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

function firstVerdict(seg: string, neg: RegExp, pos: RegExp, negWinsTie: boolean): boolean | null {
  const n = neg.exec(seg);
  const p = pos.exec(seg);
  if (n && (!p || (negWinsTie ? n.index <= p.index : n.index < p.index))) return false;
  if (p) return true;
  return null;
}

/** Per host: the verdicts (true = available) the answer gives. */
export function hostVerdicts(text: string, hosts: string[]): Map<string, Set<boolean>> {
  const out = new Map<string, Set<boolean>>(hosts.map((h) => [h, new Set<boolean>()]));
  for (const line of (text || "").split(/\r\n|\r|\n/)) {
    const low = line.toLowerCase();
    const hits = lineHits(low, hosts);
    hits.forEach(([start, host], i) => {
      const end = i + 1 < hits.length ? hits[i + 1][0] : low.length;
      const v = firstVerdict(low.slice(start + host.length, end), AVAIL_NEG, AVAIL_POS, false);
      if (v !== null) out.get(host)!.add(v);
    });
  }
  return out;
}

/** The answer says the taken host is taken and the free one is available. */
export function hostAvailability(takenSlot: string, freeSlot: string): Verify {
  return async (_q, slots, text) => {
    const taken = pyStr(slots[takenSlot]);
    const free = pyStr(slots[freeSlot]);
    const v = hostVerdicts(text, [taken, free]);
    const ok = setEquals(v.get(taken), false) && setEquals(v.get(free), true);
    return {
      passed: ok,
      reason: `stated taken ${JSON.stringify([...v.get(taken)!])}, free ${JSON.stringify([...v.get(free)!])}`,
    };
  };
}

// ── verifier defect 6: apim-group-user-check ──────────────────────────────────
// The yes/no reader collected every verdict word in a name's stretch, so "alice: not a
// member ... her account does exist" read as both. Fixed (rescore.py fix 6): per user, the
// first verdict word after the name decides; lines about "whether" are skipped.

const MEMBER_NEG =
  /\u274c|\bnot\s+(?:a\s+)?member\b|\bnot\s+in\b|\bisn't\b|\bis\s+not\b|\bno\b|\bnon-member\b/i;
const MEMBER_POS = /\u2705|\bmember\b|\byes\b|\bbelongs\b|\bis\s+in\b/i;

/** Per user name: the verdicts (true = member) the answer gives. */
export function membershipVerdicts(text: string, users: string[]): Map<string, Set<boolean>> {
  const out = new Map<string, Set<boolean>>(users.map((u) => [u, new Set<boolean>()]));
  for (const line of (text || "").split(/\r\n|\r|\n/)) {
    const low = line.toLowerCase();
    if (/\bwhether\b/.test(low)) continue;
    const hits = lineHits(low, users);
    hits.forEach(([start, user], i) => {
      const end = i + 1 < hits.length ? hits[i + 1][0] : low.length;
      const v = firstVerdict(low.slice(start + user.length, end), MEMBER_NEG, MEMBER_POS, true);
      if (v !== null) out.get(user)!.add(v);
    });
  }
  return out;
}

/** The answer says, per user, whether they are a member of the group (slot `member`). */
export function membershipStated(): Verify {
  return async (_q, slots, text) => {
    const u1 = pyStr(slots.user1);
    const u2 = pyStr(slots.user2);
    const truth = new Map<string, boolean>([
      [u1, slots.member === slots.user1],
      [u2, slots.member === slots.user2],
    ]);
    if (slots._oracle) {
      const marks = oracleMarks(text);
      const want = [truth.get(u1), truth.get(u2)];
      const ok = marks.length === 2 && marks[0] === want[0] && marks[1] === want[1];
      return {
        passed: ok,
        reason: `oracle outcomes ${JSON.stringify(marks)} vs ${JSON.stringify(want)}`,
      };
    }
    const stated = membershipVerdicts(text, [u1, u2]);
    const ok = [...truth].every(([n, t]) => setEquals(stated.get(n), t));
    const said = Object.fromEntries([...stated].map(([k, v]) => [k, [...v]]));
    return {
      passed: ok,
      reason: `stated ${JSON.stringify(said)}, truth ${JSON.stringify(Object.fromEntries(truth))}`,
    };
  };
}

// ── verifier defect 7: apim-tenant-access ─────────────────────────────────────
// The same reader: "No. Direct management API access is turned off ... enabled: false"
// read as also enabled. Fixed (rescore.py fix 7): the first verdict word decides.

const ENABLED_NEG =
  /\bno\b|\bturned\s+off\b|\bdisabled\b|\bnot\s+enabled\b|\benabled[`*]*\s*[:=]\s*[`*]*false\b/i;
const ENABLED_POS = /\byes\b|\bturned\s+on\b|\bis\s+enabled\b|\benabled[`*]*\s*[:=]\s*[`*]*true\b/i;

/** What the answer says about direct management API access: the first verdict word. */
export function tenantAccessVerdict(text: string): boolean | null {
  const neg = ENABLED_NEG.exec(text || "");
  const pos = ENABLED_POS.exec(text || "");
  if (!neg && !pos) return null;
  return Boolean(pos) && (!neg || pos!.index < neg.index);
}

/** The answer says whether direct management API access is enabled (slot access_enabled). */
export function accessStated(): Verify {
  return async (_q, slots, text) => {
    const want = Boolean(slots.access_enabled);
    const t = text || "";
    if (slots._oracle) {
      const m =
        /"name":\s*"access"[\s\S]{0,400}?"enabled":\s*(true|false)/i.exec(t) ||
        /"enabled":\s*(true|false)/i.exec(t);
      const got = m ? m[1].toLowerCase() === "true" : null;
      return {
        passed: got === want,
        reason: `oracle outputs say enabled=${got}, expected ${want}`,
      };
    }
    const said = tenantAccessVerdict(t);
    return { passed: said === want, reason: `answer says ${said}, expected ${want}` };
  };
}

// ── Key Vault ────────────────────────────────────────────────────────────────

/** The version id at the end of a key id (kid). */
export function kidVersion(kid: unknown): string {
  return (
    pyStr(kid ?? "")
      .replace(/\/+$/, "")
      .split("/")
      .pop() || ""
  );
}

/** Every version of a Key Vault key (an agent may have made more than one). */
export async function keyVersions(q: Query, vault: string, key: string): Promise<string[]> {
  const list = parseJson(
    (await q.az(`keyvault key list-versions --vault-name ${vault} --name ${key}`)).stdout
  );
  let kids = Array.isArray(list)
    ? list.map((k) => (isDict(k) ? pyStr(k.kid ?? "") : "")).filter(Boolean)
    : [];
  if (!kids.length) {
    const shown = parseJson(
      (await q.az(`keyvault key show --vault-name ${vault} --name ${key}`)).stdout
    );
    const kid = dotted(shown, "key.kid");
    kids = kid ? [pyStr(kid)] : [];
  }
  return kids.map(kidVersion).filter(Boolean);
}

/** True when `signature` (any base64 form) is an RS256 signature of `digest` by the key. */
export async function signatureValid(
  q: Query,
  vault: string,
  key: string,
  version: string,
  digestB64: string,
  signature: string
): Promise<boolean> {
  const a = await q.az(
    `keyvault key verify --vault-name ${vault} --name ${key} --version ${version} --algorithm RS256 ` +
      `--digest ${toStdB64(digestB64)} --signature ${toStdB64(signature)}`
  );
  if (a.exitCode !== 0) return false;
  const body = parseJson(a.stdout);
  return dotted(body, "isValid") === true || dotted(body, "value") === true;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * kv-sign: some long base64/base64url string in the answer is a valid RS256 signature of
 * the digest by the task's key version (checked with the vault's own verify operation).
 */
export function signatureVerifies(): Verify {
  return async (q, slots, text) => {
    for (const cand of unique((text || "").match(/[A-Za-z0-9+/_=-]{200,}/g) ?? [])) {
      if (
        await signatureValid(
          q,
          pyStr(slots.vault_name),
          pyStr(slots.key_name),
          pyStr(slots.key_version),
          pyStr(slots.digest),
          cand
        )
      ) {
        return { passed: true, reason: "a signature in the answer verifies" };
      }
    }
    return { passed: false, reason: "no valid signature in the answer" };
  };
}

/** tb-keyvault-secret-sign: a stated value verifies as a signature under any key version. */
export function signatureVerifiesIn(
  vaultSlot: string,
  keySlot: string,
  digestSlot: string
): Verify {
  return async (q, slots, text) => {
    const vault = pyStr(slots[vaultSlot]);
    const key = pyStr(slots[keySlot]);
    const versions = await keyVersions(q, vault, key);
    for (const cand of unique((text || "").match(/[A-Za-z0-9+/_-]{60,}={0,2}/g) ?? [])) {
      for (const version of versions) {
        if (await signatureValid(q, vault, key, version, pyStr(slots[digestSlot]), cand)) {
          return { passed: true, reason: "a stated signature verifies" };
        }
      }
    }
    return {
      passed: false,
      reason: `no stated value verifies as a signature of the digest (${versions.length} key version(s))`,
    };
  };
}

/** The answer states the plaintext (decoded, or as its base64url form). */
export function plaintextStated(): Verify {
  return async (_q, slots, text) => {
    const plain = pyStr(slots.plaintext);
    const t = text || "";
    const ok = t.includes(plain) || t.includes(b64url(plain));
    return { passed: ok, reason: ok ? "plaintext stated" : "plaintext not in the answer" };
  };
}

/** The vault's access policy for the principal grants the permissions. */
export function accessPolicyGrants(
  path: string,
  api: string,
  oidSlot: string,
  kind: string,
  perms: string[]
): Verify {
  return async (q, slots) => {
    const r = await arm(q, "GET", fill(path, slots), api);
    const pols = dotted(r.body, "properties.accessPolicies");
    const oid = pyStr(slots[oidSlot]).toLowerCase();
    const entry = Array.isArray(pols)
      ? pols.find((p) => isDict(p) && pyStr(p.objectId).toLowerCase() === oid)
      : undefined;
    const granted = entry ? dotted(entry, `permissions.${kind}`) : null;
    const have = new Set(Array.isArray(granted) ? granted.map((x) => pyStr(x).toLowerCase()) : []);
    const ok = entry !== undefined && perms.every((p) => have.has(p));
    return {
      passed: ok,
      reason: `policy for ${oid.slice(0, 8)}: ${entry ? JSON.stringify([...have].sort()) : "none"}`,
    };
  };
}

/** The vault's secret holds `want` (a template, or computed from the emulator). */
export function secretIs(
  vaultSlot: string,
  secretSlot: string,
  want: string | ((q: Query, slots: Slots) => Promise<string>)
): Verify {
  return async (q, slots) => {
    const expected = typeof want === "function" ? await want(q, slots) : fmt(want, slots);
    const a = await q.az(
      `keyvault secret show --vault-name ${pyStr(slots[vaultSlot])} --name ${pyStr(slots[secretSlot])}`
    );
    const got = a.exitCode === 0 ? dotted(parseJson(a.stdout), "value") : null;
    const ok =
      got !== null && expected !== "" && pyStr(got).toLowerCase().includes(expected.toLowerCase());
    return { passed: ok, reason: `secret -> ${httpStatus(a)}, holds expected value: ${ok}` };
  };
}

// ── resource index, web apps, API Management ──────────────────────────────────

/** The resource carries the tag in the ARM resource index (what `resource list --tag` reads). */
export function indexTagIs(nameSlot: string, key: string, want: string): Verify {
  return async (q, slots) => {
    const expected = fmt(want, slots);
    const r = await arm(
      q,
      "GET",
      fill("/subscriptions/{sub}/resourceGroups/{rg}/resources", slots),
      "2021-04-01"
    );
    const items = dotted(r.body, "value");
    const name = pyStr(slots[nameSlot]);
    const item = Array.isArray(items) ? items.find((i) => isDict(i) && i.name === name) : undefined;
    if (!isDict(item)) return { passed: false, reason: `${name} not in the index` };
    const got = isDict(item.tags) ? (item.tags[key] ?? null) : null;
    return { passed: got === expected, reason: `index tags.${key} -> ${JSON.stringify(got)}` };
  };
}

/** The web app's application setting `key` equals `want`. */
export function appSetting(sitePath: string, api: string, key: string, want: string): Verify {
  return async (q, slots) => {
    const expected = fmt(want, slots);
    const r = await arm(q, "POST", fill(`${sitePath}/config/appsettings/list`, slots), api);
    const props = r.status === 200 ? dotted(r.body, "properties") : null;
    const got = isDict(props) ? (props[key] ?? null) : null;
    const ok = expected !== "" && pyStr(got).replace(/\/+$/, "") === expected.replace(/\/+$/, "");
    return {
      passed: ok,
      reason: `${key} -> ${JSON.stringify(got)} (want ${JSON.stringify(expected)})`,
    };
  };
}

/** The operation's policy rate-limits to `calls` per 60 s (polls: a deployment writes it late). */
export function policyRateLimit(policyPath: string, api: string): Verify {
  return async (q, slots) => {
    const p = fill(policyPath, slots);
    const deadline = q.now() + 1000 * q.waitS;
    let r: ArmResponse;
    for (;;) {
      r = await arm(q, "GET", p, api);
      if (r.status === 200 || q.now() > deadline) break;
      await q.sleep(1000);
    }
    const xml = r.status === 200 ? pyStr(dotted(r.body, "properties.value") ?? "") : "";
    const m =
      /<rate-limit\b[^>]*\bcalls="(\d+)"[^>]*\brenewal-period="(\d+)"/.exec(xml) ||
      /<rate-limit\b[^>]*\brenewal-period="(\d+)"[^>]*\bcalls="(\d+)"/.exec(xml);
    if (!m) return { passed: false, reason: `no rate-limit in the policy (${r.status})` };
    const nums = new Set([m[1], m[2]]);
    const want = new Set([pyStr(slots.calls), "60"]);
    const ok = nums.size === want.size && [...want].every((x) => nums.has(x));
    return {
      passed: ok,
      reason: `rate-limit (${m[1]}, ${m[2]}) (want calls=${pyStr(slots.calls)}, renewal-period=60)`,
    };
  };
}

// ── recording and replaying answers ───────────────────────────────────────────

export interface RecordedCall {
  command: string;
  answer: AzAnswer;
  /** How many times in a row the same command got this same answer (polls). */
  repeat?: number;
}

function sameAnswer(a: AzAnswer, b: AzAnswer): boolean {
  return (
    a.exitCode === b.exitCode &&
    a.stdout === b.stdout &&
    a.stderr === b.stderr &&
    a.classId === b.classId
  );
}

/** The recorded form of an answer: what a verifier reads, without the tool's prose. */
export function recordable(a: AzAnswer): AzAnswer {
  const out: AzAnswer = {
    exitCode: a.exitCode,
    stdout: a.stdout,
    stderr: a.stderr,
    classId: a.classId,
  };
  if (a.stoppedByTool) out.stoppedByTool = true;
  return out;
}

/** Wraps a query so every answer is recorded (consecutive repeats are folded). */
export function recordingQuery(inner: Query, log: RecordedCall[]): Query {
  return {
    waitS: inner.waitS,
    now: () => inner.now(),
    sleep: (ms) => inner.sleep(ms),
    az: async (command) => {
      const answer = await inner.az(command);
      const rec = recordable(answer);
      const prev = log[log.length - 1];
      if (prev && prev.command === command && sameAnswer(prev.answer, rec))
        prev.repeat = (prev.repeat ?? 1) + 1;
      else log.push({ command, answer: rec });
      return answer;
    },
  };
}

/**
 * A query that answers from a recording, with a fake clock (sleep advances it at once).
 * Each command replays its recorded answers in order and then keeps its last one; a
 * command that was never recorded is an error, so a verifier cannot silently read
 * something the recording does not hold.
 */
export function replayQuery(
  calls: readonly RecordedCall[],
  waitS = 90
): Query & { asked: string[] } {
  const queues = new Map<string, AzAnswer[]>();
  for (const c of calls) {
    if (!queues.has(c.command)) queues.set(c.command, []);
    queues.get(c.command)!.push(c.answer);
  }
  let clock = 0;
  const asked: string[] = [];
  return {
    waitS,
    asked,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    az: async (command) => {
      asked.push(command);
      const queue = queues.get(command);
      if (!queue || queue.length === 0) throw new Error(`unrecorded query: az ${command}`);
      clock += 1;
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
  };
}
