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
    return { workdir: realpath(dir) };
  }
  if (deps.inDocker ?? fs.existsSync("/.dockerenv")) return { workdir: null };
  const cwd = realpath(deps.cwd ?? process.cwd());
  const home = realpath(deps.home ?? os.homedir());
  if (cwd === path.parse(cwd).root || cwd === home) return { workdir: null };
  return { workdir: cwd };
}

// Options whose value names a local file or directory, relative or absolute. Taken from the
// AWS CLI v2 source: API parameters only take a local file through file://, fileb://, a
// streaming blob (the second line, from the service models) or a streaming operation's
// positional outfile, so the rest are customizations (the last line).
const PATH_OPTION = new RegExp(
  "^--(?:[a-z0-9-]+-)?(?:file|outfile)$|^--(?:" +
    [
      "body|block-data|annotation-payload|asset-content|documents|input-stream|invoke-args|payload",
      "kubeconfig|ca-bundle|file-path|priv-launch-key|private-key|save-as|local-export-path|build-root|source|code|task-definition|codedeploy-appspec|dir|src|dest",
    ].join("|") +
    ")$"
);
// Options whose value is a name that may start with `/` (IAM paths, SSM parameter and log group
// names, S3 keys and prefixes). Their values are not checked, unless one names an existing
// file: an option missing from PATH_OPTION would read it.
const NAME_OPTION =
  /^--(?:[a-z0-9-]+-)?(?:name|names|path|paths|prefix|key|pattern|arn|id|ids|parameter|parameters|resource|resources|route|uri|url|expression|filter|query|location)$/;

/**
 * Throws when an argument names a local path outside the directory the CLI runs in. Every value
 * counts, relative ones included, whatever comes before it: a boolean flag such as --recursive
 * takes no value, so what follows it may well be a path. A relative value resolves against that
 * directory (the workdir, or the private temp dir `deps.cwd` when there is none), and symlinks
 * are followed, so neither `../x` nor a link inside it leads out. Only NAME_OPTION values are
 * exempt, unless they name an existing file. `deps.privateHome` is never allowed: an alias file
 * written there would run shell commands.
 */
export function assertLocalPathsAllowed(
  args: string[],
  workdir: string | null,
  deps: { home?: string; cwd?: string; privateHome?: string } = {}
): void {
  const base = workdir ?? deps.cwd;
  const check = (value: string) => {
    // `~user/x` is another user's home to the CLI: always outside.
    const isAbsolute = path.isAbsolute(value) || value.startsWith("~");
    if (isAbsolute && (workdir === null || /^~[^\\/]/.test(value))) throw outside(value, workdir);
    if (!isAbsolute && base === undefined) return;
    const root = isAbsolute ? (workdir as string) : (base as string);
    const target = isAbsolute
      ? path.resolve(expandHome(value, deps.home))
      : path.resolve(root, value);
    const real = realpathOfLongestExisting(target);
    if (!isInside(real, realpath(root))) throw outside(value, workdir);
    if (deps.privateHome && isInside(real, realpath(deps.privateHome))) {
      throw outside(value, workdir);
    }
  };

  let previousOption: string | undefined;
  for (const arg of args) {
    let option = previousOption;
    let value = arg;
    previousOption = undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        previousOption = arg.toLowerCase();
        continue;
      }
      option = arg.slice(0, eq).toLowerCase();
      value = arg.slice(eq + 1);
    }

    // A whole value that is file://… names one path (commas and all). Inside a value, shorthand
    // loads files with `key@=file://path`, and a list may hold several.
    const whole = value.match(/^fileb?:\/\/([\s\S]*)$/i);
    if (whole) {
      check(whole[1]);
      continue;
    }
    for (const m of value.matchAll(/fileb?:\/\/([^,\]}"'\s]*)/gi)) check(m[1]);

    if (option !== undefined && !PATH_OPTION.test(option) && NAME_OPTION.test(option)) {
      if (value !== "/" && isFile(expandHome(value, deps.home))) check(value);
    } else if (value !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      // Everything but a URL (s3://, https://, arn: has no //) may be read as a path.
      check(value);
    }
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
  return new Error(
    `${where} A list of names that start with '/' can be given as JSON instead, e.g. --names '["/a","/b"]'.`
  );
}

function expandHome(value: string, home = os.homedir()): string {
  return /^~(?:[\\/]|$)/.test(value) ? path.join(home, value.slice(1)) : value;
}

function isFile(p: string): boolean {
  try {
    return (path.isAbsolute(p) || p.startsWith("~")) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
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
