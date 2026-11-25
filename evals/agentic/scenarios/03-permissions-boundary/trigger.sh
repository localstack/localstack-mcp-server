#!/usr/bin/env bash
# Runs the statement export for one customer and November 2026, then checks the statement file was written.
# It prints only the workflow's status: the cause of a failure stays in LocalStack, as it would stay in a deployed
# workflow's execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='statement-export'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input '{"customer": "c-1001", "month": "2026-11"}' --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the statement-export workflow did not complete (status: $status)" >&2
  exit 1
fi
if ! aws s3api head-object --bucket customer-statements --key statements/c-1001/2026-11.txt >/dev/null 2>&1; then
  echo "the statement-export workflow completed, but the statement file is not in customer-statements" >&2
  exit 1
fi
echo "statement export completed"
