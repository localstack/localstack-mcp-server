#!/usr/bin/env bash
# Runs the report cleanup workflow on the Q3 2017 audited report, whose retention period has ended: the workflow
# archives it, then deletes it from the reports bucket.
# It prints only the workflow's status: the cause of a failure stays in LocalStack, as it would stay in a deployed
# workflow's execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
echo "q3 2017 report" | aws s3 cp - s3://company-reports/audited/2017/q3.txt >/dev/null
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='report-cleanup'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input '{}' --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the report-cleanup workflow did not complete (status: $status)" >&2
  exit 1
fi
if aws s3api head-object --bucket company-reports --key audited/2017/q3.txt >/dev/null 2>&1; then
  echo "the report-cleanup workflow completed, but the expired report is still in company-reports" >&2
  exit 1
fi
echo "report cleanup completed"
