#!/usr/bin/env bash
# Deploys template.yaml to LocalStack.
set -euo pipefail
cd "$(dirname "$0")"
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name app \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
