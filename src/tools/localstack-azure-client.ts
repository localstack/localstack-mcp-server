import { z } from "zod";
import { type InferSchema, type ToolExtraArguments, type ToolMetadata } from "xmcp";
import {
  requireAuthToken,
  requireAzureCli,
  requireAzureCliConfigured,
  requireAzureConfig,
  requireAzureEmulatorRunning,
  requireStack,
  runPreflights,
} from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { AZURE_COMMAND_DESCRIPTION, buildAzureClientDescription } from "../lib/azure/description";
import { extensionFor } from "../lib/azure/extension-map";
import {
  activeForwarder,
  ensureLoopbackForwarder,
  totalForwarderConnections,
} from "../lib/azure/loopback-forwarder";
import {
  bicepMissing,
  bicepRegistryUnsupported,
  formatAzResult,
  GUARD_OFF_NOTE,
  type FormatOptions,
} from "../lib/azure/output";
import { analyticsFields, evaluateAzCommand, scanBicepModules } from "../lib/azure/policy";
import {
  BicepPathError,
  localVersionJson,
  localVersionNote,
  localVersionText,
} from "../lib/azure/resolve-az";
import { progressSender } from "../lib/azure/runner";
import {
  azCli,
  azureConfig,
  bicep,
  emulatorSessionId,
  installedExtensionNames,
  installedExtensions,
  policyOptions,
  runAzCommand,
} from "../lib/azure/services";
import type { AzureConfig, ToolTextResponse } from "../lib/azure/types";

const TOOL = "localstack-azure-client";

export const schema = {
  command: z
    .string()
    .trim()
    .min(1, { message: "The command string cannot be empty." })
    .describe(AZURE_COMMAND_DESCRIPTION),
};

export const metadata: ToolMetadata = {
  name: "localstack-azure-client",
  description: buildAzureClientDescription({
    workdir: azureConfig().workdir,
    maxOutputChars: azureConfig().maxOutputChars,
  }),
  annotations: {
    title: "LocalStack Azure Client",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** The configuration whose warnings were last shown (see withGuardNote). */
let warnedConfig: AzureConfig | undefined;

/**
 * With the guard off, every response says so. The configuration's warnings (an
 * invalid setting fell back to its default, the workdir contains the home directory) go into
 * the first response of each configuration: they were computed but shown nowhere.
 */
function withGuardNote(response: ToolTextResponse): ToolTextResponse {
  const config = azureConfig();
  const notes: string[] = [];
  if (!config.egressGuard) notes.push(GUARD_OFF_NOTE);
  if (warnedConfig !== config && config.warnings.length > 0) {
    warnedConfig = config;
    notes.push(...config.warnings.map((warning) => `Note: ${warning}`));
  }
  const [first, ...rest] = response.content;
  const missing = first ? notes.filter((note) => !first.text.includes(note)) : [];
  if (!first || missing.length === 0) return response;
  return { content: [{ ...first, text: `${first.text}\n\n${missing.join("\n")}` }, ...rest] };
}

/** `.bicepparam` needs Bicep 0.14.85 or newer. */
const usesBicepparam = (argv: string[]) =>
  argv.some((a) => /\.bicepparam$/i.test(a.replace(/^@/, "")));

/**
 * Runs one `az` command against the LocalStack Azure emulator. The
 * order is section 5.2's: the token, the config and the pure policy first, so a
 * refusal needs no emulator; `version` after the CLI probe only; in Docker the
 * loopback forwarder before the parallel group; Bicep checks before any spawn; the
 * bootstrap; then the runner and the output.
 */
export default async function localstackAzureClient(
  { command }: InferSchema<typeof schema>,
  extra?: ToolExtraArguments
) {
  const config = azureConfig();
  const policy = evaluateAzCommand(command, policyOptions());
  const formatOptions = (argv: string[], notes: string[], isHelp: boolean): FormatOptions => ({
    argv,
    notes,
    isHelp,
    guardOn: config.egressGuard,
    port: config.port,
    timeoutSeconds: Math.round(config.timeoutMs / 1000),
    maxOutputChars: config.maxOutputChars,
    maxHelpChars: config.maxHelpChars,
    client: extra?.clientInfo,
    envelope: config.testEnvelope,
    inDocker: config.inDocker,
    extensionFor: (tokens) => extensionFor(tokens, installedExtensionNames()),
  });

  // Only value-free fields reach analytics; exit code and class travel in the
  // failure text's first line, which withToolAnalytics records as error_message.
  return withToolAnalytics(TOOL, analyticsFields(command, policy), async () => {
    try {
      return await handle();
    } catch (error) {
      // A thrown message would be recorded as error_message and could hold a path
      // or value; the details go below the constant first line instead.
      return withGuardNote(
        ResponseBuilder.error(
          "Azure Tool Error",
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  });

  async function handle(): Promise<ToolTextResponse> {
    const early = requireAuthToken() ?? requireAzureConfig();
    if (early) return early;
    if (!policy.ok) return withGuardNote(ResponseBuilder.error(policy.title, policy.message));

    if (policy.local === "version") {
      // `az version` would call Microsoft: answered from the probe, no emulator.
      const cli = await requireAzureCli();
      if (cli) return cli;
      const az = await azCli();
      const answer = ResponseBuilder.markdown(localVersionText(az, installedExtensions()));
      if (config.testEnvelope) {
        // As if az had printed it, so the samples shim hands `az version -o json` callers
        // (Terraform's provider) the JSON alone.
        const envelope = {
          exitCode: 0,
          stdout: `${localVersionJson(az, installedExtensions())}\n`,
          stderr: "",
          notes: [localVersionNote(az)],
          classId: null,
          truncated: false,
          stoppedByTool: false,
        };
        answer.content.push({ type: "text", text: JSON.stringify(envelope) });
      }
      return withGuardNote(answer);
    }

    // Before the parallel group: requireStack would otherwise read 127.0.0.1 before
    // the forwarder is bound.
    if (config.inDocker) await ensureLoopbackForwarder();
    const preflightError = await runPreflights([
      requireStack("azure", TOOL, { baseUrl: config.healthBaseUrl }),
      requireAzureEmulatorRunning(),
      requireAzureCli(),
    ]);
    if (preflightError) return withGuardNote(preflightError);

    if (policy.needsBicep) {
      let resolved;
      try {
        resolved = await bicep();
      } catch (error) {
        if (error instanceof BicepPathError) {
          return withGuardNote(ResponseBuilder.error("Bicep CLI Not Usable", error.message));
        }
        throw error;
      }
      if (!resolved) return withGuardNote(bicepMissing({ inDocker: config.inDocker }));
      if (usesBicepparam(policy.argv) && !resolved.supportsBicepparam) {
        return withGuardNote(
          ResponseBuilder.error(
            "Bicep CLI Too Old",
            `\`.bicepparam\` files need Bicep 0.14.85 or newer; ${resolved.path} is ${resolved.version}. Update it, or pass the parameters as JSON.`
          )
        );
      }
      // Answered before any spawn: on Windows a successful restore would write the
      // real %USERPROFILE%\.bicep even with the private home.
      const moduleRef = scanBicepModules(policy.argv, config.workdir);
      if (moduleRef) return withGuardNote(bicepRegistryUnsupported(moduleRef));
    }

    const profileError = await requireAzureCliConfigured((error) =>
      formatAzResult(
        error.result,
        formatOptions(
          error.step.split(" "),
          [
            `This failed while the tool set up its own Azure CLI profile (\`az ${error.step}\`), before your command ran.`,
          ],
          false
        )
      )
    );
    if (profileError) return withGuardNote(profileError);

    const result = await runAzCommand(policy.argv, {
      signal: extra?.signal,
      onProgress: progressSender(extra),
    });
    return withEnvelopeExtras(
      withGuardNote(formatAzResult(result, formatOptions(policy.argv, policy.notes, policy.isHelp)))
    );
  }

  /**
   * Tests only (LOCALSTACK_AZ_TEST_ENVELOPE=1): the envelope also carries the emulator
   * session the profile was checked against, which shows a re-bootstrap after an emulator
   * restart, and in Docker the loopback forwarder's connection count, which L5 reads to
   * prove the traffic went through it.
   */
  async function withEnvelopeExtras(response: ToolTextResponse): Promise<ToolTextResponse> {
    if (!config.testEnvelope || response.content.length < 2) return response;
    try {
      const envelope = JSON.parse(response.content[1].text);
      envelope.emulatorSession = emulatorSessionId() ?? null;
      if (config.inDocker && (await activeForwarder())) {
        envelope.forwarderConnections = await totalForwarderConnections();
      }
      return {
        content: [response.content[0], { type: "text", text: JSON.stringify(envelope) }],
      };
    } catch {
      return response;
    }
  }
}
