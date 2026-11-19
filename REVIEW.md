# Review Rules: LocalStack MCP Server

Rules for reviewing a change to this repository. The design rules they enforce are in [AGENTS.md](AGENTS.md).

Report each finding as BLOCKER, SHOULD-FIX or NIT, with file and line and a concrete failure scenario (inputs and
state, then the wrong result). Call something a BLOCKER only after confirming it in the code.

"Known deviations" in AGENTS.md lists existing code on `main` only. For a change under review:

- New code that breaks a rule is a finding at the rule's severity, even if the same pattern is listed. A new row in
  "Known deviations" excuses it only if the PR records that the user approved the deviation.
- A change may touch listed code without fixing it, but the PR must say so: fixed, left as is, or why it cannot be
  fixed yet (SHOULD-FIX if it does not). It must not extend a deviation to another tool.

## 0. Security leaks (always BLOCKER)

This repository is public and takes PRs from external collaborators. Check these on every PR, before anything
else, and before approving a workflow run for a first-time contributor. Treat every changed file that CI executes
or reads as code that runs with whatever the job exposes. That includes `.github/workflows/`, `.github/actions/`,
`package.json` (scripts and dependencies), `yarn.lock`, `patches/` (applied by `yarn install`), `src/` (the server
runs with the auth token), `tests/`, `data/` (sample projects CI installs and deploys, eval datasets),
`playwright.config.mjs`, `jest.config.js`, `xmcp.config.ts`, `tsconfig*.json`, `Dockerfile`, `docker/`, and anything
else a workflow, action or install script reads.

Each of these is a BLOCKER:

- **Untrusted code with secrets.** A workflow triggered by `pull_request_target`, `workflow_run` or
  `issue_comment` checks out or runs the PR's code: those triggers run with the repository's secrets
  (`LOCALSTACK_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `DOCKER_PUSH_TOKEN`, …) and a write token. Under `pull_request`,
  GitHub gives fork PRs no secrets, so the jobs fail on the token check instead (`ci.yml`, `docker.yml`). Do not
  work around that with a trigger that has secrets.
- **Secrets for Dependabot.** Dependabot PRs get no Actions secrets either, so token-gated jobs fail on them. Do not
  add `LOCALSTACK_AUTH_TOKEN` or another secret as a Dependabot secret: it would reach the install scripts of the
  packages the PR just bumped. Review the bump, then run it with secrets the same way as an external PR.
- **An external PR pushed unreviewed.** For a fork or Dependabot PR to be tested, a maintainer pushes the reviewed commit to a
  new branch the maintainer owns and opens a PR from it, so its workflows run with secrets. Review the whole diff
  under this section first, and never push a branch the contributor or Dependabot can still change.
- **Secrets printed or stored.** A step or script echoes a secret, runs `set -x`, `env` or `printenv`, logs request
  headers, or writes a secret to a file. GitHub masks secrets in logs only: an uploaded artifact (test results,
  Playwright traces, eval transcripts, the server's stderr), a cache entry, or a built image layer is not masked.
  Check what each `upload-artifact` path can contain.
- **Secrets handed to something that records or runs untrusted input.** A coding agent, a model-driven tool, a
  wrapped CLI or the LocalStack container inherits the whole environment when it needs one variable, or can read a
  file that holds a secret. Or a step installs or runs third-party code (dependency install scripts, a sample
  project's packages, a third-party action) while a secret is in its environment or in `.git/config`
  (`actions/checkout` keeps the GitHub token there unless `persist-credentials: false`). Where AGENTS.md already
  lists a workflow under Known deviations for this, a change that only bumps a dependency or action is not a new
  finding; one that adds a step, a job, or a new manifest, lockfile or registry there is. A new package in an
  existing manifest is checked under "New third-party action or package from an unknown publisher" instead.
- **Write access by default.** A new workflow, or a new job or trigger in an existing one, runs without a
  `permissions:` block, or a job that runs PR code gets more than it needs (`contents: write`, `packages: write`,
  `id-token: write`). A version bump of an action in a listed workflow is not such a change.
- **Publishing from a PR.** `npm publish`, `docker push` or a release step can run on a `pull_request` event.
- **User input in a shell.** `${{ github.event.* }}`, `${{ inputs.* }}` or a branch or PR title reaches a `run:`
  step directly instead of through `env:`.
- **Secrets in the repository or the image.** A committed token, key, `.env` file, or a test fixture, snapshot or
  eval result that holds a real credential; a build `ARG`/`ENV` or `COPY` that bakes one into the image; a removed
  `.dockerignore` entry for `.env`.
- **Secrets in tool output.** An auth token, AWS or Azure credentials or replicator source keys can reach a tool
  response, an error message, analytics or the server's logs.
- **New third-party action or package from an unknown publisher**, added without saying in the PR why it is
  trusted. (Pinning is checked in §10.)

A finding here blocks the PR even if the code is otherwise fine. If a secret may already have leaked (a log, an
artifact, a pushed commit), say so in the review so a maintainer rotates it; deleting the artifact is not enough.

## 1. lstk, not the legacy CLI

- **BLOCKER:** the change calls, documents or recommends the legacy `localstack` CLI, in code, error hints, README or
  tool descriptions.
- **BLOCKER:** a change to the container spec adds a difference from lstk's container (name, image, labels, ports,
  volumes, environment, auth env) or makes an existing one worse, so `lstk stop` or `lstk status` can find or manage
  fewer of the server's emulators, or the server fewer of lstk's; or the change drops detection of `localstack-aws`.
  Differences that already exist are not findings; the "Known deviations" list of them is not exhaustive.
- **SHOULD-FIX:** a change to the container spec has no test that compares it with lstk's defaults.
- Endpoint handling for lstk calls is an open question in AGENTS.md. Until it is decided, report these as
  questions for the user, not as rule violations, unless the failure is confirmed:
  - an lstk call can reach a different emulator than the server's other tools, for example because a
    `LSTK_ENDPOINT_URL` or `AWS_ENDPOINT_URL` in the user's environment wins (SHOULD-FIX if confirmed)
  - an endpoint reaches an lstk command that refuses one (`rejectEndpointURL` in lstk's `cmd/endpoint.go`),
    through the server or the inherited environment (BLOCKER if confirmed: the command fails)

## 2. Cloud and IaC commands

- **BLOCKER:** new code runs `awslocal`, `tflocal`, `cdklocal`, `samlocal` or a hand-configured `az`, or adds a
  fallback to them. lstk is required.
- **SHOULD-FIX:** no test for lstk being missing, or the missing-lstk message recommends anything other than
  installing lstk.
- **SHOULD-FIX:** the response does not say which command ran.
- **SHOULD-FIX:** a tool moves to lstk but the Docker image lacks a binary that lstk command calls.
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
- an endpoint that is in neither the public docs nor one of the emulator's OpenAPI specs (`/_localstack/swagger`;
  `/_localstack/appinspector/v1/openapi.yaml` for App Inspector), unless it is listed under "Gaps in LocalStack" in
  AGENTS.md
- a script or command run inside the LocalStack container to reach internals
- an undocumented configuration variable

Also a BLOCKER: the change adopts an API the server did not use before, and the PR does not record that the user
approved it (AGENTS.md rule 4).

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
- **BLOCKER:** a string from LocalStack or the user's workload (resource names, ARNs, error messages, policy JSON,
  log lines) reaches an agent-facing response without escaping. A value must not be able to close a code fence,
  break a table, or read as an instruction. Size code fences to their content, and escape markdown in table cells
  and inline text.
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
- **BLOCKER:** the image grows by more than about 50 MB per platform, or gains a new runtime, toolchain or base
  image, and the PR does not record that the user approved it (AGENTS.md "Docker image size").
- **SHOULD-FIX:** a change to `Dockerfile`, `docker/` or `.dockerignore`, or a new runtime dependency, without the
  image size before and after for amd64 and arm64.
- **SHOULD-FIX:** the runtime stage keeps build tools, dev dependencies, package caches or package lists, or cleans
  them in a later layer than the one that created them.

## 9. Tests and docs

See "Testing" in AGENTS.md.

- **BLOCKER:** a bug fix without a test that fails before the fix.
- **SHOULD-FIX:** a new or changed action without a handler test in `src/tools-tests/<tool>.test.ts` covering its
  success path, each error path (`isError: true`) and each preflight it runs.
- **SHOULD-FIX:** new `*.logic.ts` code without unit tests.
- **SHOULD-FIX:** a tool that renders payload or workload strings, or builds a command line, without an adversarial
  test (fence and table injection; shell chaining, option injection, path traversal).
- **SHOULD-FIX:** a tool that handles a secret without a test asserting the secret is absent from the response,
  the error and analytics.
- **SHOULD-FIX:** tests assert on internal calls instead of the response, the spawned argument array or the HTTP
  request sent to LocalStack.
- **SHOULD-FIX:** a new tool missing from `EXPECTED_TOOLS` in `tests/mcp/direct.spec.mjs` or `tests/docker/validate-image.mjs`, or a new action without
  a case in `tests/mcp/tools.spec.mjs` that checks its effect through another call.
- **SHOULD-FIX:** a test reaches real AWS or Azure resources; creates a LocalStack platform resource without
  cleanup, or with a fixed name outside a `concurrency` group; or skips or passes silently when a required secret
  is absent (AGENTS.md "Testing" names the only skips allowed).
- **SHOULD-FIX:** a tool's description, schema or response wording changed and the PR does not report an eval run.
- **SHOULD-FIX:** `README.md` tool or prerequisite tables are out of date.
- **NIT:** a change adds a count, version, line number or growing list to AGENTS.md instead of a rule and a
  pointer, or a list a test could hold (AGENTS.md, "Maintaining this file").
- **NIT:** a fixed known deviation still listed in AGENTS.md. (New code that breaks a rule is a finding at that
  rule's severity; see the top of this file.)

## 10. Dependencies and CVEs

See "Dependencies" in AGENTS.md.

- **BLOCKER:** a dependency or tool installed without a pinned version in a file Dependabot updates: `npm install -g`,
  `pip install`, `curl … | sh`, a `latest` tag (other than the LocalStack emulator images), or `npx` of a package
  not in `package.json`.
- **BLOCKER:** a known high or critical advisory is silenced (an `audit-ci` allowlist entry, a removed audit step)
  without the advisory ID, why it does not apply, and a date to revisit.
- **SHOULD-FIX:** a new manifest, lockfile, ecosystem or Dockerfile stage without a matching entry in
  `.github/dependabot.yml`.
- **SHOULD-FIX:** a version pinned by hand that Dependabot could manage, or a hand-managed pin without an `ignore`
  entry giving the reason.
- **SHOULD-FIX:** a new `uses:` (a new action, or an existing one in a new step) not pinned to a commit SHA with a
  version comment. Dependabot bumping a tag pin that is a known deviation is fine.
- **SHOULD-FIX:** a lockfile changed without the manifest change that explains it, or the reverse.
