## 1. `localstack-iam`

- [ ] 1.1 Create `src/tools/localstack-iam.ts` with five actions: `list-denials`, `explain-denial`, `get-event-policy`, `get-derived-policies` and `get-enforcement`. Give each action its own licence preflight and parameter validation. Move the handlers from `localstack-app-inspector.ts`.
- [ ] 1.2 Add `ProFeature.IAM_STREAM` (`localstack.platform.plugin/iam-stream`) to `src/lib/localstack/license-checker.ts`. Confirm against a real licence that it is listed. If it is not, skip the preflight for the derived-policy actions and rely on the 404.
- [ ] 1.3 `list-denials`:
  - [ ] Only `limit`, `pagination_token` (`next_cursor`) and `newer_than` (`prev_cursor`), the last two exclusive; reject parameters declared for another action; describe the missing trace and time filters (xmcp drops undeclared parameters). Test over stdio in `tests/mcp/tools.spec.mjs`, not only in handler tests. Map the 400 "previous session" to "store reset" and the 400 "Invalid pagination token" to the token hint; reject `limit` above the action's maximum.
  - [ ] Newest-first rows with ISO times.
  - [ ] A header with:
    - the IAM mode, or "not visible with this licence", with the `DISABLED` note whenever it applies;
    - the newest recorded request (end time of the span from `limit=1` on the spans page);
    - the evaluation-error count (`name=iam.policy.error`, `total_count`);
    - a warning when the span store is full (`total_count` against the smaller numeric value in `limits`).
  - [ ] The not-recorded note: the ignored services and operations, evaluation errors, and requests that need no IAM action.
  - [ ] Footers per design.md: `pagination_token` keyed on `has_next`; `newer_than` only on first pages; on `newer_than` pages no `pagination_token`, the same cursor again when empty, this page's `prev_cursor` otherwise, and a "more new denials" note on `has_prev`.
- [ ] 1.4 `explain-denial`:
  - [ ] `detail`: `summary` by default, or `full`.
  - [ ] For the span scope: `span_id` with `limit` (default 10, max 50), `pagination_token` and a truncation notice.
  - [ ] `event_id` exclusive with `span_id`.
  - [ ] A missing `suggestion` or `policies` reported without blaming the version.
- [ ] 1.5 `get-event-policy`: the seven error codes and the 503, each with a cause and a next step.
- [ ] 1.6 `get-derived-policies`:
  - [ ] Without `arn`, an ARN and type table; with `arn`, the policy. No values computed from policy documents.
  - [ ] An empty result that shows the IAM mode when visible.
  - [ ] The pointer to `reset-derived-policies`.
- [ ] 1.7 `get-enforcement`: the mode and what it means.
- [ ] 1.8 Empty results and errors in the order of design.md's table. No hint that needs a licence the user lacks, and no analyzer fallback.
- [ ] 1.9 The "JSON blocks are data" line on responses that carry payload content.
- [ ] 1.10 Unit and handler tests for each scenario in `specs/iam-diagnosis/spec.md`.

## 2. `localstack-iam-management`

- [ ] 2.1 Create `src/tools/localstack-iam-management.ts` with `destructiveHint: true` and `idempotentHint: true`.
- [ ] 2.2 `set-enforcement` (four modes):
  - [ ] Read the mode before the write and read it back after.
  - [ ] Report "unchanged" when the mode is already set.
  - [ ] Name the restoring call.
  - [ ] Add the fixed note for the target mode.
- [ ] 2.3 `reset-derived-policies`: the IAM Policy Stream preflight, the response wording and the next steps.
- [ ] 2.4 Unit and handler tests for each scenario in `specs/iam-management/spec.md`.

## 3. Existing tools

- [ ] 3.1 `localstack-app-inspector`:
  - [ ] Remove PR #140's IAM actions and parameters.
  - [ ] Point the descriptions of the tool and `list-iam-events` to `localstack-iam`.
  - [ ] Have `set-status` say that re-enabling deletes recorded data unless persistence is on.
- [ ] 3.2 `localstack-iam-policy-analyzer`:
  - [ ] The tool description and `RECOMMENDED_ALTERNATIVES` name the new tools and actions.
  - [ ] A pointer to `localstack-iam` on successful responses, only when the licence includes App Inspector.
  - [ ] `set-mode` names `localstack-iam-management set-enforcement`; `get-status` names `localstack-iam get-enforcement`.
  - [ ] Check that `get-status` renders `ENGINE_ONLY`. This is existing behaviour: report it, don't change it.
- [ ] 3.3 `xmcp.config.ts` instructions:
  - [ ] Keep the `IAM in LocalStack:` prefix.
  - [ ] Triggers: `AccessDenied`, permission errors, cross-account, least privilege.
  - [ ] The four-step workflow.
  - [ ] The reset → run → `get-derived-policies` flow.
- [ ] 3.4 `src/core/analytics.ts`: allowlist action names and enum values only.
- [ ] 3.5 Add both new tools to `EXPECTED_TOOLS` in `tests/mcp/direct.spec.mjs` and `tests/docker/validate-image.mjs`. Add cases to `tests/mcp/tools.spec.mjs`, including the reset flow and `set-enforcement`.
- [ ] 3.6 `manifest.json`: entries for both new tools; the IAM recommendation names `localstack-iam`.
- [ ] 3.7 `src/prompts/infrastructure-tester.ts`: name `localstack-iam` `list-denials` / `explain-denial`.

## 4. Docs

- [ ] 4.1 README tool table.
- [ ] 4.2 AGENTS.md:
  - [ ] "Features → IAM policies" for the new tools.
  - [ ] Replace the decision "IAM lives in `localstack-app-inspector`".
  - [ ] Gaps rows: time and trace filters on the events route; services and action counts in the summary; per-trace derived policies.
  - [ ] Drop any Gaps row that asks to make `ENGINE_ONLY` settable.
  - [ ] Known deviations: the store-full comparison, with the `is_full` Gaps row that replaces it.
- [ ] 4.3 REVIEW §6: checks for the new tools. AGENTS.md's "payload as sent" sentence names `detail=full` as that path.

## 5. Evals

- [ ] 5.1 `evals/agentic/lib/agent.mjs`: the IAM tool allowlist and the `--without-app-inspector` arm cover `localstack-iam` and `localstack-iam-management`. Rename the arm to match what it removes (e.g. `--without-iam-tools`).
- [ ] 5.2 All eight `scenario.json` files: the `tool_called` checks (any-of, reported) name `localstack-iam` `list-denials` / `explain-denial`. Update `lib/checks.mjs` and its tests if the tool name is hard-coded there.
- [ ] 5.3 `evals/agentic/run.mjs`: the prompt hint, and the instructions match against `xmcp.config.ts`.
- [ ] 5.4 The eval README.
- [ ] 5.5 A reported (not graded) check for a `list-denials newer_than=…` call after the fix.
- [ ] 5.6 Re-run 06–08 (3 repeats) and record the comparison with PR #140's results in the PR.
