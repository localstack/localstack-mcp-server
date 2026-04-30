# LocalStack MCP Server

> [!IMPORTANT]
> The LocalStack MCP server is currently available as an experimental public preview. For questions, issues or feedback, please utilize the [LocalStack Community slack](https://slack.localstack.cloud) or submit a [GitHub Issue](https://github.com/localstack/localstack-mcp-server/issues)

A [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) (MCP) server that provides tools to manage and interact with your [LocalStack for AWS](https://www.localstack.cloud/localstack-for-aws) container for simplified local cloud development and testing. The LocalStack MCP Server provides simplified integration between MCP-compatible apps and your local LocalStack for AWS development environment, enabling secure and direct communication with LocalStack's emulated services and additional developer experience features.

This server eliminates custom scripts and manual LocalStack management with direct access to:

- Start, stop, restart, and monitor LocalStack for AWS container status with built-in auth.
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
- Connect AI assistants and dev tools for automated cloud testing workflows.

## Tools Reference

This server provides your AI with dedicated tools for managing your LocalStack environment:

> [!NOTE]
> All tools in this MCP server require `LOCALSTACK_AUTH_TOKEN`.

| Tool Name                                                                         | Description                                                                | Key Features                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`localstack-management`](./src/tools/localstack-management.ts)                   | Manages LocalStack runtime operations for AWS and Snowflake stacks         | - Execute start, stop, restart, and status checks<br/>- Integrate LocalStack authentication tokens<br/>- Inject custom environment variables<br/>- Verify real-time status and perform health monitoring                                                                                                                                                                                                                                                             |
| [`localstack-deployer`](./src/tools/localstack-deployer.ts)                       | Handles infrastructure deployment to LocalStack for AWS environments       | - Automatically run CDK, Terraform, and SAM tooling to deploy infrastructure locally<br/>- Enable parameterized deployments with variable support<br/>- Process and present deployment results<br/>- Requires you to have [`cdklocal`](https://github.com/localstack/aws-cdk-local), [`tflocal`](https://github.com/localstack/terraform-local), or [`samlocal`](https://github.com/localstack/aws-sam-cli-local) installed in your system path                      |
| [`localstack-logs-analysis`](./src/tools/localstack-logs-analysis.ts)             | Analyzes LocalStack for AWS logs for troubleshooting and insights          | - Offer multiple analysis options including summaries, errors, requests, and raw data<br/>- Filter by specific services and operations<br/>- Generate API call metrics and failure breakdowns<br/>- Group errors intelligently and identify patterns                                                                                                                                                                                                                 |
| [`localstack-iam-policy-analyzer`](./src/tools/localstack-iam-policy-analyzer.ts) | Handles IAM policy management and violation remediation                    | - Set IAM enforcement levels including `enforced`, `soft`, and `disabled` modes<br/>- Search logs for permission-related violations<br/>- Generate IAM policies automatically from detected access failures<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                                             |
| [`localstack-chaos-injector`](./src/tools/localstack-chaos-injector.ts)           | Injects and manages chaos experiment faults for system resilience testing  | - Inject, add, remove, and clear service fault rules<br/>- Configure network latency effects<br/>- Comprehensive fault targeting by service, region, and operation<br/>- Built-in workflow guidance for chaos experiments<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                               |
| [`localstack-cloud-pods`](./src/tools/localstack-cloud-pods.ts)                   | Manages remote LocalStack Cloud Pods for development workflows             | - Save current state as a Cloud Pod<br/>- Load previously saved Cloud Pods instantly<br/>- Delete Cloud Pods from remote cloud-backed storage<br/>- Use this for managed remote state snapshots, not local export/import files<br/>- Requires a valid LocalStack Auth Token                                                                                                                                                                                          |
| [`localstack-state-management`](./src/tools/localstack-state-management.ts)       | Manages local file-based LocalStack state export/import workflows          | - Export LocalStack state to a local file on disk through the LocalStack State REST API<br/>- Import LocalStack state from a local file<br/>- Inspect current LocalStack state as JSON metamodel data<br/>- Reset all state or only selected services<br/>- Supports service-level granularity for export, reset, and inspect<br/>- Use this for local disk workflows; use Cloud Pods for remote cloud-backed snapshots<br/>- Requires a valid LocalStack Auth Token |
| [`localstack-extensions`](./src/tools/localstack-extensions.ts)                   | Installs, uninstalls, lists, and discovers LocalStack Extensions           | - Manage installed extensions via CLI actions (`list`, `install`, `uninstall`)<br/>- Browse the LocalStack Extensions marketplace (`available`)<br/>- Requires a valid LocalStack Auth Token support                                                                                                                                                                                                                                                                 |
| [`localstack-ephemeral-instances`](./src/tools/localstack-ephemeral-instances.ts) | Manages cloud-hosted LocalStack Ephemeral Instances                        | - Create temporary cloud-hosted LocalStack instances and get an endpoint URL<br/>- List available ephemeral instances, fetch logs, and delete instances<br/>- Supports lifetime, extension preload, Cloud Pod preload, and custom env vars on create<br/>- Requires a valid LocalStack Auth Token and LocalStack CLI                                                                                                                                                 |
| [`localstack-aws-client`](./src/tools/localstack-aws-client.ts)                   | Runs AWS CLI commands inside the LocalStack for AWS container              | - Executes commands via `awslocal` inside the running container<br/>- Sanitizes commands to block shell chaining<br/>- Auto-detects LocalStack coverage errors and links to docs                                                                                                                                                                                                                                                                                     |
| [`localstack-aws-replicator`](./src/tools/localstack-aws-replicator.ts)           | Replicates external AWS resources into a running LocalStack instance       | - Start single-resource replication jobs with a resource type and identifier or ARN<br/>- Start batch replication jobs, such as SSM parameters under a path prefix<br/>- Poll job status by job ID and list existing jobs<br/>- List resource types supported by the running Replicator extension<br/>- Reads source AWS credentials from the MCP server environment and supports optional target account or region overrides                                        |
| [`localstack-app-inspector`](./src/tools/localstack-app-inspector.ts)             | Inspects LocalStack application traces, spans, events, and IAM evaluations | - Enable or disable App Inspector for the running LocalStack instance<br/>- List and inspect traces to understand AWS service-to-service flows<br/>- Drill into spans, events, payload metadata, and IAM policy evaluation events<br/>- Filter by service, region, operation, resource, ARN, status, and time range<br/>- Requires a valid LocalStack Auth Token and the App Inspector feature in the connected LocalStack license                                   |
| [`localstack-docs`](./src/tools/localstack-docs.ts)                               | Searches LocalStack documentation through CrawlChat                        | - Queries LocalStack docs through a public CrawlChat collection<br/>- Returns focused snippets with source links only<br/>- Helps answer coverage, configuration, and setup questions without requiring LocalStack runtime                                                                                                                                                                                                                                           |

## Installation

|   Editor   | Installation                                                                                                                                                                                                            |
| :--------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cursor** | [![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=localstack-mcp-server&config=eyJjb21tYW5kIjoibnB4IC15IEBsb2NhbHN0YWNrL2xvY2Fsc3RhY2stbWNwLXNlcnZlciJ9) |

For other MCP Clients, refer to the [configuration guide](#configuration).

### Prerequisites

- [LocalStack CLI](https://docs.localstack.cloud/getting-started/installation/#localstack-cli) and Docker installed in your system path
- [`cdklocal`](https://github.com/localstack/aws-cdk-local), [`tflocal`](https://github.com/localstack/terraform-local), or [`samlocal`](https://github.com/localstack/aws-sam-cli-local) installed in your system path for running infrastructure deployment tooling
- A [valid LocalStack Auth Token](https://docs.localstack.cloud/aws/getting-started/auth-token/) configured as `LOCALSTACK_AUTH_TOKEN` (**required for all MCP tools**)
- [Node.js v22.x](https://nodejs.org/en/download/) or higher installed in your system path

### Configuration

Add the following to your MCP client's configuration file (e.g., `~/.cursor/mcp.json`). This configuration uses `npx` to run the server, which will automatically download & install the package if not already present:

```json
{
  "mcpServers": {
    "localstack-mcp-server": {
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

If you installed from source, change `command` and `args` to point to your local build:

```json
{
  "mcpServers": {
    "localstack-mcp-server": {
      "command": "node",
      "args": ["/path/to/your/localstack-mcp-server/dist/stdio.js"],
      "env": {
        "LOCALSTACK_AUTH_TOKEN": "<YOUR_TOKEN>"
      }
    }
  }
}
```

## LocalStack Configuration

| Variable Name                                                  | Description                                                                                                                                                                     | Default Value     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `LOCALSTACK_AUTH_TOKEN` (**required**)                         | The LocalStack Auth Token to use for the MCP server                                                                                                                             | None              |
| `MAIN_CONTAINER_NAME`                                          | The name of the LocalStack container to use for the MCP server                                                                                                                  | `localstack-main` |
| `MCP_ANALYTICS_DISABLED`                                       | Disable MCP analytics when set to `1`                                                                                                                                           | `0`               |
| `APP_INSPECTOR`                                                | Set to `1` in the LocalStack container environment to enable App Inspector by default across restarts. The MCP tool can also toggle App Inspector at runtime with `set-status`. | `0`               |
| `AWS_ACCESS_KEY_ID` (**required for AWS Replicator tool**)     | Source AWS access key used by AWS Replicator to read external AWS resources                                                                                                     | None              |
| `AWS_SECRET_ACCESS_KEY` (**required for AWS Replicator tool**) | Source AWS secret access key used by AWS Replicator to read external AWS resources                                                                                              | None              |
| `AWS_DEFAULT_REGION` (**required for AWS Replicator tool**)    | Source AWS region used by AWS Replicator                                                                                                                                        | None              |

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

- MCP tests target the local STDIO server command `node dist/stdio.js` by default.
- `LOCALSTACK_AUTH_TOKEN` is required for all MCP tool usage and test suites.
- You can override the target command with:
  - `MCP_TEST_COMMAND`
  - `MCP_TEST_ARGS` (space-separated arguments)

## License

[Apache License 2.0](./LICENSE)

<a href="https://glama.ai/mcp/servers/@localstack/localstack-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@localstack/localstack-mcp-server/badge" alt="LocalStack Server MCP server" />
</a>
