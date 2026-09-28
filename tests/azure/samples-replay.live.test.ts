/**
 * L4: the samples replay (plan task 4.4, section 5.4; research file 08 section 3).
 *
 * Runs localstack-azure-samples' own scripts, unmodified, with the `az` shim first on
 * PATH (tests/azure/samples-shim/), so every `az` call goes through the MCP tool
 * `localstack-azure-client`, over stdio, against the emulator on 4566.
 *
 *   AZURE_LIVE=1 AZURE_SAMPLES_DIR=<checkout> \
 *     npx jest -c jest.azure-live.config.js --selectProjects samples-subset --runInBand
 *
 * - AZURE_SAMPLES=pr (project samples-subset): the three samples of the Event Hubs,
 *   Service Bus, storage and Key Vault families whose scripts call no docker, dotnet or
 *   func tools; `scripts/deploy.sh`, then `scripts/validate.sh` (README.md: why these).
 * - AZURE_SAMPLES=all (project samples-all, CI only): every entry of the checkout's
 *   run-samples.sh (script, Terraform and Bicep runs), with its own deploy and test
 *   commands, as the samples repo's CI runs them.
 *
 * Safety (review F25, R02; plan section 7):
 * - the samples checkout is never written: each sample is copied to a temp dir first;
 * - every script gets a fresh AZURE_CONFIG_DIR, a private HOME/USERPROFILE (and XDG
 *   dirs), DOCKER_CONFIG=<tmp>/docker (an empty dir) and KUBECONFIG=<tmp>/kubeconfig,
 *   and its own tool config dir (LOCALSTACK_AZ_CONFIG_DIR);
 * - PATH is the shim dir prepended to the normal PATH, and a step aborts unless
 *   `command -v az` is the shim;
 * - on Windows the private USERPROFILE does not hold for .NET tools (they ask the OS for the
 *   profile folder), so the shim dir also answers cmd.exe callers: az.cmd for SDK credential
 *   chains and Go tools such as Terraform, and pwsh/powershell/azd blockers so a chain can
 *   never reach the machine's own Azure login; a step aborts unless cmd.exe resolves all four
 *   to the shim dir;
 * - `all` refuses to run outside CI unless the machine's owner opts in with
 *   AZURE_SAMPLES_ALL_LOCAL=1 (the samples build and push images and start containers on
 *   this Docker engine); the emulator port must be 4566 (the scripts hard-code it); a pr
 *   sample refuses to start when one of its resource groups already exists, and cleanup
 *   deletes only groups this run created;
 * - on Windows the shell is Git Bash, never WSL's System32\bash.exe.
 *
 * Other variables: AZURE_SAMPLES_ONLY (comma list of sample paths), AZURE_SAMPLES_COMMIT
 * (expected checkout HEAD), AZURE_SAMPLES_STEP_TIMEOUT_MINUTES (default 45),
 * AZURE_SAMPLES_RESULTS_DIR (default <tmp>/lsaz-l4-<run id>), AZURE_SAMPLES_CI_REWRITE=1
 * (the shim's acr login rewrite: CI, or with AZURE_SAMPLES_ALL_LOCAL=1; its docker login
 * writes only to the step's throwaway DOCKER_CONFIG), PYTHON_BIN (the samples' data-plane
 * checks), AZURE_SAMPLES_OWN_EMULATOR=1 (the emulator is dedicated to this run, as in CI: cleanup
 * also deletes groups a Terraform or Bicep sample made; without it a local `all` run leaves them,
 * and later samples reusing the name fail).
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { describeLive, LIVE, runId } from "./live/harness";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SHIM_DIR = path.join(__dirname, "samples-shim");
const SHIM_JS = path.join(SHIM_DIR, "az-shim.cjs");
const SHIM_BASH = path.join(SHIM_DIR, "az");
const SERVER_JS = process.env.AZ_SHIM_SERVER_JS || path.join(REPO_ROOT, "dist", "cli.js");

const MODE: "pr" | "all" = process.env.AZURE_SAMPLES === "all" ? "all" : "pr";
const IN_CI = process.env.CI === "true";
/** The owner's explicit opt-in to run every sample on a developer machine's Docker engine. */
const ALL_LOCAL = process.env.AZURE_SAMPLES_ALL_LOCAL === "1";
/**
 * The emulator belongs to this run, so cleanup may delete every group a sample made. CI has one
 * emulator per job; locally the owner opts in with AZURE_SAMPLES_OWN_EMULATOR=1. Without it, a
 * Terraform or Bicep sample's group (made without `az group create`) is left behind, and the next
 * sample that reuses the name fails with "already exists" (every Terraform sample after
 * the first that used local-rg).
 */
const OWN_EMULATOR = IN_CI || process.env.AZURE_SAMPLES_OWN_EMULATOR === "1";
const SAMPLES_DIR = process.env.AZURE_SAMPLES_DIR?.trim() || undefined;
const PORT = Number(process.env.LOCALSTACK_AZURE_PORT || process.env.LOCALSTACK_PORT || 4566);
const STEP_TIMEOUT_MS = Number(process.env.AZURE_SAMPLES_STEP_TIMEOUT_MINUTES || 45) * 60_000;
const RUN_ID = runId();
const RESULTS_DIR =
  process.env.AZURE_SAMPLES_RESULTS_DIR || path.join(os.tmpdir(), `lsaz-l4-${RUN_ID}`);
const DUMMY_TOKEN = "ls-live-tests-presence-only";

interface Step {
  name: "deploy" | "test";
  command: string;
}
interface Sample {
  /** Where the commands run, relative to the samples checkout (run-samples.sh's field 1). */
  path: string;
  /** What is copied: `path` without a trailing /terraform or /bicep. */
  family: string;
  steps: Step[];
  /** Resource groups the sample creates: must not exist before it runs. */
  groups?: string[];
  /** Besides az, what the scripts need on this machine (checked before running). */
  needs?: Need[];
}
type Need = "zip" | "python-azure-eventhub" | "maven";

const bashStep = (name: Step["name"], script: string): Step => ({
  name,
  command: `bash ${script}`,
});

/**
 * The pr subset. Read from the scripts (samples commit 4193d67):
 * - servicebus/java: resource group, Service Bus namespace, queue, connection string (az
 *   only); deploy.sh ends with `mvn clean spring-boot:run` (JDK 17+, Maven), a host app
 *   that sends one message to the queue, receives it and exits. validate.sh: az only.
 * - eventhubs-eventgrid/python: storage, Event Hubs (Capture), Event Grid system topic
 *   and subscription, a Function App; az plus `zip` for the function package.
 *   validate.sh: az, plus `$PYTHON_BIN roundtrip_check.py` (azure-eventhub).
 * - eventhubs/python: as above plus Key Vault secrets, Log Analytics, Application
 *   Insights (the application-insights extension) and a Web App.
 * None of them runs docker, dotnet, func or terraform.
 */
const PR_SAMPLES: Sample[] = [
  {
    path: "samples/servicebus/java",
    family: "samples/servicebus/java",
    steps: [bashStep("deploy", "scripts/deploy.sh"), bashStep("test", "scripts/validate.sh")],
    groups: ["local-rg"],
    needs: ["maven"],
  },
  {
    path: "samples/eventhubs-eventgrid/python",
    family: "samples/eventhubs-eventgrid/python",
    steps: [bashStep("deploy", "scripts/deploy.sh"), bashStep("test", "scripts/validate.sh")],
    groups: ["local-ehgrid-rg"],
    needs: ["zip", "python-azure-eventhub"],
  },
  {
    path: "samples/eventhubs/python",
    family: "samples/eventhubs/python",
    steps: [bashStep("deploy", "scripts/deploy.sh"), bashStep("test", "scripts/validate.sh")],
    groups: ["local-eventhubs-rg"],
    needs: ["zip", "python-azure-eventhub"],
  },
];

/** Sample steps the policy refuses (review R02 N1; U2 records them with these rule ids). */
const KNOWN_GAPS: Array<{ ruleId: string; where: string; match: (argv: string[]) => boolean }> = [
  {
    ruleId: "denied:acr-login",
    where: "`acr login` without --expose-token, in the six web-app-custom-image scripts",
    match: (argv) =>
      argv[0] === "acr" &&
      argv[1] === "login" &&
      !argv.some((a) => a === "-t" || a === "--expose-token" || a.startsWith("--expose-token=")),
  },
  {
    ruleId: "denied:container-exec",
    where: "`container exec` in aci-blob-storage/python/scripts/validate.sh:172",
    match: (argv) => argv[0] === "container" && argv[1] === "exec",
  },
];

// ---------------------------------------------------------------------------------------
// The samples to run

/** Every entry of run-samples.sh's SAMPLES, TERRAFORM_SAMPLES and BICEP_SAMPLES arrays. */
function registrySamples(samplesDir: string): Sample[] {
  const text = fs
    .readFileSync(path.join(samplesDir, "run-samples.sh"), "utf8")
    .replace(/\r\n/g, "\n");
  const samples: Sample[] = [];
  for (const array of ["SAMPLES", "TERRAFORM_SAMPLES", "BICEP_SAMPLES"]) {
    const block = new RegExp(`^${array}=\\(\\n([\\s\\S]*?)^\\)`, "m").exec(text);
    if (!block) throw new Error(`run-samples.sh has no ${array}=( ... ) array`);
    for (const raw of block[1].split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const quoted = /^"([^"]*)"$/.exec(line);
      if (!quoted) throw new Error(`run-samples.sh ${array}: unexpected line ${line}`);
      const [samplePath, deploy, testCommand] = quoted[1].split("|");
      const steps: Step[] = [{ name: "deploy", command: deploy }];
      if (testCommand) steps.push({ name: "test", command: testCommand });
      samples.push({
        path: samplePath,
        family: samplePath.replace(/\/(terraform|bicep)$/, ""),
        steps,
      });
    }
  }
  return samples;
}

function selectedSamples(): { samples: Sample[]; error?: string } {
  let samples: Sample[];
  if (MODE === "pr") {
    samples = PR_SAMPLES;
  } else {
    if (!SAMPLES_DIR) return { samples: [], error: "AZURE_SAMPLES_DIR is not set" };
    try {
      samples = registrySamples(SAMPLES_DIR);
    } catch (error) {
      return { samples: [], error: (error as Error).message };
    }
  }
  const only = process.env.AZURE_SAMPLES_ONLY?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (only?.length) samples = samples.filter((s) => only.includes(s.path));
  return { samples };
}

// ---------------------------------------------------------------------------------------
// Shell, environment, prerequisites

/** POSIX bash, or Git Bash on Windows; never WSL's System32\bash.exe (it would run in WSL). */
function findBash(): string | undefined {
  if (process.platform !== "win32") {
    return ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"].find(
      (p) => fs.existsSync(p)
    );
  }
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  return [
    process.env.AZ_SHIM_BASH,
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  ].find(
    (p): p is string =>
      typeof p === "string" && fs.existsSync(p) && !/\\system32\\/i.test(path.resolve(p))
  );
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/** Defaults the tool would otherwise look for under the (now private) home. */
function realHomeDefault(...parts: string[]): string | undefined {
  const candidate = path.join(os.homedir(), ".localstack", "azure", ...parts);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * One script's environment: this process's, with fresh private dirs and the shim first
 * on PATH. The tool's own settings the replay depends on are passed explicitly, because
 * the private home hides their defaults.
 */
/**
 * The variables a sample's `.bicepparam` files read with readEnvironmentVariable(). The tool
 * passes to az only those listed in LOCALSTACK_AZ_BICEP_ENV, so the replay lists
 * exactly what the sample's own parameter files ask for, as a user would in the server config.
 */
function bicepEnvNames(dir: string): string[] {
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", ".git", "bin", "obj"].includes(e.name)) walk(p);
      } else if (e.name.endsWith(".bicepparam")) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/readEnvironmentVariable\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
          names.add(m[1]);
        }
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // An unreadable tree lists nothing: the tool then reports BCP427 with its hint.
  }
  return [...names].sort();
}

function stepEnv(
  dir: string,
  step: string,
  shimLog: string,
  bicepEnv: string[] = []
): NodeJS.ProcessEnv {
  const home = path.join(dir, "home");
  const docker = path.join(dir, "docker");
  const azureConfig = path.join(dir, "azure-config");
  for (const d of [home, docker, azureConfig]) fs.mkdirSync(d, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // The shim's control variables and the in-process harness's workdir must not leak.
    if (
      key.startsWith("AZ_SHIM_") ||
      key === "LOCALSTACK_AZ_WORKDIR" ||
      key === "LOCALSTACK_AZ_SHIM_ACTIVE"
    ) {
      delete env[key];
    }
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.XDG_STATE_HOME = path.join(home, ".local", "state");
  // Java takes user.home from the OS account, not from HOME/USERPROFILE (the Windows
  // profile folder, the Linux passwd entry): without this, Maven fills the real ~/.m2.
  const javaHome = /\s/.test(home) ? `"-Duser.home=${home}"` : `-Duser.home=${home}`;
  env.JAVA_TOOL_OPTIONS = [process.env.JAVA_TOOL_OPTIONS, javaHome].filter(Boolean).join(" ");
  env.AZURE_CONFIG_DIR = azureConfig;
  env.DOCKER_CONFIG = docker;
  env.KUBECONFIG = path.join(dir, "kubeconfig");
  env.LOCALSTACK_AZ_CONFIG_DIR = path.join(dir, "mcp-config");
  const extensions = process.env.LOCALSTACK_AZ_EXTENSION_DIR || realHomeDefault("mcp-extensions");
  if (extensions) env.LOCALSTACK_AZ_EXTENSION_DIR = extensions;
  const bicepName = process.platform === "win32" ? "bicep.exe" : "bicep";
  const bicep = process.env.LOCALSTACK_AZ_BICEP_PATH || realHomeDefault("bin", bicepName);
  if (bicep) env.LOCALSTACK_AZ_BICEP_PATH = bicep;
  env.LOCALSTACK_AZ_TIMEOUT_SECONDS ||= "1800"; // function app deploys pull build images
  env.LOCALSTACK_AUTH_TOKEN ||= DUMMY_TOKEN; // only its presence is checked (D5)
  env.MCP_ANALYTICS_DISABLED ||= "1";
  env.AZ_SHIM_LOG = shimLog;
  env.AZ_SHIM_STEP = step;
  if (process.env.AZ_SHIM_SERVER_JS) env.AZ_SHIM_SERVER_JS = process.env.AZ_SHIM_SERVER_JS;
  // Windows az prints CRLF; the samples are written for LF shells.
  if (process.platform === "win32") env.AZ_SHIM_NEWLINES = "lf";
  // Git Bash converts an argument that looks like an absolute POSIX path when it starts a native
  // Windows program, so an ARM id handed to one reached it mangled: `terraform import ...
  // /subscriptions/<id>/resourceGroups/<rg>` got `C:/Program Files/Git/subscriptions/...`, the
  // import failed and the apply then clashed with the existing group. Exclude the three
  // ARM id roots the tool's policy knows; genuine paths (`/c/...`) still convert. The az shim is a
  // bash script, so its own arguments were never converted.
  if (process.platform === "win32") {
    const excluded = (env.MSYS2_ARG_CONV_EXCL ?? "").split(";").filter(Boolean);
    const armRoots = ["/subscriptions", "/providers", "/tenants"];
    env.MSYS2_ARG_CONV_EXCL = [...new Set([...excluded, ...armRoots])].join(";");
  }
  // servicebus/java starts Spring Boot's web server: an ephemeral port, never 8080.
  env.SERVER_PORT ||= "0";
  if (bicepEnv.length > 0) {
    const listed = (env.LOCALSTACK_AZ_BICEP_ENV ?? "").split(",").filter(Boolean);
    env.LOCALSTACK_AZ_BICEP_ENV = [...new Set([...listed, ...bicepEnv])].join(",");
  }
  const key = pathKey(env);
  env[key] = `${SHIM_DIR}${path.delimiter}${env[key] ?? ""}`;
  return env;
}

/** Abort unless `command -v az` is the shim (plan 5.4, L4 safety). */
function assertShimFirst(bash: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const r = spawnSync(
    bash,
    [
      "-c",
      'p=$(command -v az) || { echo "no az on PATH"; exit 3; }; printf "%s\\n" "$p"; AZ_SHIM_IDENTIFY=1 "$p"',
    ],
    { cwd, env, encoding: "utf8", timeout: 60_000, windowsHide: true }
  );
  const [resolved = "", marker = ""] = (r.stdout || "").trim().split(/\r?\n/);
  if (r.status !== 0 || !marker.startsWith("localstack-az-shim ")) {
    throw new Error(
      `aborting: \`command -v az\` is "${resolved}", not the shim in ${SHIM_DIR} (${r.stderr || marker})`
    );
  }
  assertCmdResolution(env, cwd);
  return resolved;
}

/**
 * Windows: abort unless cmd.exe's own lookup (PATHEXT) also lands in the shim dir. SDK
 * credential chains run `cmd /c az ...` and Go tools (Terraform) find az through PATHEXT, so
 * they need az.cmd; and a chain that gets past the CLI credential must hit the blockers, not
 * the machine's PowerShell or azd, which keep their logins in the REAL user folder (.NET
 * ignores the private USERPROFILE). Without them a sample's
 * DefaultAzureCredential could reach the real az, then PowerShell's Az module, which writes
 * into the user's own %USERPROFILE%\.Azure.
 */
function assertCmdResolution(env: NodeJS.ProcessEnv, cwd: string): void {
  if (process.platform !== "win32") return;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";");
  for (const name of ["az", "pwsh", "powershell", "azd"]) {
    const r = spawnSync("where.exe", [name], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    const first = (r.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => exts.includes(path.extname(line).toLowerCase()));
    if (first?.toLowerCase() !== path.join(SHIM_DIR, `${name}.cmd`).toLowerCase()) {
      throw new Error(
        `aborting: cmd.exe resolves \`${name}\` to "${first ?? "nothing"}", not ${name}.cmd in ${SHIM_DIR}`
      );
    }
  }
}

function missingNeeds(bash: string | undefined, sample: Sample): string[] {
  if (!bash) return ["bash"];
  const env = { ...process.env };
  const probes: Record<Need, string> = {
    zip: "command -v zip",
    "python-azure-eventhub": '"${PYTHON_BIN:-python3}" -c "import azure.eventhub"',
    maven: "command -v mvn && command -v java",
  };
  return (sample.needs ?? []).filter((need) => {
    const r = spawnSync(bash, ["-c", `${probes[need]} >/dev/null 2>&1`], {
      env,
      timeout: 60_000,
      windowsHide: true,
    });
    return r.status !== 0;
  });
}

// ---------------------------------------------------------------------------------------
// Copying a sample (the checkout stays untouched)

const SKIP_NAMES = new Set([
  ".git",
  ".terraform",
  "node_modules",
  ".venv",
  "__pycache__",
  "target",
]);

/**
 * Copy the sample's family dir (for example samples/eventhubs/python) to `dest`. The
 * scripts only reach inside it (`../src`, `../scripts`), so its own path is not kept:
 * shorter paths matter on Windows, where a native program cannot start from a working
 * directory longer than MAX_PATH.
 */
function copySample(samplesDir: string, family: string, dest: string): void {
  const source = path.join(samplesDir, ...family.split("/"));
  if (!fs.existsSync(source)) throw new Error(`the samples checkout has no ${family}`);
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (p) =>
      !SKIP_NAMES.has(path.basename(p)) && !/^terraform\.tfstate/.test(path.basename(p)),
  });
  if (process.platform === "win32") {
    // A Windows checkout may hold CRLF scripts, which bash cannot run; Linux CI checkouts
    // are LF already. Only the copy changes.
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".sh")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("\r\n")) fs.writeFileSync(full, text.replace(/\r\n/g, "\n"));
        }
      }
    };
    walk(dest);
  }
}

// ---------------------------------------------------------------------------------------
// Running scripts and the shim

interface StepRun {
  name: string;
  command: string;
  code: number;
  signal: string | null;
  ms: number;
  timedOut: boolean;
  tail: string;
  log: string;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Our own child's tree, through its handle's pid (never a pid from a listing).
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM"); // the step runs in its own process group
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      /* gone */
    }
  }, 10_000).unref();
}

function runStep(
  bash: string,
  step: Step,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; log: string }
): Promise<StepRun> {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(opts.log);
    out.write(`$ ${step.command}\n# cwd ${opts.cwd}\n`);
    const started = Date.now();
    const child = spawn(bash, ["-c", step.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let tail = "";
    const onData = (chunk: Buffer) => {
      out.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      out.end();
      resolve({
        name: step.name,
        command: step.command,
        code: code ?? (signal ? 128 : 1),
        signal,
        ms: Date.now() - started,
        timedOut,
        tail,
        log: opts.log,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A background process that escaped the kill may hold the pipes open.
      setTimeout(() => finish(null, "timeout"), 30_000).unref();
    }, opts.timeoutMs);
    child.on("error", (error) => {
      tail += `\nspawn error: ${error.message}`;
      finish(127, null);
    });
    // 'close' waits for background `az ... &` calls that still hold the step's pipes.
    child.on("close", (code, signal) => finish(code, signal));
  });
}

interface AzRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One az call through the shim (node directly: no bash needed for the harness's own calls). */
function shimAz(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<AzRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM_JS, ...argv], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function groupNames(env: NodeJS.ProcessEnv, cwd: string): Promise<Set<string>> {
  const r = await shimAz(["group", "list", "--query", "[].name", "--output", "json"], env, cwd);
  if (r.code !== 0)
    throw new Error(`az group list failed (exit ${r.code}): ${r.stderr.slice(0, 2000)}`);
  return new Set((JSON.parse(r.stdout) as string[]).map((n) => n.toLowerCase()));
}

/**
 * The soft-deleted Key Vaults and App Configuration stores (their names block a new one of the
 * same name until purged). Best-effort: a failed list is an empty set, never a failed sample.
 */
async function deletedStoreNames(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<{ vaults: Set<string>; stores: Set<string> }> {
  const list = async (group: string) => {
    const r = await shimAz(
      [group, "list-deleted", "--query", "[].name", "--output", "json"],
      env,
      cwd
    );
    try {
      return new Set((JSON.parse(r.stdout) as string[]).map((n) => n.toLowerCase()));
    } catch {
      return new Set<string>();
    }
  };
  return { vaults: await list("keyvault"), stores: await list("appconfig") };
}

// ---------------------------------------------------------------------------------------
// The shim log

interface ShimCall {
  step?: string;
  argv?: string[];
  exitCode?: number;
  envelope?: boolean;
  classId?: string | null;
  notes?: string[];
  refusal?: string;
  shimError?: string;
  rewrite?: string;
  ms?: number;
}

function readCalls(file: string): ShimCall[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ShimCall];
      } catch {
        return [];
      }
    });
}

function flagValues(argv: string[], flags: string[]): string[] {
  const values: string[] = [];
  argv.forEach((arg, i) => {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0 && flags.includes(arg.slice(0, eq)))
      values.push(arg.slice(eq + 1));
    else if (flags.includes(arg) && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  });
  return values;
}

const created = (calls: ShimCall[], group: string[], flags: string[]) =>
  new Set(
    calls
      .filter((c) => c.argv && group.every((word, i) => c.argv?.[i] === word) && c.exitCode === 0)
      .flatMap((c) => flagValues(c.argv as string[], flags))
  );

const knownGapOf = (call: ShimCall) =>
  call.exitCode === 2 && call.envelope === false && call.argv
    ? KNOWN_GAPS.find((gap) => gap.match(call.argv as string[]))
    : undefined;

// ---------------------------------------------------------------------------------------
// One sample

interface SampleResult {
  sample: string;
  status: "passed" | "known-gap" | "failed";
  steps: Array<Omit<StepRun, "tail">>;
  calls: number;
  refusals: Array<{ step?: string; argv?: string[]; refusal?: string; knownGap?: string }>;
  shimErrors: Array<{ step?: string; argv?: string[]; error?: string }>;
  egress: Array<{ step?: string; argv?: string[]; notes?: string[]; classId?: string | null }>;
  cleanup: string[];
  dir: string;
  message?: string;
}

interface RunContext {
  bash: string;
  samplesDir: string;
  results: SampleResult[];
  /** Samples started so far (numbers the result dirs). */
  started: number;
}

async function cleanupSample(
  ctx: RunContext,
  sample: Sample,
  root: string,
  shimLog: string,
  before: Set<string>,
  beforeDeleted?: { vaults: Set<string>; stores: Set<string> }
): Promise<string[]> {
  const notes: string[] = [];
  const env = stepEnv(path.join(root, "cleanup"), `${sample.path}:cleanup`, shimLog);
  const calls = readCalls(shimLog);
  const groups = new Set(
    [
      ...created(calls, ["group", "create"], ["--name", "-n", "--resource-group", "-g"]),
      ...(sample.groups ?? []),
    ].map((g) => g.toLowerCase())
  );
  if (OWN_EMULATOR) {
    // The emulator is this run's (CI's one per job, or the owner's opt-in): anything new was made
    // by this sample (Terraform and Bicep create groups without `az group create`). Never on a
    // shared emulator.
    try {
      for (const g of await groupNames(env, root)) if (!before.has(g)) groups.add(g);
    } catch (error) {
      notes.push(`group list failed: ${(error as Error).message}`);
    }
  }
  for (const group of groups) {
    if (before.has(group)) continue; // existed before this sample: not ours to delete
    const r = await shimAz(["group", "delete", "--name", group, "--yes"], env, root);
    notes.push(`group delete ${group}: exit ${r.code}`);
  }
  // Soft-deleted stores would block the next run's create with the same name.
  for (const vault of created(calls, ["keyvault", "create"], ["--name", "-n"])) {
    const r = await shimAz(["keyvault", "purge", "--name", vault], env, root);
    notes.push(`keyvault purge ${vault}: exit ${r.code}`);
  }
  for (const store of created(calls, ["appconfig", "create"], ["--name", "-n"])) {
    const r = await shimAz(["appconfig", "purge", "--name", store, "--yes"], env, root);
    notes.push(`appconfig purge ${store}: exit ${r.code}`);
  }
  if (OWN_EMULATOR && beforeDeleted) {
    // A Key Vault or App Configuration store a template made (Bicep, Terraform: no `az ... create`
    // to parse above) was soft-deleted with its group and would block the next sample that
    // reuses the name, in CI too. Purge every one that appeared during this sample;
    // listed after the purges above, so none is purged twice. Never on a shared emulator.
    const now = await deletedStoreNames(env, root);
    for (const vault of now.vaults) {
      if (beforeDeleted.vaults.has(vault)) continue;
      const r = await shimAz(["keyvault", "purge", "--name", vault], env, root);
      notes.push(`keyvault purge ${vault} (template-made): exit ${r.code}`);
    }
    for (const store of now.stores) {
      if (beforeDeleted.stores.has(store)) continue;
      const r = await shimAz(["appconfig", "purge", "--name", store, "--yes"], env, root);
      notes.push(`appconfig purge ${store} (template-made): exit ${r.code}`);
    }
  }
  fs.rmSync(path.join(root, "cleanup", "home"), { recursive: true, force: true });
  return notes;
}

function judge(
  sample: Sample,
  steps: StepRun[],
  calls: ShimCall[]
): Pick<SampleResult, "status" | "refusals" | "shimErrors" | "egress" | "message"> {
  const own = calls.filter((c) => !c.step?.endsWith(":cleanup") && !c.step?.endsWith(":precheck"));
  const refusals = own
    .filter((c) => c.exitCode === 2 && c.envelope === false)
    .map((c) => ({
      step: c.step,
      argv: c.argv,
      refusal: c.refusal,
      knownGap: knownGapOf(c)?.ruleId,
    }));
  const shimErrors = calls
    .filter((c) => c.exitCode === 125)
    .map((c) => ({ step: c.step, argv: c.argv, error: c.shimError }));
  // A success note naming a blocked host, or a failure classed egress-refused (L3 spirit).
  // Housekeeping blocks ("also blocked ... housekeeping") are expected and not counted.
  const egress = own
    .filter(
      (c) =>
        c.classId === "egress-refused" ||
        (c.notes ?? []).some((n) => n.includes("egress guard blocked a connection to"))
    )
    .map((c) => ({ step: c.step, argv: c.argv, notes: c.notes, classId: c.classId }));

  const problems: string[] = [];
  const unexpected = refusals.filter((r) => !r.knownGap);
  if (unexpected.length)
    problems.push(`unexpected refusals: ${JSON.stringify(unexpected, null, 1)}`);
  if (shimErrors.length) problems.push(`shim errors: ${JSON.stringify(shimErrors, null, 1)}`);
  if (egress.length) problems.push(`egress blocked: ${JSON.stringify(egress, null, 1)}`);

  let status: SampleResult["status"] = "passed";
  for (const step of steps) {
    if (step.code === 0) continue;
    const gapInStep = refusals.some((r) => r.knownGap && r.step === `${sample.path}:${step.name}`);
    if (gapInStep && !step.timedOut) {
      status = "known-gap";
    } else {
      problems.push(
        `${step.name} (\`${step.command}\`) exited ${step.code}${step.timedOut ? " (timed out)" : ""}; log ${step.log}\n--- last output ---\n${step.tail.slice(-6000)}`
      );
    }
  }
  if (steps.length < sample.steps.length && status !== "known-gap" && problems.length === 0) {
    problems.push("not every step ran");
  }
  if (problems.length)
    return { status: "failed", refusals, shimErrors, egress, message: problems.join("\n\n") };
  return { status, refusals, shimErrors, egress };
}

async function replaySample(ctx: RunContext, sample: Sample): Promise<SampleResult> {
  const slug = sample.path.replace(/^samples\//, "").replace(/[\\/]+/g, "-");
  const root = path.join(RESULTS_DIR, `${String(++ctx.started).padStart(2, "0")}-${slug}`);
  fs.mkdirSync(root, { recursive: true });
  const shimLog = path.join(root, "shim-calls.jsonl");
  const work = path.join(root, "w");
  copySample(ctx.samplesDir, sample.family, work);
  const cwd = path.join(work, ...path.posix.relative(sample.family, sample.path).split("/"));
  // A native program (node.exe, python.exe) cannot start from a longer working directory.
  if (process.platform === "win32" && cwd.length > 200) {
    throw new Error(
      `the sample's working directory is ${cwd.length} characters long (${cwd}); Windows cannot ` +
        "start native programs from a directory over MAX_PATH. Use a shorter AZURE_SAMPLES_RESULTS_DIR."
    );
  }

  const preEnv = stepEnv(path.join(root, "precheck"), `${sample.path}:precheck`, shimLog);
  assertShimFirst(ctx.bash, preEnv, cwd);
  const before = await groupNames(preEnv, root);
  // What was soft-deleted before this sample: cleanup purges only what appears after.
  const beforeDeleted = OWN_EMULATOR ? await deletedStoreNames(preEnv, root) : undefined;
  const clash = (sample.groups ?? []).filter((g) => before.has(g.toLowerCase()));
  if (clash.length) {
    throw new Error(
      `resource group(s) ${clash.join(", ")} already exist on the emulator: refusing to run ` +
        `${sample.path}, which would reuse them (and its cleanup would delete them).`
    );
  }

  const steps: StepRun[] = [];
  let cleanup: string[] = [];
  const bicepEnv = bicepEnvNames(cwd); // what the sample's .bicepparam files read
  try {
    for (const step of sample.steps) {
      const stepDir = path.join(root, step.name);
      const env = stepEnv(stepDir, `${sample.path}:${step.name}`, shimLog, bicepEnv);
      // The sample's folder is the workdir for a call that names a file elsewhere in it:
      // a script that `cd`s into a subfolder still reads the sample's other files.
      env.AZ_SHIM_ROOT = work;
      assertShimFirst(ctx.bash, env, cwd);
      const run = await runStep(ctx.bash, step, {
        cwd,
        env,
        timeoutMs: STEP_TIMEOUT_MS,
        log: path.join(root, `${step.name}.log`),
      });
      steps.push(run);
      fs.rmSync(path.join(stepDir, "home"), { recursive: true, force: true }); // .m2 and the like
      if (run.code !== 0) break;
    }
  } finally {
    cleanup = await cleanupSample(ctx, sample, root, shimLog, before, beforeDeleted);
  }

  const calls = readCalls(shimLog);
  const verdict = judge(sample, steps, calls);
  const result: SampleResult = {
    sample: sample.path,
    ...verdict,
    steps: steps.map(({ tail: _tail, ...rest }) => rest),
    calls: calls.filter((c) => !c.step?.endsWith(":cleanup") && !c.step?.endsWith(":precheck"))
      .length,
    cleanup,
    dir: root,
  };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------------------------------
// Preconditions of the whole run

function health(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/_localstack/health", timeout: 10_000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
  });
}

async function prepareRun(): Promise<RunContext> {
  if (MODE === "all" && !IN_CI && !ALL_LOCAL) {
    throw new Error(
      "AZURE_SAMPLES=all runs only in CI (azure-weekly.yml): many samples build and push images " +
        "and start containers on the Docker engine, which is shared on a developer machine. " +
        "To run them here anyway, set AZURE_SAMPLES_ALL_LOCAL=1."
    );
  }
  if (!SAMPLES_DIR) {
    throw new Error(
      "set AZURE_SAMPLES_DIR to a localstack-azure-samples checkout (CI: the pinned commit)"
    );
  }
  if (!fs.existsSync(path.join(SAMPLES_DIR, "run-samples.sh"))) {
    throw new Error(
      `${SAMPLES_DIR} is not a localstack-azure-samples checkout (no run-samples.sh)`
    );
  }
  const head = spawnSync("git", ["-C", SAMPLES_DIR, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const commit = head.status === 0 ? head.stdout.trim() : "unknown";
  const pinned = process.env.AZURE_SAMPLES_COMMIT?.trim();
  if (pinned && !commit.startsWith(pinned)) {
    throw new Error(`the samples checkout is at ${commit}, not the pinned ${pinned}`);
  }
  if (PORT !== 4566) {
    throw new Error(`the samples hard-code port 4566; this run targets ${PORT}`);
  }
  if (!fs.existsSync(SERVER_JS)) throw new Error(`${SERVER_JS} does not exist: run \`yarn build\``);
  if (process.platform !== "win32") {
    try {
      fs.accessSync(SHIM_BASH, fs.constants.X_OK);
    } catch {
      throw new Error(
        `${SHIM_BASH} is not executable: git update-index --chmod=+x tests/azure/samples-shim/az`
      );
    }
  }
  const bash = findBash();
  if (!bash) throw new Error("no usable bash (POSIX bash, or Git Bash on Windows)");
  const status = await health(PORT);
  if (status !== 200)
    throw new Error(`no LocalStack emulator answers on 127.0.0.1:${PORT} (health: ${status})`);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`L4 ${MODE}: samples ${SAMPLES_DIR} @ ${commit}; results in ${RESULTS_DIR}`);
  return { bash, samplesDir: SAMPLES_DIR, results: [], started: 0 };
}

// ---------------------------------------------------------------------------------------

const selection = selectedSamples();
const registrationBash = LIVE ? findBash() : undefined;

describeLive(`L4 samples replay (${MODE})`, () => {
  let ctx: RunContext | undefined;
  let setupError: Error | undefined;

  beforeAll(async () => {
    try {
      ctx = await prepareRun();
    } catch (error) {
      setupError = error as Error;
    }
  }, 120_000);

  afterAll(() => {
    if (!ctx) return;
    const summary = { mode: MODE, runId: RUN_ID, results: ctx.results };
    fs.writeFileSync(path.join(RESULTS_DIR, "summary.json"), JSON.stringify(summary, null, 2));
    const lines = ctx.results.map(
      (r) =>
        `${r.status.padEnd(9)} ${r.sample}  calls=${r.calls}  ${r.steps.map((s) => `${s.name}=${s.code} ${Math.round(s.ms / 1000)}s`).join("  ")}`
    );
    console.log(
      `L4 ${MODE} summary (${path.join(RESULTS_DIR, "summary.json")}):\n${lines.join("\n")}`
    );
  });

  if (selection.error) {
    test("the samples to replay can be listed", () => {
      throw new Error(selection.error);
    });
  }
  if (selection.samples.length === 0 && !selection.error) {
    test("AZURE_SAMPLES_ONLY selects at least one sample", () => {
      throw new Error(`no sample matches AZURE_SAMPLES_ONLY=${process.env.AZURE_SAMPLES_ONLY}`);
    });
  }

  for (const sample of selection.samples) {
    const missing = LIVE ? missingNeeds(registrationBash, sample) : [];
    // Locally a missing tool skips the sample; in CI the workflow must provide it.
    const register = missing.length > 0 && !IN_CI ? test.skip : test;
    const label = `${sample.path}: ${sample.steps.map((s) => s.command).join(" -> ")}${missing.length ? ` [missing: ${missing.join(", ")}]` : ""}`;
    register(
      label,
      async () => {
        if (setupError) throw setupError;
        if (!ctx) throw new Error("the run was not prepared");
        if (missing.length) throw new Error(`this runner lacks: ${missing.join(", ")}`);
        let result: SampleResult;
        try {
          result = await replaySample(ctx, sample);
        } catch (error) {
          const message = (error as Error).message;
          ctx.results.push({
            sample: sample.path,
            status: "failed",
            steps: [],
            calls: 0,
            refusals: [],
            shimErrors: [],
            egress: [],
            cleanup: [],
            dir: RESULTS_DIR,
            message,
          });
          throw error;
        }
        ctx.results.push(result);
        if (result.status === "known-gap") {
          console.log(
            `${sample.path}: failed on a known gap (${result.refusals.map((r) => r.knownGap).join(", ")})`
          );
        }
        if (result.status === "failed")
          throw new Error(`${sample.path} failed:\n${result.message}`);
      },
      sample.steps.length * STEP_TIMEOUT_MS + 20 * 60_000
    );
  }
});
