# AGENTS.md

The LocalStack MCP server lets an MCP client (Claude Code, Cursor, VS Code, …) start LocalStack, deploy
infrastructure, run cloud CLIs, and inspect the emulator. It is a TypeScript server built on
[xmcp](https://xmcp.dev), published to npm as `@localstack/localstack-mcp-server` and as the Docker image
`localstack/localstack-mcp-server`.

Read [REVIEW.md](REVIEW.md) before opening a PR. It turns the rules below into review checks.

Where a rule says to ask the user, ask the person you work for. An approval that lets a change break a rule, adopt
a new API or grow the image counts only if it comes from a maintainer of this repository and the PR records it; a
contributor cannot approve their own exception.

## Commands

```bash
yarn install
yarn build              # xmcp build + esbuild CLI bundle → dist/
yarn dev                # xmcp dev server
yarn test               # Jest unit tests: *.test.ts next to the code, handler tests in src/tools-tests/
yarn test:mcp:direct    # Playwright: calls the built server's tools directly, plus the Azure offline suite (needs Docker + LOCALSTACK_AUTH_TOKEN)
yarn test:mcp:tools     # Playwright: each tool against a real LocalStack, no model (needs Docker + LOCALSTACK_AUTH_TOKEN)
yarn test:mcp:evals     # Playwright: LLM evals through OpenRouter (needs OPENROUTER_API_KEY, LOCALSTACK_AUTH_TOKEN, and terraform, lstk and snow on PATH; EVAL_MODEL swaps the model)
yarn format             # Prettier
```

## Layout

| Path | Contents |
|------|----------|
| `src/tools/` | One file per MCP tool. xmcp discovers them: each exports `schema` (zod), `metadata`, and a default handler. |
| `src/prompts/` | MCP prompts (workflow templates such as `infrastructure-tester`). |
| `src/core/` | Shared plumbing: preflights, the response builder, analytics, the command runner, configuration. |
| `src/lib/<area>/` | Tool logic. Pure, testable logic lives in `*.logic.ts` with a matching `*.logic.test.ts`. |
| `src/lib/docker/` | Docker Engine API client (find, start, stop, exec, logs). |
| `src/lib/localstack/` | LocalStack HTTP clients and the container spec. |
| `src/cli/` | The `init` / `remove` setup wizard and the stdio entry point. |
| `src/tools-tests/` | Handler tests, one file per tool. They live outside `src/tools/` because xmcp registers every file there as a tool. |
| `tests/mcp/` | Playwright tests against the built server. |
| `tests/docker/` | Validation of the Docker image. |
| `docs/` | Topic docs. |

## Writing a tool

Follow the shape of an existing tool, for example `src/tools/localstack-aws-client.ts`:

1. Wrap the handler in `withToolAnalytics(<tool-name>, args, …)`. Add the tool to the field allowlist in
   `src/core/analytics.ts`, and list only fields that can never hold secrets or user data. Some existing entries
   break this (see [Known deviations](#known-deviations)); do not copy them.
2. Run preflights first (`runPreflights([requireAuthToken(), requireLocalStackRunning(), …])`).
3. Return every result through `ResponseBuilder` (`markdown`, `error`, …).
4. Put parsing, validation and decision logic in `src/lib/<area>/*.logic.ts` and unit-test it there.
5. Never pass user input to a shell. Spawn binaries with argument arrays (`runCommand`), and sanitize CLI strings
   like `src/lib/aws/aws-cli-sanitizer.ts` does.
6. Test it as described in [Testing](#testing).
7. Update the tool and prerequisite tables in `README.md`.

## Testing

Test every tool at these levels; many do not have all of them yet (see [Known deviations](#known-deviations)). Write
the failing test first when fixing a bug in `src/`.

| Level | Where | Runs in CI | What it proves |
|-------|-------|------------|----------------|
| Logic | `src/lib/<area>/*.logic.test.ts` | always | Parsing, validation, rendering and sanitizing, as pure functions. |
| Handler | `src/tools-tests/<tool>.test.ts` | always | The tool's actions end to end inside the process, with Docker, LocalStack and spawned binaries mocked at the module boundary. |
| Tools | `tests/mcp/tools.spec.mjs` | every PR, with the auth token | Each tool over MCP stdio against a real emulator, without a model. |
| Server | `tests/mcp/direct.spec.mjs` | every PR, with the auth token | The built server: tool list, prompts, setup wizard. |
| Image | `tests/docker/validate-image.mjs` | `docker.yml`, with the auth token | Real calls through the Docker image. |

Rules for tool tests:

- **One handler test per action**, covering its success path and each error path. Errors come back through
  `ResponseBuilder.error` with `isError: true`; assert that, not just the text.
- **Test the gates.** Each preflight the tool runs gets a case: no auth token, LocalStack not running, lstk missing,
  feature not licensed. Keep `runPreflights` real and stub only the checks that reach Docker or the license API.
  A missing license or feature returns an `isError` response that names the feature and how to get it, and the
  test checks both.
- **Assert on what leaves the process**: the response (text, `isError`), the argument array passed to the spawned
  binary, and the HTTP method, path, query and body sent to LocalStack. Do not assert on internal calls.
- **Schema.** Invalid arguments are rejected by the zod schema; test a missing required field and a wrong enum
  value for each action that takes them.
- **Adversarial input.** For a tool that renders LocalStack or workload strings into markdown, add a case whose
  payload contains a code fence, a table pipe and an instruction-like line, and assert it cannot escape. For a tool
  that builds a command line, add cases that try shell chaining, option injection and path traversal.
- **No secrets in output.** Run the handler with a recognizable fake token and credentials, and assert they appear
  in neither the response, the error, nor the analytics payload.
- **Real-emulator coverage.** A new tool goes into `EXPECTED_TOOLS` in `tests/mcp/direct.spec.mjs` and in
  `tests/docker/validate-image.mjs`. A new action
  gets a case in `tests/mcp/tools.spec.mjs`; one that changes state checks its effect through another call, not
  just its success message, so a tool that skips its API call but reports success fails. Add a case to
  `tests/docker/validate-image.mjs` when the action depends on the image (bundled binaries, mounted paths).
- **Local by default.** No real AWS or Azure resources. A test that creates something on the LocalStack platform
  (a Cloud Pod) deletes it in a `finally` and uses a name unique to the run, as `tools.spec.mjs` does, or a fixed
  name only when a workflow `concurrency` group keeps runs from overlapping, as `mcp-evals.yml` does. Costly ones
  (ephemeral instances) stay opt-in (`HARNESS_RUN_EPHEMERAL`).
- **Missing secrets fail loudly.** A job that needs a secret fails with a message naming it when it is empty, as
  `ci.yml` does for fork PRs, so a fork PR never looks tested. A case may skip for a missing secret, credential
  or tool only when it belongs to an opt-in scenario (the replicator's source AWS keys, `HARNESS_RUN_REMOTE`), or
  when an outside service is down (the docs search), and the output says why.
- **Evals are not PR gates.** `test:mcp:evals` depends on a model. `mcp-evals.yml` runs it after merges to `main`
  that touch its path filter, weekly and on demand. Run them yourself when a tool's description, schema or
  response wording changes, and report the result in the PR.

## Dependencies

Every dependency version lives in exactly one file that Dependabot updates (`.github/dependabot.yml`), so CVE fixes
arrive as PRs instead of waiting for someone to notice, or is a hand-managed pin (below):

| What | Pinned in |
|------|-----------|
| Server dependencies | `package.json` + `yarn.lock` |
| CLIs in the image (aws-cdk, lstk) | `docker/tools/npm/package-lock.json` |
| Python CLIs in the image (SAM, Snowflake) | `docker/tools/<cli>/uv.lock` |
| Base images, Terraform, uv | `FROM` lines in `Dockerfile` |
| GitHub Actions | `uses:` in `.github/workflows/` and `.github/actions/*/action.yml` (each directory needs a Dependabot entry) |

- **No version outside these files.** No `npm install -g <pkg>`, `pip install <pkg>`, `curl … | sh`, `latest` tags
  (except the LocalStack emulator images, which track the newest release on purpose), or `npx <pkg>` for a package
  that is not in `package.json`, in the Dockerfile, workflows or scripts. A new tool gets a lockfile in one of the
  places above. Debian packages are the exception: they come unversioned from the base image's release, which its
  pinned `FROM` line fixes.
- **New ecosystem or directory, new Dependabot entry.** Copy the cooldown and grouping of the existing entries.
- **CI uses the image's versions.** Jobs that run tools on the host install them through
  `.github/actions/host-tools`, from the same files the image uses. `src/core/dependency-pins.test.ts` checks that
  the jobs running the tool tests or the evals use it, and that `ci.yml`, `docker.yml` and `mcp-evals.yml` run on
  the same pinned Ubuntu.
- **Hand-managed pins** (Node's major line, the runner's Ubuntu release, `zod` up to xmcp's copy,
  `@gleanwork/mcp-server-tester` while `patches/` patches it) carry their reason next to them (an `ignore` entry in
  `dependabot.yml`, or a comment), and `src/core/dependency-pins.test.ts` keeps the ones it can in sync.
- **Fix advisories by upgrading.** `audit-ci --high --skip-dev` gates CI. If no fixed version exists, an allowlist
  entry names the advisory, why it does not apply, and when to revisit it.
- **Actions pinned to a commit SHA**, with the version in a comment (`uses: actions/checkout@<sha> # v7`).
  Dependabot updates both.

## Docker image size

Every user of the image downloads it, often in CI on every run, so its size is part of the startup time. Keep it
small, and treat growth as a decision for the user, not a side effect.

- **Ask before a larger change.** Before adding anything that grows the image by more than about 50 MB
  (uncompressed, per platform) or brings in a new runtime, toolchain or base image (a JVM, a second Python, a cloud
  CLI, a browser), stop and ask the user. Name what it is for, which tools and actions need it, its size on amd64
  and arm64, and the alternatives: leaving it to host mode with a clear error in the image, a separate image
  variant, or a lighter tool. Record the approval in the PR.
- **Measure every image change.** A PR that touches `Dockerfile`, `docker/` or `.dockerignore`, or adds a runtime
  dependency, reports the image size before and after for both platforms (`docker image inspect -f
  '{{.Size}}'`; `docker history` for the layer that grew).
- **Keep the runtime stage lean.**
  - Start from a `-slim` base and build in earlier stages; copy only the artifacts into the runtime stage, never
    compilers, build caches or dev dependencies.
  - Install system packages with `--no-install-recommends`, and remove package lists and caches in the same `RUN`
    that creates them; a later `RUN rm` does not shrink the image.
  - Install production dependencies only (`--omit=dev`), clean the npm and yarn caches, and prune test directories
    from Python environments, as the existing stages do.
  - Use `RUN --mount` (bind, cache) for files only the build needs.
  - Keep `.dockerignore` excluding everything the image does not need.
- **Do not trade correctness for size.** Removing something a tool calls breaks it only in the image. Run
  `tests/docker/validate-image.mjs` after any change that removes files.

## Design rules

### 1. Work with lstk, never with the legacy CLI

[lstk](https://github.com/localstack/lstk) ([docs](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/))
is the LocalStack CLI. Do not call, document or recommend the legacy `localstack` CLI
([legacy docs](https://docs.localstack.cloud/aws/developer-tools/running-localstack/localstack-cli/)): no
`localstack start`, `localstack extensions`, `localstack pod`, and no hints that tell users to install it.

The MCP server keeps its own lifecycle code: it starts and stops the emulator through the Docker API, so it works
without lstk. That container must be interchangeable with one lstk starts:

- **Converge on lstk's container.** The reference is lstk's `internal/config/containers.go`, `internal/container/`
  and `internal/runtime/docker.go`. The server's container still differs from it in several ways (name, labels,
  volume directory, ports, environment; see [Known deviations](#known-deviations), which lists the differences known
  so far, not all of them). A change to the container spec must not add a difference: compare it with lstk's and
  move toward it. When lstk changes, follow.
- **Either tool can take over.** `lstk stop` / `status` / `logs` / `restart` work on an emulator the MCP server
  started, and the MCP server's `stop` / `status` work on one lstk started. Today this holds only through fallbacks:
  the server detects `localstack-aws` by name, and lstk, finding no container under its own name, matches a running
  LocalStack image that serves the gateway on lstk's default container port. That interoperability is a known gap.
  Do not widen the difference: keep both names detected, keep LocalStack's own images, and keep the gateway on that
  port.
- **Same emulator.** An lstk command the server runs must reach the emulator the server's other tools use
  (`LOCALSTACK_HOSTNAME` / `LOCALSTACK_PORT`). How the server passes that target is an open question: ask the user
  before wiring a new lstk call (see [Open questions](#open-questions)).

### 2. Use lstk's cloud and IaC commands

lstk wraps the cloud CLIs and IaC tools
([docs](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/cloud-and-iac-commands/)):
`lstk aws`, `lstk az`, `lstk terraform`, `lstk cdk`, `lstk sam`. Use them, not `awslocal`, `tflocal`, `cdklocal`,
`samlocal`, or a hand-configured `az`.

- **lstk is required.** There is no fallback to the dedicated wrappers. When lstk is missing, the tool says so and
  shows how to install it (as the deployer does with `LSTK_INSTALL_MESSAGE` in `src/lib/deployment/`). It never
  recommends the legacy CLI.
- **Say what ran.** The tool response names the command that ran (`lstk aws …`), so a user can reproduce it.
- **Keep the guards.** Moving a tool to lstk does not remove its safety checks: the AWS CLI sanitizer, and the Azure
  tool's profile isolation, egress guard and command policy (`src/lib/azure/`).
- **Docker image.** The image must bundle lstk and everything its commands call (the AWS CLI, Terraform, CDK, SAM, and
  the Azure CLI once the Azure tool moves).
- **Snowflake is exempt.** The Snowflake tool uses the `snow` CLI until lstk wraps it.

### 3. Prefer LocalStack APIs over parsing logs

Get data from LocalStack's
[internal endpoints](https://docs.localstack.cloud/aws/customization/networking/internal-endpoints/) (`/_localstack/*`,
`/_aws/*`). The emulator publishes their OpenAPI spec at `/_localstack/swagger`. Log text is not an interface: its
format changes without notice, lines rotate out of the window, and regexes miss cases.

- **Structured answers come from an API.** Which calls failed, which IAM checks denied a request, which services ran:
  read these from an endpoint, for example App Inspector traces, spans and IAM events (`/_localstack/appinspector`).
- **No API, no feature.** If no endpoint exposes the data, ask for one in LocalStack rather than adding a log parser.
  A tool may explain how to enable the feature that provides the data (for example App Inspector), but must not fall
  back to logs.
- **Logs are for showing logs.** `localstack-logs-analysis` returns raw or filtered log lines (startup failures, stack
  traces) and must not classify them into services, operations, status codes or IAM denials (it still does; see
  [Known deviations](#known-deviations)).

### 4. Use only public interfaces

This repository is public. Do not reference code from private LocalStack repositories:

- no Python module paths (`localstack.pro.*`), private file paths, or class names in code, comments or docs
- no undocumented endpoints, and no scripts executed inside the LocalStack container to reach internals
- no undocumented configuration variables

Allowed: documented endpoints, documented configuration variables (for example `EXTENSION_AUTO_INSTALL`), the
public LocalStack Platform API, and public repositories such as lstk. An endpoint is documented when it is in the
public docs or in one of the OpenAPI specs a running emulator serves:

- `/_localstack/swagger` for the core and platform endpoints (`/_localstack/*`, `/_aws/*`)
- `/_localstack/appinspector/v1/openapi.yaml` (browsable at `/_localstack/appinspector/v1/swagger`) for App
  Inspector

Ask the user before adopting an API this server does not use yet, even a documented one, and name the endpoint and
what the tool would do with it. The IAM design below
would add the event policy route and the IAM policy summary; adopting them still needs a maintainer's approval,
recorded in the PR that adds them.

Exception: an endpoint listed under [Gaps in LocalStack](#gaps-in-localstack) may be used before it is documented.
Each such endpoint is one LocalStack's own clients (the web app, App Inspector) already depend on. Describe its
request and response in this repository's code (types and tests); do not link to or quote its implementation.

### 5. Compute in LocalStack, render in the MCP server

The MCP server is a client of LocalStack, next to the App Inspector UI and the coding agents that read its output.
If two clients could compute the same answer differently, the answer belongs in LocalStack.

- **LocalStack decides:** which policy denied a request, which policy to change and how, whether a change fixes the
  request, which resource holds a resource-based policy.
- **The MCP server presents:** it fetches, filters, formats and explains. It may choose wording and structure for the
  agent, but it does not parse policy documents, match actions or resources, or synthesize policies.
- **Missing data:** if LocalStack does not return what a tool needs, request a field in LocalStack. A tool may say
  the answer is unavailable on an older emulator, but must not compute it itself as a fallback.
- **Exceptions for a better experience:** when computing something in the client would clearly improve what the agent
  or user gets, and LocalStack cannot offer it yet, it may be done as a documented exception, but only with the
  user's explicit approval. This is not a default way out of the rule: first propose the LocalStack change, then
  ask the user, naming the computation, what it improves, and what it would take in LocalStack. Never assume
  approval. An approved exception gets a row in [Known deviations](#known-deviations) (under [Follow-ups](#follow-ups)
  while its code is not on `main`), saying who approved it and
  when, and a [Gaps in LocalStack](#gaps-in-localstack) row for the API that would replace it; delete both once
  that API ships. Exceptions never cover decisions about IAM (which policy denied, what fixes it), and never read logs
  (rule 3).

## Features

### IAM policies (`localstack-app-inspector`)

Today `localstack-iam-policy-analyzer` handles IAM by parsing logs and synthesizing policies (known deviations),
with its `set-mode` and `get-status` actions for the enforcement mode. IAM moves to `localstack-app-inspector`. None
of the actions below exist yet; this is the design they are built to. `localstack-app-inspector` already lists a
span's raw IAM events (`list-iam-events`, `get-event`); `list-iam-denials` and `explain-iam` are to replace those for IAM. Once its actions ship, the analyzer is
deprecated: its behaviour stays unchanged until it is removed, but its description and every response name the
app-inspector action that replaces it.

The IAM actions have three jobs. Each reads a LocalStack API; without the feature behind it, the response explains
what is missing instead of returning an empty answer.

1. **Why was a request denied, and what fixes it.** `list-iam-denials`, `explain-iam`, `get-iam-policy`. Source:
   App Inspector IAM events (`/_localstack/appinspector/v1/traces/{t}/spans/{s}/events/iam`), which include denials
   that were recorded but not enforced. An event's payload holds LocalStack's decisions (which policies allowed or
   denied the request, and at which statements), the policies involved, and for a denial a versioned suggestion of
   what to change and whether that fixes the request. `explain-iam` is to render, in this order: the request and its
   result, the deciding policies, the suggested fix, then the payload as sent. Do not recompute, merge or reorder the changes.
   A policy the event stored truncated is fetched on demand with `get-iam-policy` (the event policy route), never
   automatically.
   - Without the `localstack.appinspector/view_iam_policy_errors` entitlement, LocalStack hides IAM events and
     returns an empty list. Spans say so (`iam_errors_suppressed`) and the policy route answers 403
     `not_entitled`, but the event lists don't, so an empty IAM result reads one span of the scope and reports
     suppression, or else the IAM mode. `/_localstack/licenseinfo` cannot tell: it lists plugins, not
     entitlements.
   - A denial without a suggestion comes from an older LocalStack: say so and suggest upgrading. A suggestion
     version the server does not know is shown as JSON only.
2. **Which policies does the workload need.** `get-iam-policy-summary`, `reset-iam-policy-summary`. Source: the IAM
   policy summary (`GET`/`DELETE /_aws/iam/policies/summary`; a 404 means the feature is not licensed or not
   enabled). It is global to the emulator: there is no per-trace summary
   (see [Gaps in LocalStack](#gaps-in-localstack)). Each entry is one policy for one ARN: `resource`,
   `policy_type` (`identity` or `resource`) and `policy_document`. Present it the way App Inspector's Policies view
   does:
   - one entry per ARN, with its type; LocalStack does not send a display name, services or action count yet (see
     [Gaps in LocalStack](#gaps-in-localstack)); do not derive them from the ARN or the policy
   - the policy JSON exactly as sent: a role's trust statement and its permissions stay in one policy
   - always labelled as a suggestion, derived from the requests seen since the last reset, not as a verified policy
3. **How do the deployed policies differ from what the workload needs.** For each ARN in the summary: the
   permissions to add, and the granted permissions the run never used. This compares policy documents, so
   LocalStack computes it (rule 5). LocalStack does not offer it yet (see [Gaps in LocalStack](#gaps-in-localstack)),
   so the tool does not either.

The enforcement mode is to get separate actions (`get-iam-mode`, `set-iam-mode`, through `/_aws/iam/config`). Enforcement
is not needed to record denials. With App Inspector enabled and enforcement off, `/_aws/iam/config` reports
`ENGINE_ONLY` (a documented state), App Inspector records denials without blocking them, and the
policy summary grows, but nothing is blocked. `ENFORCED` only makes denials fail the
request; `SOFT_MODE` keeps them passing. Never tell a user to switch on enforcement just to see denials, since
`ENFORCED` can break a workload that worked.

Render every payload string escaped (REVIEW §7): an ARN, a resource name or an error message must not be able to
close a code fence, break a table, or read as an instruction.

An agentic evaluation of these actions is a follow-up (see [Follow-ups](#follow-ups)).

## Gaps in LocalStack

Things this server needs from LocalStack that are missing or undocumented. Request them in LocalStack, and remove a
row once it ships.

| Need | Status | Used by |
|------|--------|---------|
| Document the extensions API (`GET /_localstack/extensions/list`, `POST …/install`, `POST …/uninstall`) in the OpenAPI spec and the docs | The LocalStack web app's Extension Manager depends on it; neither the spec nor the docs name it. lstk has no commands for LocalStack extensions. | `localstack-extensions` (allowed under the rule 4 exception) |
| Document the IAM evaluation event payload (the `payload` attribute of App Inspector's IAM events: the decisions, the `policies` map and the `suggestion`) in the App Inspector spec | The spec types the attribute as a string; its fields are not documented anywhere public. The App Inspector UI depends on them. Until they are documented, describe them in this repository's code as types and tests written from observed responses, not from LocalStack's code; this file names them only as far as the design needs. | `explain-iam`, planned (allowed under the rule 4 exception) |
| Document the IAM policy summary and stream (`GET`/`DELETE /_aws/iam/policies/summary`, `GET /_aws/iam/policies/stream`) | App Inspector's Policies view and the web app's IAM Policy Stream depend on them; the spec documents only `/_aws/iam/config` and `/_aws/iam/check-actions-allowed`. | `localstack-app-inspector` IAM job 2, planned (allowed under the rule 4 exception) |
| Filter the IAM policy summary by trace (or time range), so a run's policies don't mix with earlier requests | Not implemented: the summary is global and only resettable. | `get-iam-policy-summary` (planned) |
| Say on the App Inspector events page when IAM events are hidden by the license (as spans do with `iam_errors_suppressed`) | Not implemented: the events routes return an empty list, so a tool has to probe one span. | `list-iam-denials`, `explain-iam` (planned) |
| Compare suggested policies with deployed ones: permissions to add and permissions granted but unused, per ARN | Not implemented. | IAM job 3 |
| Document App Inspector's status route (`GET`/`PUT /_localstack/appinspector/status`) in its OpenAPI spec | Not in `/_localstack/appinspector/v1/openapi.yaml`. lstk's `inspect` command uses it too. | `get-status`, `set-status` (allowed under the rule 4 exception) |
| Presentation fields for IAM: a display name, the services and the action count per policy summary entry; the principal kind (ARN, service, account) on suggestion hints; the statements a decision names, resolved | Not implemented. Until it ships, show the ARN, the type and the policy JSON, name statement positions without resolving them, and word hints for any kind of caller. | `explain-iam`, `get-iam-policy-summary` (planned) |
| Document `GET /_localstack/licenseinfo`, or name the documented way to tell whether a licensed feature is available | In none of the emulator's specs and not in the docs. Whether a LocalStack client depends on it is unverified: lstk and the App Inspector UI don't. | `requireProFeature` in every Pro tool. The rule 4 exception does not cover it, since no LocalStack client is known to depend on it; see [Known deviations](#known-deviations). |
| A failed-requests summary in App Inspector: failed spans grouped by service, operation, HTTP status and AWS error code, with counts, first and last time, and an example trace and span | Not implemented. | `lstk mcp`'s `localstack-app-inspector` `failed-requests`, planned (an approved exception, see [Follow-ups](#follow-ups)) |

## Known deviations

Code on `main` (of the repository that holds it) that does not follow the rules: deviations that predate them, and
exceptions a maintainer approved. A row is never a way to let unapproved code through.

- **New code follows the rules.** A change that needs to break one raises it with the user before it is written.
  If a maintainer approves, the PR records the approval and adds a row naming who approved it and when.
- **A change that touches a listed deviation raises it.** Say in the PR whether the change fixes the deviation,
  leaves it as it is, or why it cannot fix it yet. Do not copy the pattern and do not extend it to another tool.
- **Remove a row when the code is fixed.**

An approved exception stays until what replaces it ships. One approved for code not on `main` yet is recorded
under [Follow-ups](#follow-ups) until it lands.

| Where | Deviation | Target |
|-------|-----------|--------|
| `src/lib/localstack/container-spec.logic.ts`, `src/lib/docker/docker.client.ts` | The header comment describes the container as replicating the legacy `localstack start` (rule 1). The container spec differs from lstk's in several ways, among them the name (`localstack-main` for every emulator), labels, volume directory, ports and environment, so emulator state does not carry over and only AWS containers are found in both directions. Compare with lstk's `internal/config/containers.go` and `internal/container/start.go` for the current differences. Interoperability rests on the server detecting lstk's AWS container name and on lstk's fallback, which matches a known LocalStack image serving the gateway on lstk's default container port; it breaks for other images, a gateway moved off that port inside the container, and the other emulators. | Converge on lstk's container spec; decide later whether to adopt its names. Until then, keep lstk's AWS name detected (rule 1). |
| `src/tools/localstack-aws-client.ts` | Runs `awslocal` inside the container via `docker exec`. | `lstk aws`, no fallback (rule 2). |
| `src/tools/localstack-deployer.ts`, `src/prompts/infrastructure-tester.ts` | The deployer runs `awslocal cloudformation` through `docker exec` for CloudFormation deploys and deletes, and the prompt tells the agent to use `awslocal`. | `lstk aws cloudformation` (rule 2); the prompt names lstk. |
| `src/tools/` | Many tools skip parts of "Writing a tool": hand-built `❌` responses instead of `ResponseBuilder` (`withToolAnalytics` flags them as errors only by their prefix), handlers without `runPreflights`, and parsing (such as ARN splitting) in the tool file instead of a `*.logic.ts` module (rule 5). | Follow "Writing a tool". |
| `src/core/localstack-env.ts` | Passes the server's target to `lstk terraform` / `cdk` / `sam` as `AWS_ENDPOINT_URL`, but keeps an `AWS_ENDPOINT_URL` already in the user's environment, and a `LSTK_ENDPOINT_URL` there overrides both: either sends the command to a different emulator. | Depends on the [open question](#open-questions) on passing the target to lstk. |
| `src/tools/localstack-azure-client.ts` | Configures the host `az` itself. | `lstk az`, keeping the existing guards (rule 2). |
| `Dockerfile` | Bundles lstk, Terraform, CDK and SAM, but not the AWS CLI. | Bundle the AWS CLI for `lstk aws` (rule 2). This is a larger image change: ask the user first ("Docker image size"). |
| `src/core/analytics.ts` | Sends data that can hold secrets (REVIEW §0): free-form arguments such as the cloud CLIs' `command` (for example `--secret-string …`), and error text. `looksSensitiveValue` only catches a value that is a whole key or token. The allowlist also sends arguments that hold user data: names, paths, queries and filters. | Only fields that can never hold secrets or user data ("Writing a tool"): for example the command's service and operation instead of the command, an error code instead of the message. |
| `.github/workflows/*.yml` | Actions are pinned to version tags, not commit SHAs. | SHA pins with a version comment ("Dependencies"). |
| `.github/workflows/ci.yml`, `docker.yml` | No `permissions:` block, so jobs get the repository's default token permissions. | `permissions: contents: read` at the top, widened per job only where needed (REVIEW §0). |
| `src/tools/localstack-iam-policy-analyzer.ts` | Finds IAM denials by parsing container logs (rule 3). | The IAM actions of `localstack-app-inspector` ("IAM policies"); then deprecate the analyzer and remove it after a notice period. |
| `.github/workflows/azure-smoke.yml`, `ci.yml` (`mcp-direct-tests`), `tests/mcp/azure-offline.spec.mjs` | `azure-smoke.yml` runs on `ubuntu-latest`; it and `mcp-direct-tests` use the runner image's Azure CLI, whose version no file here pins. `azure-offline` skips its cases when `az` is missing, a skip "Testing" does not allow. | The pinned Ubuntu of the other workflows, and the Azure CLI from a pinned file, as `host-tools` does for Terraform, uv and lstk. |
| `.github/workflows/` | Secrets reach third-party code in CI (REVIEW §0): jobs set `LOCALSTACK_AUTH_TOKEN` (and, in `mcp-evals.yml`, the OpenRouter key) at job level, so `yarn install` runs dependency install scripts and third-party actions run with them; `docker.yml` runs `npm ci` for `data/sample-cdk`, with install scripts, in a step that holds the token; and `actions/checkout` leaves the GitHub token in `.git/config` for later steps. | Install dependencies with no secret in the environment (or with `--ignore-scripts`), set secrets only on the steps that need them, and check out with `persist-credentials: false`. |
| `src/tools/`, `src/lib/` | Most tools render LocalStack and workload strings (names, outputs, log lines, error text) into markdown tables, text and fixed code fences unescaped (REVIEW §7). `list-iam-events` answers "No events found." when the license hides IAM events, instead of explaining it ("IAM policies"). | Escape them, and size code fences to their content (REVIEW §7); explain hidden IAM events. |
| `.github/workflows/ci.yml` | `audit-ci --skip-dev` skips the devDependencies that are bundled into `dist/` and run in production, and nothing audits the `docker/tools/` lockfiles. | Audit what ships: the bundled packages and the image's lockfiles. |
| `.github/workflows/docker.yml` | Its path filter misses files the image build reads (`patches/`, `xmcp.config.ts`, `tsconfig*.json`), so a change to them is not built or tested as an image. | Filter on everything the `Dockerfile` copies. |
| `src/lib/localstack/license-checker.ts` | Calls `GET /_localstack/licenseinfo`, which is not documented and not covered by the rule 4 exception. | The documented way LocalStack names (see [Gaps in LocalStack](#gaps-in-localstack)). |
| `data/sample-terraform/` | The AWS provider has only a version constraint, no lockfile, and no Dependabot entry; CI downloads it with secrets in the job's environment. | A committed `.terraform.lock.hcl` and a `terraform` Dependabot entry ("Dependencies"). |
| `playwright.config.mjs`, `src/tools/localstack-snowflake-client.ts`, `src/core/localstack-env.ts` | Child processes inherit the whole environment (REVIEW §0): the server under test gets the eval's model keys, and the `snow` CLI and `lstk terraform` / `cdk` / `sam` get every variable of the server's environment. | Pass each child only the variables it needs. |
| `Dockerfile` | The `# syntax=` line floats to the newest frontend of its major version. | Pin the frontend version where Dependabot can update it. |
| `src/tools-tests/`, `src/lib/**/*.logic.test.ts` | Most tools have no handler test. The existing handler tests stub `withToolAnalytics` or mock internal modules and assert on their calls, and some `*.logic.test.ts` files test tool handlers instead of a `*.logic.ts` module. | Handler tests for every tool, following "Testing", with tool handler tests in `src/tools-tests/`. A ratchet test that lists the tools still without one would replace this row (see "Maintaining this file"). |
| `src/lib/iam/iam-policy.logic.ts` | Synthesizes IAM policies from denials, for the analyzer (rule 5). | Remove with the analyzer; the IAM actions present LocalStack's suggestions and summary instead. |
| `src/lib/logs/log-retriever.ts`, `src/tools/localstack-logs-analysis.ts` | Regex-classifies log lines (service, operation, status, IAM), which the logs tool's `summary`, `errors` and `requests` modes present. | Raw and filtered lines only (rule 3); App Inspector for failed requests. |
| `src/lib/localstack/extensions.logic.ts` | Runs a private Python module inside the container (the same one the legacy CLI runs), and names that private module and the container's internal paths in public code (rule 4). | The extensions HTTP API: `GET /_localstack/extensions/list`, `POST …/install`, `POST …/uninstall` (newline-delimited JSON progress events; LocalStack restarts itself afterwards). See [Gaps in LocalStack](#gaps-in-localstack). |
| `README.md`, `docs/` | Describe the analyzer's log search and policy generation, the aws-client's `awslocal`, and the logs tool's classification as features, and refer to the legacy "LocalStack CLI" for the volume path. | Update with the code; name lstk (rule 1). |

## Open questions

Decisions not settled yet. Ask the user before acting on one, and move the answer into the rules once it is made.

- **How the server passes its target to lstk (rule 1).** The proposal: pass it as `LSTK_ENDPOINT_URL`, which lstk
  prefers over `AWS_ENDPOINT_URL` (so a value in the user's environment does not win), to the commands that accept
  an endpoint, and to none of the commands lstk's `rejectEndpointURL` (`cmd/endpoint.go`) refuses one for. Today
  the deployer passes `AWS_ENDPOINT_URL` (`src/core/localstack-env.ts`). Open:
  - Is this the intended contract?
  - If the server runs a command lstk refuses an endpoint for, must it also remove the endpoint variables it
    inherited from the user's shell?

## Follow-ups

Planned work that is not on `main` yet. Ask the user before starting one.

- **Agentic evaluation of the IAM actions.** A coding agent (Claude Code headless) fixes common IAM failures in small
  projects using only this server, graded by deterministic checks, on demand and weekly. Before it lands it must
  meet REVIEW §0 and "Dependencies": the agent and the scripts it runs get no secrets, the MCP config holding the
  auth token is private and deleted after the run, the agent can read and edit only its project and cannot change
  the scripts it may run, results are redacted and checked before upload, workflow inputs go through `env:`, and
  Claude Code is pinned in a lockfile Dependabot updates.
- **`lstk mcp`'s `failed-requests` action (lstk, unreleased).** It groups App Inspector's failed spans
  (`status_code=2`) by service, operation, HTTP status and AWS error code, with counts, first and last time and the
  latest example. That computation is an approved exception to rule 5: approved by the
  project maintainer on 2026-11-17, because it replaces the log-based error summary of `localstack-logs-analysis`
  with one from App Inspector's data. It is recorded here because the code is not on lstk's `main` yet; when it
  lands, it moves to [Known deviations](#known-deviations). It goes away once the failed-requests summary in
  [Gaps in LocalStack](#gaps-in-localstack) ships.

## Maintaining this file

Write what stays true while features land, so this file changes with decisions, not with every PR.

- **No inventories.** No counts ("2 of 15"), version numbers, line numbers, port numbers, or lists of files, fields
  or routes that grow with the code. State the rule and point to where the current answer lives: a file, a
  command, or the upstream source to compare with.
- **Let code hold the lists.** A rule the code can check belongs in a test, not here. For existing code that does
  not follow it yet, the test keeps an allowlist that only shrinks: it fails when new code breaks the rule and
  when a listed entry no longer needs to be listed. This file then names the test instead of the entries, as
  `src/core/dependency-pins.test.ts` does for dependency versions.
- **Deviations by pattern.** A row in [Known deviations](#known-deviations) names the pattern, where it lives and
  the target, not every instance.
- **Name a file only when it defines the convention** (`container-spec.logic.ts` for the container,
  `response-builder.ts` for responses).
