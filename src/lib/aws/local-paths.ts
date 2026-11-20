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
 * - An absolute or `~` value must be inside the workdir, unless it is a name (/aws/lambda/f,
 *   /dev/db/password, /index.html): its first directory does not exist on this machine, or,
 *   except to s3 cp, mv and sync, which create missing directories, neither it nor its parent
 *   directory exists, so the CLI can neither read nor write it.
 * - A file:// or fileb:// path, anywhere in a value (shorthand loads files with `key@=file://`),
 *   is always a path: no name exception.
 * - The CLI expands `$VAR` and `${VAR}` in paths with its own environment: `deps.env`, plus what
 *   lstk sets, whose values the server cannot know. So a value may not name a variable `deps.env`
 *   holds, or one lstk may set (AWS_*, PYTHON*, LSTK_*, LOCALSTACK_*): `/$AWS_PAGER/etc` is
 *   `//etc` to the CLI. Any other variable is not set, and the CLI leaves it as written, so
 *   `${AWS::Region}`, `$states` and `$input` in inline documents keep working.
 * - The CLI's `~` is the private home, so a `~` value is checked against both homes.
 * - `deps.privateHome` is never allowed: an alias written there would run shell commands.
 * - Nothing inside `.git` or `.lstk`: git and lstk run what their config there tells them to.
 */
export function assertLocalPathsAllowed(
  args: string[],
  workdir: string | null,
  deps: {
    home?: string;
    cwd?: string;
    privateHome?: string;
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {}
): void {
  const base = workdir ?? deps.cwd;
  // `/` is a name (`iam … --path /`) except to the transfers, which would walk the whole disk.
  const words = args.map((arg) => arg.toLowerCase());
  const transfer = words[0] === "s3" && ["cp", "mv", "sync"].some((op) => words.includes(op));
  const check = (written: string, value: string, mayBeName: boolean, home?: string) => {
    if (mayBeName && value === "/" && !transfer) return;
    const isAbsolute = path.isAbsolute(value) || value.startsWith("~");
    if (!isAbsolute && base === undefined) return;
    const target = isAbsolute
      ? path.resolve(expandHome(value, home))
      : path.resolve(base as string, value);
    // `~user/x` is another user's home to the CLI: never a name.
    if (isAbsolute && mayBeName && !value.startsWith("~") && isName(target, transfer)) return;
    const root = isAbsolute ? workdir : (base as string);
    const real = realpathOfLongestExisting(target);
    if (root === null || /^~[^\\/]/.test(value) || !isInside(real, realpath(root))) {
      throw outside(written, workdir);
    }
    if (deps.privateHome && isInside(real, realpath(deps.privateHome))) {
      throw outside(written, workdir);
    }
    const inner = path.relative(realpath(root), real).split(path.sep);
    if (inner.some((part) => /^\.(?:git|lstk)$/i.test(part))) {
      throw new Error(
        `The local path '${written}' is not allowed: files in .git and .lstk configure programs that run on your machine.`
      );
    }
  };
  const checkAll = (value: string, mayBeName: boolean) => {
    const variable = setVariable(value, deps.env ?? {}, deps.platform);
    if (variable) {
      throw new Error(
        `The value '${value}' is not allowed: the AWS CLI would replace ${variable} with its value in a path. Write the path out.`
      );
    }
    check(value, value, mayBeName, deps.home);
    if (value.startsWith("~")) check(value, value, mayBeName, deps.privateHome ?? deps.home);
  };

  for (const arg of args) {
    // `--option=value`: the value; a bare `--option` is checked as the value of nothing.
    const value = arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
    if (value === "") continue;
    const whole = value.match(/^fileb?:\/\/([\s\S]*)$/i);
    if (whole) {
      checkAll(whole[1], false);
      continue;
    }
    for (const m of value.matchAll(/fileb?:\/\/([^,\]}"'\s]*)/gi)) checkAll(m[1], false);
    // Everything but a URL (s3://, https://; an arn: has no //) may be read as a path.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) checkAll(value, true);
  }
}

// .git and .lstk at any depth, in any case (case-insensitive file systems), for s3 filters.
const PROTECTED_DIRS = ["[Gg][Ii][Tt]", "[Ll][Ss][Tt][Kk]"].flatMap((name) => [
  "--exclude",
  `[.]${name}/*`,
  "--exclude",
  `*/[.]${name}/*`,
]);

/**
 * Confines s3 cp, mv and sync, which take their local paths from the bucket's keys as well:
 * - They walk a local directory and follow its symlinks by default, so a link inside the
 *   workdir would upload, or delete, files outside it. They get --no-follow-symlinks, last,
 *   because the last of the two flags wins; --follow-symlinks is refused in any abbreviation.
 * - A recursive download writes a key `.git/config` to .git/config, and sync --delete removes
 *   files missing from the bucket. Filters exclude .git and .lstk; they come last, because the
 *   last filter that matches wins.
 */
export function confineTransfers(args: string[]): string[] {
  const words = args.map((arg) => arg.toLowerCase());
  const transfer = words[0] === "s3" && ["cp", "mv", "sync"].some((op) => words.includes(op));
  if (!transfer) return args;
  const follows = (w: string) => {
    const name = w.split("=")[0];
    return name.length > 2 && "--follow-symlinks".startsWith(name);
  };
  if (words.some(follows)) {
    throw new Error(
      "'--follow-symlinks' is not allowed: a link could lead outside the AWS client's working directory."
    );
  }
  return [...args, "--no-follow-symlinks", ...PROTECTED_DIRS];
}

/**
 * The first variable reference in `value` that the CLI's os.path.expandvars may replace: one
 * `env` holds, or one lstk may set. Windows also expands %VAR% and ignores case in names.
 */
function setVariable(
  value: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const win = platform === "win32";
  const refs = win ? /\$(\w+|\{[^}]*\})|%(\w+)%/g : /\$(\w+|\{[^}]*\})/g;
  const names = new Set(Object.keys(env).map((k) => (win ? k.toUpperCase() : k)));
  for (const [match, ref, winRef] of value.matchAll(refs)) {
    const raw = winRef ?? (ref.startsWith("{") ? ref.slice(1, -1) : ref);
    const name = win ? raw.toUpperCase() : raw;
    if (names.has(name) || /^(?:AWS_|PYTHON|LSTK_|LOCALSTACK_)/i.test(name)) return match;
  }
  return undefined;
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

/**
 * Whether an absolute path is a name the CLI cannot read or write. An outfile is written into an
 * existing directory, and only s3 cp, mv and sync create the directories above their target.
 */
function isName(p: string, transfer: boolean): boolean {
  const { root } = path.parse(p);
  const first = p.slice(root.length).split(/[\\/]/)[0];
  if (first !== "" && !fs.existsSync(path.join(root, first))) return true;
  return !transfer && !fs.existsSync(p) && !fs.existsSync(path.dirname(p));
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
