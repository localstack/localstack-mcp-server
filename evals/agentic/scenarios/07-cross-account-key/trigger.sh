#!/usr/bin/env bash
# Registers one test customer.
# It prints only the workflow's status: the cause of a failure stays in LocalStack, as it would stay in a deployed
# workflow's execution history and logs. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
customer="customer-$RANDOM-$RANDOM"
sm=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='register-customer'].stateMachineArn | [0]" --output text)
execution=$(aws stepfunctions start-execution --state-machine-arn "$sm" --input "{\"customerId\": \"$customer\", \"phone\": \"+15550100\"}" --query executionArn --output text)
status=RUNNING
for _ in $(seq 1 60); do
  status=$(aws stepfunctions describe-execution --execution-arn "$execution" --query status --output text)
  [ "$status" != RUNNING ] && break
  sleep 1
done
if [ "$status" != SUCCEEDED ]; then
  echo "the register-customer workflow did not complete (status: $status)" >&2
  exit 1
fi
# Personal data must be encrypted with the platform's key.
key=arn:aws:kms:us-east-1:111111111111:key/7d3b9e42-1c6a-4f05-8e2d-a9b4c6f01e73
stored=$(aws dynamodb get-item --table-name customer-profiles --key "{\"customerId\": {\"S\": \"$customer\"}}" --query 'Item.encryptedWith.S' --output text)
if [ "$stored" != "$key" ]; then
  echo "the register-customer workflow completed, but the profile is not stored with the phone number encrypted by the platform key" >&2
  exit 1
fi
echo "customer registered"
