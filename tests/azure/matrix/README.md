# L2: the Azure command matrix

Representative `az` commands for each of the 29 providers of the emulator's coverage list
(`/_localstack/coverage`), run through the real `localstack-azure-client` handler against a live
LocalStack Azure emulator (plan section 5.4, tasks 4.2 and 4.7). One YAML file per provider; the
runner is `tests/azure/matrix.live.test.ts`, the schema test (U16) is `schema.test.ts` here.

## Run it

```bash
# The PR subset (`pr: true` cases, plus the live cancel case and the egress check):
AZURE_LIVE=1 npx jest -c jest.azure-live.config.js --selectProjects matrix-subset --runInBand

# Everything (the weekly run), shard 2 of 4, with the side-car cases:
AZURE_LIVE=1 AZURE_MATRIX_BACKING=1 AZURE_MATRIX_SHARD=2/4 \
  npx jest -c jest.azure-live.config.js --selectProjects matrix-full --runInBand

# The schema test runs in plain `yarn test` (no emulator):
npx jest tests/azure/matrix/schema.test.ts
```

Always pass `--runInBand`: the cases run one after the other, one `az` command at a time.

| Knob                          | Default                                | Effect                                                                           |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `AZURE_LIVE=1`                | unset                                  | without it every live test is skipped                                            |
| `AZURE_MATRIX`                | set by the project (`pr` or `full`)    | `pr` runs the `pr: true` cases; `full` runs all                                  |
| `AZURE_MATRIX_BACKING=1`      | unset                                  | also run `backing: true` cases (CI sets it)                                      |
| `AZURE_MATRIX_SHARD=i/n`      | unsharded                              | run shard i of n (see Sharding)                                                  |
| `AZURE_MATRIX_GAPS=skip`      | `run`                                  | skip known gaps instead of running them as expected failures                     |
| `AZURE_MATRIX_ONLY=a,b`       | all                                    | only these case ids or file stems (`storage`, `kv-create`)                       |
| `AZURE_MATRIX_LOCATION`       | `westeurope`                           | the `{location}` placeholder                                                     |
| `AZURE_MATRIX_RESULTS`        | `test-results/azure-matrix.jsonl`      | one JSON line per case, appended as it lands                                     |
| `AZURE_OP_CATALOGUE_OUT`      | `test-results/azure-op-catalogue.json` | the per-operation catalogue (rewritten after each case)                          |
| `LOCALSTACK_AZ_BICEP_PATH`    | the tool's lookup                      | the Bicep binary for the `.bicep` cases                                          |
| `LOCALSTACK_AZ_EXTENSION_DIR` | `~/.localstack/azure/mcp-extensions`   | the curated extensions (`node scripts/install-azure-extensions.mjs --dir <dir>`) |

The emulator should run with the CI flags of plan Appendix F: `FRONT_DOOR_CLASSIC_ALLOW_CREATE=1`
and `CDN_CLASSIC_ALLOW_CREATE=1` (classic Front Door and CDN cases), `MSSQL_ACCEPT_EULA=Y` (SQL),
and the pinned `LS_AZURE_ORYX_BUILD_IMAGE_TO_USE` (web apps).

### Sharding

Jest's `--shard` splits test _files_, and the matrix is one file, so the runner shards its cases
itself: `AZURE_MATRIX_SHARD=i/n` assigns each case to a shard by a deterministic
longest-processing-time split (a `backing` case weighs 5, others 1; heaviest first, each to the
lightest shard). The cancel case and the coverage-key check run in shard 1; the egress check runs
in every shard. Each shard needs its own emulator.

## Local safety (plan section 7)

On a machine where the emulator on 4566 is shared with other agents or people:

- use it only through the tool (this runner); never start, stop or restart it, and never start a
  second emulator beside it (a second instance once destroyed the first one's storage side-car);
- run only non-`backing` cases unless the owner agrees, with `--runInBand`;
- every case uses its own names (`mcp-<runid>-...`, from `runId()`) and cleans up: the runner
  waits until nothing in the group is still provisioning, then runs the case's `cleanup`
  (Key Vaults are deleted and purged, App Configuration stores and APIM services purged, locks
  removed) and deletes the group with `--no-wait`;
- no Docker commands beyond a read-only `docker ps`; never read or change `~/.azure`, `~/.ssh`,
  `~/.kube`, `~/.docker` (the tool's private home takes `--generate-ssh-keys` and
  `aks get-credentials`);
- the auth token only has to be present: the harness sets a dummy when none is set.

A failed storage create can leave its `ls-storage-<account>` azurite container running with no
account behind it (seen 2026-09-27); report such containers, do not remove them on a shared engine.

## Case format

```yaml
provider: Microsoft.Storage # one of the 29; the file name is derived from it
cases:
  - id: storage-account-keys # unique across all files
    operations: # coverage keys "<resource_provider> <service> <operation>"
      [Microsoft.Storage StorageAccounts ListKeys, Microsoft.Storage StorageAccounts RegenerateKey]
    pr: true # in the PR subset (never backing, never a known gap)
    backing: false # true: the case starts emulator side-car containers
    note: Why the case looks the way it does (required when operations is empty).
    timeout: 120 # optional: cancel each step after this many seconds
    setup: # prerequisites; any failure is a real failure
      - group create --name {rg} --location {location}
      - storage account create --name {storage} --resource-group {rg} --location {location} --sku Standard_LRS
      - run: storage account keys list --account-name {storage} --resource-group {rg} --query "[0].value" -o tsv
        capture: key_before # stdout (trimmed) into {key_before}; or a map name -> JSON path
        until: { stdout: { matches: "." } } # poll every 5 s until this holds
        wait: 180 # seconds for `until` (default 180)
      - storage account keys renew --account-name {storage} --resource-group {rg} --key key1
    command: storage account keys list --account-name {storage} --resource-group {rg} --query "[0].value != '{key_before}'"
    expect: # default { exitCode: 0 }
      exitCode: 0
      json: { path: "", equals: true } # one check or a list
    cleanup: # best effort, never fails the case
      - group delete --name {rg} --yes --no-wait

  - id: storage-account-keys-renew-answer # a known gap (never pr)
    operations: [Microsoft.Storage StorageAccounts RegenerateKey]
    setup:
      - group create --name {rg} --location {location}
      - storage account create --name {storage} --resource-group {rg} --location {location} --sku Standard_LRS
    command: storage account keys renew --account-name {storage} --resource-group {rg} --key key2
    expect:
      # classId: not-found  # optional: the answer's class (Appendix G)
      stdout: { contains: key2 } # on the trimmed stdout; one check or a list
    cleanup:
      - group delete --name {rg} --yes --no-wait
    known_gap: # an expected failure (see Known gaps)
      reason: Why it fails, with the source (typed server COVERAGE_SKIPS, the benchmark, L2).
      operations: [Microsoft.Storage StorageAccounts RegenerateKey] # default: all of the case's
      date: 2026-09-27 # when it was last seen
```

- **Placeholders:** `{id}` (the case run's id), `{rg}`, `{location}`, `{sub}`, `{tenant}`,
  `{uuid}`, `{storage}`, `{vault}`, `{container}`, `{port}` (the emulator's gateway port, for
  data-plane hosts a case builds itself), `{name:<kind>}` (`mcp-<id>-<kind>`),
  `{alnum:<kind>}` (lower-case alphanumerics, at most 24: registries, storage), and every name an
  earlier setup step captured. An unknown placeholder is a schema error. JSON bodies are safe
  (`{"a": 1}` is not a placeholder); a JMESPath multiselect key must not look like one (`{Id:id}`).
- **Checks:** exactly one of `equals` (deep), `contains` (substring, array element, or object
  key), `matches` (regular expression), `exists` (`true`/`false`), `length`. `path` is a tiny
  resolver: `a.b[0].c`, `[-1]` (last), `""` for the whole document; quote it in YAML when it has
  brackets. Narrow with `--query` instead of wildcards. The runner reads az's stdout from the test
  envelope, never from the tool's prose.
- **Commands** are one line without the leading `az`; use `>-` for long ones, and a block scalar
  for any line with `": "` in it. Unquoted `&`, `|`, `;`, `<`, `>` are refused by the tokenizer:
  quote URLs with query strings. Files are relative to the tool's working directory, which the
  runner seeds with `hello.txt` and `bicep/` (every `tests/fixtures/azure/bicep/*.bicep`).
- **Schema lints** (`schema.test.ts`): the file parses; ids are unique; operation keys have the
  three-part form and the file's provider; every placeholder resolves; every setup, command and
  cleanup line passes the real policy (`evaluateAzCommand`); a case that creates `{rg}` deletes it
  with `--no-wait`; a case that creates a vault deletes and purges it before the group; the PR
  subset has at least 20 cases, none backing or a known gap, and is part of the full run under
  every shard split; every one of the typed server's 127 skips is carried by a case (R.1).

## Results

- **Known gaps** run as expected failures: the case passes when its command fails (recorded as
  `known_gap` with the failure class), a failing _setup_ is still a real failure, and a known gap
  that passes fails the test as `gap_fixed`, so the entry gets removed (Jest's `test.failing`
  semantics, written out so that setup failures and the class are reported properly).
  `AZURE_MATRIX_GAPS=skip` records them as skips instead.
- **az versions:** CI runs `AZ_VERSION` (2.90); cases avoid flags that changed between 2.85 and
  2.90 (`rest` creates and `--ids` reads where az 2.86 renamed PostgreSQL flags). One case is
  version-specific by design: `aks-stop-wait` meets its gap only at az 2.90's api-version, so a
  local run with az 2.85 reports it `gap_fixed`.
- **Extensions:** a step that fails with class `extension` (a curated extension is not installed)
  makes the case a recorded skip on a developer machine and a failure when `CI` is set.
- **Transient classes** (`conn-refused`, `discovery`, `emulator-error`) are retried once per step,
  and the retry is logged in the step record. When the tool answers "Emulator Not Ready" (its health
  preflight timed out, so az never ran), the step is retried after 5, 10, 20 and 30 s: a busy
  emulator stops answering its health check for 20-40 s at a time.
- **JSONL** (`AZURE_MATRIX_RESULTS`): per case `result` (`pass`, `fail`, `setup_failed`,
  `known_gap`, `gap_fixed`, `skipped`), class, exit code, duration, each step's command and class,
  the problems (with a 400-character stdout excerpt), and the egress hosts seen; plus a
  `cancel-in-flight` and an `egress-summary` line.
- **Catalogue** (`AZURE_OP_CATALOGUE_OUT`, for the portal, review F18): per coverage key its best
  result, the date it was last verified passing, the command template (the case's `command`; the
  operation itself may be exercised by one of the case's setup steps), whether the emulator marks
  it implemented (read through the tool from `/_localstack/coverage`), and every case that touches
  it. Each run rewrites the file with that run's cases only. Shards write one catalogue each;
  `scripts/ci/merge-op-catalogue.cjs` merges them by concatenating each key's `cases` and taking
  the best result (`pass` > `gap_fixed` > `known_gap` > `fail` > `setup_failed` > `skipped`).
- **Egress:** the last test fails on any host the guard refused, except inside a known-gap case
  whose refusal is its documented failure (the App Insights data plane, whose endpoint the tool's
  cloud does not map; listed as `refusedInKnownGaps` in the `egress-summary` line), and on any
  `app.aladdin.microsoft.com` refusal (a regression of the bootstrap's
  `core.error_recommendation=off`); housekeeping hosts such as `aka.ms` (Bicep) are only reported.
- **Coverage keys:** in shard 1 a test checks every key against the emulator's live coverage list;
  unknown keys fail the full run and are only reported in the PR run.

## The typed server's skips (retirement task R.1)

All 127 `COVERAGE_SKIPS` of the typed server are carried here, keyed by coverage key: most as
`known_gap` entries with the typed server's diagnosis (updated where the emulator now fails
differently), the rest as plain cases where the CLI path does not share the typed server's
limitation (its T2 args builder, or its -n 8 parallel load) or the emulator has fixed the gap. The
YAML comment at each case says which. `schema.test.ts` lists the 127 keys and fails if one is
dropped.
