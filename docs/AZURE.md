# Using the Azure tool

`localstack-azure-client` runs the Azure CLI (`az`) installed on your machine against the LocalStack for Azure emulator; start the emulator with `localstack-management` (`service: azure`). Its settings are listed in the [README](../README.md#localstack-configuration).

- The tool keeps its own Azure CLI profile (`LOCALSTACK_AZ_CONFIG_DIR`), logged in to the emulator with a dummy account, so your own Azure login is never used or changed.
- It uses your Azure CLI extensions: install one with `az extension add --name <extension>`.
- Bicep templates need the `bicep` binary on your `PATH` (for example `brew install bicep` or `winget install Microsoft.Bicep`).
- Relative file paths in commands resolve against `LOCALSTACK_AZ_WORKDIR`, by default the directory the MCP client starts the server in.
- `rest` calls the emulator: give it a relative URL. An absolute URL must name a local host; a `management.azure.com` URL is turned into a relative one.
- Only `rest` URLs are checked: an endpoint given in a command, such as `--blob-endpoint` or a connection string, is used as it is.
- The Docker image includes the Azure CLI. Mount the files your commands use and set `LOCALSTACK_AZ_WORKDIR` to the mount (see [DOCKER.md](./DOCKER.md#azure-cli)). The image has no Azure CLI extensions or `bicep`, and its Azure CLI profile lasts only as long as the container.
