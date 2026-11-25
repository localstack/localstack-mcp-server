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
  deps: { cwd?: string; home?: string; tmp?: string; inDocker?: boolean } = {}
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
    if (tooWide(real, deps)) {
      return {
        workdir: null,
        error: `LOCALSTACK_AWS_WORKDIR (${real}) must not be / or hold your home directory or the temp directory (${deps.tmp ?? os.tmpdir()}): it would expose ~/.aws, or the AWS client's private home, to its commands. Use a project directory.`,
      };
    }
    return { workdir: real };
  }
  if (deps.inDocker ?? fs.existsSync("/.dockerenv")) return { workdir: null };
  const cwd = realpath(deps.cwd ?? process.cwd());
  return { workdir: tooWide(cwd, deps) ? null : cwd };
}

/**
 * Whether `dir` is a root, or holds the home directory or the temp directory, where the AWS
 * client's private home lies (child-env.ts): a recursive s3 download would write into it.
 */
function tooWide(dir: string, deps: { home?: string; tmp?: string }): boolean {
  return (
    dir === path.parse(dir).root ||
    holds(dir, deps.home ?? os.homedir()) ||
    holds(dir, deps.tmp ?? os.tmpdir()) ||
    // Above macOS's data volume, home and tmp lie one level deeper: /System/Volumes/Data/Users.
    holds(dir, "/System/Volumes/Data") ||
    isInside("/.vol", dir)
  );
}

/**
 * Whether `target` is `dir` or inside it, by file identity, not spelling: on macOS,
 * /System/Volumes/Data/Users is /Users. For each tail of `target` (`joe`, `Users/joe`, …),
 * `dir`/tail being `target` itself means `dir` is the directory above it (or, for no tail, it).
 */
function holds(dir: string, target: string): boolean {
  const real = realpath(target);
  if (isInside(real, dir)) return true;
  const id = stat(real);
  if (!id) return false;
  const parts = real.slice(path.parse(real).root.length).split(path.sep).filter(Boolean);
  return parts.concat("").some((_, i) => {
    const other = stat(path.join(dir, ...parts.slice(i)));
    return other?.dev === id.dev && other.ino === id.ino;
  });
}

/** `p`'s stats, or undefined when it cannot be read (missing, no permission, a symlink loop). */
function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
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
 *   directory exists, so the CLI can neither read nor write it. To s3 cp, mv and sync, only
 *   --website-redirect's value is ever a name.
 * - A file:// or fileb:// path, anywhere in a value (shorthand loads files with `key@=file://`),
 *   is always a path: no name exception.
 * - The CLI expands `$VAR`, `${VAR}` (and `%VAR%` on Windows) in paths with an environment the
 *   server cannot know: lstk and the CLI's own launcher add variables (`_PYI_ARCHIVE_FILE` is the
 *   CLI's path). So no value checked as a path may reference a variable, unless it is an inline
 *   document (it starts with `{` or `[`, or spans lines: `${AWS::Region}` in a template,
 *   `$states` in a definition), which can only expand to a path inside a directory named `{`.
 *   `$5` is no variable name. A file:// path never may.
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
    // A network share (//server/share, \\server\share): reaching it, even to check that it
    // exists, connects to that server, outside the egress guard.
    if (isAbsolute && /^[\\/]{2}/.test(value)) throw outside(written, workdir);
    const target = isAbsolute
      ? path.resolve(expandHome(value, home))
      : path.resolve(base as string, value);
    // `~user/x` is another user's home to the CLI, and AWS names start with a single /, never
    // with a drive (D:\\x): neither is a name.
    const homes = [deps.home ?? os.homedir(), deps.privateHome].filter((h): h is string => !!h);
    if (
      isAbsolute &&
      mayBeName &&
      !value.startsWith("~") &&
      !/^[a-z]:/i.test(value) &&
      isName(target, transfer, homes)
    ) {
      return;
    }
    const root = isAbsolute ? workdir : (base as string);
    const real = realpathOfLongestExisting(target);
    if (root === null || /^~[^\\/]/.test(value) || !isInside(real, realpath(root))) {
      throw outside(written, workdir);
    }
    if (deps.privateHome && isInside(real, realpath(deps.privateHome))) {
      throw outside(written, workdir);
    }
    const inner = path.relative(realpath(root), real).split(path.sep);
    if (inner.some(isProtectedName)) {
      throw new Error(
        `The local path '${written}' is not allowed: files in .git and .lstk configure programs that run on your machine.`
      );
    }
  };
  const checkAll = (value: string, mayBeName: boolean) => {
    const variable = variableReference(value, deps.platform);
    const inlineDocument = mayBeName && (/^\s*[{[]/.test(value) || value.includes("\n"));
    if (variable && !inlineDocument) {
      throw new Error(
        `The value '${value}' is not allowed: the AWS CLI would replace ${variable} with a value of its environment in a path. Write the value out.`
      );
    }
    check(value, value, mayBeName, deps.home);
    if (value.startsWith("~")) check(value, value, mayBeName, deps.privateHome ?? deps.home);
  };

  // To s3 cp, mv and sync, which create the directories above a local path (/new-dir/x), only
  // --website-redirect's value (/index.html) may be a name.
  const redirect = (w: string | undefined) =>
    w !== undefined && w.length > 4 && "--website-redirect".startsWith(w);
  args.forEach((arg, i) => {
    // `--option=value`: the value; a bare `--option` is checked as the value of nothing.
    const value = arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
    const mayBeName =
      !transfer ||
      redirect(words[i - 1]) ||
      (arg.startsWith("--") && redirect(words[i].split("=")[0]));
    if (value === "") return;
    const whole = value.match(/^fileb?:\/\/([\s\S]*)$/i);
    if (whole) {
      checkAll(whole[1], false);
      return;
    }
    for (const m of value.matchAll(/fileb?:\/\/([^,\]}"'\s]*)/gi)) checkAll(m[1], false);
    // Everything but a URL (s3://, https://; an arn: has no //) may be read as a path. The CLI
    // knows s3:// in lower case only, and a one-letter scheme is a Windows drive: it reads
    // `C://Users/x` as C:\Users\x. To s3 cp, mv and sync, anything but s3:// is a local path.
    const url = transfer ? value.startsWith("s3://") : /^[a-z][a-z0-9+.-]+:\/\//.test(value);
    if (!url) checkAll(value, mayBeName);
  });
}

// .git and .lstk, as entries or directories, at any depth, under every name a file system
// opens them by (see isProtectedName), for s3 filters: `.git`, `.git.`, `.git::$DATA`, `GIT~1`.
const PROTECTED_DIRS = ["[Gg][Ii][Tt]", "[Ll][Ss\u017f][Tt][Kk\u212a]"]
  .flatMap((name) => [`[.]${name}`, `[.]${name}[. :]*`, `${name}~[0-9]*`])
  .flatMap((alias) => [alias, `*/${alias}`, `${alias}/*`, `*/${alias}/*`])
  .flatMap((pattern) => ["--exclude", pattern]);

/**
 * Confines s3 cp, mv and sync, which take their local paths from the bucket's keys as well:
 * - They walk a local directory and follow its symlinks by default, so a link inside the
 *   workdir would upload, or delete, files outside it. They get --no-follow-symlinks, last,
 *   because the last of the two flags wins; --follow-symlinks is refused in any abbreviation.
 * - Their progress line (`Completed 17 Bytes/17 Bytes … remaining`, redrawn with \r) would
 *   mix into the tool's result: --no-progress.
 * - A recursive download writes a key `.git/config` to .git/config, and sync --delete removes
 *   files missing from the bucket. Filters exclude .git and .lstk; they come last, because the
 *   last filter that matches wins, and no other argument may hold a glob character.
 */
export function confineTransfers(args: string[], cwd: string): string[] {
  const words = args.map((arg) => arg.toLowerCase());
  const transfer = words[0] === "s3" && ["cp", "mv", "sync"].some((op) => words.includes(op));
  if (!transfer) return args;
  // Local roots lie in the directory the CLI runs in; a glob character in its path would keep
  // the filters from matching, as in an argument (below).
  if (/[[\]*?]/.test(cwd)) {
    throw new Error(
      `s3 cp, mv and sync are not available: the AWS client's working directory (${cwd}) has *, ?, [ or ] in its path, which would keep them from skipping .git and .lstk. Set LOCALSTACK_AWS_WORKDIR to a directory without them.`
    );
  }
  const follows = (w: string) => {
    const name = w.split("=")[0];
    return name.length > 2 && "--follow-symlinks".startsWith(name);
  };
  if (words.some(follows)) {
    throw new Error(
      "'--follow-symlinks' is not allowed: a link could lead outside the AWS client's working directory."
    );
  }
  // The CLI matches a filter against the transfer's root joined with the pattern, so a glob
  // character in the root (s3://b/a[x]/) would keep the .git filter from matching. Only the
  // filters' own patterns may hold one.
  const isFilter = (w: string | undefined) =>
    w !== undefined && w.length > 4 && ["--exclude", "--include"].some((f) => f.startsWith(w));
  args.forEach((arg, i) => {
    // A single object copied into a directory takes the key's name: s3 cp s3://b/.git .
    if (/^s3:\/\//i.test(arg) && arg.slice(5).split("/").some(isProtectedName)) {
      throw new Error(
        `The argument '${arg}' is not allowed: files in .git and .lstk configure programs that run on your machine.`
      );
    }
    const [name] = words[i].split("=");
    const pattern = isFilter(words[i - 1]) || (words[i].includes("=") && isFilter(name));
    if (!pattern && /[[\]*?]/.test(arg)) {
      throw new Error(
        `The argument '${arg}' is not allowed: s3 cp, mv and sync take no *, ?, [ or ] outside --exclude and --include patterns.`
      );
    }
  });
  return [...args, "--no-progress", "--no-follow-symlinks", ...PROTECTED_DIRS];
}

/** The first variable reference in `value` that os.path.expandvars could replace. */
function variableReference(
  value: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const refs = platform === "win32" ? /\$(\w+|\{[^}]*\})|%(\w+)%/g : /\$(\w+|\{[^}]*\})/g;
  for (const [match, ref, winRef] of value.matchAll(refs)) {
    const name = winRef ?? (ref.startsWith("{") ? ref.slice(1, -1) : ref);
    if (!/^\d/.test(name)) return match;
  }
  return undefined;
}

/**
 * `.git` or `.lstk`, under any name a file system opens it by: in any case, with the letters
 * that fold to s and k (ſ U+017F, K U+212A), and on Windows with trailing dots or spaces, a
 * stream suffix (`.git::$INDEX_ALLOCATION`) or as the 8.3 short name `GIT~1`, as git's own
 * is_ntfs_dotgit sees it.
 */
function isProtectedName(name: string): boolean {
  const folded = name
    .normalize("NFC")
    .toUpperCase()
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "");
  return folded === ".git" || folded === ".lstk" || /^(git|lstk)~\d+$/.test(folded);
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
 * existing directory, and of the commands not denied, only s3 cp, mv and sync create the
 * directories above their target. Inside a home directory, where a new directory can be enough
 * for a program to pick it up (~/.codex/skills), only a path whose first directory is missing
 * counts: the CLI may gain commands that create directories.
 */
function isName(p: string, transfer: boolean, homes: string[]): boolean {
  const { root } = path.parse(p);
  const first = p.slice(root.length).split(/[\\/]/)[0];
  if (first !== "" && !present(path.join(root, first))) return true;
  if (transfer) return false;
  const real = realpathOfLongestExisting(p);
  if (homes.some((home) => isInside(real, realpath(home)))) return false;
  return !present(p) && !present(path.dirname(p));
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
    // native: the spelling the file system stores (case on macOS, long names on Windows).
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch {
    return false;
  }
}

/**
 * Whether `p` exists, a symlink whose target is missing included. A path that cannot be read
 * (no permission, a file as a directory) counts as existing: it is then judged as a path.
 */
function present(p: string): boolean {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/**
 * The real path of `p`, following symlinks in the part of it that exists. Throws at a symlink
 * whose target is missing: the CLI would create that target, wherever it is.
 */
function realpathOfLongestExisting(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    if (isSymlink(existing)) {
      throw new Error(
        `The local path '${p}' is not allowed: it goes through ${existing}, a symlink whose target does not exist, so the AWS client would create a file wherever the symlink points.`
      );
    }
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpath(existing), ...rest);
}
