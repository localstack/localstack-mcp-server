## ADDED Requirements

### Requirement: One tool holds the IAM actions that change LocalStack
The server SHALL register a tool `localstack-iam-management`, annotated `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, with exactly the actions `set-enforcement` and `reset-derived-policies`. Every new IAM action that changes LocalStack SHALL live in this tool (the analyzer's released `set-mode` stays), and every IAM read SHALL live in `localstack-iam`.

#### Scenario: Reads and writes are separate
- **WHEN** a client lists the server's tools
- **THEN** `localstack-iam` has `readOnlyHint: true`
- **AND** `localstack-iam-management` has `destructiveHint: true`

### Requirement: `set-enforcement` sets the IAM mode and reports how to undo it
`set-enforcement` SHALL take `mode` ∈ {`ENFORCED`, `SOFT_MODE`, `ENGINE_ONLY`, `DISABLED`} as an enum in the input schema, write it through `POST /_aws/iam/config`, and require the IAM enforcement licence. It SHALL read the current mode before writing. Its response SHALL:
- show `iam enforcement: <old> → <new>`, where `<new>` is the mode LocalStack reports after the write;
- name the call that restores `<old>`;
- carry the fixed note for the target mode (design.md, "Response contract").

Setting the current mode SHALL make no write and SHALL report "unchanged".

#### Scenario: Invalid value
- **WHEN** `set-enforcement mode=STRICT` is called
- **THEN** the call is rejected by the schema, listing the four modes

#### Scenario: Soft mode
- **GIVEN** the IAM mode is `ENFORCED`
- **WHEN** `set-enforcement mode=SOFT_MODE` is called
- **THEN** the response shows `iam enforcement: ENFORCED → SOFT_MODE`
- **AND** names `set-enforcement mode=ENFORCED`
- **AND** says requests AWS would deny are allowed and that this fixes no policy

#### Scenario: Restoring the App Inspector default
- **GIVEN** IAM is in `ENGINE_ONLY`
- **WHEN** `set-enforcement mode=ENFORCED` is called
- **THEN** the response names `set-enforcement mode=ENGINE_ONLY` as the restoring call, which the schema accepts

#### Scenario: Disabling IAM
- **WHEN** `set-enforcement mode=DISABLED` is called
- **THEN** the response says nothing is evaluated, no denials are recorded and no policies are derived

#### Scenario: Setting the current mode
- **GIVEN** the IAM mode is `ENFORCED`
- **WHEN** `set-enforcement mode=ENFORCED` is called
- **THEN** no write request is sent and the response says "unchanged"

#### Scenario: LocalStack reports a different mode
- **WHEN** LocalStack accepts the write but reports another mode on read-back
- **THEN** the response shows the reported mode and says it differs from the requested one

### Requirement: `reset-derived-policies` clears the derived IAM policies
`reset-derived-policies` SHALL delete LocalStack's derived IAM policies (`DELETE /_aws/iam/policies/summary`). Its licence preflight SHALL follow `get-derived-policies` (iam-diagnosis spec). Its response SHALL say:
- the reset covers every principal in this LocalStack instance;
- it cannot be undone;
- the policies come back only by re-running the workload.

#### Scenario: Reset before a least-privilege run
- **WHEN** `reset-derived-policies` is called
- **THEN** the derived policies are deleted and no other LocalStack state changes
- **AND** the response names the next steps: re-run the workload, then `localstack-iam get-derived-policies`

#### Scenario: Derived policies not available
- **WHEN** LocalStack returns 404 for the summary endpoint
- **THEN** the call fails with `isError: true` and says derived policies are not licensed or not available on this LocalStack
