# The `az` shim and the L4 samples replay

Plan task 4.4 (test layer **L4**). The samples in
[localstack-azure-samples](https://github.com/localstack/localstack-azure-samples) drive `az` from
bash. Put this directory first on `PATH` and those same scripts, unmodified, drive the MCP tool
`localstack-azure-client` instead. That tests the tool the way users' deployments use it:
multi-step scripts, `VAR=$(az ...)` captures, `--query` output, exit-code checks, LROs and
data-plane calls.

| File                             | What it is                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `az`                             | The bash shim. It passes its argv to `az-shim.cjs`, NUL-separated on stdin, with the count in `AZ_SHIM_ARGC`  |
| `az-shim.cjs`                    | The Node half: it quotes, calls the tool over stdio, reads the test envelope, writes fd 1 and fd 2, and exits |
| `quote.cjs`                      | argv → one command string: the inverse of the tool's tokenizer (`src/lib/cli/argv.ts`)                        |
| `quote.test.ts`                  | U16, in plain `yarn test`: the quoting round trip and the envelope round trip                                 |
| `../samples-replay.live.test.ts` | L4 itself: runs the samples' scripts with the shim first on `PATH` (`AZURE_LIVE=1` only)                      |

## How one `az` call works

1. **Arguments.** `az` runs `printf '%s\0' "$@" | node az-shim.cjs`, so every byte of every argument
   arrives intact. This includes empty strings, newlines and non-ASCII. It also covers Windows: if the
   arguments were on node's command line, Git Bash would rewrite `/subscriptions/...` into
   `C:/Program Files/Git/subscriptions/...`. Run `node az-shim.cjs group list` directly and it uses
   `process.argv` instead.
2. **Quoting.** `quote.cjs` builds `az <args>`. A word made only of `A-Za-z0-9_@%+=:,./-` stays bare.
   Anything else is wrapped in double quotes, with every `\` and `"` escaped. It never uses single
   quotes, because the tokenizer refuses the POSIX `'\''` idiom (check C06). Inside double quotes the
   tokenizer keeps `$`, backticks, newlines, `;&|<>` and non-ASCII as data. The leading `az` is kept,
   because the tool strips exactly one. A literal second `az` therefore reaches the policy, which
   refuses it.
3. **The server.** The shim spawns `node dist/cli.js` (or `AZ_SHIM_SERVER_JS`) over stdio with its
   **whole** environment (review R02 gap C), with these changes:
   - `LOCALSTACK_AZ_TEST_ENVELOPE=1`: the result gets a second content item, the JSON envelope
     `{exitCode, stdout, stderr, notes, classId, truncated}` (task 2.9);
   - `LOCALSTACK_AZ_WORKDIR=<the caller's cwd>`: the tool runs az in its workdir, and the scripts
     pass relative file names (`fraud_function.zip`, `main.bicep`) after a `cd`. A call that names
     a file elsewhere in the sample gets the sample's folder, `AZ_SHIM_ROOT` (below);
   - this directory is removed from `PATH`. Otherwise the tool would resolve `az` to this shim.
     `LOCALSTACK_AZ_SHIM_ACTIVE=1` guards against that recursion anyway;
   - `AZ_SHIM_*` is dropped; `MCP_ANALYTICS_DISABLED` defaults to `1`.
4. **One call.** `initialize`, `notifications/initialized`, one `tools/call` of
   `localstack-azure-client`, then stdin closes and the server exits.
5. **Output.** The shim writes the envelope's `stdout` to fd 1 exactly, then the envelope's `stderr`
   to fd 2, followed by each note as a `[localstack-azure-client] ...` line. It then exits with the
   envelope's `exitCode`. So `x=$(az ...)` captures exactly what az printed, and `&>/dev/null; if [[ $? != 0 ]]`
   sees az's real code (3 for a missing resource).

### Exit codes

| Code     | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| az's own | az ran: its exit code, stdout and stderr, unchanged                                                                                                                                                                                                                                                                                                       |
| **1**    | the tool stopped az, or az never finished: timeout, cancel, egress fail-fast, capture cap or spawn error. The tool's first line then reads `(exit none, <class>)`, and the envelope's `exitCode` is whatever the killed process returned: `null` after a POSIX signal, `1` after `taskkill`, even `0`. The tool's explanation follows az's stderr on fd 2 |
| **2**    | the tool answered **without running az**: a policy refusal (see the known gaps), or a preflight or configuration error such as a stopped emulator or no token. The tool's text goes to fd 2 and nothing to fd 1. `2` is also az's own code for a usage error (a command it would not accept)                                                              |
| **125**  | the shim itself failed: the server was missing, crashed, timed out, returned a JSON-RPC error, or answered without an envelope. This is the convention of `env`, `timeout` and `docker run` for a wrapper's own failure                                                                                                                                   |

`az version` / `az --version` are answered by the tool itself, without an envelope, because the real
`az version` calls Microsoft. The shim prints that answer's JSON on fd 1 and exits 0.

### Shim variables

| Variable                     | Effect                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AZ_SHIM_SERVER_JS`          | the server entry (default `<repo>/dist/cli.js`; run `yarn build` first)                                                                   |
| `AZ_SHIM_NODE`               | the node for the bash half (default `node` on `PATH`)                                                                                     |
| `AZ_SHIM_TIMEOUT_SECONDS`    | per call; default `LOCALSTACK_AZ_TIMEOUT_SECONDS` (300) + 300 s for server start and bootstrap                                            |
| `AZ_SHIM_LOG`                | appends one JSON line per call (argv, exit code, classId, notes, refusal, ms). The replay reads it                                        |
| `AZ_SHIM_STEP`               | a label copied into each log line                                                                                                         |
| `AZ_SHIM_NEWLINES=lf`        | turns CRLF into LF on both streams. Windows az prints CRLF, and the samples are written for LF shells. The replay sets it on Windows only |
| `AZ_SHIM_DEBUG=1`            | also prints the tool's full answer and the server's stderr on fd 2                                                                        |
| `AZ_SHIM_IDENTIFY=1`         | `az` prints `localstack-az-shim <dir>` and exits 0, without a server (the replay's `command -v az` check)                                 |
| `AZURE_SAMPLES_CI_REWRITE=1` | CI, or an owner-approved local `all` run: the `acr login` rewrite described under the known gaps                                          |

## Running it

**Unit tests (U16)**, with no emulator and no az:

```bash
npx jest tests/azure/samples-shim
```

They cover the following:

- all 736 corpus argv, plus synthetic and 3,000 seeded random argv, go through the shim's quoting and
  back through `splitCliArgs` unchanged, and never produce `'\''`;
- the shim's command gets the same policy verdict and argv as the samples' own quoting;
- the envelope reaches fd 1 and fd 2 byte for byte, checked three ways: in-process, as a real
  process against a fake MCP server, and through `x=$(az ...)` in bash. POSIX bash is used, or Git
  Bash on Windows;
- the exit codes, the log, the recursion guard, and the `acr login` rewrite.

**One command by hand**, against a running emulator. Only the token's presence is checked, so a dummy
is enough:

```bash
yarn build
export LOCALSTACK_AUTH_TOKEN=ls-shim-test-presence-only
tests/azure/samples-shim/az group list --query "length(@)"
PATH="$PWD/tests/azure/samples-shim:$PATH"; n=$(az group list --query "length(@)" -o tsv); echo "$n"
```

**The replay (L4)**, which needs `AZURE_LIVE=1`:

```bash
yarn build
AZURE_LIVE=1 AZURE_SAMPLES_DIR=/path/to/localstack-azure-samples \
  npx jest -c jest.azure-live.config.js --selectProjects samples-subset --runInBand
```

- `samples-subset` (`AZURE_SAMPLES=pr`) runs the three samples below: `scripts/deploy.sh`, then
  `scripts/validate.sh`.
- `samples-all` (`AZURE_SAMPLES=all`, **CI**, or locally with the owner's `AZURE_SAMPLES_ALL_LOCAL=1`)
  runs every entry of the checkout's `run-samples.sh` with its own deploy and test commands: 26
  script, 22 Terraform and 22 Bicep runs at commit `5ae6984`.
- `AZURE_SAMPLES_ONLY=samples/servicebus/java` runs a single sample.
- `AZURE_SAMPLES_COMMIT=<sha>` fails when the checkout is at another commit.
- `AZURE_SAMPLES_STEP_TIMEOUT_MINUTES` (default 45) sets the step timeout.
- `AZURE_SAMPLES_RESULTS_DIR` (default `<tmp>/lsaz-l4-<run id>`) is where the run leaves its
  results. Each sample gets `<nn>-<slug>/` with the copy it ran (`w/`), `deploy.log`, `test.log`,
  `shim-calls.jsonl` and `result.json`; the run adds a `summary.json`.

A sample passes when every step exits 0 and its shim log shows no unexpected refusal, no shim error
and no blocked egress. A blocked egress is a success note naming a blocked host, or a failure of
class `egress-refused`; housekeeping blocks do not count. A step that fails on one of the known gaps
below is recorded as `known-gap`, not as a failure.

## Safety rules (plan section 7; review F25, R02)

- **The samples checkout is never written.** Each sample is copied to the results dir, and runs
  there. The scripts write zips and `.deployment-env` next to themselves. On Windows only, the copy's
  `*.sh` files get LF line endings, because a Windows checkout can hold CRLF, which bash cannot run.
- **Each script** (deploy and validate separately, and the harness's own pre-check and cleanup
  calls) gets:
  - a fresh `AZURE_CONFIG_DIR`;
  - a private `HOME`/`USERPROFILE`, with `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`
    under it. It also gets `JAVA_TOOL_OPTIONS=-Duser.home=<it>`: Java ignores `HOME`/`USERPROFILE`
    and takes `user.home` from the OS account (checked on Windows, where it stayed `C:\Users\<user>`),
    so without it Maven would fill the real `~/.m2`;
  - `DOCKER_CONFIG=<tmp>/docker`, an empty dir, so `docker login` writes a throwaway `config.json`
    with no credential helper;
  - `KUBECONFIG=<tmp>/kubeconfig`;
  - its own tool config dir (`LOCALSTACK_AZ_CONFIG_DIR`).

  The private home hides the tool's defaults, so `LOCALSTACK_AZ_EXTENSION_DIR` and
  `LOCALSTACK_AZ_BICEP_PATH` are passed explicitly. They come from the environment, else from
  `~/.localstack/azure/{mcp-extensions,bin/bicep}` when present. `LOCALSTACK_AZ_TIMEOUT_SECONDS`
  defaults to 1800 s, because Function App deploys pull build images. `SERVER_PORT=0` gives
  servicebus/java's Spring Boot an ephemeral port.

- **`PATH`** is this directory prepended to the normal `PATH`, because the samples also need `zip`,
  `python3`, `mvn`, `docker` and `curl` from the usual places. Every step aborts unless `command -v az`
  is the shim, which `AZ_SHIM_IDENTIFY=1` confirms. On Windows it also aborts unless cmd.exe resolves
  `az`, `pwsh`, `powershell` and `azd` to this directory's `.cmd` files (see "Windows" below).
- **The shell** is POSIX bash, or Git Bash on Windows. It is never `C:\Windows\System32\bash.exe`,
  which is WSL.
- **`all` refuses to run outside CI** (`CI=true`) unless the machine's owner sets
  `AZURE_SAMPLES_ALL_LOCAL=1`: many samples build and push images and start containers on the
  Docker engine. **The port must be 4566**, because the scripts and the Terraform
  providers hard-code it.
- **Resource groups.**
  - A pr sample refuses to start if one of its groups already exists (`local-rg`,
    `local-ehgrid-rg`, `local-eventhubs-rg`).
  - Cleanup deletes only groups this run created: those named in a successful `group create`, plus
    the sample's declared groups, never one that existed before. When the emulator belongs to the
    run, it also deletes every group that appeared during the sample, since Terraform and Bicep
    create groups without `az group create`. That is always so in CI, where each job has its own
    emulator. Locally, the owner opts in with `AZURE_SAMPLES_OWN_EMULATOR=1`.
  - **Set `AZURE_SAMPLES_OWN_EMULATOR=1` for a local `all` run on an emulator nobody else uses.**
    Without it, the first Terraform sample's `local-rg` stays behind, and every later Terraform
    sample that uses the same name fails with "a resource with the ID ... already exists".
    The failure comes from the harness, not the samples or the tool.
  - It then purges the Key Vaults and App Configuration stores the sample created, whose soft-deleted
    names would block the next run.
- **On the owner's machine** L4 runs only on the owner's explicit request. It targets the shared
  emulator on 4566 (never beside it on a shifted port), the `pr` subset, one sample at a time
  (`AZURE_SAMPLES_ONLY`), unless the owner asks for the whole run (`AZURE_SAMPLES_ALL_LOCAL=1`). The token is a dummy (`LOCALSTACK_AUTH_TOKEN=ls-shim-test-presence-only`).
- **Timeouts** kill only the step's own process tree: its process group on POSIX, and
  `taskkill /T` of its own pid on Windows.

## The PR subset, and why

The plan asks for pure-`az` samples from the Event Hubs, Service Bus, storage and Key Vault families.
No sample is pure `az` end to end. Read from the scripts at `4193d67`, these three are the only ones
in those families whose scripts call no `docker`, `dotnet`, `func` or `terraform`. The other two in
the families, function-app-service-bus/dotnet and function-app-storage-http/dotnet, run `dotnet`.

| Sample                       | az does                                                                                                                       | Needs besides az                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `servicebus/java`            | resource group, Service Bus namespace and queue, connection string. `validate.sh` is az only                                  | `deploy.sh` ends with `mvn clean spring-boot:run`, a host app that sends one message, receives it and exits. It needs JDK 17+ and Maven |
| `eventhubs-eventgrid/python` | storage, Event Hubs (Capture), Event Grid system topic and subscription, Function App (35 az calls in deploy, 22 in validate) | `zip` (the function package); `validate.sh` runs `$PYTHON_BIN roundtrip_check.py`, which needs `azure-eventhub`                         |
| `eventhubs/python`           | the same, plus Key Vault secrets, Log Analytics, Application Insights and a Web App (57 + 34 az calls)                        | `zip`, `azure-eventhub`, the `application-insights` extension                                                                           |

On the emulator side, the two Event Hubs samples deploy a Function App (and eventhubs a Web App). The
emulator runs these in containers on the job's Docker, pulling build images on first use. They
therefore take several minutes each; the samples' own CI budgets 10-25 minutes per sample. A missing
tool skips the sample locally and fails it in CI.

## Known gaps

The policy refuses **seven sample steps** (review R02 N1). U2 records them with their rule ids, and
the replay classes a failure caused by them as `known-gap`:

- `denied:acr-login`: `az acr login --name "$ACR_NAME" --only-show-errors` without `--expose-token`,
  in the six web-app-custom-image scripts: `{dotnet,python}/scripts/deploy.sh:99`,
  `{dotnet,python}/bicep/deploy.sh:123` and `{dotnet,python}/terraform/push_image.sh:7`. Without
  `--expose-token`, az would run `docker login` with the token on its command line.
- `denied:container-exec`: `az container exec` in `aci-blob-storage/python/scripts/validate.sh:172`.
  It is an interactive shell into a container; the script counts it as a FAIL, so validate exits 1.

**In CI, or in an owner-approved local `all` run** (`AZURE_SAMPLES_CI_REWRITE=1`), the shim rewrites
`acr login --name X [--only-show-errors]` into `acr login --name X --expose-token --output json`. It
then pipes the token to `docker login <loginServer> --username 00000000-0000-0000-0000-000000000000
--password-stdin`, under the throwaway `DOCKER_CONFIG`. The token never appears on a command line.
Only the plain forms are rewritten: anything else, such as `--username`, is left to the policy. The
rewrite refuses to run without `DOCKER_CONFIG`.

**Found while building L4 and in acceptance testing, since fixed in the tool or the replay:**

- **`functionapp create` was reported as failed** (local pr replay, 2026-09-27). Without
  `--disable-app-insights`, az fetches an App Insights region map from `appinsights.azureedge.net`
  (az's `appservice/_create_util.py`). The guard refused it, and although az fell back and exited 0
  with the app created, the refusal marked the run failed, so the sample's `|| fail` stopped the
  deploy. `appinsights.azureedge.net` is now a housekeeping host (`HOUSEKEEPING_HOSTS` in
  `src/lib/azure/egress-proxy.ts`, mirrored in `src/lib/azure/output.ts`), like
  `raw.githubusercontent.com` for `vm create` image aliases. The Event Hubs sample
  now creates and deploys its function app through the shim.
- **Terraform samples and `az version`.** The azurerm provider authenticates through the Azure CLI,
  and go-azure-sdk's `azurecli.CheckAzVersion()` (`sdk/internal/azurecli/azcli.go`) fails with
  "could not detect Azure CLI version" unless `az version -o=json` has an `azure-cli` key. The tool's
  local answer now has it (`localVersionJson` in `src/lib/azure/resolve-az.ts`). On Windows the
  provider reaches the shim only through `az.cmd` (below).
- **Windows.**
  - **cmd.exe callers.** An SDK credential chain runs `cmd /c az account get-access-token ...`, and
    Go tools such as Terraform's azurerm provider find `az` through `PATHEXT`: neither sees the bash
    shim. `az.cmd` hands them to `az-shim.cjs` (with plain arguments; bash callers keep using `az`,
    which keeps every byte). A private `USERPROFILE` does not hold for .NET tools, which ask the OS
    for the profile folder (as Java does for `user.home`). So a chain that got past the CLI
    credential would reach the machine's own Azure PowerShell or azd login. `pwsh.cmd`,
    `powershell.cmd` and `azd.cmd` here block both for sample steps, failing closed with a note. The
    server's own `PATH` drops this directory, so the tool never sees them. Before
    this, the Event Hubs sample's `schema_register.py` (its `DefaultAzureCredential`) reached the
    machine's real `az`, then PowerShell's Az module, which writes into the user's own
    `%USERPROFILE%\.Azure`.
  - az prints CRLF. Git Bash's `$(...)` drops the CR, but pipes and redirects keep it, so local
    Windows replays set `AZ_SHIM_NEWLINES=lf`. CI runs on Linux, where az prints LF.
  - **Drive paths.** Git Bash turns `/c/...` into `C:/...` for native programs, but the
    bash shim passes its argv unconverted (so ARM ids stay intact). So on Windows the shim converts
    a single-letter drive root itself (`/c/...` and `--flag=/c/...` become `C:/...`). Before this,
    `apim api import --specification-path /c/.../openapi.json` reached a Windows az that could
    not open it.
  - **ARM ids handed to native programs.** Git Bash also converts `/subscriptions/...`
    for a native program such as terraform.exe: `terraform import ... /subscriptions/<id>/...` got
    `C:/Program Files/Git/subscriptions/...`. Each step now sets `MSYS2_ARG_CONV_EXCL` for
    `/subscriptions`, `/providers` and `/tenants`; genuine paths still convert.
  - A native program such as `node.exe` cannot start from a working directory longer than
    MAX_PATH. The replay keeps paths short (`<results>/<nn>-<slug>/w/`). It stops with a clear error
    when a sample's directory would exceed 200 characters; the fix is a shorter
    `AZURE_SAMPLES_RESULTS_DIR`.
- **Soft-deleted stores a template made.** When the emulator belongs to the run, cleanup
  also purges every soft-deleted Key Vault and App Configuration store that appeared during the
  sample. Before this, a vault made by a Bicep template stayed soft-deleted, and the next sample
  using the name failed with "a vault with the same name already exists in deleted state". This
  hits CI too, since `samples-all` runs in one job.
- **Bicep parameter files read environment variables.** The tool passes Bicep only the
  variables listed in `LOCALSTACK_AZ_BICEP_ENV`. So the replay lists each sample's
  `readEnvironmentVariable('NAME')` names, as a user would in the server config.
- **A file elsewhere in the sample.** The workdir is the directory the script called az
  from, so after `cd function` the tool refused
  `apim api import --specification-path $SCRIPT_DIR/../apim/openapi.json`: that file is outside
  `function/`. A user's workdir is the whole project, so the replay passes the sample's folder as
  `AZ_SHIM_ROOT`. A call that names an existing file there by absolute path, outside the cwd, gets
  that folder as its workdir, unless another argument is a relative path, whose meaning the move
  would change. Of the 1,826 calls in a full replay of the samples, only that one qualifies. This hits
  CI too: since the file rule checks `--specification-path`, the sample fails on Linux.

## CI (section 8)

`azure-live.yml` (the `pr` subset) and `azure-weekly.yml` (`samples-all`) need:

- **The samples repo at a pinned commit.** Use `actions/checkout` with
  `repository: localstack/localstack-azure-samples`, `ref: <sha>` and `path: samples-repo`, and set
  `AZURE_SAMPLES_DIR=${{ github.workspace }}/samples-repo` and `AZURE_SAMPLES_COMMIT=<sha>`. Pin a
  commit that is on the samples repo's `main`. The U2 corpus's `4193d67` was, at the last fetch of
  the local clone, only on `feat/api-management-sample`, and a merged-and-deleted branch leaves its
  commits unreachable.
- **`yarn build`**, then `dist/cli.js` for the shim.
- **The pinned az and tools.**
  - `LOCALSTACK_AZ_PATH` (job level), and the extensions installed with
    `node scripts/install-azure-extensions.mjs --dir ~/.localstack/azure/mcp-extensions`;
    `eventhubs/python` needs `application-insights`. Also `LOCALSTACK_AZ_BICEP_PATH` for the Bicep
    runs.
  - For the pr subset: `zip` (preinstalled on ubuntu-latest); a venv with `azure-eventhub` and
    `PYTHON_BIN` pointing at it; JDK 17+ and Maven (`actions/setup-java`; Maven is preinstalled on
    ubuntu-latest).
  - `samples-all` also needs the samples repo's own tool list (`.github/workflows/run-samples.yml`):
    .NET, Terraform 1.5, jq, sqlcmd, the mysql and psql clients, and its `requirements-runtime.txt`.
- **The emulator** on 4566 with the samples CI's flags, `DOCKER_FLAGS: "-e MSSQL_ACCEPT_EULA=Y"`
  among them.
- **The environment:**
  - `AZURE_LIVE=1`, and `CI=true`, which GitHub sets;
  - `LOCALSTACK_AUTH_TOKEN` from the secret;
  - `AZURE_SAMPLES_CI_REWRITE=1` for `samples-all`.

  The replay prepends the shim to `PATH` itself; the workflow does nothing for that.

- **The shim's executable bit.** Commit `tests/azure/samples-shim/az` as mode 100755:
  `git update-index --chmod=+x tests/azure/samples-shim/az`. A Windows checkout creates it as 100644.
  The POSIX unit test checks this.
- **Time.** Each shim call costs about 3-4 s: a server start, the preflights and az; the first call of
  a script adds about 5 s for the bootstrap. Measured locally on Windows against the shared emulator:
  - servicebus/java took 2 min: 10 calls, plus the Maven build and the app run;
  - eventhubs/python's deploy reached its Function App step after 197 s and 49 calls;
  - the Function App and Web App deploys, which pull build images, were not reached (see the known
    gaps).

  Budget 30-45 minutes for the pr subset until measured in CI, and run `samples-subset` in a job of
  its own, with its own emulator, beside `matrix-subset`/`egress`.

- **Artifacts.** Upload `AZURE_SAMPLES_RESULTS_DIR`, after the token scan of section 8 (N22).
