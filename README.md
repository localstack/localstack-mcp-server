<div align="center">

<img src="icon.png" alt="LocalStack MCP Server" width="120" />

# LocalStack MCP Server

**Let an AI agent manage and interact with LocalStack on your machine.**

[![npm version](https://img.shields.io/npm/v/@localstack/localstack-mcp-server)](https://www.npmjs.com/package/@localstack/localstack-mcp-server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-localstack-blue)](https://registry.modelcontextprotocol.io/)

</div>

> [!IMPORTANT]
> The LocalStack MCP server is currently available as an experimental public preview. For questions, issues or feedback, please utilize the [LocalStack Community slack](https://slack.localstack.cloud) or submit a [GitHub Issue](https://github.com/localstack/localstack-mcp-server/issues)

LocalStack emulates the cloud on your local machine so software teams and AI agents can validate security, quality, and reliability faster and more safely than the cloud allows. This [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) (MCP) server lets any MCP client (Cursor, Claude, VS Code, and more) start LocalStack, deploy infrastructure, and debug your local cloud in natural language.

## Quick start

Set up the server in your MCP client with the interactive wizard:

```bash
npx -y @localstack/localstack-mcp-server init
```

The wizard detects your installed clients, asks how you want to run the server, and writes the configuration for you. You need a LocalStack Auth Token; the wizard reads `LOCALSTACK_AUTH_TOKEN` from your environment or asks for it. For the full options, prerequisites, and manual setup, see [Installation](#installation).

## What you can ask your agent

Once the server is configured, talk to LocalStack through your agent in natural language:

- "Start LocalStack and deploy the Terraform project in `./infra`, then tell me which resources came up."
- "My Lambda calls are failing. Read the LocalStack logs, find the permission errors, and generate an IAM policy that fixes them."
- "Inject 500ms of latency into DynamoDB and confirm my retry logic still works."
- "Search the LocalStack docs for how to enable S3 event notifications and summarize the steps."
- "Start the LocalStack Azure emulator, create a resource group and a storage account in westeurope, and upload `./data/sample.csv` to a new container."
- "Using the Azure emulator, create a Key Vault, store a secret called `db-password`, and show me how my app would read it."

## How it works

The server connects MCP-compatible apps directly to your local LocalStack environment and its emulated AWS services, so your assistant can operate the stack securely without custom scripts or manual setup.

This server eliminates custom scripts and manual LocalStack management. Your agent can:

- Start, stop, restart, and monitor the LocalStack for AWS, Snowflake and Azure emulators with built-in auth.
- Run Azure CLI (`az`) commands against the local LocalStack for Azure emulator, never real Azure.
- Deploy CDK, Terraform, and SAM projects with automatic configuration detection.
- Search LocalStack documentation for guides, API references, and configuration details.
- Parse logs, catch errors, and auto-generate IAM policies from violations.
- Inject chaos faults and network effects into LocalStack to test system resilience.
- Manage LocalStack state snapshots via [Cloud Pods](https://docs.localstack.cloud/aws/capabilities/state-management/cloud-pods/) for development workflows.
- Export, import, inspect, and reset LocalStack state locally with [Export & Import State](https://docs.localstack.cloud/aws/capabilities/state-management/export-import-state/) file-based workflows.
- Install, remove, list, and discover [LocalStack Extensions](https://docs.localstack.cloud/aws/capabilities/extensions/) from the marketplace.
- Launch and manage [Ephemeral Instances](https://docs.localstack.cloud/aws/capabilities/cloud-sandbox/ephemeral-instances/) for remote LocalStack testing workflows.
- Replicate external AWS resources into LocalStack with [AWS Replicator](https://docs.localstack.cloud/aws/tooling/aws-replicator/) so IaC stacks can resolve shared dependencies locally.
- Inspect LocalStack application flows with [App Inspector](https://docs.localstack.cloud/aws/capabilities/web-app/app-inspector/) traces, spans, events, payload metadata, and IAM policy evaluations.
- Start repeatable LocalStack workflows from ready-made MCP prompts, including infrastructure validation and integration test generation.

## Tools

This server provides your AI with dedicated tools for managing your LocalStack environment:

> [!NOTE]
> All tools in this MCP server require `LOCALSTACK_AUTH_TOKEN`.

| Tool Name                                                                         | Description                                                                | Key Features                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`localstack-management`](./src/tools/localstack-management.ts)                   | Manages LocalStack runtime operations for AWS, Snowflake and Azure stacks  | - Execute start, stop, restart, and status checks<br/>- Integrate LocalStack authentication tokens<br/>- Inject custom environment variables<br/>- Verify real-time status and perform health monitoring                                                                                                                                                                                                                                                                                                                              |
| [`localstack-deployer`](./src/tools/localstack-deployer.ts)                       | Handles infrastructure deployment to LocalStack for AWS environments       | - Automatically run CDK, Terraform, and SAM tooling to deploy infrastructure locally<br/>- Enable parameterized deployments with variable support<br/>- Process and present deployment results<br/>- Requires you to have [`cdklocal`](https://github.com/localstack/aws-cdk-local), [`tflocal`](https://github.com/localstack/terraform-local), or [`samlocal`](https://github.com/localstack/aws-sam-cli-local) installed in your system path                                                                                       |
| [`localstack-logs-analysis`](./src/tools/localstack-logs-analysis.ts)             | Analyzes LocalStack for AWS logs for troubleshooting and insights          | - Offer multiple analysis options including summaries, errors, requests, and raw data<br/>- Filter by specific services and operations<br/>- Generate API call metrics and failure breakdowns<br/>- Group errors intelligently and identify patterns                                                                                                                                                                                                                                                                                  |
| [`localstack-iam-policy-analyzer`](./src/tools/localstack-iam-policy-analyzer.ts) | Handles IAM policy management and violation remediation                    | - Set IAM enforcement levels including `enforced`, `soft`, and `disabled` modes<br/>- Search logs for permission-related violations<br/>- Generate IAM policies automatically from detected access failures<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                                                                                              |
| [`localstack-chaos-injector`](./src/tools/localstack-chaos-injector.ts)           | Injects and manages chaos experiment faults for system resilience testing  | - Inject, add, remove, and clear service fault rules<br/>- Configure network latency effects<br/>- Comprehensive fault targeting by service, region, and operation<br/>- Built-in workflow guidance for chaos experiments<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                                                                                |
| [`localstack-cloud-pods`](./src/tools/localstack-cloud-pods.ts)                   | Manages remote LocalStack Cloud Pods for development workflows             | - Save current state as a Cloud Pod<br/>- Load previously saved Cloud Pods instantly<br/>- Delete Cloud Pods from remote cloud-backed storage<br/>- Use this for managed remote state snapshots, not local export/import files<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                                                                           |
| [`localstack-state-management`](./src/tools/localstack-state-management.ts)       | Manages local file-based LocalStack state export/import workflows          | - Export LocalStack state to a local file on disk through the LocalStack State REST API<br/>- Import LocalStack state from a local file<br/>- Inspect current LocalStack state as JSON metamodel data<br/>- Reset all state or only selected services<br/>- Supports service-level granularity for export, reset, and inspect<br/>- Use this for local disk workflows; use Cloud Pods for remote cloud-backed snapshots<br/>- Requires a valid LocalStack Auth Token                                                                  |
| [`localstack-extensions`](./src/tools/localstack-extensions.ts)                   | Installs, uninstalls, lists, and discovers LocalStack Extensions           | - Manage installed extensions (`list`, `install`, `uninstall`) inside the running container<br/>- Browse the LocalStack Extensions marketplace (`available`)<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                                                                                                                                             |
| [`localstack-ephemeral-instances`](./src/tools/localstack-ephemeral-instances.ts) | Manages cloud-hosted LocalStack Ephemeral Instances                        | - Create temporary cloud-hosted LocalStack instances and get an endpoint URL<br/>- List available ephemeral instances, fetch logs, and delete instances<br/>- Supports lifetime, extension preload, Cloud Pod preload, and custom env vars on create<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                                                     |
| [`localstack-aws-client`](./src/tools/localstack-aws-client.ts)                   | Runs AWS CLI commands inside the LocalStack for AWS container              | - Executes commands via `awslocal` inside the running container<br/>- Sanitizes commands to block shell chaining<br/>- Auto-detects LocalStack coverage errors and links to docs                                                                                                                                                                                                                                                                                                                                                      |
| [`localstack-azure-client`](./src/tools/localstack-azure-client.ts)               | Runs Azure CLI (`az`) commands against the LocalStack for Azure emulator   | - Runs the host's `az` in an isolated CLI profile that is logged in to the emulator only<br/>- Refuses shell syntax, CLI-profile changes, logins, extension installs and commands that open a browser, shell or tunnel<br/>- Rewrites absolute `management.azure.com` URLs to relative ones and blocks every other outbound host<br/>- Keeps file arguments inside the working directory; returns hints when the emulator does not implement an operation<br/>- Requires the Azure CLI (`az` 2.85+) and a valid LocalStack Auth Token |
| [`localstack-aws-replicator`](./src/tools/localstack-aws-replicator.ts)           | Replicates external AWS resources into a running LocalStack instance       | - Start single-resource replication jobs with a resource type and identifier or ARN<br/>- Start batch replication jobs, such as SSM parameters under a path prefix<br/>- Poll job status by job ID and list existing jobs<br/>- List resource types supported by the running Replicator extension<br/>- Reads source AWS credentials from the MCP server environment and supports optional target account or region overrides                                                                                                         |
| [`localstack-app-inspector`](./src/tools/localstack-app-inspector.ts)             | Inspects LocalStack application traces, spans, events, and IAM evaluations | - Enable or disable App Inspector for the running LocalStack instance<br/>- List and inspect traces to understand AWS service-to-service flows<br/>- Drill into spans, events, payload metadata, and IAM policy evaluation events<br/>- Filter by service, region, operation, resource, ARN, status, and time range<br/>- Requires a valid LocalStack Auth Token and the App Inspector feature in the connected LocalStack license                                                                                                    |
| [`localstack-docs`](./src/tools/localstack-docs.ts)                               | Searches LocalStack documentation through CrawlChat                        | - Queries LocalStack docs through a public CrawlChat collection<br/>- Returns focused snippets with source links only<br/>- Helps answer coverage, configuration, and setup questions without requiring LocalStack runtime                                                                                                                                                                                                                                                                                                            |
| [`localstack-snowflake-client`](./src/tools/localstack-snowflake-client.ts)       | Runs SQL against the LocalStack Snowflake emulator through the `snow` CLI  | - Execute SELECT, DDL (CREATE/DROP), DML (INSERT/UPDATE/DELETE), and SHOW/DESCRIBE statements from a query string or a `.sql` file<br/>- Check the Snowflake connection before running queries<br/>- Set optional database, schema, warehouse, and role context per query<br/>- Requires the Snowflake CLI (`snow`) and a valid LocalStack Auth Token                                                                                                                                                                                 |

## Prompts

Prompts are user-selected workflow templates exposed by MCP clients as slash commands or quick actions. They frame multi-step LocalStack tasks so the assistant follows the same phases, evidence requirements, and reporting format every time.

| Prompt Name             | Description                                                                                                                                                               | Arguments                                                                                                    |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------- |
| `infrastructure-tester` | Deploys an IaC project to LocalStack, validates declared resources with live AWS probes and App Inspector evidence, then writes and runs deterministic integration tests. | `iac_path` (required), `iac_type`, `test_language`, `test_framework`, `mode`, `services_focus`, `user_focus` |

## Installation

### Set up with the wizard (recommended)

The fastest way to install the MCP server is the interactive setup wizard:

```bash
npx -y @localstack/localstack-mcp-server init
```

The wizard:

- lets you choose how to run the server (`npx` on your machine, or the self-contained Docker image),
- checks the prerequisites (Node.js, Docker) and tells you how to fix anything missing,
- picks up your `LOCALSTACK_AUTH_TOKEN` from the environment, or asks for it,
- lets you pass extra LocalStack config (e.g. `DEBUG=1,PERSISTENCE=1`),
- detects your installed MCP clients (Cursor, Antigravity, Claude Code, Claude Desktop, VS Code, Codex, OpenCode, Amazon Q CLI) and writes the right configuration for each one you select.

It can also run fully non-interactively, e.g. in dotfiles or scripts:

```bash
npx -y @localstack/localstack-mcp-server init --method npx --client cursor,claude-code --yes
```

To remove the server from your clients again:

```bash
npx -y @localstack/localstack-mcp-server remove
```

Run `npx -y @localstack/localstack-mcp-server init --help` for all options.

### Prerequisites

- Docker installed and running. The MCP server manages the LocalStack container directly through the Docker API.
- [`cdklocal`](https://github.com/localstack/aws-cdk-local), [`tflocal`](https://github.com/localstack/terraform-local), or [`samlocal`](https://github.com/localstack/aws-sam-cli-local) installed in your system path if you want to deploy CDK, Terraform, or SAM projects
- Snowflake CLI (`snow`) installed in your system path if you want to use the Snowflake tool
- Azure CLI (`az` 2.85 or newer) installed in your system path if you want to use the Azure tool, plus the tool's add-ons: see [Setting up the Azure tool](#setting-up-the-azure-tool)
- A [valid LocalStack Auth Token](https://docs.localstack.cloud/aws/getting-started/auth-token/) configured as `LOCALSTACK_AUTH_TOKEN` (**required for all MCP tools**)
- [Node.js v20](https://nodejs.org/en/download/) or higher installed in your system path

The Docker image bundles `cdklocal`, `tflocal`, `samlocal`, the Snowflake CLI and the Azure CLI with the Azure tool's add-ons, so with `--method docker` you do not install those.

### Setting up the Azure tool

The Azure tool runs the Azure CLI on your machine against the LocalStack Azure emulator, the way the Snowflake tool runs the Snowflake CLI. The emulator does not include the Azure CLI, and the setup wizard does not install it, so install it yourself:

1. **The Azure CLI** (`az` 2.85 or newer), following the [official documentation](https://learn.microsoft.com/cli/azure/install-azure-cli). Installation options:
   - Windows: `winget install --exact --id Microsoft.AzureCLI`
   - macOS: `brew install azure-cli`
   - Debian or Ubuntu: `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`

   If you already have it, `az --version` shows which version, and `az upgrade` updates it.

2. **The tool's add-ons**: the Azure CLI extensions it supports, and the Bicep CLI for `.bicep` templates:

   ```bash
   npx -y @localstack/localstack-mcp-server install-azure-addons
   ```

   This installs the 26 pinned extensions into `~/.localstack/azure/mcp-extensions` and the pinned, sha256-checked Bicep into `~/.localstack/azure/bin`. Skip either part with `--no-extensions` or `--no-bicep`. A `bicep` already on your `PATH` works too (for example `winget install -e --id Microsoft.Bicep`, or `brew install azure/bicep/bicep`).

   Without the add-ons, the core `az` commands still work. A command that needs an extension, or a `.bicep` deployment without Bicep, answers with this command.

The tool keeps its own Azure CLI profile, logged in to the emulator only, and never changes yours (`~/.azure`). If `az` is missing when the tool is used, its answer says how to install it, as the Snowflake tool's does for `snow`.

### Run with npx

Add the following to your MCP client's configuration file (e.g., `~/.cursor/mcp.json`). This configuration uses `npx` to run the server, which will automatically download and install the package if needed. The server manages LocalStack through your Docker daemon; any deployment CLIs used by tools run from your host PATH.

```json
{
  "mcpServers": {
    "localstack": {
      "command": "npx",
      "args": ["-y", "@localstack/localstack-mcp-server"],
      "env": {
        "LOCALSTACK_AUTH_TOKEN": "<YOUR_TOKEN>"
      }
    }
  }
}
```

All LocalStack MCP tools require `LOCALSTACK_AUTH_TOKEN` to be set. You can get your LocalStack Auth Token by following the official [documentation](https://docs.localstack.cloud/aws/getting-started/auth-token/).

### Run from source

If you installed from source, change `command` and `args` to point to your local build:

```json
{
  "mcpServers": {
    "localstack": {
      "command": "node",
      "args": ["/path/to/your/localstack-mcp-server/dist/cli.js"],
      "env": {
        "LOCALSTACK_AUTH_TOKEN": "<YOUR_TOKEN>"
      }
    }
  }
}
```

### Run with Docker

The `localstack/localstack-mcp-server` Docker image bundles Terraform/`tflocal`, CDK/`cdklocal`, SAM/`samlocal`, and the Snowflake CLI. The only required host dependency is Docker. The container uses the mounted Docker socket to run LocalStack as a sibling container on the host; state lives in a named Docker volume (`localstack-mcp`) unless `LOCALSTACK_VOLUME_DIR` points at a host directory.

If you use the deployer tool with local Terraform, CDK, or SAM projects, bind-mount those project paths into the MCP container and pass the in-container path to the tool. The simplest convention is to mount projects at the same absolute path they use on the host.

```json
{
  "mcpServers": {
    "localstack": {
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
        "localstack/localstack-mcp-server:latest"
      ],
      "env": { "LOCALSTACK_AUTH_TOKEN": "<YOUR_TOKEN>" }
    }
  }
}
```

See **[docs/DOCKER.md](./docs/DOCKER.md)** for the run command, MCP client config, IaC project mounts, CDK notes, and troubleshooting.

## LocalStack configuration

| Variable Name                                                     | Description                                                                                                                                                                                                                                     | Default Value                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `LOCALSTACK_AUTH_TOKEN` (**required**)                            | The LocalStack Auth Token to use for the MCP server                                                                                                                                                                                             | None                                                     |
| `MAIN_CONTAINER_NAME`                                             | The explicit LocalStack container name to use for Docker-based tools. When unset, the server auto-detects standard LocalStack containers such as `localstack-main` and `localstack-aws`, then LocalStack Docker images.                         | Auto-detect                                              |
| `LOCALSTACK_IMAGE_NAME` / `IMAGE_NAME`                            | Docker image the `start` action launches for the AWS stack. `LOCALSTACK_IMAGE_NAME` wins when both are set (beware: bare `IMAGE_NAME` is a common CI variable).                                                                                 | `localstack/localstack-pro:latest`                       |
| `LOCALSTACK_VOLUME_DIR`                                           | Host directory mounted at `/var/lib/localstack` in the LocalStack container. Defaults to the same per-OS cache path the LocalStack CLI used (state carries over); inside Docker it defaults to the `localstack-mcp` named volume.               | Per-OS cache dir                                         |
| `GATEWAY_LISTEN`                                                  | Override the gateway port bindings for `start` (comma-separated `[host]:port`). When set, the implicit `443` binding is skipped.                                                                                                                | `:4566,:443`                                             |
| `DOCKER_HOST`                                                     | Docker daemon endpoint used for all container operations (`unix://`, `npipe://`, `tcp://`).                                                                                                                                                     | Platform default socket                                  |
| `DOCKER_SOCK`                                                     | Host path of the Docker socket mounted into the LocalStack container (for Lambda). Validated to exist when set explicitly.                                                                                                                      | `/var/run/docker.sock`                                   |
| `EXTERNAL_SERVICE_PORTS_START` / `_END`                           | Inclusive host port range published for external services on `start`. Validated (1–65535, start ≤ end).                                                                                                                                         | `4510` / `4560`                                          |
| `MCP_ANALYTICS_DISABLED`                                          | Disable MCP analytics when set to `1`                                                                                                                                                                                                           | `0`                                                      |
| `APP_INSPECTOR`                                                   | Set to `1` in the LocalStack container environment to enable App Inspector by default across restarts. The MCP tool can also toggle App Inspector at runtime with `set-status`.                                                                 | `0`                                                      |
| `AWS_ACCESS_KEY_ID` (**required for AWS Replicator tool**)        | Source AWS access key used by AWS Replicator to read external AWS resources                                                                                                                                                                     | None                                                     |
| `AWS_SECRET_ACCESS_KEY` (**required for AWS Replicator tool**)    | Source AWS secret access key used by AWS Replicator to read external AWS resources                                                                                                                                                              | None                                                     |
| `AWS_DEFAULT_REGION` (**required for AWS Replicator tool**)       | Source AWS region used by AWS Replicator                                                                                                                                                                                                        | None                                                     |
| `LOCALSTACK_AZURE_IMAGE_NAME`                                     | Docker image the `start` action launches for `service: azure`.                                                                                                                                                                                  | `localstack/localstack-azure:latest`                     |
| `LOCALSTACK_AZURE_PORT`                                           | Gateway port of the Azure emulator the Azure tool talks to (for example `4666` for a port-shifted emulator).                                                                                                                                    | `LOCALSTACK_PORT`, then `4566`                           |
| `LOCALSTACK_AZURE_ENDPOINT`                                       | ARM endpoint override. It must use a local name (`localhost.localstack.cloud` or a subdomain, `localhost`, `127.0.0.1`, `::1`); remote endpoints are refused.                                                                                   | `https://azure.localhost.localstack.cloud:<port>`        |
| `LOCALSTACK_AZ_PATH`                                              | Explicit Azure CLI launcher (`az`, `az.cmd`) or its Python.                                                                                                                                                                                     | `PATH` lookup                                            |
| `LOCALSTACK_AZ_CONFIG_DIR`                                        | The Azure tool's own isolated Azure CLI profile. It may not be, lie inside, or contain your `~/.azure`.                                                                                                                                         | `~/.localstack/azure/mcp-config-<port>`                  |
| `LOCALSTACK_AZ_EXTENSION_DIR`                                     | Azure CLI extension directory for the tool (automatic extension installs are off).                                                                                                                                                              | `~/.localstack/azure/mcp-extensions`                     |
| `LOCALSTACK_AZ_BICEP_PATH`                                        | An explicit Bicep binary: an absolute path to a file named `bicep` or `bicep.exe`. Otherwise `~/.localstack/azure/bin`, then `PATH` (never `~/.azure/bin`).                                                                                     | Auto-detect                                              |
| `LOCALSTACK_AZ_BICEP_ENV`                                         | Comma-separated server environment variables a `.bicepparam` may read with `readEnvironmentVariable()`. Nothing else reaches Bicep; the auth token and `AZURE_*`, `ARM_*`, `BICEP_*`, proxy and path variables are never passed.                | None                                                     |
| `LOCALSTACK_AZ_WORKDIR`                                           | Directory that the Azure tool's file arguments must stay inside; also `az`'s working directory.                                                                                                                                                 | The server's working directory                           |
| `LOCALSTACK_AZ_TIMEOUT_SECONDS`                                   | Per-command timeout of the Azure tool (5–3600).                                                                                                                                                                                                 | `300`                                                    |
| `LOCALSTACK_AZ_MAX_OUTPUT_CHARS` / `LOCALSTACK_AZ_MAX_HELP_CHARS` | Output and help-page limits of the Azure tool.                                                                                                                                                                                                  | `30000` / `30000`                                        |
| `LOCALSTACK_AZ_DENYLIST_FILE`                                     | A file of extra `az` command prefixes the tool refuses, one per line (`#` comments allowed).                                                                                                                                                    | None                                                     |
| `LOCALSTACK_AZ_EGRESS_GUARD`                                      | `0` turns off the Azure tool's egress guard (debugging only; every answer then says so).                                                                                                                                                        | `1`                                                      |
| `LOCALSTACK_AZ_PYCACHE_DIR`                                       | Bytecode cache for Azure CLI installs without `.pyc` files (the Docker image sets it).                                                                                                                                                          | None                                                     |
| `LOCALSTACK_AZ_RUNNER`                                            | `worker` (experimental) keeps warm Azure CLI processes and runs each command in one of them: about 5x faster per call on Linux. Same isolation as the default; a worker is replaced after 200 commands or any change to the tool's CLI profile. | `host` (a fresh `az` process per command)                |
| `LOCALSTACK_AZURE_FORWARD_TARGET`                                 | Docker image only: where the loopback forwarder relays the Azure emulator's ports.                                                                                                                                                              | `host.docker.internal`, then the emulator's container IP |

### How the Azure tool stays local

`localstack-azure-client` runs the Azure CLI installed on your machine, but it never uses your own Azure CLI login and never reaches real Azure:

- **Its own CLI profile.** `az` runs with `AZURE_CONFIG_DIR` set to the tool's profile (`~/.localstack/azure/mcp-config-<port>`), registered with a `LocalStack` cloud and a dummy login. It also gets a private home and temp directory inside that profile, so commands that write into `~` (SSH keys, kubeconfig, certificates) never touch yours.
- **A command policy.** Shell syntax, logins, cloud and config changes, extension installs, `upgrade`, and commands that open a browser, shell, tunnel or run Docker on your machine are refused. File arguments must stay inside `LOCALSTACK_AZ_WORKDIR` (or the private home), and never reach `~/.azure`, `~/.ssh`, `~/.kube` or `~/.docker`.
- **An allow-list environment.** `az` gets a minimal environment; your `AZURE_*`, `ARM_*`, proxy and CA variables are never passed on.
- **An egress guard.** Every connection `az` or Bicep makes goes through a local proxy that allows only the emulator's names (`*.localhost.localstack.cloud`, `localhost`). Anything else is refused. A few calls `az` makes on its own, such as update checks, Bicep's module index and the Application Insights region map that `functionapp create` downloads, are refused quietly and `az` carries on without them; any other refused host stops the command at once, and the answer names it. Absolute `https://management.azure.com/...` URLs given to `rest` are rewritten to relative ones.

Long-running creates wait until the resource is ready. Claude Desktop stops waiting for a tool call after about 60 seconds; with that client, ask for `--no-wait` and poll with `show`. Other clients (Claude Code, most IDEs) wait much longer.

File arguments (templates, uploads, downloads) must be inside the tool's working directory, which is the server's own working directory unless you set `LOCALSTACK_AZ_WORKDIR`. GUI clients such as Claude Desktop start the server in their own folder, so add `"LOCALSTACK_AZ_WORKDIR": "<your project folder>"` to the entry's `env` to work with local files.

The other tools with the Azure emulator: `localstack-management` manages it (`service: "azure"`), and `localstack-logs-analysis` shows its raw log (`analysisType: "logs"`); the summary, errors and requests analyses read AWS logs only.

### Migration notes (CLI-free lifecycle)

Since v0.6.0 the MCP server no longer uses (or requires) the `localstack` CLI. The LocalStack container is created directly through the Docker Engine API. Behavioral differences from CLI-driven starts:

- `~/.localstack/*.env` config profiles and `DOCKER_FLAGS` are **not** read at start. Pass configuration through the `envVars` argument of the `localstack-management` start action, or set `LOCALSTACK_`-prefixed variables in the MCP server's environment (LocalStack aliases `LOCALSTACK_<NAME>` to `<NAME>` natively).
- Besides `LOCALSTACK_*`/`PROVIDER_OVERRIDE_*`, only a curated set of common unprefixed config variables is forwarded from the host environment (`DEBUG`, `LS_LOG`, `SERVICES`, `PERSISTENCE`, `EAGER_SERVICE_LOADING`, `ENFORCE_IAM`, `IAM_SOFT_MODE`, `EXTENSION_AUTO_INSTALL`, `APP_INSPECTOR`, `DNS_ADDRESS`, `MAIN_DOCKER_NETWORK`, and the `LAMBDA_*`/`CFN_*`/`SNOWFLAKE_*`/`SF_*` families).
- Port 443 is published by default. If something else uses port 443 locally, set `GATEWAY_LISTEN=:4566` to skip it.
- If you previously used `lstk`, note the container the server creates is named `localstack-main` (externally started `localstack-aws` containers are still detected and managed; `restart` preserves their name, image, and volume).

For AWS Replicator-specific source credentials, you can use the `AWS_REPLICATOR_SOURCE_` prefixed variants instead of the unprefixed variants. Do not mix the prefixed and unprefixed source credential groups; when any `AWS_REPLICATOR_SOURCE_` variable is set, the Replicator tool reads the source configuration only from that group.

## Contributing

Built on the [XMCP](https://github.com/basementstudio/xmcp) framework, you can add new tools by adding a new file to the `src/tools` directory and documenting it in the `manifest.json` file.

Pull requests are welcomed on GitHub! To get started:

- Install Git and Node.js
- Clone the repository
- Install dependencies with `yarn`
- Build with `yarn build`

### MCP Server Tester

This repository includes [MCP Server Tester](https://github.com/gleanwork/mcp-server-tester) for tool validation in direct mode and LLM host mode.

- Run direct MCP tests (deterministic):
  ```bash
  yarn test:mcp:direct
  ```
- Run Gemini-based MCP host evals:
  ```bash
  export GOOGLE_GENERATIVE_AI_API_KEY="<your-gemini-key>"
  export LOCALSTACK_AUTH_TOKEN="<your-localstack-auth-token>"
  yarn test:mcp:evals
  ```
- Open the latest MCP Server Tester HTML report:
  ```bash
  npx mcp-server-tester open
  ```
- Run both:
  ```bash
  yarn test:mcp
  ```

Notes:

- MCP tests target the lifecycle-aware local server command `node dist/cli.js` by default.
- `LOCALSTACK_AUTH_TOKEN` is required for all MCP tool usage and test suites.
- You can override the target command with:
  - `MCP_TEST_COMMAND`
  - `MCP_TEST_ARGS` (space-separated arguments)

## License

[Apache License 2.0](./LICENSE)

<a href="https://glama.ai/mcp/servers/@localstack/localstack-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@localstack/localstack-mcp-server/badge" alt="LocalStack Server MCP server" />
</a>
