## ADDED Requirements

### Requirement: The analyzer recommends the new tools without changing behaviour
`localstack-iam-policy-analyzer` SHALL keep its actions and behaviour. When the licence includes App Inspector, every successful response SHALL end with a pointer to `localstack-iam`. The response of `set-mode` SHALL name `localstack-iam-management set-enforcement`, and that of `get-status` SHALL name `localstack-iam get-enforcement`. The tool description SHALL recommend `localstack-iam` and `localstack-iam-management` instead of PR #140's actions. Error responses SHALL NOT carry a pointer.

#### Scenario: A successful analysis
- **GIVEN** the licence includes App Inspector
- **WHEN** `analyze-policies` succeeds
- **THEN** the response ends with a pointer to `localstack-iam list-denials` and `explain-denial`

#### Scenario: No App Inspector licence
- **GIVEN** the licence does not include App Inspector
- **WHEN** `analyze-policies` succeeds
- **THEN** the response carries no pointer to `localstack-iam`

#### Scenario: Setting the mode
- **WHEN** `set-mode` succeeds
- **THEN** the response names `localstack-iam-management set-enforcement`
