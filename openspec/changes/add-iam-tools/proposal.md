## Why

When a request fails with `AccessDenied` in LocalStack, a coding agent needs the same answers the App Inspector UI gives a person: which request was denied, which policies decided it, and the change that fixes it (DEVX-1089). LocalStack now computes all three, plus the least-privilege policies derived from the requests it saw. The MCP server exposes none of it in a structured form. The only IAM tool, `localstack-iam-policy-analyzer`, parses LocalStack's log, which loses the deciding policies and mixes in denials from earlier runs.

The first implementation (PR #140) added seven IAM actions to `localstack-app-inspector`. It works: in the agentic eval, Claude Sonnet fixed all 9 runs of the three IAM scenarios (3 repeats each) with it, and none of the 9 without the MCP server. But an adversarial review against Arcade's agentic tool patterns found that the grouping follows LocalStack's endpoints, not the agent's task:

- **Reads and global changes share one tool.** Clients grant permissions per tool, and MCP's `readOnlyHint` / `destructiveHint` are per tool. A user cannot allow "explain my denial" without also allowing "disable IAM enforcement" and "delete all traces".
- **Half the IAM actions have nothing to do with App Inspector.** The IAM mode and the derived policies come from `/_aws/iam/...` and need no App Inspector licence. Both `localstack-app-inspector` and `localstack-iam-policy-analyzer` would set the IAM mode.
- **The verify step has no support.** `list-iam-denials` accepts filters it silently drops, so the agent cannot tell new denials from old ones.
- **`set-iam-mode` can make a denial disappear without fixing it**, and reports neither the previous mode nor how to restore it.

None of the IAM actions has been released, so the interface can still change for free.

## What Changes

- **New tool `localstack-iam`** (read-only): `list-denials`, `explain-denial`, `get-event-policy`, `get-derived-policies`, `get-enforcement`. Moves the IAM reads out of `localstack-app-inspector`.
- **New tool `localstack-iam-management`** (destructive, idempotent): `set-enforcement` and `reset-derived-policies`, every IAM action that changes LocalStack. `set-enforcement` takes an enum-typed mode and reports the old and the new mode, the call that restores it, and what the new mode means. App Inspector's recording switch stays in `localstack-app-inspector`, because re-enabling App Inspector deletes its recorded data.
- **`list-denials` supports checking a fix** with LocalStack's own backward cursor: `newer_than` returns only denials recorded after an earlier call. The header states the newest recorded request, the evaluation-error count and whether the span store is full. It declares no filter LocalStack cannot apply, and its description says it has no trace or time filter.
- **Empty and error results say why** (App Inspector disabled, licence hides IAM errors, nothing recorded, span store full, unknown event, IAM disabled, nothing denied, route not available) and what to call next.
- **`localstack-app-inspector`** loses the IAM actions added by PR #140. Its released actions, including `set-status` and `list-iam-events`, stay unchanged; their descriptions point to the new tools, and `set-status` says re-enabling deletes recorded data.
- **`localstack-iam-policy-analyzer`** keeps working unchanged (deprecating it is a pending product decision). Its successful responses recommend `localstack-iam` when the licence includes App Inspector, and `localstack-iam-management set-enforcement` for the mode.

## Capabilities

### New Capabilities

- `iam-diagnosis`: the `localstack-iam` tool.
- `iam-management`: the `localstack-iam-management` tool.

### Modified Capabilities

- `app-inspector`: released actions kept; pointers to the new tools.
- `iam-policy-analyzer`: recommendation footer, shown only when the licence includes App Inspector.

The repository has no baseline specs yet, so every capability is written as ADDED requirements.

## Impact

- **Code:** `src/tools/localstack-iam.ts`, `src/tools/localstack-iam-management.ts` (new); `localstack-app-inspector.ts`, `localstack-iam-policy-analyzer.ts`, `xmcp.config.ts`, `src/core/analytics.ts`. The render logic in `src/lib/iam/` moves unchanged apart from the response changes below.
- **Docs:** README tool table; AGENTS.md "Features → IAM policies" (the decision "IAM lives in `localstack-app-inspector`" is replaced); REVIEW §6.
- **Evals:** the tool allowlist (both arms), the `tool_called` checks of all eight scenarios, the prompt hint and the README name the new tools; scenarios 06–08 are re-run and compared with PR #140's results.
- **LocalStack:** no change required. A trace filter on the events route and an `is_full` flag on the spans page would help (see design.md, "Gaps").
- **Compatibility:** no released action changes. PR #140's action names never shipped.
