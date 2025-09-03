# LocalStack MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) server that provides tools to manage your LocalStack container and other assorted related tasks, to simplify local cloud development and testing. The LocalStack MCP Server provides simplified integration between Model Context Protocol-compatible apps and your local AWS development environment, enabling secure and direct communication with LocalStack's assortment of various features.

This server eliminates custom scripts and manual LocalStack management with direct access to:

- Start, stop, restart, and monitor LocalStack container status with built-in auth.
- Deploy CDK and Terraform projects with automatic configuration detection.
- Parse logs, catch errors, and auto-generate IAM policies from violations.
- Connect AI assistants and dev tools for automated cloud testing workflows.

## Tools Reference

This server provides your AI with dedicated tools for managing your LocalStack environment:

| Tool Name | Description | Key Features |
| :--- | :--- | :--- |
| [`localstack-management`](./src/tools/localstack-management.ts) | Manages LocalStack container operations and settings | - Execute start, stop, restart, and status checks<br/>- Integrate LocalStack Pro authentication tokens<br/>- Inject custom environment variables<br/>- Verify real-time status and perform health monitoring |
| [`localstack-deployer`](./src/tools/localstack-deployer.ts) | Handles infrastructure deployment to LocalStack environments | - Automatically run CDK and Terraform tooling to deploy infrastructure locally<br/>- Enable parameterized deployments with variable support<br/>- Process and present deployment results<br/>- Requires you to have [`cdklocal`](https://github.com/localstack/aws-cdk-local) or [`tflocal`](https://github.com/localstack/terraform-local) installed in your system path |
| [`localstack-logs-analysis`](./src/tools/localstack-logs-analysis.ts) | Analyzes LocalStack logs for troubleshooting and insights | - Offer multiple analysis options including summaries, errors, requests, and raw data<br/>- Filter by specific services and operations<br/>- Generate API call metrics and failure breakdowns<br/>- Group errors intelligently and identify patterns |
| [`localstack-iam-policy-analyzer`](./src/tools/localstack-iam-policy-analyzer.ts) | Handles IAM policy management and violation remediation | - Set IAM enforcement levels including `enforced`, `soft`, and `disabled` modes<br/>- Search logs for permission-related violations<br/>- Generate IAM policies automatically from detected access failures<br/>- Requires a valid LocalStack Auth Token |
| [`localstack-chaos-injector`](./src/tools/localstack-chaos-injector.ts) | Injects and manages chaos engineering faults for system resilience testing | - Inject, add, remove, and clear service fault rules<br/>- Configure network latency effects<br/>- Comprehensive fault targeting by service, region, and operation<br/>- Built-in workflow guidance for chaos experiments |

## Installation

| Editor | Installation |
|:------:|:-------------|
| **Cursor** | [![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=localstack-mcp-server&config=eyJjb21tYW5kIjoibnB4IC15IEBsb2NhbHN0YWNrL2xvY2Fsc3RhY2stbWNwLXNlcnZlciJ9) |
| **VS Code** | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_LocalStack_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=ffffff)](vscode:mcp/install?%7B%22name%22%3A%22localstack-mcp-server%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40localstack%2Flocalstack-mcp-server%22%5D%7D) |
| **VS Code Insiders** | [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_LocalStack_MCP-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=ffffff)](vscode-insiders:mcp/install?%7B%22name%22%3A%22localstack-mcp-server%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40localstack%2Flocalstack-mcp-server%22%5D%7D) |

### Prerequisites

- [LocalStack CLI](https://docs.localstack.cloud/getting-started/installation/#localstack-cli) and Docker installed in your system path.
- [`cdklocal`](https://github.com/localstack/aws-cdk-local) or [`tflocal`](https://github.com/localstack/terraform-local) installed in your system path for running infrastructure deployment tooling.
- A [valid LocalStack Auth Token](https://docs.localstack.cloud/aws/getting-started/auth-token/) to enable Pro services and IAM Policy Analyzer tool. (**optional**)
- [Node.js v22.x](https://nodejs.org/en/download/) installed in your system path

### Configuration

Add the following to your MCP client's configuration file (e.g., `~/.cursor/mcp.json`). This configuration uses `npx` to run the server, which will automatically download & install the package if not already present:

```json
{
    "mcpServers": {
      "localstack-mcp-server": {
        "command": "npx",
        "args": ["-y", "@localstack/localstack-mcp-server"]
      }
    }
  }
```

If you installed from source, change `command` and `args` to point to your local build:

```json
{
    "mcpServers": {
      "localstack-mcp-server": {
        "command": "node",
        "args": ["/path/to/your/localstack-mcp-server/dist/stdio.js"]
      }
    }
}
```

#### Enabling Licensed Features

To activate LocalStack licensed features, you need to add your LocalStack Auth Token to the environment variables. You can get your LocalStack Auth Token by following the official [documentation](https://docs.localstack.cloud/aws/getting-started/auth-token/).

Here's how to add your LocalStack Auth Token to the environment variables:

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

## Contributing

Pull requests are welcomed on GitHub! To get started:

- Install Git and Node.js
- Clone the repository
- Install dependencies with `npm install`
- Build with `npm run build`

Built on the [XMCP](https://github.com/basementstudio/xmcp) framework, you can add new tools by adding a new file to the `src/tools` directory and documenting it in the `manifest.json` file.

## License

[Apache License 2.0](./LICENSE)
