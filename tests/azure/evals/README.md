# E2: composition evals for `localstack-azure-client`

E2 measures whether Claude can do real Azure work through the server: it gets a task, calls
`localstack-azure-client` over MCP until it ends its turn, and then a verifier reads the outcome
from the emulator.

- **No money is spent** by `--oracle`, `--negative`, `--dry-run` and `--list`, and by the unit
  tests. Only a model run calls the Anthropic API, and it refuses to start without a key.
- **The gate:** at least 95% success at n=3, zero egress events, and the cost per completed task
  recorded.

## Quick start

```bash
yarn build                                   # dist/cli.js, the stdio server E2 drives

node tests/azure/evals/run.mjs --list        # the 50 tasks
node tests/azure/evals/run.mjs --dry-run --variant compact,long,help-tool,no-test-data

# No model: each task's reference solution must pass its verifier, and setup alone must fail
# it (needs a running emulator and LOCALSTACK_AUTH_TOKEN).
node tests/azure/evals/run.mjs --oracle   --out test-results/e2-oracle
node tests/azure/evals/run.mjs --negative --out test-results/e2-negative

# The model run (the CI job's command line)
node tests/azure/evals/run.mjs --runs 3 --max-usd 20 --out test-results/e2
```

**What a run needs**

- Node.js 22.18 or newer: `run.mjs` loads the `.ts` modules with Node's built-in type
  stripping (Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning once; `NODE_NO_WARNINGS=1`
  hides it).
- A LocalStack Azure emulator on `LOCALSTACK_AZURE_PORT` (default 4566), started with
  `CDN_CLASSIC_ALLOW_CREATE=1` (for `cdn-can-migrate`; `scripts/ci/azure-emulator-up.sh` sets it).
- `LOCALSTACK_AUTH_TOKEN` in the environment (the tool checks that it is set).
- An `az` the tool resolves (`LOCALSTACK_AZ_PATH`), with the curated extensions
  (`node scripts/install-azure-extensions.mjs`).
- For a model run, an API key: `ANTHROPIC_API_KEY`, or `--key-file <path>` /
  `ANTHROPIC_API_KEY_FILE` naming a file that holds only the key (mode 600 on POSIX).
- On a shared machine, give E2 its own CLI profile (`LOCALSTACK_AZ_CONFIG_DIR`) and keep
  `--jobs 1`.

## Options

| Option                                             | Default                                     | Meaning                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runs N`                                         | 1                                           | repetitions per task (and per variant)                                                                                                                                        |
| `--max-usd X`                                      | `$AZURE_EVALS_MAX_USD` or 20                | the total cap: no new run once the spend (pre-warms included) reaches X, and a running loop stops before its next request; every turn counts at once, for concurrent runs too |
| `--max-usd-per-run Y`                              | `$EVAL_MAX_USD_PER_RUN` or 1                | a run's agent loop stops (failure `spend_cap`) before a request once the run's own cost reaches Y                                                                             |
| `--out DIR`                                        | `test-results/e2`                           | results directory                                                                                                                                                             |
| `--tasks id,id` / `--tier T-A,T-B,T-APIM`          | all                                         | selection                                                                                                                                                                     |
| `--model M`                                        | `$EVAL_MODEL` or `claude-opus-5-5`          | a model needs a price in `agent.ts` (`PRICES`), or the run refuses                                                                                                            |
| `--effort E`                                       | `$EVAL_EFFORT` or `high`                    | `output_config.effort`                                                                                                                                                        |
| `--variant v[,v]`                                  | `compact`                                   | see below; several variants interleave per task in a seeded order                                                                                                             |
| `--all-tools`                                      | off                                         | offer every server tool, not only the Azure tool (`localstack-management` is withheld: it can stop the emulator)                                                              |
| `--key-file PATH`                                  |                                             | the key file (else `ANTHROPIC_API_KEY_FILE`, else `ANTHROPIC_API_KEY`)                                                                                                        |
| `--phrasing alt\|0\|1`                             | `alt`                                       | T-A has two phrasings: run _i_ uses phrasing _i_ mod 2, or a fixed one                                                                                                        |
| `--verify-wait S`                                  | 90 (10 with `--negative`)                   | how long a polling verifier waits for a state                                                                                                                                 |
| `--jobs N`                                         | `$EVAL_JOBS`, else 3 when `CI=true`, else 1 | concurrent runs, each with its own agent and harness server                                                                                                                   |
| `--seed N`                                         | 20260924                                    | the variant order                                                                                                                                                             |
| `--max-minutes M`                                  | none                                        | no new run after M minutes                                                                                                                                                    |
| `--no-prewarm`                                     |                                             | skip the `max_tokens: 0` cache pre-warm per variant                                                                                                                           |
| `--oracle` / `--negative` / `--dry-run` / `--list` |                                             | the no-spend modes                                                                                                                                                            |

Exit status: **0** passed (the gate for a model run; every expectation for `--oracle` and
`--negative`) and the final cleanup check was clean; **1** not passed, or stopped early (spend
cap, `--max-minutes`, a key that stopped working, Ctrl+C); **2** a usage or configuration error:
no API key for a model run, no price for the model, no `dist/cli.js`, no `LOCALSTACK_AUTH_TOKEN`,
Node.js too old.

## How a run works

```
group create                (harness session)
task setup                  (harness session: the task's fixtures, as az commands)
the agent loop | the oracle | nothing (--negative)   (agent session)
the verifier                (harness session; every answer recorded)
teardown, cleanup           (harness session)
```

- **Two server sessions per worker**: the agent's (`node dist/cli.js`, what Claude or the
  oracle calls) and the harness's own. Verification never uses the agent's session. Both get
  the whole environment plus `LOCALSTACK_AZ_TEST_ENVELOPE=1`, minus every `ANTHROPIC_*`
  variable (the key never reaches a server or its `az`).
- **The model never sees the test envelope.** The tool appends it as a second content item;
  `agent.ts` (`splitEnvelope`) removes it before the `tool_result` is built and keeps it for
  the record (exit code, class, egress refusals).
- **Egress events** are the tool's own reports: class `egress-refused`, or the note
  "Note: the egress guard blocked a connection to ...". Housekeeping blocks (update checks the
  tool always refuses) are recorded apart and are not events.
- **Cleanup** leaves nothing behind: it waits until nothing in the group is still provisioning,
  removes the group's locks, deletes and purges its Key Vaults, deletes the group and waits,
  purges soft-deleted vaults, APIM services and App Configuration stores the run named, and
  checks the group is gone. At the end, an orphan sweep lists every resource type the tasks
  create and deletes whatever still sits in one of the run's groups. Groups are named
  `mcpe2-<random>-<task>-<n>`.
- **Model settings** are fixed in `agent.ts`: `claude-opus-5-5`, `max_tokens` 16000, adaptive
  thinking with summarized display, effort `high`, a cached system block plus top-level
  automatic caching, and per-tier caps (T-A and T-APIM: 20 turns, 30 tool calls, 600 s; T-B: 40,
  60, 1800 s). The record keeps the billed cost and the cost re-priced as if the first turn
  found the shared prefix cached ("warm") or not ("cold"); the gate uses the warm one.

## Variants

| Variant        | What Claude gets                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact`      | the server's own description, unchanged: the shipped default                                                                                                          |
| `long`         | a longer description in sections (Context, Input, Output, Rules, Examples)                                                                                            |
| `help-tool`    | `compact` with "Run it with --help first" replaced by "Call `az_help` ...", plus a separate `az_help` tool that the runner runs as `<prefix> --help` through the tool |
| `no-test-data` | `compact` without ", so all data and secrets are local test data"                                                                                                     |

A variant whose anchor text is no longer in the server's description fails at start, rather than
silently testing the default. To compare a variant with the default, run both, for example
`--runs 3 --variant compact,long`, and read `summary.json`: `success_rate`,
`cost_per_completed_task_warm_usd`, `median_time_to_verified_ms`, `egress_events` and
`kv_crypto_refusals`. With two variants, `--max-usd` caps both together.

## Output

`--out DIR` holds:

- `runs.jsonl`: one record per run, with the task, variant and mode, `success` (null for a setup
  or infrastructure fault) and `failure` (`verify_failed`, `refusal`, `max_tokens`,
  `cap_exceeded`, `spend_cap`, `setup_error`, `infra_error`, `account_error`, `api_error`,
  `harness_error`; `verifier_passed_without_action` for `--negative`), the timings, turns, tool
  calls, tokens and costs, the egress events, the verifier's result with every query it made,
  `verify_input` (the slots and text the verifier read, so a verifier fixed later can re-score
  the run offline), and the turn log and tool trace.
- `meta.json`: the settings (model, effort, thinking, prices, the tool definitions sent per
  variant and their sizes, tasks, seed, jobs), the pre-warm usage, the spend, why it stopped.
- `summary.json`: per variant the success rate, costs, median time to verified state, egress
  events, refusals, setup and infrastructure faults, the failing tasks, and the gate; for
  `--oracle` / `--negative` the runs that met or missed their expectation.
- `cleanup.json`: the final orphan sweep and the leftover check (`clean`).
- `server-*.stderr.log`: each server's stderr.

The API key never appears in any of them: it is read once, handed to the SDK client, removed from
the environment, and scrubbed from every error text and record before it is written.

## The tasks

50 tasks in three tiers; `node run.mjs --list` prints them.

- **T-A** (28): single operations, each with two phrasings.
- **T-B** (8): multi-step goals, verified step by step (partial credit is recorded).
- **T-APIM** (14): API Management operations, each run on its own APIM service.

| Tier   | Tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-A    | `appconfig-kv-unlock`, `appconfig-check-keys`, `appconfig-regenerate-key`, `lock-delete`, `locks-list`, `role-definition-get`, `acr-login-server`, `acr-webhook-create`, `eventgrid-topic-regenerate-key`, `eventgrid-domain-disable-local-auth`, `eventhub-hub-auth-rule-rights`, `insights-activity-log-alert-create`, `kv-sign`, `kv-decrypt`, `kv-rotation-policy`, `kv-access-policy-grant`, `identity-create`, `identity-list`, `route-get`, `private-dns-zones-list`, `vnet-address-space`, `la-workspace-retention`, `deployment-sub-validate`, `sb-queue-regenerate-key`, `sb-dp-queue-max-delivery`, `storage-regenerate-key`, `disk-create`, `cdn-can-migrate` |
| T-B    | `tb-storage-blob`, `tb-keyvault-secret-sign`, `tb-servicebus-topic`, `tb-resource-graph-tags`, `tb-tag-audit`, `tb-mysql-firewall`, `tb-eventgrid-to-eventhub`, `tb-webapp-settings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T-APIM | `apim-group-user-check`, `apim-workspace-product-update`, `apim-tenant-access`, `apim-git-regenerate-primary`, `apim-api-create`, `apim-operation-delete`, `apim-operation-policy`, `apim-tag-assign-api`, `apim-tag-detach-product`, `apim-api-tag-descriptions`, `apim-graphql-resolver`, `apim-certificate-create`, `apim-oidc-secret`, `apim-migrate-stv2`                                                                                                                                                                                                                                                                                                            |

Every fixture runs as `az` commands through the harness's session (`az rest` where a resource has
no command), and the verifiers read state with `az rest` (relative URLs) and `az` data-plane
commands (`keyvault key verify`, `keyvault secret show`). With the oracle there is no answer, so
the claim verifiers read the oracle's transcript: one block per call, a mark line
(`ORACLE ✅ az <command>`, ❌ on failure) and az's output fenced.

## Tests

`npx jest tests/azure/evals` (part of the default suite; no emulator, no network, no key):

- `verifiers.test.ts`: each verifier against recorded answers, pass and fail; the query, record
  and replay helpers; offline checks of the answer readers.
- `defects.test.ts`: seven answer-reading edge cases (a negation such as "doesn't", a table
  instead of sentences, a host name with or without its port, and more): the naive reading gets
  a correct answer wrong, the verifier reads it right, and a wrong answer still fails.
- `tasks.test.ts`: the catalogue (50 tasks, unique ids, the pitfall and crypto tasks present),
  and every task's verifier replayed against answers recorded in live `--oracle` (must pass)
  and `--negative` (must fail) runs: `fixtures/recorded-verifications.json`.
- `agent.test.ts`: the loop against a fake client (the request settings, the envelope never
  sent, refusal, `pause_turn`, the caps, the per-run spend cap, error classes), the cost.
- `harness.test.ts`: a run in each mode against fake sessions, the setup-error path, the
  cleanup order, the `az_help` dispatch, the spend cap, the orphan sweep, the gate.
- `keys.test.ts`: where the key is read from, how a bad file is refused, the scrubbing, the
  child environment, and `run.mjs` without a key: exit 2 with the message, nothing written,
  and not one socket opened (a preloaded hook fails on any connect).
- `variants.test.ts`: each variant changes only what it says, against the server's real
  description.
- `run.test.ts`: Node loads every module through type stripping (`--list`), and bad options
  exit 2 before anything starts.

**Files.** `run.mjs` (the entry point), `harness.ts` (one run, cleanup, the orphan sweep, the
summary), `agent.ts` (the Messages API loop, envelope stripping, egress events, cost),
`verifiers.ts` (verifiers, fixture helpers, record and replay), `tasks-ta.ts`, `tasks-tb.ts`,
`tasks-tapim.ts` (the tasks), `variants.ts`, `keys.ts`, `types.ts`, `record-fixtures.mjs`. Node
loads the `.ts` modules unbundled, so none of them imports another local module at runtime
(only `import type`): `run.mjs` passes the verifier library to the task modules, and the other
modules to the harness.

**Refreshing the recordings** after changing a task, or when the emulator's answers change:

```bash
node tests/azure/evals/run.mjs --oracle   --out test-results/e2-oracle
node tests/azure/evals/run.mjs --negative --out test-results/e2-negative
node tests/azure/evals/record-fixtures.mjs test-results/e2-oracle/runs.jsonl test-results/e2-negative/runs.jsonl
```

`record-fixtures.mjs` keeps, per task and mode, the latest record that met its expectation: its
`verify_input` (slots and text) and `verifier.queries` (JSON stdout minified; connection-string
key parts, which no verifier reads, redacted). All values are local emulator test data.

## CI

`azure-weekly.yml`, job `evals`: `node tests/azure/evals/run.mjs --runs 3 --max-usd
"${AZURE_EVALS_MAX_USD:-20}" --out test-results/e2`, after `yarn build`, the pinned `az` and
the emulator. It needs the `ANTHROPIC_API_KEY` secret (the job skips itself without one), an
Azure-entitled `LOCALSTACK_AUTH_TOKEN`, and an emulator started with
`CDN_CLASSIC_ALLOW_CREATE=1`. With `CI=true` E2 runs three jobs at once (each with its own two
servers), which keeps 150 runs inside the job's 180 minutes. The job's secret scan covers
`test-results/` before the upload.
