# AGENTS.md

The LocalStack MCP server lets an MCP client (Claude Code, Cursor, VS Code, …) start LocalStack, deploy
infrastructure, run cloud CLIs, and inspect the emulator. It is a TypeScript server built on
[xmcp](https://xmcp.dev), published to npm as `@localstack/localstack-mcp-server` and as the Docker image
`localstack/localstack-mcp-server`.

Read [REVIEW.md](REVIEW.md) before opening a PR. It turns the rules below into review checks.

## Commands

```bash
yarn install
yarn build              # xmcp build + esbuild CLI bundle → dist/
yarn dev                # xmcp dev server
yarn test               # Jest unit tests (*.test.ts next to the code)
yarn test:mcp:direct    # Playwright: calls the built server's tools directly (needs Docker + LOCALSTACK_AUTH_TOKEN)
yarn test:mcp:evals     # Playwright: LLM evals against the tools (needs a Gemini key)
yarn format             # Prettier
```

## Layout

| Path | Contents |
|------|----------|
| `src/tools/` | One file per MCP tool. xmcp discovers them: each exports `schema` (zod), `metadata`, and a default handler. |
| `src/prompts/` | MCP prompts (workflow templates such as `infrastructure-tester`). |
| `src/core/` | Shared plumbing: `preflight.ts`, `response-builder.ts`, `analytics.ts`, `command-runner.ts`, `config.ts`, `http-client.ts`. |
| `src/lib/<area>/` | Tool logic. Pure, testable logic lives in `*.logic.ts` with a matching `*.logic.test.ts`. |
| `src/lib/docker/` | Docker Engine API client (find, start, stop, exec, logs). |
| `src/lib/localstack/` | LocalStack HTTP clients and the container spec. |
| `src/cli/` | The `init` / `remove` setup wizard and the stdio entry point. |
| `tests/mcp/` | Playwright tests against the built server. |
| `tests/docker/` | Validation of the Docker image. |
| `docs/` | Topic docs (`AZURE.md`, `DOCKER.md`). |

## Writing a tool

Follow the shape of an existing tool, for example `src/tools/localstack-aws-client.ts`:

1. Wrap the handler in `withToolAnalytics(<tool-name>, args, …)`. Add the tool to the field allowlist in
   `src/core/analytics.ts`, and list only fields that can never hold secrets or user data.
2. Run preflights first (`runPreflights([requireAuthToken(), requireLocalStackRunning(), …])`).
3. Return every result through `ResponseBuilder` (`markdown`, `error`, …).
4. Put parsing, validation and decision logic in `src/lib/<area>/*.logic.ts` and unit-test it there.
5. Never pass user input to a shell. Spawn binaries with argument arrays (`runCommand`), and sanitize CLI strings
   like `src/lib/aws/aws-cli-sanitizer.ts` does.
6. Update the tool and prerequisite tables in `README.md`.

## Design rules

### 1. Work with lstk, never with the legacy CLI

[lstk](https://github.com/localstack/lstk) ([docs](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/))
is the LocalStack CLI. Do not call, document or recommend the legacy `localstack` CLI
([legacy docs](https://docs.localstack.cloud/aws/developer-tools/running-localstack/localstack-cli/)): no
`localstack start`, `localstack extensions`, `localstack pod`, and no hints that tell users to install it.

The MCP server keeps its own lifecycle code: it starts and stops the emulator through the Docker API, so it works
without lstk. That container must be interchangeable with one lstk starts:

- **Same container.** Container name, image, ports, labels, volume layout and auth env match what lstk creates.
  The reference is lstk's `internal/config/containers.go` and `internal/container/`. When lstk changes them, follow.
- **Either tool can take over.** `lstk stop` / `lstk status` work on an emulator the MCP server started, and the MCP
  server's `stop` / `status` work on one lstk started. Find the container the way lstk marks it (name and labels),
  not by a name only this server uses.
- **Same endpoint.** When the MCP server calls lstk, it passes its own target (`LOCALSTACK_HOSTNAME` /
  `LOCALSTACK_PORT`) as `LSTK_ENDPOINT_URL`, so both talk to the same emulator.

### 2. Prefer lstk's cloud and IaC commands over dedicated wrappers

lstk wraps the cloud CLIs and IaC tools
([docs](https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/cloud-and-iac-commands/)):
`lstk aws`, `lstk az`, `lstk terraform`, `lstk cdk`, `lstk sam`. Use them instead of `awslocal`, `tflocal`,
`cdklocal`, `samlocal`, or a hand-configured `az`.

- **lstk first, legacy fallback.** When `lstk` is on `PATH`, use it. Otherwise fall back to the dedicated wrapper,
  so a setup without lstk keeps working. Resolve this in one shared helper, not per tool.
- **Say which path ran.** The tool response names the command that ran (`lstk aws …` or `awslocal …`), so a user
  can reproduce it.
- **Hint toward lstk.** When the fallback runs, or no runner is found, the message recommends installing lstk. It
  never recommends the legacy CLI.
- **Keep the guards.** Moving a tool to lstk does not remove its safety checks: the AWS CLI sanitizer, and the Azure
  tool's profile isolation, egress guard and command policy (`src/lib/azure/`).
- **Docker image.** The image bundles lstk and the AWS CLI, so the lstk path also runs there.
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
  traces). It does not classify lines into services, operations, status codes or IAM denials.

### 4. Use only public interfaces

This repository is public. Do not reference code from private LocalStack repositories:

- no Python module paths (`localstack.pro.*`), private file paths, or class names in code, comments or docs
- no undocumented endpoints, and no scripts executed inside the LocalStack container to reach internals
- no undocumented configuration variables

Allowed: documented endpoints (in the OpenAPI spec or the docs), documented configuration variables (for example
`EXTENSION_AUTO_INSTALL`), the public LocalStack Platform API, and public repositories such as lstk.

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
  approval. An approved exception gets a row in [Approved exceptions](#approved-exceptions) and a
  [Gaps in LocalStack](#gaps-in-localstack) row for the API that would replace it; delete both once that API
  ships. Exceptions never cover decisions about IAM (which policy denied, what fixes it), and never read logs
  (rule 3).

## Features

### IAM policies (`localstack-app-inspector`)

`localstack-app-inspector` owns IAM. `localstack-iam-policy-analyzer` is deprecated: its behaviour is unchanged
until it is removed, but its description and every response name the app-inspector action that replaces it.

The IAM actions have three jobs. Each reads a LocalStack API; without the feature behind it, the response explains
what is missing instead of returning an empty answer.

1. **Why was a request denied, and what fixes it.** `list-iam-denials`, `explain-iam`, `get-iam-policy`. Source:
   App Inspector IAM events (`/_localstack/appinspector/v1/traces/{t}/spans/{s}/events/iam`, `iam.policy.denied` for
   denials, also in soft mode with `enforcement: allow_with_warning`). The event's `payload` attribute is a JSON
   string holding the decisions (`explicit_allows`, `explicit_denies`, `implicit_denies`, each with `caused_by`
   policy keys and statement positions), the `policies` map, and for a denial LocalStack's `suggestion` (version 1:
   `outcome`, `entries`, `hints`, `near_misses`). `explain-iam` renders them in the section order of the App
   Inspector UI's "Copy agent prompt", then the payload as sent. Do not recompute, merge or reorder the changes.
   A policy stored truncated (`statement_count` without `document`) is fetched on demand with `get-iam-policy`
   (`/v1/events/{event_id}/policies/{key}`), never automatically.
   - Without the `localstack.appinspector/view_iam_policy_errors` entitlement, LocalStack hides IAM events and
     returns an empty list. Only spans say so (`iam_errors_suppressed`), so an empty IAM result reads one span of
     the scope and reports suppression, or else the IAM mode. `/_localstack/licenseinfo` cannot tell: it lists
     plugins, not entitlements.
   - A denial without `suggestion` comes from an older LocalStack: say so and suggest upgrading. A suggestion
     `version` other than 1 is shown as JSON only.
2. **Which policies does the workload need.** `get-iam-policy-summary`, `reset-iam-policy-summary`. Source: the IAM
   policy summary (`GET`/`DELETE /_aws/iam/policies/summary`, feature `localstack.platform.plugin/iam-stream`; a 404
   means the feature is not licensed or not enabled). It is global to the emulator: there is no per-trace summary
   (see [Gaps in LocalStack](#gaps-in-localstack)). Each entry is one policy for one ARN: `resource`,
   `policy_type` (`identity` or `resource`) and `policy_document`. Present it the way App Inspector's Policies view
   does ([localstack-appinspector-ui#341](https://github.com/localstack/localstack-appinspector-ui/pull/341)):
   - one entry per ARN, with its name (the ARN's last part), its type, its services and its number of actions
   - the policy JSON exactly as sent: a role's trust statement and its permissions stay in one policy
   - always labelled as a suggestion, derived from the requests seen since the last reset, not as a verified policy
3. **How do the deployed policies differ from what the workload needs.** For each ARN in the summary: the
   permissions to add, and the granted permissions the run never used. This compares policy documents, so
   LocalStack computes it (rule 5). LocalStack does not offer it yet (see [Gaps in LocalStack](#gaps-in-localstack)),
   so the tool does not either.

The enforcement mode (`get-iam-mode`, `set-iam-mode`, through `/_aws/iam/config`) is a separate action. Denials and
the policy summary are only recorded while the mode is `ENFORCED` or `SOFT_MODE`.

The agentic evaluation in `evals/agentic/` checks that a coding agent fixes common IAM failures with these actions.

## Gaps in LocalStack

Things this server needs from LocalStack that are missing or undocumented. Request them in LocalStack, and remove a
row once it ships.

| Need | Status | Used by |
|------|--------|---------|
| Document the extensions API (`GET /_localstack/extensions/list`, `POST …/install`, `POST …/uninstall`) in the OpenAPI spec and the docs | The LocalStack web app's Extension Manager depends on it; neither the spec nor the docs name it. lstk has no extensions commands. | `localstack-extensions` (allowed under the rule 4 exception) |
| Document the IAM policy summary and stream (`GET`/`DELETE /_aws/iam/policies/summary`, `GET /_aws/iam/policies/stream`) | App Inspector's Policies view and the web app's IAM Policy Stream depend on them; the spec documents only `/_aws/iam/config` and `/_aws/iam/check-actions-allowed`. | `localstack-app-inspector` IAM job 2 (allowed under the rule 4 exception) |
| Filter the IAM policy summary by trace (or time range), so a run's policies don't mix with earlier requests | Not implemented: the summary is global and only resettable. | `get-iam-policy-summary` |
| Say on the App Inspector events page when IAM events are hidden by the license (as spans do with `iam_errors_suppressed`) | Not implemented: the events routes return an empty list. The tool probes one span instead. | `list-iam-denials`, `explain-iam` |
| Compare suggested policies with deployed ones: permissions to add and permissions granted but unused, per ARN | Not implemented. Listed as a follow-up in localstack-appinspector-ui#341. | IAM job 3 |
| A failed-requests summary in App Inspector: failed spans grouped by service, operation, HTTP status and AWS error code, with counts, first and last time, and an example trace and span | Not implemented. | `lstk mcp`'s `localstack-app-inspector` `failed-requests` (an [approved exception](#approved-exceptions) until then) |

## Approved exceptions

Client-side computations allowed under rule 5's exception, each approved by the user. Remove a row when the
LocalStack API that replaces it ships.

| Where | Computation | Why | Approved | Replaced by |
|-------|-------------|-----|----------|-------------|
| `lstk mcp`, `localstack-app-inspector` action `failed-requests` (lstk `internal/mcp/appinspector_render.go`) | Groups App Inspector's failed spans (`status_code=2`) by service, operation, HTTP status and AWS error code, with counts, first and last time, and the latest example. Reads at most 5,000 spans. | Replaces the log-based error summary of `localstack-logs-analysis` with one from App Inspector's data; without it an agent pages through raw spans or greps logs. | 2026-11-17, by the user, during the `lstk mcp` prototype | The failed-requests summary in [Gaps in LocalStack](#gaps-in-localstack) |

## Known deviations

The code does not follow every rule yet. Do not copy these patterns; remove an entry when the code is fixed.

| Where | Deviation | Target |
|-------|-----------|--------|
| `src/lib/localstack/container-spec.logic.ts`, `src/lib/docker/docker.client.ts` | Names its container `localstack-main` (the legacy CLI's name); lstk uses `localstack-aws`. | Match lstk's container spec (rule 1). |
| `src/tools/localstack-aws-client.ts` | Runs `awslocal` inside the container via `docker exec`. | `lstk aws` first, `awslocal` fallback (rule 2). |
| `src/tools/localstack-deployer.ts` | Runs `tflocal`, `cdklocal`, `samlocal` only. | `lstk terraform` / `cdk` / `sam` first (rule 2). |
| `src/tools/localstack-azure-client.ts` | Configures the host `az` itself. | `lstk az` first, keeping the existing guards (rule 2). |
| `Dockerfile` | Bundles neither lstk nor the AWS CLI. | Bundle lstk and the AWS CLI (rule 2). |
| `src/tools/localstack-iam-policy-analyzer.ts` | Deprecated. Finds IAM denials by parsing container logs. | Remove it once the deprecation notice period ends; `localstack-app-inspector` covers its jobs (rule 3). |
| `src/lib/iam/iam-policy.logic.ts` | Synthesizes IAM policies from denials, for the deprecated analyzer. | Remove with the analyzer; `src/lib/iam/iam-explain.logic.ts` presents LocalStack's suggestions and summary (rule 5). |
| `src/lib/logs/log-retriever.ts` | Regex-classifies log lines (service, operation, status, IAM). | Raw and filtered lines only (rule 3). |
| `src/lib/localstack/extensions.logic.ts` | Runs a private Python module inside the container (the same one the legacy CLI runs). | The extensions HTTP API: `GET /_localstack/extensions/list`, `POST …/install`, `POST …/uninstall` (newline-delimited JSON progress events; LocalStack restarts itself afterwards). See [Gaps in LocalStack](#gaps-in-localstack). |
| `README.md` | Advertises log parsing for IAM policies and lists `tflocal`/`cdklocal`/`samlocal` as prerequisites. | Update with the code. |
