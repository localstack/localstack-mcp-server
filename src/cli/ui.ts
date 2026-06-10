import * as p from "@clack/prompts";
import { PrereqResult } from "../lib/wizard/prereqs";
import { ClientId, InstallOutcome } from "../lib/wizard/types";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CANCELLED = 130;

/** Unwraps a clack prompt result, exiting cleanly when the user hits Ctrl+C/Esc. */
export function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled — nothing was written.");
    process.exit(EXIT_CANCELLED);
  }
  return value as T;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface Progress {
  start(message: string): void;
  stop(message: string): void;
}

/** A clack spinner on TTYs; plain log lines when output is piped (CI, logs). */
export function createProgress(): Progress {
  if (process.stdout.isTTY) {
    const spin = p.spinner();
    return { start: (message) => spin.start(message), stop: (message) => spin.stop(message) };
  }
  return { start: () => {}, stop: (message) => p.log.step(message) };
}

export function printPrereqResults(results: PrereqResult[]): { fatal: boolean } {
  let fatal = false;
  for (const result of results) {
    if (result.ok) {
      p.log.success(`${result.name} ✓`);
    } else if (result.fatal) {
      fatal = true;
      p.log.error(`${result.name} ✗ — ${result.hint ?? "required"}`);
    } else {
      p.log.warn(`${result.name} ✗ — ${result.hint ?? "continuing anyway"}`);
    }
  }
  return { fatal };
}

export interface ClientOutcome {
  clientId: ClientId;
  label: string;
  outcome: InstallOutcome;
  restartNote?: string;
}

export function formatOutcomeLines(outcomes: ClientOutcome[]): string {
  return outcomes
    .map(({ label, outcome }) => {
      const symbol =
        outcome.status === "installed" ? "✓" : outcome.status === "skipped" ? "−" : "✗";
      return `${symbol} ${label}: ${outcome.detail}`;
    })
    .join("\n");
}
