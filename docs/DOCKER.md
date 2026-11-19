# Running the LocalStack MCP Server in Docker

The published image bundles everything the server shells out to — `lstk` with
the AWS CLI v2, Terraform, AWS CDK, and AWS SAM, and the Snowflake `snow`
CLI — so the **only dependency on your machine is Docker itself**. LocalStack
lifecycle and logs run through the Docker Engine API and LocalStack's REST APIs.

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
  --add-host snowflake.localhost.localstack.cloud:host-gateway \
  -e LOCALSTACK_AUTH_TOKEN="<YOUR_TOKEN>" \
  -e LOCALSTACK_HOSTNAME=host.docker.internal \
  localstack/localstack-mcp-server:latest
```

| Flag                                                           | Why it's needed                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-v /var/run/docker.sock:/var/run/docker.sock`                 | Lets the server create/stop/restart the sibling LocalStack container and read its logs.                            |
| `--add-host host.docker.internal:host-gateway`                 | Resolves `host.docker.internal` on Linux. Harmless on Docker Desktop (Mac/Windows), where it already resolves.     |
| `--add-host snowflake.localhost.localstack.cloud:host-gateway` | Lets the Snowflake CLI reach the sibling Snowflake emulator through the hostname the emulator expects for routing. |
| `-e LOCALSTACK_AUTH_TOKEN`                                     | Required by **every** tool in this server.                                                                         |
| `-e LOCALSTACK_HOSTNAME=host.docker.internal`                  | Tells the server + IaC CLIs where the sibling LocalStack lives.                                                    |

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

The deployer runs Terraform, SAM, and CDK through `lstk terraform|sam|cdk`, and the AWS
client tool and the deployer's CloudFormation actions run the AWS CLI through `lstk aws`.
These receive the LocalStack endpoint automatically when
`LOCALSTACK_HOSTNAME=host.docker.internal` is set. A CloudFormation template is read inside
the MCP container, so bind-mount it like a project directory. `lstk` forces CDK asset
publishing to path-style S3, so no extra S3 host alias is needed. Existing configs
that still pass `--add-host s3.host.docker.internal:host-gateway` keep working.

## Known limitations

- **AWS client files.** In the image, the AWS client tool reads and writes local files only in
  `LOCALSTACK_AWS_WORKDIR`, which is unset by default. To `s3 cp` your own files, bind-mount their
  directory at the same absolute path and set `-e LOCALSTACK_AWS_WORKDIR=<that path>`.
- **Extra host aliases.** Include the aliases shown in the quick-start command.
- **First cold start** of LocalStack can take up to ~2 minutes while the image is
  pulled and the runtime initializes; subsequent starts reuse the persisted volume.
- **Persistence across MCP restarts.** The sibling `localstack-main` keeps running
  on the host even if your editor restarts the MCP container — reconnecting finds
  your stack still up. State persists in the `localstack-mcp` named volume (or
  `LOCALSTACK_VOLUME_DIR` if you set one).
- **No Azure CLI.** The image lists all 15 tools, but it does not include the Azure
  CLI, so `localstack-azure-client` answers that `az` is not available. To use the
  Azure tool, run the server with npx or from source. `localstack-management` can
  still start and stop the Azure emulator (`service: azure`) from the image.

## Troubleshooting

| Symptom                                                                                                     | Cause / fix                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tools report `LocalStack Not Running` after `start`                                                         | Check `LOCALSTACK_HOSTNAME=host.docker.internal` is set and `--add-host` is present (Linux).                                                                                                     |
| `Auth Token Required`                                                                                       | `LOCALSTACK_AUTH_TOKEN` must be passed through (every tool requires it).                                                                                                                         |
| `Docker Not Available` / daemon unreachable                                                                 | Ensure `/var/run/docker.sock` is mounted (or pass `DOCKER_HOST` for a non-default daemon).                                                                                                       |
| `LocalStack container not found` or `Could not find a running LocalStack container named "localstack-main"` | The server finds `localstack-main`, `localstack-{type}` and containers lstk started. Set `MAIN_CONTAINER_NAME` for another name ([lstk](../README.md#using-lstk)).                               |
| State disappeared after upgrading the image                                                                 | Old configs stored state under `$XDG_CACHE_HOME/localstack/volume` — keep that env var, or point `LOCALSTACK_VOLUME_DIR` at the old directory.                                                   |
| MCP server containers pile up over time                                                                     | Older images did not exit when the client disconnected. Pull the latest image, then remove strays with `docker ps -aq --filter ancestor=localstack/localstack-mcp-server \| xargs docker rm -f`. |

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

`tests/docker/validate-lstk.mjs` checks [lstk](../README.md#using-lstk) interop: lstk
starts the AWS emulator with a pinned tag on port 4577, the server restarts it, and lstk
still finds it. It needs `lstk` on `PATH` and free host ports 443 and 4510-4560. A tag
that exists only locally avoids a second image download:

```bash
docker tag localstack/localstack-pro:latest localstack/localstack-pro:mcp-ci
LOCALSTACK_AUTH_TOKEN="<YOUR_TOKEN>" \
node tests/docker/validate-lstk.mjs -- \
  docker run -i --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --add-host host.docker.internal:host-gateway \
    -e LOCALSTACK_AUTH_TOKEN \
    -e LOCALSTACK_HOSTNAME=host.docker.internal \
    -e LOCALSTACK_PORT=4577 \
    localstack/localstack-mcp-server:latest
```

## Tool versions in the image

Each tool's version is pinned in one file, and Dependabot opens the update PRs once a
release is at least 7 days old (its `cooldown`). The `FROM` images wait 30 days, because the
AWS CLI ships almost daily and each bump re-downloads its layer:

| Tool | Pinned in | Dependabot ecosystem |
| --- | --- | --- |
| Node.js base image | `FROM node:…` in `Dockerfile` | `docker` (major updates by hand: the workflows use `node-version: 22.x`, the latest 22 at run time, and a test keeps the majors equal) |
| Terraform | `FROM hashicorp/terraform:…` in `Dockerfile` | `docker` |
| uv (build time only) | `FROM ghcr.io/astral-sh/uv:…` in `Dockerfile` | `docker` |
| AWS CLI v2 | `FROM amazon/aws-cli:…` in `Dockerfile` | `docker` |
| `aws-cdk`, `lstk` | `docker/tools/npm/package-lock.json` | `npm` |
| AWS SAM CLI | `docker/tools/sam/pyproject.toml` and `uv.lock` | `uv` |
| Snowflake CLI | `docker/tools/snowflake/pyproject.toml` and `uv.lock` | `uv` |
| `dockerode` and other server dependencies | `yarn.lock` | `npm` |

Each Python CLI is a uv project of its own, because their dependencies conflict. Both set
`exclude-newer = "1 week"`, so `uv lock` only picks releases older than the cooldown. To change
a version by hand, edit the `pyproject.toml` and run `uv lock` in its directory.
