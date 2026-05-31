# Running the LocalStack MCP Server in Docker

The published image bundles everything the server shells out to — the LocalStack
CLI, `awslocal`, Terraform + `tflocal`, AWS CDK + `cdklocal`, AWS SAM + `samlocal`,
the Snowflake `snow` CLI, and the Docker CLI — so the **only dependency on your
machine is Docker itself**.

```
localstack/localstack-mcp-server:latest      # multi-arch: linux/amd64 + linux/arm64
```

## How it works (Docker-out-of-Docker)

The container talks to your **host Docker daemon** through the bind-mounted
`/var/run/docker.sock`. When you ask the server to start LocalStack, `localstack
start` launches a **sibling** `localstack-main` container on the host (not nested
inside the MCP container). The MCP server and the IaC CLIs reach that sibling over
the host gateway.

```
MCP client ── stdio ──► docker run … (MCP server)
                              │  /var/run/docker.sock (mounted)
                              ▼
                         host Docker daemon
                              └─ localstack-main  (sibling, publishes :4566 on the host)
```

Because LocalStack is a sibling, two things must be configured at run time:

1. **Reachability** — set `LOCALSTACK_HOSTNAME=host.docker.internal` so the server
   and the IaC CLIs target the sibling's published port instead of the container's
   own `localhost`.
2. **Host-resolvable mounts** — `localstack start` asks the **host** daemon to
   bind-mount its license/state files into `localstack-main`. Those mount *sources*
   must exist at an **identical path** on the host and inside the MCP container, so
   point LocalStack's cache at a directory you bind-mount one-to-one (via
   `XDG_CACHE_HOME`). Without this you get `Mounts denied: … is not shared from the
   host`.

## Quick start

```bash
mkdir -p "$HOME/.localstack-mcp"

docker run -i --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.localstack-mcp:$HOME/.localstack-mcp" \
  -e XDG_CACHE_HOME="$HOME/.localstack-mcp" \
  --add-host host.docker.internal:host-gateway \
  --add-host s3.host.docker.internal:host-gateway \
  --add-host snowflake.localhost.localstack.cloud:host-gateway \
  -e LOCALSTACK_AUTH_TOKEN="<YOUR_TOKEN>" \
  -e LOCALSTACK_HOSTNAME=host.docker.internal \
  localstack/localstack-mcp-server:latest
```

| Flag | Why it's needed |
| --- | --- |
| `-v /var/run/docker.sock:/var/run/docker.sock` | Lets the bundled LocalStack CLI drive the host Docker daemon (start/stop the sibling, `awslocal` exec). |
| `-v "$HOME/.localstack-mcp:$HOME/.localstack-mcp"` + `-e XDG_CACHE_HOME=…` | Puts LocalStack's license/machine/volume files on an **identically-pathed** host directory so the host daemon can bind-mount them into `localstack-main`. |
| `--add-host host.docker.internal:host-gateway` | Resolves `host.docker.internal` on Linux. Harmless on Docker Desktop (Mac/Windows), where it already resolves. |
| `--add-host s3.host.docker.internal:host-gateway` | Lets CDK's virtual-hosted S3 endpoint resolve when `cdklocal` uses `AWS_ENDPOINT_URL_S3=http://s3.host.docker.internal:4566`. |
| `--add-host snowflake.localhost.localstack.cloud:host-gateway` | Lets the Snowflake CLI reach the sibling Snowflake emulator through the hostname the emulator expects for routing. |
| `-e LOCALSTACK_AUTH_TOKEN` | Required by **every** tool in this server. |
| `-e LOCALSTACK_HOSTNAME=host.docker.internal` | Tells the server + IaC CLIs where the sibling LocalStack lives. |

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
        "-v", "/Users/you/.localstack-mcp:/Users/you/.localstack-mcp",
        "-e", "XDG_CACHE_HOME=/Users/you/.localstack-mcp",
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

Deploys run **inside** the MCP container, so your project directory must be visible
there. Mount it and pass the **in-container path** to the `localstack-deployer`
tool. The simplest, least-surprising convention is to mount it at the same absolute
path:

```
-v "/Users/you/projects/my-infra:/Users/you/projects/my-infra"
```

Then tell the tool `directory: /Users/you/projects/my-infra`. Terraform and SAM
work out of the box (the server injects the LocalStack endpoint into `tflocal` /
`samlocal`).

## Known limitations

- **Extra host aliases.** CDK needs `s3.host.docker.internal` for virtual-hosted S3
  calls, and the Snowflake CLI needs `snowflake.localhost.localstack.cloud` for
  emulator routing. Include the aliases shown in the quick-start command.
- **First cold start** of LocalStack can take up to ~2 minutes while the runtime
  initializes; subsequent starts reuse the persisted volume under
  `$XDG_CACHE_HOME`.
- **Persistence across MCP restarts.** The sibling `localstack-main` keeps running
  on the host even if your editor restarts the MCP container — reconnecting finds
  your stack still up. State persists in `$XDG_CACHE_HOME/localstack/volume`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Mounts denied: … is not shared from the host` | The cache bind mount / `XDG_CACHE_HOME` is missing or not under a Docker-shared root. Use a path under your home directory and mount it one-to-one. |
| Tools report `LocalStack Not Running` after `start` | Check `LOCALSTACK_HOSTNAME=host.docker.internal` is set and `--add-host` is present (Linux). |
| `Auth Token Required` | `LOCALSTACK_AUTH_TOKEN` must be passed through (every tool requires it). |
| `Could not find a running LocalStack container named "localstack-main"` | Set `MAIN_CONTAINER_NAME` if you renamed it. |

## Validating an image yourself

`tests/docker/validate-image.mjs` is a dependency-free MCP stdio client that drives
the image through real tool calls (management, aws-client, deployer, docs,
extensions). See its header for usage.
