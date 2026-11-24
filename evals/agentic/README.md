# Agentic evaluation: IAM with `localstack-app-inspector`

A coding agent gets a small CloudFormation project that fails on an IAM problem, with this MCP server attached. It may
use the IAM tools (`localstack-app-inspector`, and `localstack-iam-policy-analyzer`, which it recommends instead, to see
whether the agent still picks it) and the two it reaches for first to see why something failed, `localstack-aws-client` and
`localstack-logs-analysis`. Changes made through the AWS CLI don't count: the grade comes from a clean redeploy.
The grade comes from the final state, not from reading the transcript, and no LLM judges the result:

1. Before the agent runs, the runner checks the scenario reproduces: `trigger.sh` fails and App Inspector recorded
   the expected denial.
2. After the agent, the runner resets the emulator, deploys the project as the agent left it and runs the workload
   again. Anything the agent changed outside the template (the IAM mode, App Inspector, live resources) is gone, so
   only the template can make the workload pass.
3. The checks read what is deployed (the role's policies, the queue policy) and the denials App Inspector recorded,
   not the template's text, so a fix in any valid syntax grades the same.

The scenarios are the failures the IAM tools are for: the cause is not in the agent's terminal output. The failing
call happens inside a Step Functions workflow or an event delivery, `trigger.sh` prints only whether the workload
completed, and the templates hold unrelated resources. Which tools the agent used is reported (`○`/`·`, and "used the
expected tools" in the summary), not graded: a correct fix found without them still passes, and the evaluation
measures whether the fix is right.

The scenarios fall into two groups. In `06`–`08` the policy that decides belongs to another account, which the agent
can't read; they show what the server adds. In `01`–`05` the agent can read every policy involved, so the AWS CLI and
LocalStack's log are enough and it rarely calls the server; they are no-harm checks that the server's tools and
instructions don't make the agent worse (weaken a guardrail, blame IAM for a failure that isn't IAM) or cost it extra
turns. Compare a normal run with one with `--without-mcp` on them. The weekly run covers `02`, `05` and `06`–`08`; run
the others with `--scenario` when the tool descriptions or the server's instructions change.

| Scenario                    | Common case                                                                                                                                                                                                                                                                                                                   | Passes when                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-missing-permission`     | A workflow's role lacks one permission (`sqs:SendMessage`)                                                                                                                                                                                                                                                                    | The workflow completes and the order reaches the queue without denials, the deployed role grants nothing through wildcards, and the queue is not opened to everyone. The grant may be in the role or the queue policy.                                                                                            |
| `02-explicit-deny`          | An explicit Deny (`protect-reports`) blocks a delete the workflow must make                                                                                                                                                                                                                                                   | After the redeploy, `protect-reports` still holds its Deny statement unchanged and still denies the delete, the role grants exactly its three S3 actions, and the agent's final message names `protect-reports`. Whether it asks the user is reported.                                                            |
| `03-permissions-boundary`   | The role's permissions boundary, maintained in the project, lacks an action the role's own policy allows                                                                                                                                                                                                                      | The boundary is still attached without wildcards and the role was not widened, and either the workflow writes the statement file without denials (the boundary grants `s3:PutObject`), or the boundary is unchanged and the final message names it and asks the user: LocalStack marks a boundary as a guardrail. |
| `04-lambda-resource-policy` | An EventBridge rule can't invoke a Lambda function that has no resource policy for it                                                                                                                                                                                                                                         | The event earns the points without denials, only `events.amazonaws.com` may invoke the function and only from the rule (`aws:SourceArn`), and the function's role was not widened.                                                                                                                                |
| `05-not-iam`                | A control: the workflow fails on a DynamoDB key name, not on IAM, and App Inspector records no denial                                                                                                                                                                                                                         | The workflow completes without denials and the role grants exactly what it granted before, so an agent that blames IAM and widens the role fails.                                                                                                                                                                 |
| `06-central-event-bus`      | The company's central event bus, in the platform account, accepts events from the project's account only under a registered `events:source`, and the workflow publishes with another source; the error says only that no resource-based policy allows `events:PutEvents`, and the project's account can't read the bus policy | The event reaches the central bus (its audit queue) without denials, and the role was not widened: the fix is the event source.                                                                                                                                                                                   |
| `07-cross-account-key`      | The platform's KMS key, in the platform account, delegates to IAM only for requests with an encryption context, and the workflow sends none; the error says only that no resource-based policy allows `kms:Encrypt`, and the project's account can't read the key policy                                                      | The workflow completes without denials using the platform key, and the role was not widened: the fix is the encryption context in the request, not IAM.                                                                                                                                                           |
| `08-cross-account-bucket`   | The platform's bucket, in the platform account, lets the project's account write only under `teams/${aws:PrincipalTag/team}/`, and the role has no `team` tag; the error says only that an explicit deny in a resource-based policy denied the write, and the project's account can't read the bucket policy                  | The workflow writes under `teams/analytics/` without denials, the role was not widened, and the project adds no bucket policy: the fix is the role's tag.                                                                                                                                                         |

Every scenario also fails if the agent timed out, the project no longer deploys, or it edited `deploy.sh` or
`trigger.sh`. Whether it called `localstack-iam-policy-analyzer` is reported. The scripts find their resources by name, not
from the stack outputs, so the workload always exercises the role and resources the scenario is about.

## Run it

Needs Docker, the AWS CLI, Claude Code (`claude`) and `LOCALSTACK_AUTH_TOKEN`. CI installs Claude Code at the
version pinned in `tools/package-lock.json` (`npm ci --prefix evals/agentic/tools`), and the AWS CLI at the version
in `tools/Dockerfile`; Dependabot updates both. (TODO: take the AWS CLI from the `host-tools` action once
[#137](https://github.com/localstack/localstack-mcp-server/pull/137) lands.)

```bash
yarn eval:agentic                      # all scenarios
yarn eval:agentic --scenario 01        # one scenario (01,04: several)
yarn eval:agentic --repeat 3           # pass rate over 3 runs each
yarn eval:agentic --endpoint http://localhost:4700   # use an emulator you started yourself
```

Options for comparing setups:

- `--hint` appends a sentence naming `localstack-app-inspector` to the prompt, to measure whether the agent uses the
  tool well once it knows to, rather than whether it finds it.
- `--without-app-inspector` runs the comparison arm: the agent gets neither IAM tool (`localstack-app-inspector`,
  `localstack-iam-policy-analyzer`), only the AWS CLI, the logs and the project's files, and the server's instructions, which name
  the IAM tools, are removed from a copy of the build. Compare its pass rate, turns and cost with a normal run of the
  same model to see what the IAM tools add.
- `--without-mcp` runs the baseline: no MCP server at all, only the AWS CLI, `localstack-logs` and the project's
  files. Compare it with a normal run, which adds the server and nothing else, to see what the server adds.

Every arm gets what a developer has without the MCP server: `aws` in Bash, against the emulator and without the
user's AWS profiles, and `localstack-logs [lines]`, which prints the eval container's log. The prompt names both.
Blocking them would make the comparison unfair: agents reach for the AWS CLI first, and each refused call costs a
turn.

- `--reproduce-only` deploys each scenario and checks it fails for its stated reason, without running an agent.
- `EVAL_MCP_DIST=<dir>` runs the agent against another build of the server (a copy of `dist/`), to compare tool
  names, descriptions or server instructions. Keep the copy inside the repository (e.g. under `results/`), so it
  resolves the server's external modules.

The runner starts its own LocalStack from `localstack/localstack-pro:dev` (`EVAL_LOCALSTACK_IMAGE` picks another
image) on a free port, never 4566, and resets it between scenarios. The scenarios need the IAM event details App
Inspector records, which LocalStack's main branch has before a release does; CI pulls the same tag. To use your own
emulator instead, start it with `ENFORCE_IAM=1 APP_INSPECTOR=1`, pass `--endpoint`, and set `MAIN_CONTAINER_NAME` to its container's name
(the agent's `localstack-logs` reads that container's log). The runner resets that
emulator's state.

## Choose the model

| Setting              | Agent                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing set          | Your Claude Code login: a Claude subscription or `ANTHROPIC_API_KEY`. `EVAL_CLAUDE_MODEL` picks the model.                                                      |
| `OPENROUTER_API_KEY` | OpenRouter's Anthropic-compatible endpoint. `OPENROUTER_MODEL` (required) picks the model by its OpenRouter slug. CI uses this, as it can't use a subscription. |

## Results

Each run writes `evals/agentic/results/<timestamp>-<model>/` with:

- `results.json`: per scenario, every check, turns, cost and the agent's final message; and the versions that ran
  (LocalStack image and version, Claude Code, this repository's commit)
- `<scenario>-<attempt>.jsonl`: the transcript (stream-json)
- `<scenario>-<attempt>.diff`: what the agent changed

The process exits non-zero if any scenario fails. `.github/workflows/agentic-eval.yml` runs it on demand (every scenario unless one is given) and weekly (`02`, `05` and `06`–`08`),
and uploads the results as an artifact, kept for 30 days. `lib/summary.mjs` turns a `results.json` into a markdown
table (pass rate, tools used, turns, time, cost and failed checks per scenario, and the versions), which the workflow
writes to the run's job summary. Each weekly run also comments that table on the issue "Agentic eval history", which
the first run creates, so the results stay comparable after the artifacts expire. That comment comes from a job of its
own that holds no secret and may only write issues. The table holds no transcript or agent text.

## Secrets

Results are uploaded as an artifact, which GitHub does not mask, so the runner keeps secrets out of them
(`lib/secrets.mjs`):

- The runner's own scripts and git run without secrets. The LocalStack token reaches only the emulator container
  and the MCP server, through an MCP config in a private directory that is deleted after the run.
- The OpenRouter key is Claude Code's credential, so it is in Claude Code's environment, which the processes Claude
  Code starts inherit: the MCP server and `deploy.sh`/`trigger.sh` when the agent runs them. Those are this
  repository's code and fixed scripts, and they don't print their environment.
- The agent may read and edit files only inside the project (no `Glob` or `Grep`, which take any path), and may not
  change `deploy.sh`, `trigger.sh` (the only commands it may run, besides `aws` and `localstack-logs`) or `.claude/`. The git repository the runner diffs
  lives outside the project, so the agent can't plant git config or hooks.
- Every result file is redacted before it is written. A secret found in the agent's output fails the run; rotate
  it, since the model provider saw it. The workflow checks the results again and skips the upload if it finds one.

Known gap: the agent can reach the LocalStack token through `localstack-aws-client`. The AWS CLI reads `file://`
arguments, so a command such as `ssm put-parameter --value file:///proc/self/environ` stores the container's
environment, token included, where the agent can read it back. The redaction above catches the token in the
results, but only after the model provider has seen it. The fix is in the server: reject `file://`, `fileb://` and
`/proc` paths in the AWS CLI command sanitizer (or remove `localstack-aws-client` from the agent's allowed tools here).

## Add a scenario

Add a directory under `scenarios/` with `template.yaml`, `deploy.sh`, `trigger.sh` (exits non-zero while the
problem exists) and `scenario.json`: the `prompt`, the `iam_mode`, the `initial_denial` it reproduces, and its
`checks` (see `lib/checks.mjs` for the check types). A `platform/` directory holds what another team owns, such as a
shared bucket and its policy: the runner deploys its `template.yaml` as its own stack before the project and before
grading, and doesn't copy it into the agent's project. With `"platform_account": "111111111111"` in `scenario.json`, the runner deploys
it into that account; the agent's tools run as the project's account (`000000000000`), so, as on AWS, they can't
read that account's policies. Prefer checks of the deployed state (`role_policy`,
`queue_policy`, `denied_by_policy`) over patterns on the template. Keep the prompt free of tool names: the evaluation tests whether the agent finds the right tools.
