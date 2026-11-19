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

// Options whose value names a local file or directory, relative or absolute.
const PATH_OPTION =
  /^--(?:[a-z0-9-]+-)?(?:file|outfile|body|kubeconfig|root|dir|directory|ca-bundle|block-data)$|^--source$/;
// Options whose value is a name that may start with `/` (IAM paths, SSM parameter and log group
// names, S3 keys and prefixes): never a local path, unless given as file://.
const NAME_OPTION =
  /^--(?:[a-z0-9-]+-)?(?:name|names|path|paths|prefix|key|pattern|arn|id|ids|parameter|parameters|resource|resources|route|uri|url|expression|filter|query|location)$/;

/**
 * Throws when an argument names a local path outside the working directory. Every absolute or
 * `~` argument counts, whatever comes before it: a boolean flag such as --recursive takes no
 * value, so what follows it may well be a path. Only NAME_OPTION values are exempt.
 */
export function assertLocalPathsAllowed(
  args: string[],
  workdir: string | null,
  deps: { home?: string; cwd?: string } = {}
): void {
  // Relative paths resolve in the child's working directory: the workdir, or a private temp dir
  // where nothing of the user's lives.
  const check = (value: string, relativeToo: boolean) => {
    // `~user/x` is another user's home to the CLI: always outside.
    const isAbsolute = path.isAbsolute(value) || value.startsWith("~");
    if (!isAbsolute && (!relativeToo || workdir === null)) return;
    if (isAbsolute && (workdir === null || /^~[^\\/]/.test(value))) throw outside(value, workdir);
    const target = isAbsolute
      ? path.resolve(expandHome(value, deps.home))
      : path.resolve(workdir as string, value);
    const real = realpathOfLongestExisting(target);
    if (real !== workdir && !real.startsWith((workdir as string) + path.sep)) {
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

    const file = value.match(/^fileb?:\/\/([\s\S]*)$/i);
    if (file) check(file[1], true);
    else if (option !== undefined && PATH_OPTION.test(option)) check(value, true);
    else if (option === undefined || !NAME_OPTION.test(option)) check(value, false);
  }
}

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
