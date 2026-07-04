# Running the LocalStack MCP Server in Docker

The published image bundles everything the server shells out to — Terraform +
`tflocal`, AWS CDK + `cdklocal`, AWS SAM + `samlocal`, and the Snowflake `snow`
CLI — so the **only dependency on your machine is Docker itself**. LocalStack
lifecycle, logs, and `awslocal` run through the Docker Engine API and LocalStack's
REST APIs; no LocalStack CLI is involved anywhere.

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
> mount plus `XDG_CACHE_HOME`. Old configs keep working — when `XDG_CACHE_HOME` is
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

| Flag                                                           | Why it's needed                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `-v /var/run/docker.sock:/var/run/docker.sock`                 | Lets the server create/stop/restart the sibling LocalStack container, read its logs, and run `awslocal` inside it.            |
| `--add-host host.docker.internal:host-gateway`                 | Resolves `host.docker.internal` on Linux. Harmless on Docker Desktop (Mac/Windows), where it already resolves.                |
| `--add-host s3.host.docker.internal:host-gateway`              | Lets CDK's virtual-hosted S3 endpoint resolve when `cdklocal` uses `AWS_ENDPOINT_URL_S3=http://s3.host.docker.internal:4566`. |
| `--add-host snowflake.localhost.localstack.cloud:host-gateway` | Lets the Snowflake CLI reach the sibling Snowflake emulator through the hostname the emulator expects for routing.            |
| `-e LOCALSTACK_AUTH_TOKEN`                                     | Required by **every** tool in this server.                                                                                     |
| `-e LOCALSTACK_HOSTNAME=host.docker.internal`                  | Tells the server + IaC CLIs where the sibling LocalStack lives.                                                                |

## MCP client configuration

MCP clients launch the server over stdio. Note that client config files do **not**
expand `$HOME`/`$PWD` — use absolute paths.

```jsonc
{
  "mcpServers": {
    "localstack-mcp-server": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "--add-host", "host.docker.internal:host-gateway",
        "--add-host", "s3.host.docker.internal:host-gateway",
        "--add-host", "snowflake.localhost.localstack.cloud:host-gateway",
        "-e", "LOCALSTACK_AUTH_TOKEN",
        "-e", "LOCALSTACK_HOSTNAME=host.docker.internal",
        "-v", "/Users/you/projects:/Users/you/projects",
        "localstack/localstack-mcp-server:latest"
      ],
      "env": { "LOCALSTACK_AUTH_TOKEN": "<YOUR_TOKEN>" }
    }
  }
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

## Known limitations

- **Extra host aliases.** Include the aliases shown in the quick-start command.
- **First cold start** of LocalStack can take up to ~2 minutes while the image is
  pulled and the runtime initializes; subsequent starts reuse the persisted volume.
- **Persistence across MCP restarts.** The sibling `localstack-main` keeps running
  on the host even if your editor restarts the MCP container — reconnecting finds
  your stack still up. State persists in the `localstack-mcp` named volume (or
  `LOCALSTACK_VOLUME_DIR` if you set one).

## Troubleshooting

| Symptom                                                                                                     | Cause / fix                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tools report `LocalStack Not Running` after `start`                                                         | Check `LOCALSTACK_HOSTNAME=host.docker.internal` is set and `--add-host` is present (Linux).                 |
| `Auth Token Required`                                                                                       | `LOCALSTACK_AUTH_TOKEN` must be passed through (every tool requires it).                                     |
| `Docker Not Available` / daemon unreachable                                                                 | Ensure `/var/run/docker.sock` is mounted (or pass `DOCKER_HOST` for a non-default daemon).                   |
| `LocalStack container not found` or `Could not find a running LocalStack container named "localstack-main"` | Set `MAIN_CONTAINER_NAME` if you use a custom LocalStack container name.                                     |
| State disappeared after upgrading the image                                                                 | Old configs stored state under `$XDG_CACHE_HOME/localstack/volume` — keep that env var, or point `LOCALSTACK_VOLUME_DIR` at the old directory. |

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
