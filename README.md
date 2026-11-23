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
- "My Lambda calls fail with AccessDenied. Find out which policy denies them and fix the project's IAM policies."
- "Generate a least-privilege policy for what this workload actually does."
- "Inject 500ms of latency into DynamoDB and confirm my retry logic still works."
- "Search the LocalStack docs for how to enable S3 event notifications and summarize the steps."
- "Start the LocalStack Azure emulator, create a resource group and a storage account, and upload `./data/sample.csv` to a new blob container."

## How it works

The server connects MCP-compatible apps directly to your local LocalStack environment and its emulated AWS services, so your assistant can operate the stack securely without custom scripts or manual setup.

This server eliminates custom scripts and manual LocalStack management. Your agent can:

- Start, stop, restart, and monitor the LocalStack for AWS, Snowflake and Azure emulators with built-in auth.
- Deploy CDK, Terraform, and SAM projects with automatic configuration detection.
- Search LocalStack documentation for guides, API references, and configuration details.
- Explain IAM denials from LocalStack's policy evaluations: the policies that decided a request, the suggested fix, and least-privilege policies derived from a run.
- Inject chaos faults and network effects into LocalStack to test system resilience.
- Manage LocalStack state snapshots via [Cloud Pods](https://docs.localstack.cloud/aws/capabilities/state-management/cloud-pods/) for development workflows.
- Export, import, inspect, and reset LocalStack state locally with [Export & Import State](https://docs.localstack.cloud/aws/capabilities/state-management/export-import-state/) file-based workflows.
- Install, remove, list, and discover [LocalStack Extensions](https://docs.localstack.cloud/aws/capabilities/extensions/) from the marketplace.
- Launch and manage [Ephemeral Instances](https://docs.localstack.cloud/aws/capabilities/cloud-sandbox/ephemeral-instances/) for remote LocalStack testing workflows.
- Replicate external AWS resources into LocalStack with [AWS Replicator](https://docs.localstack.cloud/aws/tooling/aws-replicator/) so IaC stacks can resolve shared dependencies locally.
- Inspect LocalStack application flows with [App Inspector](https://docs.localstack.cloud/aws/capabilities/web-app/app-inspector/) traces, spans, events, payload metadata, and IAM policy evaluations with suggested fixes.
- Start repeatable LocalStack workflows from ready-made MCP prompts, including infrastructure validation and integration test generation.

## Tools

This server provides your AI with dedicated tools for managing your LocalStack environment:

> [!NOTE]
> All tools in this MCP server require `LOCALSTACK_AUTH_TOKEN`.

| Tool Name                                                                         | Description                                                                | Key Features                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`localstack-management`](./src/tools/localstack-management.ts)                   | Manages LocalStack runtime operations for AWS, Snowflake and Azure stacks  | - Execute start, stop, restart, and status checks<br/>- Integrate LocalStack authentication tokens<br/>- Inject custom environment variables<br/>- Verify real-time status and perform health monitoring                                                                                                                                                                                                                                                             |
| [`localstack-deployer`](./src/tools/localstack-deployer.ts)                       | Handles infrastructure deployment to LocalStack for AWS environments       | - Automatically run CDK, Terraform, and SAM tooling to deploy infrastructure locally<br/>- Enable parameterized deployments with variable support<br/>- Process and present deployment results<br/>- Runs `lstk terraform`, `lstk cdk`, or `lstk sam`, so it requires [`lstk`](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/) plus `terraform`, `cdk`, or `sam` in your system path                      |
| [`localstack-logs-analysis`](./src/tools/localstack-logs-analysis.ts)             | Analyzes LocalStack for AWS logs for troubleshooting and insights          | - Offer multiple analysis options including summaries, errors, requests, and raw data<br/>- Filter by specific services and operations<br/>- Generate API call metrics and failure breakdowns<br/>- Group errors intelligently and identify patterns                                                                                                                                                                                                                 |
| [`localstack-iam-policy-analyzer`](./src/tools/localstack-iam-policy-analyzer.ts) | Handles IAM policy management and violation remediation; `localstack-app-inspector` is recommended for IAM | - Set IAM enforcement levels including `enforced`, `soft`, and `disabled` modes<br/>- Search logs for permission-related violations<br/>- Generate IAM policies automatically from detected access failures<br/>- Every response recommends the matching `localstack-app-inspector` action (`get-iam-mode`, `set-iam-mode`, `list-iam-denials`, `explain-iam`, `get-auto-derived-iam-policies`)<br/>- Requires a valid LocalStack Auth Token |
| [`localstack-chaos-injector`](./src/tools/localstack-chaos-injector.ts)           | Injects and manages chaos experiment faults for system resilience testing  | - Inject, add, remove, and clear service fault rules<br/>- Configure network latency effects<br/>- Comprehensive fault targeting by service, region, and operation<br/>- Built-in workflow guidance for chaos experiments<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                               |
| [`localstack-cloud-pods`](./src/tools/localstack-cloud-pods.ts)                   | Manages remote LocalStack Cloud Pods for development workflows             | - Save current state as a Cloud Pod<br/>- Load previously saved Cloud Pods instantly<br/>- Delete Cloud Pods from remote cloud-backed storage<br/>- Use this for managed remote state snapshots, not local export/import files<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                          |
| [`localstack-state-management`](./src/tools/localstack-state-management.ts)       | Manages local file-based LocalStack state export/import workflows          | - Export LocalStack state to a local file on disk through the LocalStack State REST API<br/>- Import LocalStack state from a local file<br/>- Inspect current LocalStack state as JSON metamodel data<br/>- Reset all state or only selected services<br/>- Supports service-level granularity for export, reset, and inspect<br/>- Use this for local disk workflows; use Cloud Pods for remote cloud-backed snapshots<br/>- Requires a valid LocalStack Auth Token |
| [`localstack-extensions`](./src/tools/localstack-extensions.ts)                   | Installs, uninstalls, lists, and discovers LocalStack Extensions           | - Manage installed extensions (`list`, `install`, `uninstall`) inside the running container<br/>- Browse the LocalStack Extensions marketplace (`available`)<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                                                                            |
| [`localstack-ephemeral-instances`](./src/tools/localstack-ephemeral-instances.ts) | Manages cloud-hosted LocalStack Ephemeral Instances                        | - Create temporary cloud-hosted LocalStack instances and get an endpoint URL<br/>- List available ephemeral instances, fetch logs, and delete instances<br/>- Supports lifetime, extension preload, Cloud Pod preload, and custom env vars on create<br/>- Requires a valid LocalStack Auth Token                                                                                    |
| [`localstack-aws-client`](./src/tools/localstack-aws-client.ts)                   | Runs AWS CLI commands against LocalStack for AWS                          | - Executes commands with the official AWS CLI v2 through `lstk aws`, so it requires `lstk` and `aws` in your system path<br/>- Keeps every request on LocalStack: the CLI runs without your `~/.aws` and behind a local proxy that refuses other hosts<br/>- Reads and writes local files only inside `LOCALSTACK_AWS_WORKDIR`<br/>- Sanitizes commands to block shell chaining<br/>- Auto-detects LocalStack coverage errors and links to docs                                                                                                                                                                                                                                                                                     |
| [`localstack-azure-client`](./src/tools/localstack-azure-client.ts)               | Runs Azure CLI (`az`) commands against the LocalStack for Azure emulator   | - Runs the Azure CLI installed on your machine with its own profile, never your Azure login<br/>- Blocks shell syntax and commands that would change the profile, install software or never end<br/>- Uses the extensions you installed with `az extension add`<br/>- Requires the Azure CLI and a valid LocalStack Auth Token                                                                                                                                       |
| [`localstack-aws-replicator`](./src/tools/localstack-aws-replicator.ts)           | Replicates external AWS resources into a running LocalStack instance       | - Start single-resource replication jobs with a resource type and identifier or ARN<br/>- Start batch replication jobs, such as SSM parameters under a path prefix<br/>- Poll job status by job ID and list existing jobs<br/>- List resource types supported by the running Replicator extension<br/>- Reads source AWS credentials from the MCP server environment and supports optional target account or region overrides                                        |
| [`localstack-app-inspector`](./src/tools/localstack-app-inspector.ts) | Inspects LocalStack application traces, spans, events, and IAM evaluations | - Enable or disable App Inspector for the running LocalStack instance<br/>- List and inspect traces to understand AWS service-to-service flows<br/>- Drill into spans, events, payload metadata, and IAM policy evaluation events<br/>- Filter by service, region, operation, resource, ARN, status, and time range<br/>- IAM: set the enforcement mode (`get-iam-mode`, `set-iam-mode`, which reports the previous mode and how to restore it), list denied requests and, after a fix, only new ones (`list-iam-denials`, `newer_than`), explain one with its deciding policies and LocalStack's suggested fix (`explain-iam`, `detail`, `get-iam-policy`), and read or clear the least-privilege policies derived from a run (`get-auto-derived-iam-policies`, `clear-auto-derived-iam-policies`)<br/>- Requires a valid LocalStack Auth Token and the App Inspector feature in the connected LocalStack license, except `get-iam-mode` / `set-iam-mode` (IAM enforcement) and the auto-derived policies (IAM Policy Stream); IAM details need a license that includes viewing IAM policy errors |
| [`localstack-docs`](./src/tools/localstack-docs.ts)                               | Searches LocalStack documentation through CrawlChat                        | - Queries LocalStack docs through a public CrawlChat collection<br/>- Returns focused snippets with source links only<br/>- Helps answer coverage, configuration, and setup questions without requiring LocalStack runtime                                                                                                                                                                                                                                           |
| [`localstack-snowflake-client`](./src/tools/localstack-snowflake-client.ts)       | Runs SQL against the LocalStack Snowflake emulator through the `snow` CLI  | - Execute SELECT, DDL (CREATE/DROP), DML (INSERT/UPDATE/DELETE), and SHOW/DESCRIBE statements from a query string or a `.sql` file<br/>- Check the Snowflake connection before running queries<br/>- Set optional database, schema, warehouse, and role context per query<br/>- Requires the Snowflake CLI (`snow`) and a valid LocalStack Auth Token                                                                                                                |

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
- [`lstk`](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/) (`npm install -g @localstack/lstk`) and the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) if you want to run AWS CLI commands or deploy CloudFormation stacks, plus the Terraform, AWS CDK (2.177.0 or newer), or AWS SAM (1.95.0 or newer) CLI in your system path if you want to deploy Terraform, CDK, or SAM projects
- Snowflake CLI (`snow`) installed in your system path if you want to use the Snowflake tool
- Azure CLI (`az`) installed in your system path if you want to use the Azure tool (see [docs/AZURE.md](./docs/AZURE.md))
- A [valid LocalStack Auth Token](https://docs.localstack.cloud/aws/getting-started/auth-token/) configured as `LOCALSTACK_AUTH_TOKEN` (**required for all MCP tools**)
- [Node.js v20](https://nodejs.org/en/download/) or higher installed in your system path

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

The `localstack/localstack-mcp-server` Docker image bundles `lstk` with the AWS CLI v2, Terraform, CDK, and SAM, and the Snowflake CLI. The only required host dependency is Docker. The container uses the mounted Docker socket to run LocalStack as a sibling container on the host; state lives in a named Docker volume (`localstack-mcp`) unless `LOCALSTACK_VOLUME_DIR` points at a host directory.

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

| Variable Name                                                  | Description                                                                                                                                                                                                                       | Default Value                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `LOCALSTACK_AUTH_TOKEN` (**required**)                         | The LocalStack Auth Token to use for the MCP server                                                                                                                                                                               | None                               |
| `LOCALSTACK_HOSTNAME`                                          | Host name of the LocalStack gateway the tools call; in Docker, `host.docker.internal`. The Azure tool always calls `azure.localhost.localstack.cloud` (127.0.0.1), so it needs a local gateway.                                   | `localhost`                        |
| `LOCALSTACK_PORT`                                              | Port of the LocalStack gateway the tools call.                                                                                                                                                                                    | `4566`                             |
| `MAIN_CONTAINER_NAME`                                          | Container name for Docker-based tools and the container `start` creates. When unset, `start` uses `localstack-main`; the tools find it, lstk's containers, then LocalStack images ([lstk](#using-lstk)).                          | Auto-detect                        |
| `LOCALSTACK_IMAGE_NAME` / `IMAGE_NAME`                         | Docker image the `start` action launches for the AWS stack. `LOCALSTACK_IMAGE_NAME` wins when both are set (beware: bare `IMAGE_NAME` is a common CI variable).                                                                   | `localstack/localstack-pro:latest` |
| `LOCALSTACK_VOLUME_DIR`                                        | Host directory mounted at `/var/lib/localstack` in the LocalStack container. Defaults to the same per-OS cache path the LocalStack CLI used (state carries over); inside Docker it defaults to the `localstack-mcp` named volume. | Per-OS cache dir                   |
| `GATEWAY_LISTEN`                                               | Override the gateway port bindings for `start` (comma-separated `[host]:port`). When set, the implicit `443` binding is skipped.                                                                                                  | `:4566,:443`                       |
| `DOCKER_HOST`                                                  | Docker daemon endpoint used for all container operations (`unix://`, `npipe://`, `tcp://`).                                                                                                                                       | Platform default socket            |
| `DOCKER_SOCK`                                                  | Host path of the Docker socket mounted into the LocalStack container (for Lambda). Validated to exist when set explicitly.                                                                                                        | `/var/run/docker.sock`             |
| `EXTERNAL_SERVICE_PORTS_START` / `_END`                        | Inclusive host port range published for external services on `start`. Validated (1–65535, start ≤ end).                                                                                                                           | `4510` / `4560`                    |
| `MCP_ANALYTICS_DISABLED`                                       | Disable MCP analytics when set to `1`                                                                                                                                                                                             | `0`                                |
| `APP_INSPECTOR`                                                | Set to `1` in the LocalStack container environment to enable App Inspector by default across restarts. The MCP tool can also toggle App Inspector at runtime with `set-status`.                                                   | `0`                                |
| `AWS_ACCESS_KEY_ID` (**required for AWS Replicator tool**)     | Source AWS access key used by AWS Replicator to read external AWS resources                                                                                                                                                       | None                               |
| `AWS_SECRET_ACCESS_KEY` (**required for AWS Replicator tool**) | Source AWS secret access key used by AWS Replicator to read external AWS resources                                                                                                                                                | None                               |
| `AWS_DEFAULT_REGION` (**required for AWS Replicator tool**)    | Source AWS region used by AWS Replicator                                                                                                                                                                                          | None                               |
| `LOCALSTACK_AZURE_IMAGE_NAME`                                  | Docker image the `start` action launches for the Azure stack (default `localstack/localstack-azure:latest`).                                                                                                                      | Latest Azure image                 |
| `LOCALSTACK_AZ_PATH`                                           | The `az` launcher, or the Azure CLI's Python, for the Azure tool.                                                                                                                                                                 | Found on `PATH`                    |
| `LOCALSTACK_AZ_CONFIG_DIR`                                     | The Azure tool's own Azure CLI profile directory (default `~/.localstack/azure/mcp-config-<port>`); it must not overlap your `~/.azure`.                                                                                          | Under `~/.localstack/azure`        |
| `LOCALSTACK_AWS_WORKDIR`                                       | The directory the AWS client tool runs the AWS CLI in. Local files a command reads or writes (`s3 cp`, `file://`, `--body`, an outfile) must be inside it. Unset in the Docker image, and when the server runs in `/` or your home directory: then only relative paths work, in a private temp directory. | The server's working directory     |
| `LOCALSTACK_AZ_WORKDIR`                                        | The directory the Azure tool runs `az` in; relative file paths resolve against it.                                                                                                                                                | The server's working directory     |
| `LOCALSTACK_AZ_TIMEOUT_SECONDS`                                | Time limit for one Azure CLI command (5–3600).                                                                                                                                                                                    | `300`                              |

See **[docs/AZURE.md](./docs/AZURE.md)** for how the Azure tool runs the Azure CLI.

### Migration notes (CLI-free lifecycle)

Since v0.6.0 the MCP server no longer uses (or requires) the `localstack` CLI. The LocalStack container is created directly through the Docker Engine API. Behavioral differences from CLI-driven starts:

- `~/.localstack/*.env` config profiles and `DOCKER_FLAGS` are **not** read at start. Pass configuration through the `envVars` argument of the `localstack-management` start action, or set `LOCALSTACK_`-prefixed variables in the MCP server's environment (LocalStack aliases `LOCALSTACK_<NAME>` to `<NAME>` natively).
- Besides `LOCALSTACK_*`/`PROVIDER_OVERRIDE_*`, only a curated set of common unprefixed config variables is forwarded from the host environment (`DEBUG`, `LS_LOG`, `SERVICES`, `PERSISTENCE`, `EAGER_SERVICE_LOADING`, `ENFORCE_IAM`, `IAM_SOFT_MODE`, `EXTENSION_AUTO_INSTALL`, `APP_INSPECTOR`, `DNS_ADDRESS`, `MAIN_DOCKER_NETWORK`, and the `LAMBDA_*`/`CFN_*`/`SNOWFLAKE_*`/`SF_*` families).
- Port 443 is published by default. If something else uses port 443 locally, set `GATEWAY_LISTEN=:4566` to skip it.
- The container the server creates is named `localstack-main`, not lstk's `localstack-aws`. See [Using lstk](#using-lstk).

For AWS Replicator-specific source credentials, you can use the `AWS_REPLICATOR_SOURCE_` prefixed variants instead of the unprefixed variants. Do not mix the prefixed and unprefixed source credential groups; when any `AWS_REPLICATOR_SOURCE_` variable is set, the Replicator tool reads the source configuration only from that group.

### Using lstk

[lstk](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/) names its container `localstack-{type}`, such as `localstack-aws`, or `localstack-{type}-{tag}` when it runs a pinned tag. The server names the container it creates `localstack-main`. It finds lstk's containers under these names, or under any name by the `cloud.localstack.lstk` label lstk sets.

To have both tools manage one container, set lstk's [`container_name`](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/configuration/) to `localstack-main`:

```toml
[[containers]]
type = "aws"
port = "4566"
container_name = "localstack-main"
```

Then lstk finds the container by name, whichever tool started it.

Without that setting, the server still finds and manages lstk's container: `stop` and `status` act on it, `restart` keeps its name, image, volume and lstk's labels (the gateway moves to `LOCALSTACK_PORT`, where the tools reach it), and `start` reports it as a conflict when it holds a port `start` needs. When `LOCALSTACK_PORT` is set, the tools that use Docker (`stop`, `restart`, logs, the deployer and others) act only on a container that publishes that port, or that publishes no ports at all, such as one on the host network. lstk, for its part, falls back to the first running container with a standard LocalStack image that publishes port 4566, so it may find the server's container, or another one when several run.

The two tools keep state in different directories, even under one container name. lstk uses `<cache dir>/lstk/volume/<derived name>`, which does not change with `container_name`, and the server uses the LocalStack CLI's `<cache dir>/localstack/volume`. To share state, point one at the other: set `volume` in lstk's config, or `LOCALSTACK_VOLUME_DIR` for the server.

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
- Run each tool against a running LocalStack, without a model (deterministic; starts LocalStack if it isn't running):
  ```bash
  export LOCALSTACK_AUTH_TOKEN="<your-localstack-auth-token>"
  yarn test:mcp:tools
  ```
  The tests deploy a sample project, switch IAM enforcement to soft mode and save a Cloud Pod, so point them at an instance you don't need: set `LOCALSTACK_PORT` and `MAIN_CONTAINER_NAME` to use one other than the default on 4566. Set `MCP_TEST_RESTART_LOCALSTACK=1` (as CI does) to let a test stop and start that instance, so the AWS client is checked against one the server started; without it the test uses the running instance. They need Docker, Terraform, the AWS CLI v2 and [lstk](https://github.com/localstack/lstk) on the `PATH`.
- Run MCP host evals through [OpenRouter](https://openrouter.ai) (default model `google/gemini-2.5-flash`; set `EVAL_MODEL` to any OpenRouter model ID to override it):
  ```bash
  export OPENROUTER_API_KEY="<your-openrouter-key>"
  export LOCALSTACK_AUTH_TOKEN="<your-localstack-auth-token>"
  yarn test:mcp:evals
  ```
  The evals check whether a model picks and combines the right tools for a goal; their prompts don't name the tools. They start, change and stop LocalStack on port 4566, so don't run them against an instance you're using. They need Docker, Terraform, the AWS CLI v2, [lstk](https://github.com/localstack/lstk) and the Snowflake CLI (`snow`) on the `PATH`, and the sample project's providers downloaded with `terraform -chdir=data/sample-terraform init`.
  The [MCP evals workflow](./.github/workflows/mcp-evals.yml) runs them after every merge into `main` that changes the server, its tools or the evals, weekly and on demand; it needs the `OPENROUTER_API_KEY` repository secret.
- Open the latest MCP Server Tester HTML report:
  ```bash
  npx mcp-server-tester open
  ```
- Run all of them:
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
