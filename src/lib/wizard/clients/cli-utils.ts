import { runCommand, CommandResult } from "../../../core/command-runner";
import { ClientContext } from "./types";

const VERSION_CHECK_TIMEOUT = 15_000;
const MUTATION_TIMEOUT = 60_000;

/**
 * npm/cargo-installed CLIs are .cmd/.exe shims on Windows; spawn needs a shell
 * to resolve them there. cmd.exe quoting cannot be done safely for arbitrary
 * strings (backslash-escaping doesn't exist, %VAR% expands even inside
 * quotes), so on Windows we refuse args containing cmd metacharacters instead
 * of trying to escape them — our generated args are all safe; only
 * user-supplied env values/tokens can trip this.
 */
const WINDOWS_SAFE_ARG = /^[A-Za-z0-9_\-=.:/@,+~ ]+$/;

function spawnOptions(ctx: ClientContext, timeout: number) {
  return { timeout, shell: ctx.platform === "win32" };
}

function findUnsafeWindowsArg(args: string[], ctx: ClientContext): string | undefined {
  if (ctx.platform !== "win32") return undefined;
  return args.find((arg) => !WINDOWS_SAFE_ARG.test(arg));
}

function quoteForWindowsShell(args: string[], ctx: ClientContext): string[] {
  if (ctx.platform !== "win32") return args;
  return args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg));
}

export async function cliAvailable(binary: string, ctx: ClientContext): Promise<boolean> {
  const result = await runCommand(binary, ["--version"], spawnOptions(ctx, VERSION_CHECK_TIMEOUT));
  return result.exitCode === 0;
}

/** Returns the CLI's --version output, or null when it isn't runnable. */
export async function cliVersionOutput(binary: string, ctx: ClientContext): Promise<string | null> {
  const result = await runCommand(binary, ["--version"], spawnOptions(ctx, VERSION_CHECK_TIMEOUT));
  if (result.exitCode !== 0) return null;
  return `${result.stdout} ${result.stderr}`.trim();
}

export async function runClientCli(
  binary: string,
  args: string[],
  ctx: ClientContext
): Promise<CommandResult> {
  const unsafeArg = findUnsafeWindowsArg(args, ctx);
  if (unsafeArg !== undefined) {
    const message = `refusing to pass an argument with shell-special characters to ${binary} on Windows: "${unsafeArg}" — use a value without quotes, %, or &|<>^ characters, or configure this client manually`;
    return { stdout: "", stderr: message, exitCode: 1, error: new Error(message) };
  }
  return runCommand(binary, quoteForWindowsShell(args, ctx), spawnOptions(ctx, MUTATION_TIMEOUT));
}

/** Replaces any of the given secret values with *** in CLI output. */
export function redactValues(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("***");
  }
  return result;
}

export function describeCliFailure(
  result: CommandResult,
  binary: string,
  secrets: string[] = []
): string {
  if (result.error?.message.includes("ENOENT")) {
    return `\`${binary}\` was not found on your PATH — install it first, then re-run the wizard`;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout || result.error?.message || `exit code ${result.exitCode}`;
  return redactValues(detail, secrets);
}
