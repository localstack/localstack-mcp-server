# Customer profiles

Owned by the profiles team. When a customer signs up, the `register-customer` workflow encrypts the customer's phone
number and stores the profile in the `customer-profiles` table.

Personal data is encrypted with the platform team's key for personal data, which the platform team runs in the
platform account (111111111111) and deploys from its own repository:
`arn:aws:kms:us-east-1:111111111111:key/7d3b9e42-1c6a-4f05-8e2d-a9b4c6f01e73`. Teams grant their own roles the use of the key.

- `./deploy.sh` deploys `template.yaml`
- `./trigger.sh` registers a test customer
