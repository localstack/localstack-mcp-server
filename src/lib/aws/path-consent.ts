import fs from "fs";
import path from "path";
import type { ElicitResult, ToolExtraArguments } from "xmcp";
import { isTooWideToAllow, type OutsideWorkdirError } from "./local-paths";

/**
 * Asking the user, through MCP elicitation, to allow a local path outside the AWS client's
 * working directory, such as a file in ~/Downloads to upload. Only the user can answer: the
 * client shows the question to them, not to the model. A client without elicitation, a run
 * with nobody to answer (CI, `claude -p`) and every answer but "allow" leave the command
 * refused, as before.
 */

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

/** The question for `error`'s path. The path is the server's resolved one, never the agent's text. */
export function consentRequest(
  error: OutsideWorkdirError,
  command: string,
  workdir: string | null
): Parameters<ToolExtraArguments["elicit"]>[0] {
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
      type: "object",
      properties: {
        scope: {
          type: "string",
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
 * Asks the user to allow `error`'s path. Returns the path or folder to allow, or the refusal to
 * report when the user declines or cannot be asked.
 */
export async function askToAllow(
  error: OutsideWorkdirError,
  options: {
    command: string;
    workdir: string | null;
    elicit?: ToolExtraArguments["elicit"];
  }
): Promise<{ allow: string } | { refusal: string }> {
  if (!options.elicit) return { refusal: cannotAsk(error, "the server has no client to ask") };
  let result: ElicitResult;
  try {
    result = await options.elicit(consentRequest(error, options.command, options.workdir));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { refusal: cannotAsk(error, reason) };
  }
  if (result.action !== "accept") {
    return {
      refusal: `${error.message}\n\nYou did not allow the AWS client to use ${error.path}.`,
    };
  }
  const folder = consentFolder(error.path);
  if (result.content?.scope === "folder" && !isTooWideToAllow(folder)) {
    sessionFolders.add(folder);
    return { allow: folder };
  }
  return { allow: error.path };
}

function cannotAsk(error: OutsideWorkdirError, reason: string): string {
  return `${error.message}\n\nThe server could not ask you to allow it (${reason}). Move the file into the working directory, or set LOCALSTACK_AWS_WORKDIR to a directory that holds it.`;
}
