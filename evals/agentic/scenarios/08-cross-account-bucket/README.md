# Usage reports

Owned by the analytics team. Each month the `usage-report` workflow records the report run in the
`usage-report-runs` table and writes the usage report file to the shared `platform-exports` bucket.

`platform-exports` belongs to the platform team, which runs it in the platform account (111111111111) and deploys it
from its own repository. Every team writes under
its own prefix there, `teams/<team>/`; ours is `teams/analytics/`. The analytics dashboards pick up report files
from anywhere under that prefix.

- `./deploy.sh` deploys `template.yaml`
- `./trigger.sh` runs the workflow for the current month
