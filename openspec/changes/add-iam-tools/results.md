# Results: add-iam-tools prototype

This branch builds the design in this directory (`proposal.md`, `design.md`, `specs/`) as a prototype, and evaluates it
against PR #140's single-tool approach. It is parked: the findings below are carried into PR #140 instead.

## What was built

- `localstack-iam` (read-only): `list-denials` (with `newer_than`), `explain-denial` (with `detail`),
  `get-event-policy`, `get-derived-policies`, `get-enforcement`.
- `localstack-iam-management` (destructive, idempotent): `set-enforcement` (old → new, restoring call, fixed note per
  mode; no write when unchanged), `reset-derived-policies`.
- `localstack-app-inspector` keeps only its released actions; the analyzer recommends the new tools on successful
  responses only.
- Tests: 623 unit tests, 34 eval-harness tests, build. The MCP-level tests (`tests/mcp/*.spec.mjs`) were updated but not
  run.

## Design review

Eight rounds of adversarial review (Claude Fable, against Arcade's agentic tool patterns and the LocalStack code) until
no BLOCKER or MAJOR remained. The findings that changed the design most:

| Finding | Change |
|---|---|
| IAM has four modes; `ENGINE_ONLY` was missing, so the advertised restore call failed | All four modes in the enum |
| `DISABLED → ENGINE_ONLY` happens only when App Inspector goes from disabled to enabled | Point to `set-enforcement mode=ENGINE_ONLY`, not to enabling recording |
| Disabling and re-enabling App Inspector deletes its database (unless persistence is on) | The recording switch stays in the destructive `localstack-app-inspector`; no generic `localstack-config` |
| Events have no trace column: a `trace_id` scope is silently ignored | No trace filter on `list-denials` |
| Client-side time filters kept producing holes | `newer_than` = LocalStack's own backward cursor (`prev_cursor`); only first pages offer it |
| `iam.policy.error` requests are allowed unchecked | Header counts evaluation errors |
| App Inspector stops recording at 1000 spans | Store-full warning (a known deviation until LocalStack reports `is_full`) |
| xmcp drops undeclared parameters | Reject parameters of another action in the handler; describe missing filters |
| Licence product for derived policies | A real licence lists `localstack.platform.plugin/iam-stream` |

## Evaluation (round 20, Claude subscription, Sonnet, 3 repeats)

| Arm | Scenarios | Passed | Turns | Time | Cost | Input tokens |
|---|---|---|---|---|---|---|
| No MCP server (round 19) | 06–08 | 0/9 | 4.3 | 84 s | $0.082 | 101k |
| PR #140 `localstack-app-inspector` (round 19) | 06–08 | 9/9 | 10.2 | 116 s | $0.127 | 240k |
| `localstack-iam` (round 20) | 06–08 | 9/9 | 9.6 | 112 s | $0.112 | 234k |
| PR #140 (round 19) | 01–05 | 15/15 | 5.3 | 90 s | $0.068 | 100k |
| `localstack-iam` (round 20) | 01–05 | 15/15 | 4.9 | 77 s | $0.067 | 92k |

- Agents called `list-denials` → `explain-denial` in every run of 06–08, with no tool errors, never the analyzer and
  never `localstack-iam-management`. No IAM tool in 01–05, as before.
- `explain-denial` responses averaged 3.8k characters against 9.7k for `explain-iam` (−61%), because the payload copy is
  opt-in (`detail=full`). `list-denials` grew from 1.3k to 2.1k (header and not-recorded note). About −46% IAM output per
  run.
- No agent used `newer_than`; all verified by redeploying and re-running the workload.
- **Discoverability is not shown.** PR #140 was already at 9/9, and in both builds the server instructions name the IAM
  tool. Measuring it needs instruction-free builds of both layouts, more repeats, and the turn of the first IAM call.

## What carries over to PR #140 without the tool split

The response and error-handling findings do not depend on the split: `detail` for the explanation, `newer_than`,
no silent trace filter, the four modes with old → new and a restoring call, `ENGINE_ONLY` instead of `SOFT_MODE` after
`DISABLED`, the ordered empty-result causes, the evaluation-error count, the store-full warning, the complete
not-recorded list, the derived-policy list without documents, the `iam-stream` licence check, the analyzer pointer on
successful responses only, and per-action parameter rejection. The split itself (read-only annotation, per-tool
permissions) is what a single tool cannot provide.
