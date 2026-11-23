#!/usr/bin/env bash
# Places one test order and confirms the OrderPlaced event reached the central event bus.
# It prints only the outcome: the cause of a failure stays in LocalStack, as it would stay in a deployed workflow's
# execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
order="order-$RANDOM-$RANDOM"
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='place-order'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input "{\"orderId\": \"$order\", \"total\": 42}" --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the place-order workflow did not complete (status: $status)" >&2
  exit 1
fi
# The platform copies every event on the central bus to its audit queue, which workload accounts may read.
audit=$(aws sqs get-queue-url --queue-name central-audit --queue-owner-aws-account-id 111111111111 --query QueueUrl --output text)
for _ in $(seq 1 10); do
  if aws sqs receive-message --queue-url "$audit" --max-number-of-messages 10 --wait-time-seconds 1 --query 'Messages[].Body' --output text | grep -q "$order"; then
    echo "order placed"
    exit 0
  fi
done
echo "the place-order workflow completed, but OrderPlaced for $order never reached the central event bus" >&2
exit 1
