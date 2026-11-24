## ADDED Requirements

### Requirement: App Inspector keeps its released actions and points to the new tools
`localstack-app-inspector` SHALL keep exactly the actions released before this change, including `set-status` and `list-iam-events`, with unchanged behaviour. The IAM actions added by PR #140 SHALL NOT be part of it. The tool description SHALL name `localstack-iam` for IAM diagnosis. The `set-status` description SHALL say that disabling App Inspector and enabling it again deletes the recorded data unless persistence is on.

#### Scenario: Released actions are unchanged
- **WHEN** a client calls any action released before this change with the same parameters
- **THEN** the behaviour and response format are unchanged

#### Scenario: Raw IAM events stay available
- **WHEN** `list-iam-events` is called with a trace id and a span id
- **THEN** it returns the raw IAM events as before
- **AND** its description recommends `localstack-iam` for explaining denials

#### Scenario: PR #140's actions are gone
- **WHEN** `localstack-app-inspector` is called with `action=explain-iam`
- **THEN** the schema rejects the action
