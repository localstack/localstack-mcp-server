import * as p from "@clack/prompts";
import * as os from "os";
import { parseRemoveFlags } from "../lib/wizard/cli-args.logic";
import { CLIENT_ADAPTERS, getClientAdapter } from "../lib/wizard/clients/registry";
import { ClientContext } from "../lib/wizard/clients/types";
import { ClientId } from "../lib/wizard/types";
import { HELP_TEXT } from "./help";
import {
  ClientOutcome,
  createProgress,
  ensureAnswer,
  EXIT_ERROR,
  EXIT_OK,
  formatOutcomeLines,
  isInteractive,
} from "./ui";

export async function runRemove(argv: string[]): Promise<number> {
  const { flags, errors } = parseRemoveFlags(argv);
  if (!flags) {
    for (const error of errors) console.error(`Error: ${error}`);
    console.error('Run "remove --help" for usage.');
    return EXIT_ERROR;
  }
  if (flags.help) {
    console.log(HELP_TEXT);
    return EXIT_OK;
  }

  const ctx: ClientContext = {
    platform: process.platform,
    homeDir: os.homedir(),
    env: process.env,
  };
  const interactive = isInteractive();

  if (!interactive && (!flags.clients || flags.clients.length === 0) && !flags.force) {
    console.error("Error: non-interactive runs need --client or --force.");
    return EXIT_ERROR;
  }

  p.intro("LocalStack MCP Server — remove");

  let targets: ClientId[];
  if (flags.clients && flags.clients.length > 0) {
    targets = flags.clients;
  } else {
    const spin = createProgress();
    spin.start("Looking for LocalStack entries…");
    const withEntries: { id: ClientId; label: string; keys: string[] }[] = [];
    const uninspectable: string[] = [];
    for (const adapter of CLIENT_ADAPTERS) {
      const existing = await adapter.getExisting(ctx);
      if (existing.error) {
        uninspectable.push(`${adapter.label}: ${existing.error}`);
        continue;
      }
      if (existing.entries.length > 0) {
        withEntries.push({
          id: adapter.id,
          label: adapter.label,
          keys: existing.entries.map((entry) => entry.key),
        });
      }
    }
    spin.stop(
      withEntries.length > 0
        ? `Found entries in: ${withEntries.map((entry) => entry.label).join(", ")}`
        : "No LocalStack entries found in any client."
    );
    for (const warning of uninspectable) {
      p.log.warn(`Could not inspect ${warning} — target it explicitly with --client if needed.`);
    }
    if (withEntries.length === 0) {
      p.outro("Nothing to remove.");
      return EXIT_OK;
    }

    if (interactive && !flags.force) {
      targets = ensureAnswer(
        await p.multiselect<ClientId>({
          message: "Remove the LocalStack MCP server from:",
          options: withEntries.map((entry) => ({
            value: entry.id,
            label: entry.label,
            hint: entry.keys.join(", "),
          })),
          initialValues: withEntries.map((entry) => entry.id),
          required: true,
        })
      );
    } else {
      targets = withEntries.map((entry) => entry.id);
    }
  }

  if (interactive && !flags.force) {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: `Remove the LocalStack entry from ${targets.length} client(s)?`,
        initialValue: true,
      })
    );
    if (!confirmed) {
      p.cancel("Nothing was removed.");
      return EXIT_OK;
    }
  }

  const outcomes: ClientOutcome[] = [];
  for (const clientId of targets) {
    const adapter = getClientAdapter(clientId);
    const progress = createProgress();
    progress.start(`Updating ${adapter.label}…`);
    const outcome = await adapter.remove(ctx);
    progress.stop(
      `${adapter.label}: ${outcome.status === "installed" ? "removed" : outcome.status}`
    );
    outcomes.push({ clientId, label: adapter.label, outcome });
  }

  p.note(formatOutcomeLines(outcomes), "Removal summary");

  const failed = outcomes.filter((entry) => entry.outcome.status === "failed");
  if (failed.length > 0) {
    p.outro(`Done with errors — ${failed.length} client(s) failed (see above).`);
    return EXIT_ERROR;
  }
  p.outro("Done. Restart the affected clients to apply the change.");
  return EXIT_OK;
}
