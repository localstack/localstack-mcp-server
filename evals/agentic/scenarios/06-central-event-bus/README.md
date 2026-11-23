# Orders service

Owned by the orders team. The `place-order` workflow stores an order in the `orders` table and publishes an
`OrderPlaced` event to the company's central event bus, `central-events`, which the platform team runs in the
platform account (111111111111) and deploys from its own repository. Shipping, billing and analytics consume
`OrderPlaced` from that bus.

- `./deploy.sh` deploys `template.yaml`
- `./trigger.sh` places a test order and confirms the event reached the central bus
