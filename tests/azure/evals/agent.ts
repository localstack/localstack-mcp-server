/**
 * The E2 agent loop and its bookkeeping: the loop, the cache pre-warm, the cost, and the
 * fixed settings.
 *
 * The loop is hand-rolled on the Messages API, with fixed settings (model
 * claude-opus-5-5, max_tokens 16000, adaptive thinking with summarized
 * display, effort high, a cached system block plus top-level automatic caching, the
 * assistant turn replayed unmodified). The client is injected: run.mjs passes the official
 * SDK's client, the unit tests a fake. This module imports no local module at runtime and
 * only types from the SDK, so run.mjs can load it with Node's type stripping.
 *
 * The model never sees the tool's test envelope (LOCALSTACK_AZ_TEST_ENVELOPE=1):
 * `splitEnvelope` removes it from every tool result before the tool_result is built, and
 * the runner keeps it for the record (exit code, class, egress refusals).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  Caps,
  EgressEvent,
  Envelope,
  McpResult,
  Price,
  ToolDef,
  TurnLog,
  Usage,
} from "./types";

// ── fixed settings ────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "high";
export const MAX_TOKENS = 16_000;
export const THINKING = { type: "adaptive", display: "summarized" } as const;
export const TOOL_CALL_TIMEOUT_S = 300;

/** The system prompt, identical for every variant. */
export const SYSTEM_PROMPT =
  "You operate a local Azure emulator (LocalStack for Azure) on behalf of a developer. " +
  "Everything you create lives in subscription 00000000-0000-0000-0000-000000000000; the " +
  "default location is westeurope unless the request says otherwise. Use the tools you have " +
  "been given to carry out the request. Do not ask the developer questions: if something is " +
  "ambiguous, make a reasonable choice and say what you chose. When you are finished, reply " +
  "with a short summary that states the outcome and names every resource you created, " +
  "changed, read or deleted.";

export const CAPS: Record<"T-A" | "T-B", Caps> = {
  "T-A": { turns: 20, toolCalls: 30, seconds: 600 },
  "T-B": { turns: 40, toolCalls: 60, seconds: 1800 },
};

/**
 * USD per million tokens, fixed so that runs stay comparable; the cache write is the
 * standard 1.25x (5-minute) one, except where a model's row says otherwise.
 * A model without a price cannot run: the spend cap needs one.
 */
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4.0, output: 20.0, cache_write: 5.0, cache_read: 0.2 },
  "claude-opus-5": { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.5 },
  "claude-fable-5-1": { input: 10.0, output: 50.0, cache_write: 12.5, cache_read: 0.25 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cache_write: 2.5, cache_read: 0.2 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.1 },
};

export function priceFor(model: string): Price | undefined {
  return PRICES[model];
}

// ── tokens and cost ───────────────────────────────────────────────────────────

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function usageOf(u: UsageLike | null | undefined): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cache_write: u?.cache_creation_input_tokens ?? 0,
    cache_read: u?.cache_read_input_tokens ?? 0,
  };
}

export interface Totals extends Usage {
  /** "Initial tokens": the whole first request (system + tool catalogue + prompt). */
  initial: number;
}

export function totals(turns: ReadonlyArray<{ usage: Usage }>): Totals {
  const t = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  for (const turn of turns) {
    t.input += turn.usage.input;
    t.output += turn.usage.output;
    t.cache_write += turn.usage.cache_write;
    t.cache_read += turn.usage.cache_read;
  }
  const first = turns[0]?.usage;
  return { ...t, initial: first ? first.input + first.cache_write + first.cache_read : 0 };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Billed cost: each turn priced exactly as the API reported it. */
export function costUsd(turns: ReadonlyArray<{ usage: Usage }>, price: Price): number {
  const t = totals(turns);
  return round6(
    (t.input * price.input +
      t.output * price.output +
      t.cache_write * price.cache_write +
      t.cache_read * price.cache_read) /
      1_000_000
  );
}

/**
 * Cost as if the first turn found the shared prefix (tool catalogue + system prompt)
 * already cached ("warm") or not cached ("cold"); later turns are priced as billed. The
 * gate's cost per completed task uses the warm price.
 */
export function pricedCostUsd(
  turns: ReadonlyArray<{ usage: Usage }>,
  prefixTokens: number | null | undefined,
  state: "warm" | "cold",
  price: Price
): number | null {
  if (turns.length === 0) return 0;
  if (prefixTokens === null || prefixTokens === undefined) return null;
  const first = { ...turns[0].usage };
  if (state === "warm") {
    let need = Math.max(0, prefixTokens - first.cache_read);
    for (const src of ["cache_write", "input"] as const) {
      const moved = Math.min(need, first[src]);
      first[src] -= moved;
      first.cache_read += moved;
      need -= moved;
    }
  } else {
    const moved = Math.min(prefixTokens, first.cache_read);
    first.cache_read -= moved;
    first.cache_write += moved;
  }
  return costUsd([{ usage: first }, ...turns.slice(1)], price);
}

// ── the test envelope and egress events ───────────────────────────────────────

function isEnvelope(v: unknown): v is Envelope {
  return (
    typeof v === "object" &&
    v !== null &&
    "exitCode" in v &&
    "stdout" in v &&
    "stderr" in v &&
    "classId" in v
  );
}

export interface SplitResult {
  /** What the model sees: the tool's text items without the envelope. */
  text: string;
  envelope: Envelope | null;
  isError: boolean;
}

/**
 * Splits an MCP result into the model-visible text and the test envelope (the last text
 * item, when it is the envelope JSON). Only the text goes into a tool_result.
 */
export function splitEnvelope(result: McpResult | null | undefined): SplitResult {
  const items = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "");
  let envelope: Envelope | null = null;
  if (items.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(items[items.length - 1]);
      if (isEnvelope(parsed)) {
        envelope = parsed;
        items.pop();
      }
    } catch {
      // not an envelope: every item stays visible
    }
  }
  return { text: items.join("\n"), envelope, isError: Boolean(result?.isError) };
}

const BLOCKED_NOTE = "Note: the egress guard blocked a connection to";
const HOUSEKEEPING_NOTE = "Note: the egress guard also blocked";

function hostsIn(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * The egress refusals of one tool call: an `egress-refused` failure class, or a note that
 * the guard blocked a host while the command still succeeded. Housekeeping blocks (update
 * checks the tool always refuses) are not egress events; they are returned apart.
 */
export function egressOf(
  call: number,
  command: string,
  text: string,
  envelope: Envelope | null
): { events: EgressEvent[]; housekeeping: string[] } {
  const events: EgressEvent[] = [];
  const housekeeping: string[] = [];
  const notes = envelope?.notes ?? [];
  if (envelope?.classId === "egress-refused") {
    const line = /Blocked (.*?): this tool only lets/.exec(text);
    events.push({
      call,
      command,
      classId: envelope.classId,
      hosts: line ? hostsIn(line[1]) : [],
      source: "classId",
    });
  }
  for (const note of notes) {
    if (note.startsWith(BLOCKED_NOTE)) {
      events.push({
        call,
        command,
        classId: envelope?.classId ?? null,
        hosts: hostsIn(note),
        source: "note",
      });
    } else if (note.startsWith(HOUSEKEEPING_NOTE)) {
      housekeeping.push(...hostsIn(note));
    }
  }
  if (!envelope && text.includes(BLOCKED_NOTE)) {
    const note = text.slice(text.indexOf(BLOCKED_NOTE)).split("\n")[0];
    events.push({ call, command, classId: null, hosts: hostsIn(note), source: "note" });
  }
  return { events, housekeeping };
}

// ── the agent loop ────────────────────────────────────────────────────────────

/** What a tool call returns to the loop: the model-visible text plus the record. */
export interface ToolOutcome {
  text: string;
  isError: boolean;
  ms: number;
  envelope: Envelope | null;
  /** The command the Azure tool ran, when the call went to it. */
  command?: string;
}

export interface ToolTrace {
  name: string;
  args: unknown;
  ms: number;
  is_error: boolean;
  ok: boolean;
  head: string;
  exit_code?: number | null;
  class_id?: string | null;
  truncated?: boolean;
  stopped_by_tool?: boolean;
  stdout_chars?: number;
}

export interface AgentRun {
  final_text: string;
  stop: string;
  /** cap_exceeded | spend_cap | account_error | infra_error | api_error | any stop_reason but end_turn. */
  failure: string | null;
  refusal: boolean;
  stop_details: unknown;
  turns: TurnLog[];
  tool_calls: ToolTrace[];
  egress: EgressEvent[];
  housekeeping: string[];
  wall_ms: number;
}

/** The part of the SDK client the loop uses (the tests pass a fake). */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export type ErrorClass = "account_error" | "infra_error" | "api_error";

type ErrorCtor = abstract new (...args: never[]) => unknown;

/** The SDK's typed error classes the classifier needs (run.mjs passes the real ones). */
export interface ErrorClasses {
  AuthenticationError: ErrorCtor;
  PermissionDeniedError: ErrorCtor;
  APIConnectionError: ErrorCtor;
  RateLimitError: ErrorCtor;
  InternalServerError: ErrorCtor;
}

/**
 * Error classes, on the SDK's typed errors. An
 * account error (invalid or revoked key, no credit, a spend limit) stops the campaign
 * unscored; an infrastructure error (connection, 429, 5xx after the SDK's retries) is not
 * scored either; anything else (a 400) is the run's own failure.
 */
export function makeErrorClassifier(c: ErrorClasses): (e: unknown) => ErrorClass {
  return (e) => {
    const err = e as {
      status?: unknown;
      type?: unknown;
      error?: { error?: { type?: unknown } };
      message?: unknown;
    };
    if (e instanceof c.AuthenticationError || e instanceof c.PermissionDeniedError)
      return "account_error";
    const type = err?.type ?? err?.error?.error?.type;
    const text = String(err?.message ?? "").toLowerCase();
    if (err?.status === 402 || type === "billing_error") return "account_error";
    if (
      ["credit balance", "billing", "spend limit", "usage limit", "quota"].some((w) =>
        text.includes(w)
      )
    )
      return "account_error";
    if (
      e instanceof c.APIConnectionError ||
      e instanceof c.RateLimitError ||
      e instanceof c.InternalServerError
    )
      return "infra_error";
    const status = err?.status;
    if (typeof status === "number" && (status === 429 || status >= 500)) return "infra_error";
    return "api_error";
  };
}

export interface AgentOptions {
  client: MessagesClient;
  model: string;
  effort: string;
  maxTokens?: number;
  system?: string;
  tools: ToolDef[];
  prompt: string;
  caps: Caps;
  price: Price;
  /** Stops the loop before a request once the run's cost reaches it. */
  perRunUsd: number;
  /**
   * What is left of the campaign's cap, net of every turn already billed, this run's and
   * any concurrent run's (`onCost` reports each turn as it lands).
   */
  remainingUsd: () => number;
  /** Called with each turn's cost as soon as the API reports it. */
  onCost?: (usd: number) => void;
  callTool: (name: string, input: Record<string, unknown>) => Promise<ToolOutcome>;
  classifyError: (e: unknown) => ErrorClass;
  scrub: (text: string) => string;
  now?: () => number;
}

/**
 * The system prompt with an explicit cache breakpoint on its last block: tools render
 * before system, so this entry holds the whole shared prefix (tool catalogue + system
 * prompt), which every task reads; the top-level automatic breakpoint caches each task's
 * growing conversation.
 */
export function systemBlocks(system: string = SYSTEM_PROMPT): Anthropic.TextBlockParam[] {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

function errorText(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name || e.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message.slice(0, 300)}`;
}

export async function runAgent(o: AgentOptions): Promise<AgentRun> {
  const now = o.now ?? (() => Date.now());
  const res: AgentRun = {
    final_text: "",
    stop: "",
    failure: null,
    refusal: false,
    stop_details: null,
    turns: [],
    tool_calls: [],
    egress: [],
    housekeeping: [],
    wall_ms: 0,
  };
  const t0 = now();
  const system = systemBlocks(o.system ?? SYSTEM_PROMPT);
  const tools = o.tools as unknown as Anthropic.Tool[];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.prompt }];
  for (;;) {
    if (
      res.turns.length >= o.caps.turns ||
      res.tool_calls.length >= o.caps.toolCalls ||
      now() - t0 > o.caps.seconds * 1000
    ) {
      res.failure = "cap_exceeded";
      break;
    }
    if (costUsd(res.turns, o.price) >= o.perRunUsd || o.remainingUsd() <= 0) {
      res.failure = "spend_cap";
      break;
    }
    const t = now();
    let resp: Anthropic.Message;
    try {
      resp = await o.client.messages.create({
        model: o.model,
        max_tokens: o.maxTokens ?? MAX_TOKENS,
        system,
        tools,
        messages,
        thinking: THINKING,
        output_config: { effort: o.effort as Anthropic.OutputConfig["effort"] },
        cache_control: { type: "ephemeral" },
      });
    } catch (e) {
      // The SDK has already retried 429/5xx/connection errors.
      res.failure = o.classifyError(e);
      res.stop = o.scrub(errorText(e));
      break;
    }
    const turn: TurnLog = {
      ms: now() - t,
      stop_reason: resp.stop_reason,
      usage: usageOf(resp.usage),
    };
    if (resp.stop_details) turn.stop_details = resp.stop_details;
    res.turns.push(turn);
    o.onCost?.(costUsd([turn], o.price));
    // Replay the assistant turn unmodified: Claude Opus 5.5 binds thinking blocks to the
    // conversation (preserved thinking), and an untouched prefix keeps the cache valid.
    messages.push({ role: "assistant", content: resp.content });
    res.stop = resp.stop_reason ?? "";

    if (resp.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const out = await o.callTool(block.name, input);
        const index = res.tool_calls.length;
        res.tool_calls.push({
          name: block.name,
          args: input,
          ms: Math.round(out.ms * 100) / 100,
          is_error: out.isError,
          ok: !out.text.trimStart().startsWith("❌"),
          head: out.text.slice(0, 300),
          ...(out.envelope
            ? {
                exit_code: out.envelope.exitCode,
                class_id: out.envelope.classId,
                truncated: Boolean(out.envelope.truncated),
                stopped_by_tool: Boolean(out.envelope.stoppedByTool),
                stdout_chars: (out.envelope.stdout || "").length,
              }
            : {}),
        });
        const egress = egressOf(index, out.command ?? "", out.text, out.envelope);
        res.egress.push(...egress.events);
        res.housekeeping.push(...egress.housekeeping);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: out.text || "(no output)",
          is_error: out.isError,
        });
      }
      if (results.length) messages.push({ role: "user", content: results });
      continue;
    }
    if (resp.stop_reason === "pause_turn") continue;
    if (resp.stop_reason === "refusal") {
      res.refusal = true;
      res.stop_details = resp.stop_details ?? null;
    }
    if (resp.stop_reason !== "end_turn") res.failure = resp.stop_reason || "no_stop_reason";
    res.final_text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    break;
  }
  res.wall_ms = now() - t0;
  return res;
}

/**
 * Writes the shared prefix to the cache before the first task, and measures it: a
 * `max_tokens: 0` request runs prefill only and bills no output. It carries the same
 * thinking and effort settings as the real traffic and no top-level cache_control.
 */
export async function prewarm(
  client: MessagesClient,
  model: string,
  effort: string,
  tools: ToolDef[],
  system: string = SYSTEM_PROMPT
): Promise<{ usage: Usage; prefix_tokens: number }> {
  const resp = await client.messages.create({
    model,
    max_tokens: 0,
    system: systemBlocks(system),
    tools: tools as unknown as Anthropic.Tool[],
    messages: [{ role: "user", content: "warmup" }],
    thinking: THINKING,
    output_config: { effort: effort as Anthropic.OutputConfig["effort"] },
  });
  const usage = usageOf(resp.usage);
  return { usage, prefix_tokens: usage.cache_write + usage.cache_read };
}
