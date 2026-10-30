# Using the Azure tool

`localstack-azure-client` runs the Azure CLI (`az`) installed on your machine against the LocalStack for Azure emulator; start the emulator with `localstack-management` (`service: azure`). Its settings are listed in the [README](../README.md#localstack-configuration).

- The tool keeps its own Azure CLI profile (`LOCALSTACK_AZ_CONFIG_DIR`), logged in to the emulator with a dummy account, so your own Azure login is never used or changed.
- It uses your Azure CLI extensions: install one with `az extension add --name <extension>`.
- Bicep templates need the `bicep` binary on your `PATH` (for example `brew install bicep` or `winget install Microsoft.Bicep`).
- Relative file paths in commands resolve against `LOCALSTACK_AZ_WORKDIR`, by default the directory the MCP client starts the server in.
- `rest` calls the emulator: give it a relative URL. An absolute URL must name a local host; a `management.azure.com` URL is turned into a relative one.
- `az` reaches only the emulator: see [What `az` can reach](#what-az-can-reach).
- The Docker image does not include the Azure CLI yet: run the server with npx or from source to use the Azure tool.

## What `az` can reach

The agent writes the commands, and a command can name any endpoint: `--blob-endpoint`, a connection string, a `rest` URL. `az` would send that endpoint the file the command reads, with a key from the command. So every `az` run goes through an egress guard, a proxy on `127.0.0.1` that the tool starts for that run and points `HTTPS_PROXY` and `HTTP_PROXY` at.

- It relays only to the emulator: `localhost.localstack.cloud` and every name under it, `localhost`, `127.0.0.1` and `::1`.
- It relays only to the emulator's ports: `LOCALSTACK_PORT`, 443 and the external-service range (`EXTERNAL_SERVICE_PORTS_START` to `_END`, by default 4510 to 4560). Other local services, such as a Docker API on `localhost:2375`, stay out of reach.
- It sends those names to `127.0.0.1` itself, so no DNS answer decides where a request goes, and routers that block LocalStack's DNS answers do not matter.
- Every other request is refused, and the tool's answer names the host.

It covers what honours `HTTPS_PROXY` and `HTTP_PROXY`: `az` itself, the Azure SDKs and MSAL, and Bicep. It does not cover programs that open connections of their own, such as the Docker daemon behind `az acr login`, or a database client behind `flexible-server connect`.
