// Shared helpers of the live Azure suites (plan section 5.4: L2, L3, L4, DR). The
// suites call the tool handler in-process, so they share this process's egress guard
// and can read its records; az's exact stdout comes from the test envelope
// (LOCALSTACK_AZ_TEST_ENVELOPE=1, review R02 N2), never from the tool's prose.
import { mkdirSync, mkdtempSync } from "fs";
import os from "os";
import path from "path";
import type { ResultEnvelope } from "../../../src/lib/azure/output";
import type { EgressEvent } from "../../../src/lib/azure/types";

export const LIVE = process.env.AZURE_LIVE === "1";
/** Live suites skip themselves unless AZURE_LIVE=1. */
export const describeLive = LIVE ? describe : describe.skip;

export interface LiveEnv {
  root: string;
  configDir: string;
  workdir: string;
}

let liveEnv: LiveEnv | undefined;

/**
 * Point the Azure tool at a private config dir and workdir before the tool module is
 * loaded (it reads its configuration once per process). The auth token only has to be
 * present (D5): the tool never sends it anywhere, so a dummy is used when none is set.
 */
export function setupLiveEnv(): LiveEnv {
  if (liveEnv) return liveEnv;
  const root = mkdtempSync(path.join(os.tmpdir(), "lsaz-live-"));
  const configDir = process.env.LOCALSTACK_AZ_CONFIG_DIR || path.join(root, "azure-config");
  const workdir = process.env.LOCALSTACK_AZ_WORKDIR || path.join(root, "work");
  mkdirSync(workdir, { recursive: true });
  process.env.LOCALSTACK_AZ_CONFIG_DIR = configDir;
  process.env.LOCALSTACK_AZ_WORKDIR = workdir;
  process.env.LOCALSTACK_AZ_TEST_ENVELOPE = "1";
  process.env.MCP_ANALYTICS_DISABLED = "1";
  process.env.LOCALSTACK_AUTH_TOKEN ||= "ls-live-tests-presence-only";
  liveEnv = { root, configDir, workdir };
  return liveEnv;
}

/** A short unique id for resource names: lower-case letters and digits only. */
export function runId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
}

/** Names that respect each provider's rules (storage: 3-24 lower-case alphanumerics). */
export const names = {
  group: (id: string) => `mcp-${id}-rg`,
  storage: (id: string) => `mcp${id}`.replace(/[^a-z0-9]/g, "").slice(0, 24),
  container: (id: string) => `mcp-${id}-c`.slice(0, 63),
  vault: (id: string) => `mcp${id}kv`.replace(/[^a-z0-9]/g, "").slice(0, 24),
  generic: (id: string, kind: string) => `mcp-${id}-${kind}`.slice(0, 60),
};

export interface AzCall {
  command: string;
  /** The tool's text answer (first content item). */
  text: string;
  envelope?: ResultEnvelope;
  exitCode: number | null;
  /** az's stdout exactly, from the envelope ("" for tool refusals). */
  stdout: string;
  classId: string | null;
  ms: number;
  /** True when the tool answered without an error. */
  ok: boolean;
}

type Tool = typeof import("../../../src/tools/localstack-azure-client");

function tool(): Tool {
  setupLiveEnv();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../src/tools/localstack-azure-client") as Tool;
}

/** Run one command through the real tool handler. */
export async function az(command: string, extra?: Parameters<Tool["default"]>[1]): Promise<AzCall> {
  const started = Date.now();
  const result = (await tool().default({ command }, extra)) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content[0]?.text ?? "";
  let envelope: ResultEnvelope | undefined;
  try {
    envelope = result.content[1]
      ? (JSON.parse(result.content[1].text) as ResultEnvelope)
      : undefined;
  } catch {
    envelope = undefined;
  }
  return {
    command,
    text,
    envelope,
    exitCode: envelope?.exitCode ?? null,
    stdout: envelope?.stdout ?? "",
    classId: envelope?.classId ?? null,
    ms: Date.now() - started,
    ok: !text.startsWith("❌"),
  };
}

/** az's stdout as JSON (throws with the tool's answer when it is not JSON). */
export function json<T = unknown>(call: AzCall): T {
  try {
    return JSON.parse(call.stdout) as T;
  } catch {
    throw new Error(`\`az ${call.command}\` did not print JSON:\n${call.text.slice(0, 2000)}`);
  }
}

/** Poll a command until its result satisfies a predicate (LROs, provisioningState). */
export async function waitFor(
  command: string,
  predicate: (call: AzCall) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<AzCall> {
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  let last = await az(command);
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5_000));
    last = await az(command);
  }
  if (!predicate(last))
    throw new Error(`timed out waiting on \`az ${command}\`:\n${last.text.slice(0, 2000)}`);
  return last;
}

export interface EgressLog {
  events: Array<EgressEvent & { callId: string }>;
  stop(): void;
}

/** Record every egress-guard event of this process (L3). Undefined with the guard off. */
export async function recordEgress(): Promise<EgressLog | undefined> {
  setupLiveEnv();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const services =
    require("../../../src/lib/azure/services") as typeof import("../../../src/lib/azure/services");
  const proxy = await services.egressGuard();
  if (!proxy) return undefined;
  const events: EgressLog["events"] = [];
  const stop = proxy.onEvent((callId, event) => events.push({ callId, ...event }));
  return { events, stop };
}

/** Best-effort cleanup: delete a group without waiting (and never fail a test on it). */
export async function deleteGroup(name: string): Promise<void> {
  await az(`group delete --name ${name} --yes --no-wait`).catch(() => undefined);
}
