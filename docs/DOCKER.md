# Running the LocalStack MCP Server in Docker

The published image bundles everything the server shells out to — Terraform +
`tflocal`, AWS CDK + `cdklocal`, AWS SAM + `samlocal`, the Snowflake `snow` CLI,
and for the Azure tool the Azure CLI, its curated extensions and the Bicep CLI — so
the **only dependency on your machine is Docker itself**. LocalStack lifecycle, logs,
and `awslocal` run through the Docker Engine API and LocalStack's REST APIs.

The image is multi-arch (`linux/amd64` and `linux/arm64`).

## How it works (Docker-out-of-Docker)

The container talks to your **host Docker daemon** through the bind-mounted
`/var/run/docker.sock`. When you ask the server to start LocalStack, it creates a
**sibling** `localstack-main` container on the host (not nested inside the MCP
container) directly via the Docker API. Stop/restart operations act on the detected
sibling container the same way. The MCP server and the IaC CLIs reach that sibling
over the host gateway.

```
MCP client ── stdio ──► docker run … (MCP server)
                              │  /var/run/docker.sock (mounted)
                              ▼
                         host Docker daemon
                              └─ localstack-main  (sibling, publishes :4566 on the host)
```

Because LocalStack is a sibling container, one thing must be configured at run time:

- **Reachability** — set `LOCALSTACK_HOSTNAME=host.docker.internal` so the server
  and the IaC CLIs target the sibling's published port instead of the container's
  own `localhost`.

LocalStack state lives in a **named Docker volume** (`localstack-mcp`) by default,
so no host directory needs to be mounted or path-mirrored. To keep state in a host
directory instead, set `-e LOCALSTACK_VOLUME_DIR=/absolute/host/path` (the path is
interpreted by the **host** daemon).

> **Upgrading from an older image?** Previous versions required a one-to-one cache
> mount plus `XDG_CACHE_HOME`. Old configs keep working: when `XDG_CACHE_HOME` is
> set, the server keeps using `$XDG_CACHE_HOME/localstack/volume` for state, so
> your persisted resources survive the upgrade. New configs need neither flag.

## Quick start

```bash
docker run -i --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  --add-host s3.host.docker.internal:host-gateway \
  --add-host snowflake.localhost.localstack.cloud:host-gateway \
  -e LOCALSTACK_AUTH_TOKEN="<YOUR_TOKEN>" \
  -e LOCALSTACK_HOSTNAME=host.docker.internal \
  localstack/localstack-mcp-server:latest
```

| Flag                                                           | Why it's needed                                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `-v /var/run/docker.sock:/var/run/docker.sock`                 | Lets the server create/stop/restart the sibling LocalStack container, read its logs, and run `awslocal` inside it.            |
| `--add-host host.docker.internal:host-gateway`                 | Resolves `host.docker.internal` on Linux. Harmless on Docker Desktop (Mac/Windows), where it already resolves.                |
| `--add-host s3.host.docker.internal:host-gateway`              | Lets CDK's virtual-hosted S3 endpoint resolve when `cdklocal` uses `AWS_ENDPOINT_URL_S3=http://s3.host.docker.internal:4566`. |
| `--add-host snowflake.localhost.localstack.cloud:host-gateway` | Lets the Snowflake CLI reach the sibling Snowflake emulator through the hostname the emulator expects for routing.            |
| `-e LOCALSTACK_AUTH_TOKEN`                                     | Required by **every** tool in this server.                                                                                    |
| `-e LOCALSTACK_HOSTNAME=host.docker.internal`                  | Tells the server + IaC CLIs where the sibling LocalStack lives.                                                               |

## MCP client configuration

MCP clients launch the server over stdio. Note that client config files do **not**
expand `$HOME`/`$PWD` — use absolute paths.

```jsonc
{
  "mcpServers": {
    "localstack-mcp-server": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--add-host",
        "s3.host.docker.internal:host-gateway",
        "--add-host",
        "snowflake.localhost.localstack.cloud:host-gateway",
        "-e",
        "LOCALSTACK_AUTH_TOKEN",
        "-e",
        "LOCALSTACK_HOSTNAME=host.docker.internal",
        "-v",
        "/Users/you/projects:/Users/you/projects",
        "localstack/localstack-mcp-server:latest",
      ],
      "env": { "LOCALSTACK_AUTH_TOKEN": "<YOUR_TOKEN>" },
    },
  },
}
```

## Deploying your IaC (mounting projects)

Deploys run inside the MCP container, so your project directory must be visible
there. Mount it and pass the in-container path to the `localstack-deployer` tool.
The simplest convention is to mount it at the same absolute path:

```
-v "/Users/you/projects/my-infra:/Users/you/projects/my-infra"
```

Then tell the tool `directory: /Users/you/projects/my-infra`.

Terraform, SAM, and CDK receive the LocalStack endpoint automatically when
`LOCALSTACK_HOSTNAME=host.docker.internal` is set. CDK asset publishing is forced
to path-style S3 inside the Docker image, so the single `s3.host.docker.internal`
alias covers bootstrap asset uploads.

## Azure (`localstack-azure-client`)

The image contains everything the Azure tool runs:

| What                                                                | Where                                             | Version              |
| ------------------------------------------------------------------- | ------------------------------------------------- | -------------------- |
| Azure CLI, in a virtualenv of its own                               | `/opt/az` (`az` on `PATH`)                        | 2.90.0               |
| The 26 curated Azure CLI extensions (`docker/azure-extensions.txt`) | `/opt/az-extensions` (`manifest.json` lists them) | pinned per extension |
| Bicep CLI                                                           | `/usr/local/bin/bicep`                            | 0.47.16              |

Start the Azure emulator with the `localstack-management` tool (`action: start`,
`service: azure`), or use one that is already running. No extra flags are needed
beyond the quick-start ones; an Azure-only setup needs just these:

```bash
docker run -i --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e LOCALSTACK_AUTH_TOKEN="<YOUR_TOKEN>" \
  -v "$PWD/infra:/work/infra" \
  localstack/localstack-mcp-server:latest
```

**Files go under `/work`.** The Azure tool's working directory in the image is
`/work`, and file arguments (`--template-file`, `--file`, `@body.json`, …) must stay
inside it. Mount what `az` should read there and use paths relative to it: with the
mount above, `deployment group create -g demo --template-file infra/main.bicep`. To
keep the same-path project mount shown for IaC deploys, point the tool at it with
`-e LOCALSTACK_AZ_WORKDIR=/Users/you/projects`.

**How the tool reaches the emulator.** Inside the container, the emulator is not on
`127.0.0.1`, yet `az`'s endpoint and the tool's health checks expect it there. So,
in Docker only, the server starts a small **loopback forwarder** on the first Azure
call: it listens on `127.0.0.1` on the emulator's gateway port and its external
service ports, and relays each connection unchanged (TLS stays end to end). It picks
its target in this order:

1. `LOCALSTACK_AZURE_FORWARD_TARGET`, when set;
2. `host.docker.internal` (hence the `--add-host` flag on Linux);
3. the emulator container's own IP, found through the mounted Docker socket (both
   containers must share a Docker network; the default bridge counts).

Under `--network host`, `127.0.0.1` already answers and no forwarder starts. If the
emulator restarts and comes back elsewhere, the next call finds it again.

> **Linux caveat.** On a Linux Docker engine, `host.docker.internal` is the bridge
> gateway (`172.17.0.1`), which cannot reach an emulator published on `127.0.0.1`
> only — the way `lstk start` and `localstack start` publish it. The forwarder then
> falls back to the emulator container's IP (step 3), which works when the socket is
> mounted and both containers are on the same network. Otherwise, run the MCP server
> with `--network host`, or attach both to a shared network and set
> `-e LOCALSTACK_AZURE_FORWARD_TARGET=<emulator container name>`. An emulator that
> this server starts itself listens on all interfaces and needs none of this. Docker
> Desktop (Mac and Windows) is not affected.

**A different Bicep binary.** Mount it and name it explicitly; a path that does not
exist is a hard error, never a silent fallback:

```
-v /path/to/dir/bicep:/opt/bicep/bicep:ro -e LOCALSTACK_AZ_BICEP_PATH=/opt/bicep/bicep
```

**Parameter files that read environment variables.** `az`, and so Bicep, runs with a
clean environment, so a `.bicepparam` that uses `readEnvironmentVariable('DB_PASSWORD')`
sees nothing unless you list the name. Pass the variable into the container and list it:

```
-e DB_PASSWORD -e LOCALSTACK_AZ_BICEP_ENV=DB_PASSWORD
```

Only listed names pass. The auth token and variables that steer `az` (`AZURE_*`,
`ARM_*`, `BICEP_*`, proxies, paths) are never passed, even when listed.

**Extensions.** Only the curated extensions are installed, and automatic installs
are off, so an extension command outside the list fails at once with a hint naming
the extension. To add your own, mount a directory with the extensions you need and
set `-e LOCALSTACK_AZ_EXTENSION_DIR=<that dir>` (it replaces the curated set).

## Known limitations

- **Extra host aliases.** Include the aliases shown in the quick-start command.
- **First cold start** of LocalStack can take up to ~2 minutes while the image is
  pulled and the runtime initializes; subsequent starts reuse the persisted volume.
- **Persistence across MCP restarts.** The sibling `localstack-main` keeps running
  on the host even if your editor restarts the MCP container — reconnecting finds
  your stack still up. State persists in the `localstack-mcp` named volume (or
  `LOCALSTACK_VOLUME_DIR` if you set one).

## Troubleshooting

| Symptom                                                                                                     | Cause / fix                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tools report `LocalStack Not Running` after `start`                                                         | Check `LOCALSTACK_HOSTNAME=host.docker.internal` is set and `--add-host` is present (Linux).                                                                                                     |
| `Auth Token Required`                                                                                       | `LOCALSTACK_AUTH_TOKEN` must be passed through (every tool requires it).                                                                                                                         |
| `Docker Not Available` / daemon unreachable                                                                 | Ensure `/var/run/docker.sock` is mounted (or pass `DOCKER_HOST` for a non-default daemon).                                                                                                       |
| `LocalStack container not found` or `Could not find a running LocalStack container named "localstack-main"` | Set `MAIN_CONTAINER_NAME` if you use a custom LocalStack container name.                                                                                                                         |
| State disappeared after upgrading the image                                                                 | Old configs stored state under `$XDG_CACHE_HOME/localstack/volume` — keep that env var, or point `LOCALSTACK_VOLUME_DIR` at the old directory.                                                   |
| MCP server containers pile up over time                                                                     | Older images did not exit when the client disconnected. Pull the latest image, then remove strays with `docker ps -aq --filter ancestor=localstack/localstack-mcp-server \| xargs docker rm -f`. |
| The Azure tool reports the emulator is not running, but it is (Linux)                                       | The emulator is published on `127.0.0.1` only: see the Linux caveat in the Azure section (mount the socket, share a network, or use `--network host`).                                           |
| An Azure file argument is refused as outside the working directory                                          | Mount the file under `/work` and use a path relative to it, or set `LOCALSTACK_AZ_WORKDIR` to the directory you mounted.                                                                         |

## Validating an image yourself

`tests/docker/validate-image.mjs` is a dependency-free MCP stdio client that drives
the image through real tool calls.

```bash
LOCALSTACK_AUTH_TOKEN="<YOUR_TOKEN>" \
HARNESS_TOKEN_REAL=1 \
node tests/docker/validate-image.mjs -- \
  docker run -i --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --add-host host.docker.internal:host-gateway \
    --add-host s3.host.docker.internal:host-gateway \
    --add-host snowflake.localhost.localstack.cloud:host-gateway \
    -e LOCALSTACK_AUTH_TOKEN \
    -e LOCALSTACK_HOSTNAME=host.docker.internal \
    -v "$PWD/data:/work/data" \
    localstack/localstack-mcp-server:latest
```

Use `HARNESS_SKIP` to skip scenarios, for example:

```bash
HARNESS_SKIP=docs,cloudpods,ephemeral,replicator
```

The Azure stage takes extra switches (the header of `validate-image.mjs` lists them
all). The image-specific checks need the server started with
`-e LOCALSTACK_AZ_TEST_ENVELOPE=1`:

```bash
HARNESS_AZURE_EXTENSIONS=1   # an extension command reaches the emulator; a non-curated one fails fast
HARNESS_AZURE_FORWARDER=1    # the traffic went through the loopback forwarder
HARNESS_AZURE_BICEP=1        # a .bicep and a .bicepparam deployment
HARNESS_AZURE_EXTERNAL=1     # the emulator is managed outside the harness: no start or stop
```

The harness stops or restarts only a container that its own `start` created, so it
never stops an emulator you already had running.
