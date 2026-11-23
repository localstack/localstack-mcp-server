#!/usr/bin/env bash
# Runs the order workflow for one order.
# It prints only the workflow's status: the cause of a failure stays in LocalStack, as it would stay in a deployed
# workflow's execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='order-workflow'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input '{"id": "order-42"}' --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the order-workflow workflow did not complete (status: $status)" >&2
  exit 1
fi
queue_url=$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text)
for _ in 1 2 3; do
  bodies=$(aws sqs receive-message --queue-url "$queue_url" --wait-time-seconds 3 \
    --max-number-of-messages 10 --query "Messages[].Body" --output text)
  if [[ "$bodies" == *order-42* ]]; then
    echo "order workflow completed"
    exit 0
  fi
done
echo "the order-workflow workflow completed, but order-42 did not reach the orders queue" >&2
exit 1
