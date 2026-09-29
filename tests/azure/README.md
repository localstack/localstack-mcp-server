# Azure tests

The tests of `localstack-azure-client` and of `localstack-management`'s Azure support, by layer.
The CI job names use these labels.

| Layer   | What it checks                                                                                                 | Where                                                                   | When                                               |
| ------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Unit    | the policy, tokenizer, runner, egress guard, output classes, bootstrap, config, lifecycle and add-ons          | `src/**/*.test.ts`, and `tests/azure/**/*.test.ts` without `.live`      | `yarn test`, every PR (Linux, Windows, macOS)      |
| L1      | a scenario through the MCP harness: start, readiness, commands, Bicep, stop; through npx and through the image | `tests/docker/validate-image.mjs`                                       | `azure-live.yml`, `docker.yml`                     |
| L2      | the command matrix: one YAML file per provider, known gaps as expected failures                                | `matrix/`, `matrix.live.test.ts`                                        | a PR subset in `azure-live.yml`; every case weekly |
| L3      | egress: the guard's records, the `~/.azure` home guard, the leak-command replay, a job with no route out       | `egress.live.test.ts`, `home-guard.live.test.ts`, `egress-internal/`    | `azure-live.yml`; in full weekly                   |
| L4      | the official samples, unmodified, with an `az` shim that routes them through the tool                          | `samples-shim/`, `samples-replay.live.test.ts`                          | three samples in `azure-live.yml`; all weekly      |
| L5      | the Docker image: what it contains, what it must not, and its compressed size                                  | `tests/docker/l5-image-assertions.sh`, `tests/docker/image-size.mjs`    | `docker.yml`                                       |
| E1      | Gemini tool-trigger evals                                                                                      | `tests/mcp/evals-gemini-azure.spec.mjs`, `data/evals/gemini-azure.json` | manual (`yarn test:mcp:evals:azure`)               |
| E2      | Claude composition evals: a task, the agent loop, a verifier that reads the emulator                           | `evals/`                                                                | weekly, when `ANTHROPIC_API_KEY` is set            |
| DR1-DR8 | drift gates, below                                                                                             | `drift/`                                                                | weekly                                             |

The drift gates catch changes outside this repository:

- **DR1** the emulator's `/metadata/endpoints` suffixes still equal the snapshot;
- **DR2** its health still reports an Azure edition and a boolean `license`, as the preflight reads them;
- **DR3** the resolved `az` is supported; the weekly job runs L1 on `az` 2.85 (the minimum) and on the latest;
- **DR4** every curated extension installs at its pinned version and loads with the pinned `az`;
- **DR5** the tool's cloud config equals `lstk`'s;
- **DR6** every provider in the emulator's `/_localstack/coverage` has an L2 file;
- **DR7** (informational) changes to the emulator's certificate names and passthrough URLs;
- **DR8** the samples corpus, regenerated from the samples repo, still tokenizes to bash's argv and
  passes the policy.

The live suites need `AZURE_LIVE=1` and a running LocalStack Azure emulator:

```bash
AZURE_LIVE=1 npx jest -c jest.azure-live.config.js --selectProjects matrix-subset --runInBand
```

The projects are `matrix-subset`, `matrix-full`, `egress`, `samples-subset`, `samples-all` and
`drift`; each folder's README has the details.
