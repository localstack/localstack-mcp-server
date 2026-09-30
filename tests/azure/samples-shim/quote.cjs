"use strict";
// Quoting for the L4 `az` shim.
//
// The shim receives the argv bash built for `az`, and has to hand the Azure tool ONE
// command string. The tool splits that string with `splitCliArgs(command, {
// quotedControlChars: true, keepEmptyQuoted: true, bashDoubleQuoteEscapes: true })`
// (src/lib/cli/argv.ts), so the quoting here must be that tokenizer's inverse:
//
// - an argument made only of "safe" ASCII characters is written bare;
// - anything else goes in double quotes, with every `\` and `"` escaped by a backslash.
//   Inside double quotes the tokenizer keeps `$`, backticks, newlines, CR, tabs, `'`,
//   `;&|<>`, `#`, `{}` and non-ASCII as data, and turns `\\` into `\` and `\"` into `"`.
//   Because every original backslash is doubled, the tokenizer never sees a `\$`, `` \` ``
//   or backslash-newline that the argument did not contain;
// - never single quotes: the tokenizer refuses the POSIX `'\''` idiom as an unterminated
//   quote, and a single-quoted string cannot contain a `'`.
//
// Bare words are limited to ASCII on purpose: the tokenizer splits unquoted text on JS
// `\s`, which also matches U+00A0, U+2028, U+FEFF and the other Unicode spaces.

/** Characters an argument may consist of to be written without quotes. */
const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argument (see the rules above). */
function quoteArg(arg) {
  if (typeof arg !== "string") {
    throw new TypeError(`argv elements must be strings, got ${typeof arg}`);
  }
  if (arg.includes("\0")) {
    // Impossible in a real argv; refused rather than silently truncated.
    throw new Error("an argument cannot contain a NUL character");
  }
  if (SAFE_ARG.test(arg)) return arg;
  return `"${arg.replace(/[\\"]/g, "\\$&")}"`;
}

/** Join argv into one string that splitCliArgs (Azure options) splits back into argv. */
function quoteArgv(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  return argv.map(quoteArg).join(" ");
}

/**
 * The tool's `command` for `az <argv...>`: one leading `az`, which the tool strips.
 * Keeping it means a literal second `az` in argv (`az az group list`) reaches the
 * policy as a second `az`, which it refuses, instead of being stripped silently.
 */
function toToolCommand(argv) {
  return argv.length > 0 ? `az ${quoteArgv(argv)}` : "az";
}

module.exports = { SAFE_ARG, quoteArg, quoteArgv, toToolCommand };
