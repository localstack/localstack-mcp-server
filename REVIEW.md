# Review Rules: LocalStack MCP Server

Rules for reviewing a change to this repository. The design rules they enforce are in [AGENTS.md](AGENTS.md).

Report each finding as BLOCKER, SHOULD-FIX or NIT, with file and line and a concrete failure scenario (inputs and
state, then the wrong result). Call something a BLOCKER only after confirming it in the code.

A change may touch code listed under "Known deviations" in AGENTS.md without fixing it. It must not add new code of
the same kind, and it must not extend a deviation to another tool.

## 1. lstk, not the legacy CLI

- **BLOCKER:** the change calls, documents or recommends the legacy `localstack` CLI, in code, error hints, README or
  tool descriptions.
- **BLOCKER:** the container the server starts differs from lstk's in name, labels, ports, volumes or auth env, so
  `lstk stop` or `lstk status` cannot find or manage it, or the server cannot manage an lstk-started emulator.
- **SHOULD-FIX:** a change to the container spec has no test that compares it with lstk's defaults.
- **SHOULD-FIX:** the server calls lstk without passing its own endpoint as `LSTK_ENDPOINT_URL`, so a non-default
  `LOCALSTACK_HOSTNAME` or `LOCALSTACK_PORT` sends the command to a different emulator.

## 2. Cloud and IaC commands

- **BLOCKER:** a new code path runs `awslocal`, `tflocal`, `cdklocal`, `samlocal` or a hand-configured `az` without
  trying the lstk command first.
- **BLOCKER:** the lstk/fallback choice is made per tool instead of in the shared helper.
- **SHOULD-FIX:** tests cover only one path. Both the lstk path and the fallback need a test, including "neither is
  installed".
- **SHOULD-FIX:** the response does not say which command ran, or the missing-runner hint recommends anything other
  than lstk.
- **BLOCKER:** moving a tool to lstk drops a safety check: the AWS CLI sanitizer, or the Azure profile isolation,
  egress guard or command policy.

## 3. APIs over logs

- **BLOCKER:** new code derives structured facts from log text: services, operations, status codes, errors per
  request, IAM denials.
- **BLOCKER:** a tool falls back to log parsing when an API is unavailable. It should explain how to enable the
  feature instead.
- **SHOULD-FIX:** the change reads data from logs that a documented endpoint already returns.

## 4. Public interfaces only

This repository is public, so these are BLOCKERs:

- a reference to private LocalStack code: Python module paths (`localstack.pro.*`), private file paths or class names,
  in code, comments, tests or docs
- an endpoint that is neither in the emulator's OpenAPI spec (`/_localstack/swagger`) nor in the public docs, unless
  it is listed under "Gaps in LocalStack" in AGENTS.md
- a script or command run inside the LocalStack container to reach internals
- an undocumented configuration variable

## 5. Compute in LocalStack, render here

Flag new code that decides what is true instead of presenting what LocalStack returned. Red flags:

- parsing ARNs (`split(':')`, regexes) to learn an account, service, resource type or principal kind
- reading policy documents, or matching actions and resources against statements
- building or merging IAM policies
- choosing between remedies (which policy to edit, attach versus inline)

The fix is a field in the LocalStack payload. A tool may report that an older emulator lacks the field, but must
not compute it as a fallback.

## 6. IAM policies

See "IAM policies" in AGENTS.md.

- **BLOCKER:** the tool changes LocalStack's suggestion for a denied request: drops, merges or reorders its changes,
  or reports a different `outcome`. What the agent applies must be what LocalStack verified.
- **BLOCKER:** the tool computes a diff between suggested and deployed policies itself, instead of presenting one
  that LocalStack returned.
- **SHOULD-FIX:** a summary policy is presented as verified or complete, instead of as a suggestion from the
  requests seen so far; or "unused permissions" is not qualified as unused in this run.
- **SHOULD-FIX:** a summary policy is reshaped, for example by splitting a role's trust statement from its
  permissions.
- **SHOULD-FIX:** a missing license feature (a 404 from the policy summary, or App Inspector unavailable) shows as an
  error instead of an explanation of the feature and how to get it.

## 7. Tool contract

- **BLOCKER:** user input reaches a shell (`shell: true`, string commands, unescaped interpolation), or a CLI string
  bypasses its sanitizer.
- **BLOCKER:** a secret (auth token, AWS or Azure credentials, replicator source keys) can reach a tool response, an
  error message or analytics.
- **SHOULD-FIX:** the handler skips `withToolAnalytics`, preflights or `ResponseBuilder`, or a new tool argument is
  missing from (or wrongly added to) the analytics allowlist in `src/core/analytics.ts`.
- **SHOULD-FIX:** decision or parsing logic lives in the tool file instead of a tested `*.logic.ts` module.
- **SHOULD-FIX:** a tool's `schema` descriptions or `metadata.description` no longer match what the tool does. Agents
  choose tools from these strings.
- **SHOULD-FIX:** a breaking change to a tool's arguments or actions without a note in the PR. MCP clients and saved
  prompts depend on them.

## 8. Run modes

The server runs through `npx` on the host and as a Docker image that reaches the host's Docker daemon through the
mounted socket.

- **SHOULD-FIX:** the change works in one mode only. Check paths (host paths versus mounted paths), hostnames
  (`localhost` versus `host.docker.internal`) and binaries the image must bundle.
- **SHOULD-FIX:** a new host binary is needed but neither README prerequisites nor the `Dockerfile` are updated.

## 9. Tests and docs

- **SHOULD-FIX:** new `*.logic.ts` code without unit tests, or a new tool or action without a case in
  `tests/mcp/direct.spec.mjs`.
- **SHOULD-FIX:** `README.md` tool or prerequisite tables are out of date.
- **NIT:** a fixed known deviation still listed in AGENTS.md, or a new one not listed.
