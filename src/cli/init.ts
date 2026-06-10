import * as p from "@clack/prompts";
import * as os from "os";
import * as path from "path";
import { parseInitFlags } from "../lib/wizard/cli-args.logic";
import { CLIENT_ADAPTERS } from "../lib/wizard/clients/registry";
import { ClientAdapter, ClientContext, DetectResult } from "../lib/wizard/clients/types";
import { parseEnvVarsInput } from "../lib/wizard/env-parser.logic";
import { checkPrereqs } from "../lib/wizard/prereqs";
import { buildDockerServerSpec, buildNpxServerSpec } from "../lib/wizard/server-config.logic";
import {
  AUTH_TOKEN_ENV,
  ClientId,
  DockerOptions,
  InstallMethod,
  ServerSpec,
  WizardAnswers,
} from "../lib/wizard/types";
import { HELP_TEXT } from "./help";
import {
  ClientOutcome,
  createProgress,
  ensureAnswer,
  EXIT_CANCELLED,
  EXIT_ERROR,
  EXIT_OK,
  formatOutcomeLines,
  isInteractive,
  printPrereqResults,
} from "./ui";

function buildContext(): ClientContext {
  return { platform: process.platform, homeDir: os.homedir(), env: process.env };
}

function expandPath(input: string, homeDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, homeDir);
  return path.resolve(expanded);
}

interface DetectedClient {
  adapter: ClientAdapter;
  detection: DetectResult;
}

async function detectClients(ctx: ClientContext): Promise<DetectedClient[]> {
  return Promise.all(
    CLIENT_ADAPTERS.map(async (adapter) => ({ adapter, detection: await adapter.detect(ctx) }))
  );
}

async function resolveMethod(
  flagMethod: InstallMethod | undefined,
  interactive: boolean,
  yes: boolean,
  ctx: ClientContext
): Promise<InstallMethod | null> {
  let method = flagMethod;
  if (!method && interactive && !yes) {
    method = ensureAnswer(
      await p.select<InstallMethod>({
        message: "How do you want to run the MCP server?",
        options: [
          {
            value: "npx",
            label: "npx (Node on this machine)",
            hint: "needs Node 20+, LocalStack CLI, and Docker",
          },
          {
            value: "docker",
            label: "Docker (self-contained image)",
            hint:
              ctx.platform === "win32"
                ? "not yet supported on Windows"
                : "only Docker required on the host",
          },
        ],
        initialValue: "npx",
      })
    );
  }
  method = method ?? "npx";

  if (method === "docker" && ctx.platform === "win32") {
    p.log.error(
      "The Docker install method isn't supported on Windows yet — use npx, or run the wizard inside WSL."
    );
    return null;
  }
  return method;
}

async function resolveToken(
  flagToken: string | undefined,
  interactive: boolean
): Promise<string | null> {
  if (flagToken?.trim()) return flagToken.trim();

  const fromEnv = process.env[AUTH_TOKEN_ENV]?.trim();
  if (fromEnv) {
    p.log.info(`Using ${AUTH_TOKEN_ENV} from your environment.`);
    return fromEnv;
  }

  if (!interactive) {
    p.log.error(
      `No auth token found. Set ${AUTH_TOKEN_ENV} or pass --token. Get yours at https://app.localstack.cloud/workspace/auth-tokens`
    );
    return null;
  }

  const token = ensureAnswer(
    await p.password({
      message: `${AUTH_TOKEN_ENV} (from https://app.localstack.cloud/workspace/auth-tokens)`,
      validate: (value) => (value && value.trim() ? undefined : "An auth token is required"),
    })
  ).trim();

  if (!token.startsWith("ls-")) {
    p.log.warn('This token does not start with "ls-" — double-check it if tools fail later.');
  }
  return token;
}

interface DockerFlagInputs {
  cacheDir?: string;
  workspace?: string;
  imageTag?: string;
}

async function resolveDockerOptions(
  flags: DockerFlagInputs,
  interactive: boolean,
  yes: boolean,
  ctx: ClientContext
): Promise<DockerOptions> {
  const defaults = {
    cacheDir: path.join(ctx.homeDir, ".localstack-mcp"),
    workspace: process.cwd(),
    imageTag: "latest",
  };

  const prompts = interactive && !yes;

  const cacheDir = flags.cacheDir
    ? expandPath(flags.cacheDir, ctx.homeDir)
    : prompts
      ? expandPath(
          ensureAnswer(
            await p.text({
              message: "State/cache directory (mounted into the container)",
              initialValue: defaults.cacheDir,
              validate: (value) => (value?.trim() ? undefined : "A directory is required"),
            })
          ),
          ctx.homeDir
        )
      : defaults.cacheDir;

  // flags.workspace === "" is meaningful: skip the workspace mount.
  const workspaceRaw =
    flags.workspace !== undefined
      ? flags.workspace
      : prompts
        ? ensureAnswer(
            await p.text({
              message: "Workspace to mount for IaC deployments (clear to skip)",
              initialValue: defaults.workspace,
            })
          )
        : defaults.workspace;
  const workspace = expandPath(workspaceRaw, ctx.homeDir);

  const imageTag = flags.imageTag?.trim()
    ? flags.imageTag.trim()
    : prompts
      ? ensureAnswer(
          await p.text({
            message: "Docker image tag",
            initialValue: defaults.imageTag,
            validate: (value) => (value?.trim() ? undefined : "A tag is required"),
          })
        ).trim()
      : defaults.imageTag;

  return { cacheDir, workspaceDir: workspace || undefined, imageTag };
}

async function resolveExtraEnv(
  flagConfig: string | undefined,
  method: InstallMethod,
  interactive: boolean,
  yes: boolean
): Promise<Record<string, string> | null> {
  let input = flagConfig;
  if (input === undefined && interactive && !yes) {
    input = ensureAnswer(
      await p.text({
        message: "Extra LocalStack config vars, e.g. DEBUG=1,PERSISTENCE=1 (leave empty to skip)",
        defaultValue: "",
        placeholder: "KEY=value,KEY2=value2",
        validate: (value) => {
          if (!value?.trim()) return undefined;
          const { errors } = parseEnvVarsInput(value);
          return errors.length > 0 ? errors.join("; ") : undefined;
        },
      })
    );
  }
  if (!input?.trim()) return {};

  const { env, errors } = parseEnvVarsInput(input);
  if (errors.length > 0) {
    p.log.error(`Invalid --config: ${errors.join("; ")}`);
    return null;
  }
  if (method === "docker" && env.LOCALSTACK_HOSTNAME) {
    p.log.warn(
      "Overriding LOCALSTACK_HOSTNAME with the Docker method can break container networking — the image relies on host.docker.internal."
    );
  }
  return env;
}

async function resolveClients(
  flagClients: ClientId[] | undefined,
  detected: DetectedClient[],
  interactive: boolean,
  yes: boolean
): Promise<ClientId[] | null> {
  const byId = new Map(detected.map((entry) => [entry.adapter.id, entry]));

  if (flagClients && flagClients.length > 0) {
    for (const id of flagClients) {
      const entry = byId.get(id);
      if (entry?.detection.unsupportedReason) {
        p.log.error(`${entry.adapter.label}: ${entry.detection.unsupportedReason}`);
        return null;
      }
      if (id === "codex" && !entry?.detection.installed) {
        p.log.error("Codex is managed via its CLI, but `codex` was not found on your PATH.");
        return null;
      }
      if (id === "claude-code" && !entry?.detection.installed) {
        p.log.error("Claude Code is managed via its CLI, but `claude` was not found on your PATH.");
        return null;
      }
    }
    return flagClients;
  }

  const detectedIds = detected
    .filter((entry) => entry.detection.installed)
    .map((entry) => entry.adapter.id);

  if (!interactive || yes) {
    if (detectedIds.length === 0) {
      p.log.error("No MCP clients detected. Pass --client to choose explicitly.");
      return null;
    }
    p.log.info(`Configuring detected clients: ${detectedIds.join(", ")}`);
    return detectedIds;
  }

  const options = detected
    // Codex is CLI-managed: only offer it when the binary is present.
    .filter((entry) => entry.adapter.id !== "codex" || entry.detection.installed)
    .filter((entry) => !entry.detection.unsupportedReason)
    .map((entry) => ({
      value: entry.adapter.id,
      label: entry.adapter.label,
      hint: entry.detection.installed ? "detected" : undefined,
    }));

  const selection = ensureAnswer(
    await p.multiselect<ClientId>({
      message: "Select the MCP clients to configure",
      options,
      initialValues: detectedIds,
      required: true,
    })
  );
  return selection;
}

async function installIntoClients(
  clients: ClientId[],
  detected: DetectedClient[],
  spec: ServerSpec,
  ctx: ClientContext,
  force: boolean,
  interactive: boolean,
  yes: boolean
): Promise<ClientOutcome[]> {
  const byId = new Map(detected.map((entry) => [entry.adapter.id, entry.adapter]));
  const outcomes: ClientOutcome[] = [];

  for (const clientId of clients) {
    const adapter = byId.get(clientId)!;
    const existing = await adapter.getExisting(ctx);

    for (const warning of existing.warnings ?? []) {
      p.log.warn(warning);
    }

    if (existing.error) {
      outcomes.push({
        clientId,
        label: adapter.label,
        outcome: { status: "failed", detail: existing.error },
      });
      continue;
    }

    if (existing.entries.length > 0 && !force) {
      const summary = existing.entries
        .map((entry) => `"${entry.key}" (${entry.method})`)
        .join(" and ");
      // --yes means "don't ask": keep existing entries, like non-interactive
      // runs. Overwriting without a prompt requires the explicit --force.
      if (!interactive || yes) {
        outcomes.push({
          clientId,
          label: adapter.label,
          outcome: {
            status: "skipped",
            detail: `existing ${summary} entry — re-run with --force to overwrite`,
          },
        });
        continue;
      }
      const overwrite = await p.confirm({
        message: `${adapter.label} already has ${summary}. Overwrite with the new config?`,
        initialValue: true,
      });
      if (p.isCancel(overwrite)) {
        // Earlier clients in this loop may already be configured — report
        // what happened instead of pretending nothing was written.
        outcomes.push({
          clientId,
          label: adapter.label,
          outcome: { status: "skipped", detail: "cancelled" },
        });
        for (const remaining of clients.slice(clients.indexOf(clientId) + 1)) {
          outcomes.push({
            clientId: remaining,
            label: byId.get(remaining)!.label,
            outcome: { status: "skipped", detail: "cancelled" },
          });
        }
        p.log.warn("Cancelled — see the summary below for what was already configured.");
        return outcomes;
      }
      if (!overwrite) {
        outcomes.push({
          clientId,
          label: adapter.label,
          outcome: { status: "skipped", detail: "kept the existing entry" },
        });
        continue;
      }
    }

    const progress = createProgress();
    progress.start(`Configuring ${adapter.label}…`);
    const outcome = await adapter.install(spec, ctx);
    progress.stop(
      `${adapter.label}: ${outcome.status === "installed" ? "configured" : outcome.status}`
    );
    outcomes.push({ clientId, label: adapter.label, outcome, restartNote: adapter.restartNote });
  }

  return outcomes;
}

function printSummary(outcomes: ClientOutcome[], answers: WizardAnswers): void {
  const lines = [formatOutcomeLines(outcomes)];

  const restartNotes = outcomes
    .filter((entry) => entry.outcome.status === "installed" && entry.restartNote)
    .map((entry) => `• ${entry.restartNote}`);
  if (restartNotes.length > 0) {
    lines.push("", "Next steps:", ...restartNotes);
  }
  if (
    answers.method === "docker" &&
    outcomes.some((entry) => entry.outcome.status === "installed")
  ) {
    lines.push(
      "",
      "The first run pulls the localstack/localstack-mcp-server image (~1.7 GB) — give it a minute."
    );
  }
  p.note(lines.join("\n"), "Setup summary");
}

export async function runInit(argv: string[]): Promise<number> {
  const { flags, errors } = parseInitFlags(argv);
  if (!flags) {
    for (const error of errors) console.error(`Error: ${error}`);
    console.error('Run "init --help" for usage.');
    return EXIT_ERROR;
  }
  if (flags.help) {
    console.log(HELP_TEXT);
    return EXIT_OK;
  }

  const ctx = buildContext();
  const interactive = isInteractive();

  if (!interactive && !flags.yes && (!flags.method || !flags.clients)) {
    console.error(
      "Error: non-interactive runs need --method and --client (or --yes to use detected defaults)."
    );
    return EXIT_ERROR;
  }

  p.intro("🚀 LocalStack MCP Server Setup");

  // Close the clack frame on every abort so output never looks truncated.
  const abort = (): number => {
    p.cancel("Setup aborted — nothing was written.");
    return EXIT_ERROR;
  };

  const method = await resolveMethod(flags.method, interactive, flags.yes, ctx);
  if (!method) return abort();

  const prereqProgress = createProgress();
  prereqProgress.start("Checking prerequisites…");
  const prereqs = await checkPrereqs(method);
  prereqProgress.stop("Prerequisite checks");
  const { fatal } = printPrereqResults(prereqs);
  if (fatal) {
    p.cancel("Fix the failed prerequisite above and re-run the wizard.");
    return EXIT_ERROR;
  }

  const token = await resolveToken(flags.token, interactive);
  if (token === null) return abort();

  const docker =
    method === "docker"
      ? await resolveDockerOptions(
          { cacheDir: flags.cacheDir, workspace: flags.workspace, imageTag: flags.imageTag },
          interactive,
          flags.yes,
          ctx
        )
      : undefined;

  const extraEnv = await resolveExtraEnv(flags.config, method, interactive, flags.yes);
  if (extraEnv === null) return abort();

  const detectProgress = createProgress();
  detectProgress.start("Detecting MCP clients…");
  const detected = await detectClients(ctx);
  detectProgress.stop(
    `Detected: ${
      detected
        .filter((entry) => entry.detection.installed)
        .map((entry) => entry.adapter.label)
        .join(", ") || "none"
    }`
  );

  const clients = await resolveClients(flags.clients, detected, interactive, flags.yes);
  if (!clients) return abort();

  const spec =
    method === "docker"
      ? buildDockerServerSpec(token, extraEnv, docker!)
      : buildNpxServerSpec(token, extraEnv);

  const answers: WizardAnswers = { method, token, extraEnv, docker, clients, force: flags.force };
  const outcomes = await installIntoClients(
    clients,
    detected,
    spec,
    ctx,
    flags.force,
    interactive,
    flags.yes
  );

  printSummary(outcomes, answers);

  const failed = outcomes.filter((entry) => entry.outcome.status === "failed");
  const installed = outcomes.filter((entry) => entry.outcome.status === "installed");
  if (failed.length > 0) {
    p.outro(`Done with errors — ${failed.length} client(s) failed (see above).`);
    return EXIT_ERROR;
  }
  if (installed.length === 0) {
    p.outro("Nothing was changed — re-run with --force to overwrite existing entries.");
    return EXIT_OK;
  }
  p.outro("✅ All set! Open your MCP client and ask it to start LocalStack.");
  return EXIT_OK;
}

export { EXIT_CANCELLED };
