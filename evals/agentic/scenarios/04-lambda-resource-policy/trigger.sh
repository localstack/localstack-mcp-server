#!/usr/bin/env bash
# Places one order event on the default event bus and checks that loyalty points were credited for it.
# It prints only whether the points arrived: the cause of a failure stays in LocalStack, as it would in a deployed
# application. Resources are looked up by name, not from the stack outputs.
set -euo pipefail
order="order-$RANDOM-$RANDOM"
aws events put-events --entries "[{\"Source\": \"shop.orders\", \"DetailType\": \"OrderPlaced\", \"Detail\": \"{\\\"orderId\\\": \\\"$order\\\", \\\"total\\\": 120}\"}]" >/dev/null
for _ in $(seq 1 30); do
  points=$(aws dynamodb get-item --table-name loyalty-points --key "{\"orderId\": {\"S\": \"$order\"}}" --query 'Item.points.N' --output text)
  if [ "$points" != None ] && [ -n "$points" ]; then
    echo "loyalty points credited for the order"
    exit 0
  fi
  sleep 2
done
echo "no loyalty points were credited for the order" >&2
exit 1
