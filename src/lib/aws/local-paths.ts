import fs from "fs";
import os from "os";
import path from "path";

/**
 * Where the AWS client may read and write local files. The CLI runs where this server runs, so
 * `s3 cp s3://b/k ~/.zshrc` would otherwise overwrite a file on the user's machine, and
 * `s3 cp ~/.aws/credentials s3://b/c` would hand a secret to the agent.
 *
 * The working directory is LOCALSTACK_AWS_WORKDIR, or else the server's own directory. There is
 * none in the Docker image (the server's code lives there) or when the server runs in `/` or the
 * home directory (as some MCP hosts start it): local paths are then refused, except relative
 * ones, which resolve in the tool's private temp directory.
 */
export function awsWorkdir(
  env: NodeJS.ProcessEnv = process.env,
  deps: { cwd?: string; home?: string; inDocker?: boolean } = {}
): { workdir: string | null; error?: string } {
  const configured = env.LOCALSTACK_AWS_WORKDIR?.trim();
  if (configured) {
    const dir = path.resolve(expandHome(configured, deps.home));
    if (!isDirectory(dir)) {
      return {
        workdir: null,
        error: `LOCALSTACK_AWS_WORKDIR (${dir}) is not an existing directory: set it to the directory that holds the files the AWS client may read and write.`,
      };
    }
    const real = realpath(dir);
    if (real === path.parse(real).root || real === realpath(deps.home ?? os.homedir())) {
      return {
        workdir: null,
        error: `LOCALSTACK_AWS_WORKDIR (${real}) must not be / or your home directory: it would expose ~/.aws and every other file to the AWS client.`,
      };
    }
    return { workdir: real };
  }
  if (deps.inDocker ?? fs.existsSync("/.dockerenv")) return { workdir: null };
  const cwd = realpath(deps.cwd ?? process.cwd());
  const home = realpath(deps.home ?? os.homedir());
  if (cwd === path.parse(cwd).root || cwd === home) return { workdir: null };
  return { workdir: cwd };
}

/**
 * Throws when an argument may name a local path outside the directory the CLI runs in. One rule
 * for every value, whatever option it belongs to: the CLI accepts any unambiguous prefix of an
 * option name (`--public-key` for `--public-key-outfile`), so a name proves nothing.
 *
 * - A relative value resolves against that directory (the workdir, or the private temp dir
 *   `deps.cwd` when there is none), following symlinks, and must stay inside.
 * - An absolute or `~` value must be inside the workdir, unless its first directory does not
 *   exist on this machine: then it is a name (/aws/lambda/f, /prod/db/password, /index.html)
 *   the CLI cannot read, and writing it would only create a new top-level directory.
 * - A file:// or fileb:// path, anywhere in a value (shorthand loads files with `key@=file://`),
 *   is always a path: no name exception.
 * - A leading `$VAR`: the CLI expands variables in paths, so `$HOME/x` would leave the check.
 * - `deps.privateHome` is never allowed: an alias written there would run shell commands.
 */
export function assertLocalPathsAllowed(
  args: string[],
  workdir: string | null,
  deps: { home?: string; cwd?: string; privateHome?: string } = {}
): void {
  const base = workdir ?? deps.cwd;
  // `/` is a name (`iam … --path /`) except to the transfers, which would walk the whole disk.
  const words = args.map((arg) => arg.toLowerCase());
  const transfer = words[0] === "s3" && ["cp", "mv", "sync"].some((op) => words.includes(op));
  const check = (value: string, mayBeName: boolean) => {
    if (mayBeName && value === "/" && !transfer) return;
    if (/^\$\{?[A-Za-z_]/.test(value)) {
      throw new Error(
        `The value '${value}' is not allowed: the AWS CLI would expand the variable in a path. Write the path out.`
      );
    }
    const isAbsolute = path.isAbsolute(value) || value.startsWith("~");
    if (!isAbsolute && base === undefined) return;
    const target = isAbsolute
      ? path.resolve(expandHome(value, deps.home))
      : path.resolve(base as string, value);
    // `~user/x` is another user's home to the CLI: never a name.
    if (isAbsolute && mayBeName && !value.startsWith("~") && !topLevelExists(target)) return;
    const root = isAbsolute ? workdir : (base as string);
    const real = realpathOfLongestExisting(target);
    if (root === null || /^~[^\\/]/.test(value) || !isInside(real, realpath(root))) {
      throw outside(value, workdir);
    }
    if (deps.privateHome && isInside(real, realpath(deps.privateHome))) {
      throw outside(value, workdir);
    }
  };

  for (const arg of args) {
    // `--option=value`: the value; a bare `--option` is checked as the value of nothing.
    const value = arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
    if (value === "") continue;
    const whole = value.match(/^fileb?:\/\/([\s\S]*)$/i);
    if (whole) {
      check(whole[1], false);
      continue;
    }
    for (const m of value.matchAll(/fileb?:\/\/([^,\]}"'\s]*)/gi)) check(m[1], false);
    // Everything but a URL (s3://, https://; an arn: has no //) may be read as a path.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) check(value, true);
  }
}

/**
 * s3 cp, mv and sync walk a local directory and follow its symlinks by default, so a link inside
 * the workdir would upload, or delete, files outside it. They get --no-follow-symlinks.
 */
export function withoutFollowingSymlinks(args: string[]): string[] {
  const words = args.map((arg) => arg.toLowerCase());
  const transfer = words[0] === "s3" && ["cp", "mv", "sync"].some((op) => words.includes(op));
  if (!transfer) return args;
  if (words.some((w) => /^--follow-symlinks(?:=|$)/.test(w))) {
    throw new Error(
      "'--follow-symlinks' is not allowed: a link could lead outside the AWS client's working directory."
    );
  }
  return words.includes("--no-follow-symlinks") ? args : [...args, "--no-follow-symlinks"];
}

const isInside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

function outside(value: string, workdir: string | null): Error {
  const where =
    workdir === null
      ? `The local path '${value}' is not allowed: the AWS client has no working directory here. Set LOCALSTACK_AWS_WORKDIR to the directory that holds your files, or use a relative path.`
      : `The local path '${value}' is outside the AWS client's working directory (${workdir}). Use a path inside it, or set LOCALSTACK_AWS_WORKDIR.`;
  return new Error(where);
}

function expandHome(value: string, home = os.homedir()): string {
  return /^~(?:[\\/]|$)/.test(value) ? path.join(home, value.slice(1)) : value;
}

/** Whether the first directory below the root of an absolute path exists. */
function topLevelExists(p: string): boolean {
  const { root } = path.parse(p);
  const first = p.slice(root.length).split(/[\\/]/)[0];
  return first === "" || fs.existsSync(path.join(root, first));
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The real path of `p`, following symlinks in the part of it that exists. */
function realpathOfLongestExisting(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpath(existing), ...rest);
}
