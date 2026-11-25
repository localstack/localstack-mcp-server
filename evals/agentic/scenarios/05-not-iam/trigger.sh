#!/usr/bin/env bash
# Runs the ticket booking workflow for one booking.
# It prints only the workflow's status: the cause of a failure stays in LocalStack, as it would stay in a deployed
# workflow's execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='ticket-booking'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input '{"bookingId": "booking-42", "seat": "B12"}' --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the ticket-booking workflow did not complete (status: $status)" >&2
  exit 1
fi
if [ "$(aws dynamodb get-item --table-name reservations --key '{"bookingId": {"S": "booking-42"}}' --query 'Item.seat.S' --output text)" != B12 ]; then
  echo "the ticket-booking workflow completed, but the booking is not in the reservations table" >&2
  exit 1
fi
echo "ticket booking completed"
