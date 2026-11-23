#!/usr/bin/env bash
# Runs the usage report for November 2026.
# It prints only the workflow's status: the cause of a failure stays in LocalStack, as it would stay in a deployed
# workflow's execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='usage-report'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input '{}' --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the usage-report workflow did not complete (status: $status)" >&2
  exit 1
fi
# The analytics dashboards pick up report files only under analytics' prefix.
count=$(aws s3api list-objects-v2 --bucket platform-exports --prefix teams/analytics/ --query 'length(Contents || `[]`)' --output text)
if [ "$count" = 0 ]; then
  echo "the usage-report workflow completed, but no report file is under teams/analytics/ in platform-exports" >&2
  exit 1
fi
echo "usage report completed"
