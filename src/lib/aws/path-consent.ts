import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type InputRequiredResult,
  type ToolExtraArguments,
} from "xmcp";
import { isTooWideToAllow, type OutsideWorkdirError } from "./local-paths";

/**
 * Asking the user to allow a local path outside the AWS client's working directory, such as a
 * file in ~/Downloads to upload, with a multi round-trip request (MCP 2026-07-28): the tool
 * returns `inputRequired` with a form, the client shows it to the user, not to the model, and
 * calls the tool again with the answer. On earlier protocol revisions the SDK sends the form as
 * an `elicitation/create` request and calls the tool again itself. A client that cannot ask, a
 * run with nobody to answer (CI, `claude -p`) and every answer but "allow" leave the command
 * refused, as before.
 *
 * The state that travels through the client between the rounds names the paths allowed so
 * far, so it is signed with a key only this process knows, and bound to the command.
 */

const QUESTION = "allow_path";
// The longest a user may take to answer.
const TTL_SECONDS = 15 * 60;

interface ConsentState {
  command: string;
  /** Paths and folders the user allowed in earlier rounds. */
  allowed: string[];
  /** The path the last round asked about. */
  asking: string;
  rounds: number;
}

const codec = createRequestStateCodec<ConsentState>({
  key: crypto.randomBytes(32),
  ttlSeconds: TTL_SECONDS,
});

/** Folders the user allowed for the rest of this server process. */
const sessionFolders = new Set<string>();

export function allowedFolders(): string[] {
  return [...sessionFolders];
}

/** Tests: forget the folders allowed so far. */
export function resetPathConsent(): void {
  sessionFolders.clear();
}

/** The folder an "allow the folder" answer covers: the path if it is a directory, else its parent. */
export function consentFolder(p: string): string {
  return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ? p : path.dirname(p);
}

/** The form for `error`'s path. The path is the server's resolved one, never the agent's text. */
export function consentRequest(
  error: OutsideWorkdirError,
  command: string,
  workdir: string | null
) {
  const folder = consentFolder(error.path);
  const scopes = isTooWideToAllow(folder)
    ? [["once", "Allow this path for this command only"]]
    : [
        ["once", "Allow this path for this command only"],
        ["folder", `Allow everything in ${folder} until the MCP server stops`],
      ];
  // One line, and short: the agent wrote the command.
  const line = command.replace(/\s+/g, " ");
  const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
  return {
    message: [
      `The AWS CLI command \`${shown}\` uses the local path`,
      error.path,
      `outside the AWS client's working directory${workdir ? ` (${workdir})` : ""}.`,
      "The AWS CLI may read this path, or write or overwrite it. Allow it?",
    ].join("\n"),
    requestedSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          title: "Allow",
          enum: scopes.map(([value]) => value),
          enumNames: scopes.map(([, name]) => name),
          default: "once",
        },
      },
      required: ["scope"],
    },
  };
}

/**
 * What earlier rounds of this tool call settled: the paths the user allowed, or the path they
 * did not allow. A first call, or state that fails verification or belongs to another command,
 * settles nothing.
 */
export async function readConsent(
  command: string,
  extra?: Pick<ToolExtraArguments, "requestState" | "inputResponses">
): Promise<{ allowed: string[]; rounds: number } | { declined: string }> {
  const raw = extra?.requestState?.();
  if (typeof raw !== "string") return { allowed: [], rounds: 0 };
  let state: ConsentState;
  try {
    // Without a context binding, the codec does not read the context.
    state = await codec.verify(raw, undefined as never);
  } catch {
    return { allowed: [], rounds: 0 };
  }
  if (state.command !== command) return { allowed: [], rounds: 0 };
  const answer = acceptedContent<{ scope?: unknown }>(extra?.inputResponses, QUESTION);
  if (!answer) return { declined: state.asking };
  const folder = consentFolder(state.asking);
  if (answer.scope === "folder" && !isTooWideToAllow(folder)) {
    sessionFolders.add(folder);
    return { allowed: [...state.allowed, folder], rounds: state.rounds };
  }
  return { allowed: [...state.allowed, state.asking], rounds: state.rounds };
}

/** The input-required result that asks the user about `error`'s path. */
export async function askToAllow(
  error: OutsideWorkdirError,
  options: { command: string; workdir: string | null; allowed: string[]; rounds: number }
): Promise<InputRequiredResult> {
  const state: ConsentState = {
    command: options.command,
    allowed: options.allowed,
    asking: error.path,
    rounds: options.rounds + 1,
  };
  return inputRequired({
    inputRequests: {
      [QUESTION]: inputRequired.elicit(consentRequest(error, options.command, options.workdir)),
    },
    requestState: await codec.mint(state),
  });
}
