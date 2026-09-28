# E2: composition evals for `localstack-azure-client`

E2 (plan section 5.6, tasks 6.1-6.3) measures whether Claude can do real Azure work through
the unified server: it gets a task, calls `localstack-azure-client` over MCP until it ends its
turn, and then a verifier reads the outcome from the emulator. The tasks, their fixtures and
their verifiers are ported from the Azure MCP benchmark
(its `benchmark/harness/ta.py`, `tb.py`, `tapim.py`), with the benchmark's
task ids, prompts, oracle commands and model settings.

- **No money is spent** by `--oracle`, `--negative`, `--dry-run` and `--list`, and by the unit
  tests. Only a model run calls the Anthropic API, and it refuses to start without a key.
- **The gate** (plan 5.6): at least 95% success at n=3, zero egress events, and the cost per
  completed task recorded.

## Quick start

```bash
yarn build                                   # dist/cli.js, the stdio server E2 drives

node tests/azure/evals/run.mjs --list        # the 50 tasks
node tests/azure/evals/run.mjs --dry-run --variant compact,p1c,help-tool,no-test-data

# No model: the benchmark's reference solution must pass every verifier, and setup alone
# must fail it (needs a running emulator and LOCALSTACK_AUTH_TOKEN).
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

| Option                                             | Default                                     | Meaning                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runs N`                                         | 1                                           | repetitions per task (and per variant)                                                                                                                                             |
| `--max-usd X`                                      | `$AZURE_EVALS_MAX_USD` or 20                | the campaign's cap: no new run once the spend (pre-warms included) reaches X, and a running loop stops before its next request; every turn counts at once, for concurrent runs too |
| `--max-usd-per-run Y`                              | `$EVAL_MAX_USD_PER_RUN` or 1                | a run's agent loop stops (failure `spend_cap`) before a request once the run's own cost reaches Y                                                                                  |
| `--out DIR`                                        | `test-results/e2`                           | results directory                                                                                                                                                                  |
| `--tasks id,id` / `--tier T-A,T-B,T-APIM`          | all                                         | selection                                                                                                                                                                          |
| `--model M`                                        | `$EVAL_MODEL` or `claude-opus-5-5`          | a model needs a price in `agent.ts` (`PRICES`), or the run refuses                                                                                                                 |
| `--effort E`                                       | `$EVAL_EFFORT` or `high`                    | `output_config.effort`                                                                                                                                                             |
| `--variant v[,v]`                                  | `compact`                                   | see below; several variants interleave per task in a seeded order                                                                                                                  |
| `--all-tools`                                      | off                                         | offer every server tool, not only the Azure tool (`localstack-management` is withheld: it can stop the emulator)                                                                   |
| `--key-file PATH`                                  |                                             | the key file (else `ANTHROPIC_API_KEY_FILE`, else `ANTHROPIC_API_KEY`)                                                                                                             |
| `--phrasing alt\|0\|1`                             | `alt`                                       | T-A has two phrasings: run _i_ uses phrasing _i_ mod 2, or a fixed one                                                                                                             |
| `--verify-wait S`                                  | 90 (10 with `--negative`)                   | how long a polling verifier waits for a state                                                                                                                                      |
| `--jobs N`                                         | `$EVAL_JOBS`, else 3 when `CI=true`, else 1 | concurrent runs, each with its own agent and harness server                                                                                                                        |
| `--seed N`                                         | 20260924                                    | the variant order                                                                                                                                                                  |
| `--max-minutes M`                                  | none                                        | no new run after M minutes                                                                                                                                                         |
| `--no-prewarm`                                     |                                             | skip the `max_tokens: 0` cache pre-warm per variant                                                                                                                                |
| `--oracle` / `--negative` / `--dry-run` / `--list` |                                             | the no-spend modes                                                                                                                                                                 |

Exit status: **0** passed (the gate for a model run; every expectation for `--oracle` and
`--negative`) and the final cleanup check was clean; **1** not passed, or stopped early (spend
cap, `--max-minutes`, a key that stopped working, Ctrl+C); **2** a usage or configuration error:
no API key for a model run, no price for the model, no `dist/cli.js`, no `LOCALSTACK_AUTH_TOKEN`,
Node.js too old.

## How a run works

```
group create                (harness session)
task setup                  (harness session: the benchmark's fixtures, as az commands)
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
- **Cleanup** leaves nothing behind: it waits until nothing in the group is still provisioning
  (a group deleted under a Creating storage account leaks its Azurite container), removes the
  group's locks, deletes and purges its Key Vaults, deletes the group and waits, purges
  soft-deleted vaults, APIM services and App Configuration stores the run named, and checks the
  group is gone. At the end, an orphan sweep lists every resource type the tasks create and
  deletes whatever still sits in one of the run's groups (an agent that re-creates an existing
  group empties its resource index, and the group delete then leaves those resources running).
  Groups are named `mcpe2-<random>-<task>-<n>`.

## Model settings (the benchmark's, `benchmark/harness/config.py` and `agent.py`)

|                   | E2                                                                                                                                      | benchmark (P1c arm)                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| model             | `claude-opus-5-5`                                                                                                                       | `claude-opus-5-5`                        |
| loop              | hand-rolled Messages API, `tool_use` -> MCP `tools/call` -> `tool_result`, the assistant turn replayed unmodified                       | same                                     |
| `max_tokens`      | 16000, non-streaming                                                                                                                    | same                                     |
| thinking          | `{type: "adaptive", display: "summarized"}`                                                                                             | same                                     |
| effort            | `high` (sent: Opus 5.5 defaults to `medium`)                                                                                            | same                                     |
| caching           | system block with `cache_control`, plus top-level automatic `cache_control`; a `max_tokens: 0` pre-warm per variant measures the prefix | same                                     |
| system prompt     | the benchmark's Appendix B text                                                                                                         | same                                     |
| caps              | T-A and T-APIM: 20 turns, 30 tool calls, 600 s; T-B: 40, 60, 1800 s                                                                     | same                                     |
| tool timeout      | 300 s                                                                                                                                   | same                                     |
| retries           | the SDK's, `maxRetries: 4`; an auth or billing error is not scored and stops the campaign                                               | same                                     |
| tools             | `localstack-azure-client` (and `az_help` in `help-tool`)                                                                                | `az`, `az_help`, `check_emulator_status` |
| refusal fallbacks | off: E2 counts refusals (experiment 3), a fallback would hide them and switch models                                                    | none                                     |
| spend cap         | per campaign and per run                                                                                                                | per campaign                             |

Prices (USD per million tokens): `claude-opus-5-5` $4 input, $20 output, $5 cache write,
$0.20 cache read (the benchmark's frozen prices). The record keeps the billed cost and, like the
benchmark, the cost re-priced as if the first turn found the shared prefix cached ("warm") or
not ("cold"); the gate's "cost per completed task" is the warm one.

## Variants and the experiments (task 6.3)

| Variant        | What Claude gets                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `compact`      | the server's own description (Appendix C), unchanged: the shipped default                                                                                                                                                                                    |
| `p1c`          | the benchmark's P1c description, adapted in three places that are false for this tool: one command per call (no list input), no "absolute URLs are blocked" (the tool rewrites them), `--help` instead of `az_help`                                          |
| `help-tool`    | `compact` with "Run it with --help first" replaced by "Call `az_help` ...", plus a separate `az_help` tool (the P1c arm's description and `prefix` parameter); the runner runs it as `<prefix> --help` through the Azure tool, so only the interface differs |
| `no-test-data` | `compact` without ", so all data and secrets are local test data"                                                                                                                                                                                            |

A variant whose anchor text is no longer in the server's description fails at start, rather than
silently testing the default. The experiments, n=3 each:

```bash
node tests/azure/evals/run.mjs --runs 3 --variant compact,p1c          --out test-results/e2-exp1
node tests/azure/evals/run.mjs --runs 3 --variant compact,help-tool    --out test-results/e2-exp2
node tests/azure/evals/run.mjs --runs 3 --variant compact,no-test-data --out test-results/e2-exp3
```

Compare, per variant in `summary.json`: `success_rate`, `cost_per_completed_task_warm_usd`,
`median_time_to_verified_ms`, `egress_events`, and for experiment 3 `kv_crypto_refusals`
(refusals on `kv-sign`, `kv-decrypt` and `tb-keyvault-secret-sign`, the tasks that drew
first-turn refusals in the benchmark). An estimate from the benchmark's costs (about $0.02 per
T-A run for its P1c arm, $0.17 per T-B run averaged over all arms): 50 tasks x 3 runs is
roughly $5-10 per variant, so an experiment's two variants about $10-20; `--max-usd` caps it.
With `--variant` listing two variants, `--max-usd` is the cap for both together.

## Output

`--out DIR` holds:

- `runs.jsonl`: one record per run: `task_id`, `tier`, `op_id`, `verb`, `variant`, `mode`,
  `model`, `effort`, `run`, `phrasing`, `rg`, `success` (null for a setup or infrastructure
  fault), `reason`, `failure` (`verify_failed`, `refusal`, `max_tokens`, `cap_exceeded`,
  `spend_cap`, `setup_error`, `infra_error`, `account_error`, `api_error`, `harness_error`;
  `verifier_passed_without_action` for `--negative`), `expected` (`pass`, or `fail` for
  `--negative`), `stop`,
  `stop_details`, `refusal`, `prompt`, `wall_ms`, `verify_ms`, `time_to_verified_ms`, `turns`,
  `tool_calls`, `tool_ms`, `tokens` (`input`, `output`, `cache_write`, `cache_read`,
  `initial`), `prefix_tokens`, `cost_usd`, `cost_warm_usd`, `cost_cold_usd`, `egress_events`,
  `housekeeping_blocks`, `harness_egress`, `verifier` (`passed`, `reason`, `steps`, and every
  query it made with its answer), `steps` and `steps_passed` (T-B), `verify_input` (the slots
  and text the verifier read, so a verifier fixed later can re-score the run offline), `slots`,
  `setup`, `turn_log`, `tool_trace`, `final_text`, `cleanup`; `oracle` and `transcript` for
  `--oracle`.
- `meta.json`: the settings (model, effort, thinking, prices, variants with the tool
  definitions sent and their sizes, tasks, seed, jobs), the pre-warm usage, the spend, why it
  stopped.
- `summary.json`: per variant the success rate (overall and the mean over tasks), billed cost,
  cost per completed task (warm and billed), median time to verified state, egress events,
  refusals (all, and Key Vault crypto), setup and infrastructure faults, the failing tasks, and
  the gate; for `--oracle` / `--negative` the runs that met or missed their expectation.
- `cleanup.json`: the final orphan sweep and the leftover check (`clean`).
- `server-*.stderr.log`: each server's stderr.

The API key never appears in any of them: it is read once, handed to the SDK client, removed from
the environment, and scrubbed from every error text and record before it is written.

## The tasks

50 tasks: 28 from T-A (both phrasings), 8 from T-B, 14 from T-APIM. `node run.mjs --list`
prints them. The ids are the benchmark's.

| Tier   | Tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-A    | `appconfig-kv-unlock`, `appconfig-check-keys`, `appconfig-regenerate-key`, `lock-delete`, `locks-list`, `role-definition-get`, `acr-login-server`, `acr-webhook-create`, `eventgrid-topic-regenerate-key`, `eventgrid-domain-disable-local-auth`, `eventhub-hub-auth-rule-rights`, `insights-activity-log-alert-create`, `kv-sign`, `kv-decrypt`, `kv-rotation-policy`, `kv-access-policy-grant`, `identity-create`, `identity-list`, `route-get`, `private-dns-zones-list`, `vnet-address-space`, `la-workspace-retention`, `deployment-sub-validate`, `sb-queue-regenerate-key`, `sb-dp-queue-max-delivery`, `storage-regenerate-key`, `disk-create`, `cdn-can-migrate` |
| T-B    | `tb-storage-blob`, `tb-keyvault-secret-sign`, `tb-servicebus-topic`, `tb-resource-graph-tags`, `tb-tag-audit`, `tb-mysql-firewall`, `tb-eventgrid-to-eventhub`, `tb-webapp-settings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T-APIM | `apim-group-user-check`, `apim-workspace-product-update`, `apim-tenant-access`, `apim-git-regenerate-primary`, `apim-api-create`, `apim-operation-delete`, `apim-operation-policy`, `apim-tag-assign-api`, `apim-tag-detach-product`, `apim-api-tag-descriptions`, `apim-graphql-resolver`, `apim-certificate-create`, `apim-oidc-secret`, `apim-migrate-stv2`                                                                                                                                                                                                                                                                                                            |

**How the port differs.** The benchmark's fixtures called the typed server's builders
(`tests/coverage_mapping.py` of the typed repo) and a raw ARM client. Here every fixture runs
as `az` commands through the harness's session, with the benchmark's ARM bodies (`az rest`)
wherever it sent one, and the verifiers read state with `az rest` (relative URLs) and `az`
data-plane commands (`keyvault key verify`, `keyvault secret show`). The HTTP status of an
`az rest` answer comes from az's `ERROR: <REASON>(...)` line. With the oracle there is no
answer, so the claim verifiers read the oracle's transcript: one block per call, a mark line
(`ORACLE ✅ az <command>`, ❌ on failure) and az's output fenced.

**Not taken from the benchmark.** T-A had 111 scored tasks (120 sampled, 9 blocked in the
benchmark because the emulator records no outcome to verify). E2 takes 28, leaving out the
tasks with heavy or session-shared fixtures (AKS clusters and node pools, SQL, PostgreSQL and
MySQL servers, Cosmos DB accounts, VMs and scale sets, container groups, Container Apps
environments) and keeping a spread over providers and verbs within the plan's 30-50;
`eventhub-ns-auth-rule-delete` passed its oracle but was left out to stay within 50. T-B: 8 of
20 workflows (the others need PostgreSQL, SQL, Cosmos DB or Container Apps, or repeat a covered
pattern). T-APIM: 14 of the 16 unblocked tasks (`apim-workspace-group-update` repeats
`apim-workspace-product-update`; `apim-workspace-loggers` passed its oracle but was left out to
stay within 50). No task was dropped for failing: see Validation below.

## The verifiers and the seven benchmark defects

`verifiers.ts` ports `verifiers.py` and the helpers of `tasks.py`. The seven verifier defects the
benchmark found after data collection (`research-2026-09-24/19-campaign-log.md`; the fixes in
`benchmark/report/rescore.py`) are fixed here, and `defects.test.ts` shows, per defect, that the
original reader misreads a correct answer, the fixed one reads it right, and a wrong answer
still fails:

1. `eventhub-hub-auth-rule-rights`: the negation `\b(...|n't)\b` never matched inside
   "doesn't"; now the answer's grant statement is read (`affirmedRights`).
2. `deployment-sub-validate`: any "error" or "fail" failed the answer; now its validity
   statement decides (`validationVerdict`).
3. `tb-tag-audit`: per-sentence stretches lost a table's verdicts; now per line
   (`untaggedVerdicts`).
4. `tb-mysql-firewall`: the FQDN was demanded with the emulator's port (`:4513`); now with or
   without it (`hostOf`).
5. `td-afd-hostname-check` (T-D, not an E2 task): dots in host names split the sentences; the
   fixed reader is in the library (`hostVerdicts`).
6. `apim-group-user-check`: verdicts were collected across stretches; now the first verdict
   word after each name decides, and "whether" lines are skipped (`membershipVerdicts`).
7. `apim-tenant-access`: "enabled: false" read as enabled; now the first verdict word decides
   (`tenantAccessVerdict`).

## Tests

`npx jest tests/azure/evals` (part of the default suite; no emulator, no network, no key):

- `verifiers.test.ts`: each verifier against recorded answers, pass and fail; the query,
  record and replay helpers; the benchmark's own `test_verifiers.py` cases.
- `defects.test.ts`: the seven defects above.
- `tasks.test.ts`: the catalogue (50 tasks, unique ids, the defect and crypto tasks present),
  and every task's verifier replayed against the answers recorded in live `--oracle` (must
  pass) and `--negative` (must fail) runs: `fixtures/recorded-verifications.json`.
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
servers). Measured on a Windows workstation (below), an oracle run (setup, the reference
commands, verification, cleanup) takes a median 19 s and a negative run 27 s; a model run adds
its turns and extra tool calls, so 150 sequential runs would take roughly two hours, close to
the job's 180 minutes. The job's secret scan covers `test-results/` before the upload.

## Validation (2026-09-27)

Against a shared LocalStack Azure emulator on port 4566, from Windows 11 with the tool's MSI
`az` 2.85.0, a dummy `LOCALSTACK_AUTH_TOKEN`, and one tool call in flight at a time:

- `--oracle`: **50 of 50** met (a first pass over 52 candidates met 52 of 52, the two left out
  included); zero egress events, from the agent's session and from the harness's; every group
  gone and the final sweep clean. Median 19 s per run (13-113 s; `tb-mysql-firewall`, which
  starts a MySQL server, is the longest); the pass took 21 minutes.
- `--negative`: **50 of 50** met: setup alone fails every verifier. Median 27 s per run; 28
  minutes.
- The recordings of both passes are `fixtures/recorded-verifications.json` (100 entries), which
  `tasks.test.ts` replays.
- No model run was made (no API key on that machine): the experiments of task 6.3 are next.
