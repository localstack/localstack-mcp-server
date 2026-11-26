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
    within(deps.home ?? os.homedir(), dir) ||
    within(deps.tmp ?? os.tmpdir(), dir) ||
    // Above macOS's data volume, home and tmp lie one level deeper: /System/Volumes/Data/Users.
    within(DATA_VOLUME, dir) ||
    isVolfs(dir)
  );
}

/** Whether the user may not allow `dir` as a whole: a root, or it holds the home or temp directory. */
export function isTooWideToAllow(dir: string): boolean {
  return tooWide(realpath(dir), {});
}

/**
 * Whether `p` is `dir` or inside it, either possibly missing below some point, by real path and
 * by file identity: on macOS, /var/folders is /private/var/folders.
 */
function within(p: string, dir: string): boolean {
  const realP = realpathOfExistingPart(p);
  const realDir = realpathOfExistingPart(dir);
  if (isInside(realP, realDir)) return true;
  const id = stat(realDir);
  if (!id) return false;
  for (let at = realP; ; at = path.dirname(at)) {
    const other = stat(at);
    if (other?.dev === id.dev && other.ino === id.ino) return true;
    if (path.dirname(at) === at) return false;
  }
}

/**
 * Where git and lstk read the user's configuration, which can make them run programs
 * (core.fsmonitor, core.pager; an lstk container's image, volumes and environment). A project's
 * own `.git` and `.lstk` are refused by name (isProtectedName). XDG_CONFIG_HOME and
 * GIT_CONFIG_GLOBAL come from the server's environment, which an MCP host may have trimmed; files
 * a git config includes (include.path, core.hooksPath) are asked about by path, like any other.
 */
function userToolConfigs(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return [
    path.join(home, ".gitconfig"),
    path.join(home, ".config", "git"),
    path.join(xdg, "git"),
    env.GIT_CONFIG_GLOBAL?.trim() || undefined,
    // lstk's config search: ~/.config/lstk, then the OS config directory (Go's UserConfigDir).
    path.join(home, ".config", "lstk"),
    path.join(xdg, "lstk"),
    platform === "darwin" ? path.join(home, "Library", "Application Support", "lstk") : undefined,
    platform === "win32" && env.APPDATA ? path.join(env.APPDATA, "lstk") : undefined,
  ]
    .filter((p): p is string => !!p && path.isAbsolute(p))
    .map((p) => path.resolve(p));
}

/**
 * The first symlink that `value`, as written, goes through before a `..` (relative values start
 * at `base`, whose own symlinks do not count), or undefined.
 */
function symlinkBeforeDotDot(value: string, base?: string): string | undefined {
  const parts = value.split(/[\\/]+/);
  let at = path.isAbsolute(value) ? path.parse(value).root : (base ?? "");
  let link: string | undefined;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (link) return link;
      at = path.dirname(at);
      continue;
    }
    at = path.join(at, part);
    if (!link && isSymlink(at)) link = at;
  }
  return undefined;
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
 * - `deps.allowed`: paths outside the workdir the user allowed (localstack-aws-client asks with
 *   MCP elicitation). An otherwise valid path outside them and the workdir throws
 *   OutsideWorkdirError, which names the path to ask about; every other refusal is final.
 * - `deps.privateHome`, and a folder that holds it, are never allowed: an alias written there
 *   would run shell commands.
 * - Nothing named `.git` or `.lstk`, or inside one: git and lstk run what their config there
 *   tells them to. Inside the directory the CLI runs in, only the part below it counts (it may lie
 *   in ~/.lstk); elsewhere the whole real path.
 * - Nothing inside, or holding, the user's git and lstk configuration (userToolConfigs).
 * All three are refused before the user is asked, so no answer and no allowed path lets them pass.
 */
export function assertLocalPathsAllowed(
  args: string[],
  workdir: string | null,
  deps: {
    home?: string;
    cwd?: string;
    privateHome?: string;
    platform?: NodeJS.Platform;
    allowed?: string[];
    env?: NodeJS.ProcessEnv;
  } = {}
): void {
  // The private temp dir lies under /var on macOS, which is /private/var: `..` follows that.
  const base = workdir ?? (deps.cwd === undefined ? undefined : realpath(deps.cwd));
  const toolConfigs = userToolConfigs(deps.home ?? os.homedir(), deps.platform, deps.env).flatMap(
    (c) => configPaths(c)
  );
  const caseless = ["darwin", "win32"].includes(deps.platform ?? process.platform);
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
    // macOS's /.vol/<device>/<inode> opens a file by number, which no prompt could name.
    if (isVolfs(target)) throw outside(written, workdir);
    // The OS follows a symlink before it applies a later `..`; path.resolve does not.
    // Before the name exception, which judges the path as path.resolve spells it.
    const link = symlinkBeforeDotDot(isAbsolute ? expandHome(value, home) : value, base);
    if (link) {
      throw new Error(
        `The local path '${written}' is not allowed: it goes through the symlink ${link} and then '..', which leads wherever the symlink points. Write the path without '..'.`
      );
    }
    const homes = [deps.home ?? os.homedir(), deps.privateHome].filter((h): h is string => !!h);
    // `~user/x` is another user's home to the CLI, and AWS names start with a single /, never
    // with a drive (D:\\x): neither is a name.
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
    // `~user/x` is another user's home to the CLI; the server would check another path.
    if (/^~[^\\/]/.test(value)) throw outside(written, workdir);
    const real = realpathOfLongestExisting(target);
    // Checked before the user is asked, so that no answer can allow them: on the whole path,
    // or inside the directory the CLI runs in, on the part below it (it may lie in ~/.lstk).
    const realRoot = root === null ? undefined : realpath(root);
    const below = realRoot && isInside(real, realRoot) ? path.relative(realRoot, real) : real;
    if (below.split(path.sep).some(isProtectedName)) {
      throw new Error(
        `The local path '${written}' is not allowed: files in .git and .lstk configure programs that run on your machine.`
      );
    }
    // Inside the private home, or a folder that holds it (a recursive download writes home/…).
    if (deps.privateHome && (within(real, deps.privateHome) || within(deps.privateHome, real))) {
      throw outside(written, workdir);
    }
    // macOS and Windows file systems ignore case: ~/.config/GIT is ~/.config/git once created.
    const fold = (p: string) => (caseless ? foldPath(p) : p);
    const config = toolConfigs.find(
      (c) =>
        within(real, c) ||
        within(c, real) ||
        isInside(fold(real), fold(c)) ||
        isInside(fold(c), fold(real))
    );
    if (config) {
      throw new Error(
        `The local path '${written}' is not allowed: git and lstk read their configuration from ${config}, which can run programs on your machine.`
      );
    }
    const inRoot = [root, ...(deps.allowed ?? [])]
      .filter((r): r is string => r !== null)
      .some((r) => isInside(real, realpath(r)));
    if (!inRoot) {
      // `~` is the private home to the CLI, and `~user` another user's: the user could not tell
      // which file they allow. A root, or a directory holding the home or temp directory (which
      // holds the private home), is too wide to allow.
      if (value.startsWith("~") || tooWide(real, deps)) {
        throw outside(written, workdir, value.startsWith("~"));
      }
      throw new OutsideWorkdirError(outside(written, workdir).message, real);
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
    if (/^s3:\/\//i.test(arg) && arg.slice(5).split(/[\\/]/).some(isProtectedName)) {
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
  const folded = foldName(name);
  return folded === ".git" || folded === ".lstk" || /^(git|lstk)~\d+$/.test(folded);
}

/**
 * A path component as a case-insensitive file system opens it: in any case, with ſ (U+017F) and
 * K (U+212A) as s and k, and as Windows does, without a stream suffix or trailing dots or spaces.
 */
function foldName(name: string): string {
  return name
    .normalize("NFC")
    .toUpperCase()
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "");
}

/** `p` with every component folded (foldName). */
const foldPath = (p: string) => p.split(path.sep).map(foldName).join(path.sep);

const isInside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/**
 * A path outside the workdir that the user may still allow: `path` is its real path, as the CLI
 * will open it.
 */
export class OutsideWorkdirError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(message);
    this.name = "OutsideWorkdirError";
  }
}

function outside(value: string, workdir: string | null, tilde = false): Error {
  const where =
    workdir === null
      ? `The local path '${value}' is not allowed: the AWS client has no working directory here. Set LOCALSTACK_AWS_WORKDIR to the directory that holds your files, or use a relative path.`
      : `The local path '${value}' is outside the AWS client's working directory (${workdir}). Use a path inside it, or set LOCALSTACK_AWS_WORKDIR.`;
  // The CLI runs with a private home, so its `~` is not the user's.
  const hint = tilde
    ? " To the AWS CLI, ~ is a private home directory, not yours: write the absolute path."
    : "";
  return new Error(where + hint);
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

/**
 * The real path of `p`, in one spelling: the one the file system stores (case on macOS, long names
 * on Windows), without macOS's data-volume prefix (withoutDataVolume).
 */
function realpath(p: string): string {
  try {
    return withoutDataVolume(fs.realpathSync.native(p));
  } catch {
    return path.resolve(p);
  }
}

/** Where the symlink `p` points, resolved against its directory, or nothing if `p` is none. */
function symlinkTarget(p: string): string | undefined {
  try {
    // Against the link's real directory, as the OS resolves a relative target (../x).
    return path.resolve(realpath(path.dirname(p)), fs.readlinkSync(p));
  } catch {
    return undefined;
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
  // A path that exists but has no real path (/.vol/<device>/<inode>) can't be judged.
  try {
    fs.realpathSync.native(existing);
  } catch {
    throw new Error(`The local path '${p}' is not allowed: its real path cannot be resolved.`);
  }
  return path.join(realpath(existing), ...rest);
}

/** The real path of the part of `p` that exists, joined with the rest; never throws. */
function realpathOfExistingPart(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpath(existing), ...rest);
}

/** Whether `p` lies in macOS's /.vol, which opens files by device and inode number. */
function isVolfs(p: string): boolean {
  const [first] = p.slice(path.parse(p).root.length).split(/[\\/]/);
  return path.parse(p).root === "/" && foldName(first ?? "") === ".vol";
}

const DATA_VOLUME = "/System/Volumes/Data";

/**
 * `real`, an existing real path, without macOS's data-volume prefix when that names the same file
 * (a firmlink: /System/Volumes/Data/Users is /Users), so that paths, missing ones included,
 * compare by spelling.
 */
function withoutDataVolume(real: string): string {
  if (!real.startsWith(DATA_VOLUME + "/")) return real;
  const short = real.slice(DATA_VOLUME.length);
  const a = stat(real);
  const b = stat(short);
  return a && b && a.dev === b.dev && a.ino === b.ino ? short : real;
}

/**
 * The real paths a config path may name: itself, and through a chain of symlinks whose targets
 * are missing, each target (git or lstk would read it once it exists).
 */
function configPaths(p: string, hops = 8): string[] {
  try {
    return [realpathOfLongestExisting(p)];
  } catch {
    const link = danglingSymlink(p);
    const target = link && symlinkTarget(link);
    if (!target || hops === 0) return [p];
    return [p, ...configPaths(path.join(target, path.relative(link as string, p)), hops - 1)];
  }
}

/** The symlink with a missing target that `p` goes through, if any. */
function danglingSymlink(p: string): string | undefined {
  for (let at = p; !fs.existsSync(at); at = path.dirname(at)) {
    if (isSymlink(at)) return at;
    if (path.dirname(at) === at) return undefined;
  }
  return undefined;
}
