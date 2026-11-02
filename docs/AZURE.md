# Using the Azure tool

`localstack-azure-client` runs the Azure CLI (`az`) installed on your machine against the LocalStack for Azure emulator; start the emulator with `localstack-management` (`service: azure`). Its settings are listed in the [README](../README.md#localstack-configuration).

- The tool keeps its own Azure CLI profile (`LOCALSTACK_AZ_CONFIG_DIR`), logged in to the emulator with a dummy account, so your own Azure login is never used or changed.
- It uses your Azure CLI extensions: install one with `az extension add --name <extension>`.
- Bicep templates need the `bicep` binary on your `PATH` (for example `brew install bicep` or `winget install Microsoft.Bicep`).
- Relative file paths in commands resolve against `LOCALSTACK_AZ_WORKDIR`, by default the directory the MCP client starts the server in.
- For an operation that has no `az` command, use [`az rest`](https://learn.microsoft.com/cli/azure/reference-index#az-rest), which sends a raw HTTP request to the Azure API. Give it a relative URL, such as `/subscriptions/{subscriptionId}/resourcegroups?api-version=2021-04-01`. A `management.azure.com` URL is turned into a relative one. Any other absolute URL must be https on a `localhost.localstack.cloud` name, such as `https://azure.localhost.localstack.cloud:4566/...`, the names the emulator's certificate is for.
- `az` reaches only the emulator: see [What `az` can reach](#what-az-can-reach).
- The Docker image does not include the Azure CLI yet: run the server with npx or from source to use the Azure tool.

## What `az` can reach

Some `az` commands take an address to send data to, such as `--blob-endpoint` or a connection string. Without a check, a command could point that address at any server and upload a local file there. So the tool makes sure `az` can only talk to the emulator.

It does this with a small local proxy, started for each command. `az` is pointed at the proxy for all its HTTP traffic. The proxy passes on https to the emulator's names (`localhost.localstack.cloud` and every name under it) and the loopback ones, and refuses everything else, including plain `http://`. If the command then fails, the answer names the refused host.

The proxy sends those names to this machine itself, so `az` does not need DNS to find the emulator. Your application, `kubectl` and Docker still look these names up: if your router or company DNS blocks answers that point to `127.0.0.1`, allow `localhost.localstack.cloud` there.

Anything `az` would download from the internet fails, for example:

- Bicep registry modules (`br:` and `br/public:`), with error BCP192: use local module files.
- `--template-uri`, and parameter files given as URLs (`--parameters @https://...`): download the file and pass its path.
- `az extension list-available`: run it with your own Azure CLI.

The proxy covers `az`, the Azure SDKs, MSAL and Bicep, which all honour `HTTPS_PROXY` and `HTTP_PROXY`. It is not a sandbox, and these are outside it:

- programs that open their own connections, such as the Docker daemon behind `az acr login` and `az containerapp up --source`, a database client behind `flexible-server connect`, or the MQTT device commands of the `azure-iot` extension;
- workloads running in the emulator (container instances, web apps, AKS clusters), which have their own network access;
- an agent with a shell, which does not go through this tool at all.
