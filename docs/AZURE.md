# Using the Azure tool

`localstack-azure-client` runs the Azure CLI (`az`) installed on your machine against the LocalStack for Azure emulator; start the emulator with `localstack-management` (`service: azure`). Its settings are listed in the [README](../README.md#localstack-configuration).

- The tool keeps its own Azure CLI profile (`LOCALSTACK_AZ_CONFIG_DIR`), logged in to the emulator with a dummy account, so your own Azure login is never used or changed.
- It uses your Azure CLI extensions: install one with `az extension add --name <extension>`.
- Bicep templates need the `bicep` binary on your `PATH` (for example `brew install bicep` or `winget install Microsoft.Bicep`).
- Relative file paths in commands resolve against `LOCALSTACK_AZ_WORKDIR`, by default the directory the MCP client starts the server in.
- For an operation that has no `az` command, use [`az rest`](https://learn.microsoft.com/cli/azure/reference-index#az-rest), which sends a raw HTTP request to the Azure API. Give it a relative URL, such as `/subscriptions/{subscriptionId}/resourcegroups?api-version=2021-04-01`. A `management.azure.com` URL is turned into a relative one, and any other absolute URL must point at the emulator, over https.
- `az` reaches only the emulator: see [What `az` can reach](#what-az-can-reach).
- The Docker image does not include the Azure CLI yet: run the server with npx or from source to use the Azure tool.

## What `az` can reach

Some `az` commands take an address to send data to, such as `--blob-endpoint` or a connection string. Without a check, a command could point that address at any server and upload a local file there. So the tool makes sure `az` can only talk to the emulator.

It does this with a small local proxy, started for each command. `az` is pointed at the proxy for all its HTTP traffic, and the proxy passes on requests to the emulator and refuses everything else:

- It relays only to the emulator: `localhost.localstack.cloud` and every name under it, `localhost`, `127.0.0.1` and `::1`.
- It relays only to the emulator's ports, the ones the `start` action publishes: `LOCALSTACK_PORT`, 443 (only when `GATEWAY_LISTEN` is unset; otherwise its ports), and the external-service range (`EXTERNAL_SERVICE_PORTS_START` to `_END`, by default 4510 to 4560). Other local services, such as a Docker API on `localhost:2375`, stay out of reach. The Azure tool reads these settings from the MCP server's environment, not from the `envVars` of a `start` call, and an invalid value stops it with a configuration error.
- It relays https only. The emulator hands out https endpoints, so a plain `http://` request is refused.
- It sends those names to this machine itself, so `az` does not need DNS to find the emulator. Your application, `kubectl` and Docker still look these names up: if your router or company DNS blocks answers that point to `127.0.0.1`, allow `localhost.localstack.cloud` there.
- Every other request is refused. If the command then fails, the tool's answer names the host.

Some things stop working because they download from the internet:

- Bicep registry modules (`br:` and `br/public:`): Bicep fails with BCP192. Use local module files instead.
- `--template-uri`, and parameter files given as URLs (`--parameters @https://...`), which `az` downloads itself. Download the file and pass its path.
- `az extension list-available`. Run it with your own Azure CLI instead.

The proxy covers what honours `HTTPS_PROXY` and `HTTP_PROXY`: `az` itself, the Azure SDKs and MSAL, and Bicep. It does not cover:

- programs that open connections of their own, such as the Docker daemon behind `az acr login` and `az containerapp up --source`, or a database client behind `flexible-server connect`;
- extensions you installed that open their own connections, such as the device commands of the `azure-iot` extension, which use MQTT.

The proxy limits `az`'s own connections; it is not a sandbox. Workloads running in the emulator (container instances, web apps, AKS clusters) have their own network access, and an agent with a shell does not go through this tool at all.
