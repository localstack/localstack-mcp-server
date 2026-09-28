# The internal-network egress job (L3 b)

Plan section 5.4, row L3 (b); review F23. `run.sh` proves that the Azure tool needs nothing
outside the LocalStack emulator: the MCP server runs in a container that has **no route out**,
and a scenario through `localstack-azure-client` must still succeed.

**CI only.** The script builds an image, creates a Docker network, and starts an emulator and
containers. It refuses to run unless `CI=true`. Never run it on a machine whose Docker engine
is shared: a second emulator on a shared engine has already destroyed another emulator's storage
side-car once.

## Layout

```
                 default bridge (internet)                  --internal network (no route out)
                          |                                              |
 runner ── 127.0.0.1:4566 ─┤                                              |
                          ├── emulator (licence activation) ─────────────┤ <emulator internal IP>:4566
                          |                                              |
                          |                                  MCP server container (internal only)
                          |                                  LOCALSTACK_AZURE_FORWARD_TARGET=<IP>
                          |                                  az → egress guard → 127.0.0.1:4566
                          |                                     → loopback forwarder → <IP>:4566
```

- The emulator is **dual-homed**: on the default bridge, so it can activate its licence online,
  and on a network created with `docker network create --internal`.
- The MCP server's container is on the internal network **only**, with
  `LOCALSTACK_AZURE_FORWARD_TARGET` set to the emulator's address there. It needs no DNS: the
  egress guard maps `localhost.localstack.cloud` and every name under it to 127.0.0.1 itself
  (plan task 2.8), and the loopback forwarder relays 127.0.0.1 to the emulator (task 5.2).
- The client (`tests/azure/tools/stdio-client.mjs`) runs on the runner and talks to the server
  over `docker run -i` stdio. The server gets no Docker socket.

## What the script does

1. Checks `CI=true`, `LOCALSTACK_AUTH_TOKEN` (never printed), and `docker`, `node` and `curl`.
2. Builds the MCP server image from the repository, or uses `MCP_SERVER_IMAGE`. The image must
   contain `az`, which is plan task 5.1 (PR 5); without it the script stops with that message.
3. Starts the emulator on the bridge with Appendix F's values, published on `127.0.0.1` only,
   and waits until health reports the Azure edition with `license: true` and HTTPS answers.
4. Connects the emulator to the internal network, then checks the layout:
   - a container on the internal network reaches `http://<IP>:4566/_localstack/health`;
   - **negative controls:** `https://management.azure.com/` and `https://1.1.1.1/` are _not_
     reachable from the internal network. If either is, the run fails, because a pass would
     then prove nothing.
5. Runs one MCP session with the server on the internal network only:
   - the first call (`group list`) bootstraps the tool's profile through the forwarder;
   - group create and show; storage account create (a long-running operation, polled at the
     apex `localhost.localstack.cloud`); a blob container, upload and list; a Key Vault with a
     secret set and shown; `rest` with a relative URL; `rest` with an absolute
     `management.azure.com` URL, which the tool rewrites; a `--help` page; a third-party URL,
     which the policy refuses; then the cleanup (vault delete and purge, group delete);
   - every answer must pass its check, no successful answer may carry the guard's "blocked a
     connection" note, and no failure may be class `egress-refused`;
   - the server's stderr must show the forwarder's target, and its connection count must be
     above zero: the test envelope's `forwarderConnections`, or the `forwarder connections=<n>`
     line the server prints at exit.
6. Checks that the emulator's licence and health held through the scenario.

On exit it saves the emulator log, removes the containers, the network and a built image, then
**scans every output file for the token** and replaces any occurrence (plan section 8, review
N22), so an upload step cannot publish it.

### Feasibility first (plan task 4.3)

The first CI run is the feasibility check for this layout. The messages marked `FEASIBILITY:`
(licence activation while dual-homed, reachability on the internal network, the first bootstrap
through the forwarder) mean the layout itself does not work: redesign the job before building
more on it, as the plan says.

## Inputs

| Variable                       | Default                              | Use                                                                               |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------- |
| `CI`                           | none                                 | must be `true`                                                                    |
| `LOCALSTACK_AUTH_TOKEN`        | none                                 | an Azure-entitled token; passed to the emulator and (presence only) to the server |
| `MCP_SERVER_IMAGE`             | built from the repository            | an image that already contains `az`                                               |
| `LOCALSTACK_AZURE_IMAGE_NAME`  | `localstack/localstack-azure:latest` | the emulator image                                                                |
| `EGRESS_EMULATOR_HOST_PORT`    | `4566`                               | the runner port the emulator is published on (`127.0.0.1` only)                   |
| `EGRESS_READY_TIMEOUT_SECONDS` | `300`                                | how long to wait for health, licence and HTTPS                                    |
| `EGRESS_LS_LOG`                | `debug`                              | the emulator's `LS_LOG`                                                           |
| `EGRESS_INTERNAL_OUT`          | `$RUNNER_TEMP/egress-internal-<run>` | where the outputs go                                                              |

## Outputs

In `EGRESS_INTERNAL_OUT`: `health.json` (the last health answer), `scenario.mjs` (the generated
client), `scenario.jsonl` (one line per step, written as each lands, plus the forwarder check),
`scenario.log`, and `emulator.log`.

## Workflow

`azure-weekly.yml` (plan section 8), job `egress-internal-network`:

```yaml
jobs:
  egress-internal-network:
    runs-on: ubuntu-latest
    timeout-minutes: 60 # an image build with az takes about 9 minutes cold
    env:
      LOCALSTACK_AUTH_TOKEN: "${{ secrets.LOCALSTACK_AUTH_TOKEN }}"
      EGRESS_INTERNAL_OUT: "${{ runner.temp }}/egress-internal"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22.x }
      - run: docker pull localstack/localstack-azure:latest
      - run: bash tests/azure/egress-internal/run.sh
      - uses: actions/upload-artifact@v4 # run.sh has already replaced any token in these files
        if: failure()
        with:
          name: egress-internal
          path: ${{ runner.temp }}/egress-internal
          retention-days: 7
```

`CI=true` comes from GitHub Actions. No `yarn install` is needed on the runner: the stdio client
has no dependencies, and the image build installs its own.

## Not covered

- Commands whose extensions call other Microsoft hosts, for example
  `monitor app-insights query` (it calls `api.applicationinsights.io`): that is L3's weekly
  run with the extensions installed (plan section 3.3).
- Bicep: L5 covers it in the image (plan phase 5).
