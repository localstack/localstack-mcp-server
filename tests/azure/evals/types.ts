/**
 * Types shared by the E2 eval modules (plan section 5.6). Type declarations only: every
 * module imports this file with `import type`, which Node's type stripping erases, so the
 * modules can be loaded unbundled by `run.mjs` (Node 22.18+) and by ts-jest alike.
 */

/** The benchmark's tiers that E2 draws from. */
export type Tier = "T-A" | "T-B" | "T-APIM";

/**
 * One `az` answer as the tool returns it with LOCALSTACK_AZ_TEST_ENVELOPE=1: az's exact
 * stdout, stderr and exit code from the envelope, and the tool's text (what a model sees).
 */
export interface AzAnswer {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  classId: string | null;
  /** The tool's text answer (first content item), without the envelope. */
  text?: string;
  notes?: string[];
  stoppedByTool?: boolean;
}

/**
 * What a verifier or a fixture uses to read and change emulator state. The harness
 * implements it with a server session of its own (never the agent's), and the unit tests
 * with recorded answers and a fake clock.
 */
export interface Query {
  az(command: string): Promise<AzAnswer>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds, monotonic. */
  now(): number;
  /** How long a polling check waits for a state (the benchmark's VERIFY_WAIT_S, 90 s). */
  waitS: number;
}

/** Fixture values, filled into prompts, oracle commands and paths. Keys that start with
 * an underscore are internal (snapshots, `_oracle`) and never recorded as slots. */
export type Slots = Record<string, unknown>;

export interface StepResult {
  step: string;
  passed: boolean;
  reason: string;
}

export interface Verdict {
  passed: boolean;
  reason: string;
  /** A workflow's per-step results (T-B partial credit). */
  steps?: StepResult[];
}

/** Reads the outcome from the emulator (and, for read tasks, the answer text). */
export type Verify = (q: Query, slots: Slots, text: string) => Promise<Verdict>;

/** An oracle command: a template filled from the slots, or one computed from the
 * emulator just before it runs (the benchmark's `Late`). */
export type OracleStep = string | ((q: Query, slots: Slots) => Promise<string>);

/** What a task's setup gets: the harness query, the run's slots and random helpers. */
export interface SetupContext {
  q: Query;
  slots: Slots;
  rg: string;
  /** `prefix` + 6 hex characters (the benchmark's `_name`). */
  name(prefix: string): string;
  hex(chars: number): string;
  uuid(): string;
  pick<T>(options: readonly T[]): T;
  sample<T>(options: readonly T[], count: number): T[];
  randomInt(min: number, max: number): number;
  random(): number;
}

export interface Task {
  /** The benchmark's task id, kept as it was. */
  id: string;
  tier: Tier;
  /** The sampled operation (provider/OperationId). */
  opId: string;
  verb: string;
  /** One or two phrasings of the same request (T-A has two). */
  prompts: readonly string[];
  /** The benchmark's CLI oracle commands, in order. */
  oracle: readonly OracleStep[];
  verify: Verify;
  /** Creates the prerequisites through the harness session and fills the slots. */
  setup?: (ctx: SetupContext) => Promise<void>;
  /** Removes what a run leaves outside its resource group (subscription-scope records). */
  teardown?: (q: Query, slots: Slots) => Promise<void>;
  /** The benchmark's caps tier for the agent loop (T-APIM tasks use T-A's). */
  caps: "T-A" | "T-B";
  /** Read tasks whose answer is the same whatever the fixture (the benchmark's GUESSABLE). */
  guessable?: boolean;
  /** Key Vault crypto tasks: experiment 3 counts their refusals (risk R7). */
  kvCrypto?: boolean;
  /** Slots naming Key Vaults the run may create, purged in cleanup. */
  vaultSlots?: readonly string[];
  /** Slots naming App Configuration stores, purged in cleanup if soft-deleted. */
  appConfigSlots?: readonly string[];
  /** Slots naming API Management services, purged in cleanup if soft-deleted. */
  apimSlots?: readonly string[];
  /** Resource types (with an api-version) the end-of-run orphan sweep lists. */
  sweep?: readonly string[];
  /** Why the task differs from the benchmark (the port's own notes, like CLI_NOTES). */
  notes?: string;
}

/** Per-tier agent-loop caps (the benchmark's config.CAPS). */
export interface Caps {
  turns: number;
  toolCalls: number;
  seconds: number;
}

/** Token counts of one Messages API turn (the benchmark's `_usage`). */
export interface Usage {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface TurnLog {
  ms: number;
  stop_reason: string | null;
  usage: Usage;
  stop_details?: unknown;
}

/** Prices in USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/** The test envelope the tool appends with LOCALSTACK_AZ_TEST_ENVELOPE=1. */
export interface Envelope {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notes: string[];
  classId: string | null;
  truncated?: boolean;
  stoppedByTool?: boolean;
  emulatorSession?: string | null;
}

/** An egress refusal the tool reported during an agent's tool call. */
export interface EgressEvent {
  call: number;
  command: string;
  classId: string | null;
  hosts: string[];
  source: "classId" | "note";
}

/** A tool definition as the runner sends it to the Messages API. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** An MCP tools/call result (text items only matter here). */
export interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
