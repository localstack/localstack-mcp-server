import { runCommand } from "../../core/command-runner";
import { InstallMethod } from "./types";

const CHECK_TIMEOUT = 20_000;

export interface PrereqResult {
  name: string;
  ok: boolean;
  /** Fatal failures block the wizard; the rest warn and continue. */
  fatal: boolean;
  hint?: string;
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  const result = await runCommand(command, args, {
    timeout: CHECK_TIMEOUT,
    shell: process.platform === "win32",
  });
  return result.exitCode === 0;
}

export function checkNodeVersion(versionString: string = process.version): PrereqResult {
  const major = Number(versionString.replace(/^v/, "").split(".")[0]);
  return {
    name: `Node.js ${versionString}`,
    ok: major >= 20,
    fatal: false,
    hint: major >= 20 ? undefined : "the MCP server requires Node.js 20+ — upgrade from nodejs.org",
  };
}

export async function checkPrereqs(method: InstallMethod): Promise<PrereqResult[]> {
  const results: PrereqResult[] = [];

  const dockerInstalled = await commandWorks("docker", ["--version"]);
  const dockerRunning = dockerInstalled && (await commandWorks("docker", ["info"]));

  if (method === "npx") {
    results.push(checkNodeVersion());
    results.push({
      name: "LocalStack CLI",
      ok: await commandWorks("localstack", ["--version"]),
      fatal: false,
      hint: "install it with `brew install localstack/tap/localstack-cli` or `pip install localstack` — needed by the lifecycle tools",
    });
  }

  results.push({
    name: "Docker CLI",
    ok: dockerInstalled,
    // Without Docker the docker-run config can never work; npx setups only
    // need it later, at container start.
    fatal: method === "docker",
    hint: "install Docker from https://docs.docker.com/get-docker/",
  });

  if (dockerInstalled) {
    results.push({
      name: "Docker daemon",
      ok: dockerRunning,
      fatal: false,
      hint: "Docker is installed but not running — start it before using the MCP server",
    });
  }

  return results;
}
