# The AWS CLI the agentic eval's deploy and trigger scripts run, at a version Dependabot updates.
#   docker build --output type=local,dest=DIR evals/agentic/tools   →   DIR/aws-cli/bin/aws
#
# TODO: once https://github.com/localstack/localstack-mcp-server/pull/137 lands, take the AWS CLI from the
# .github/actions/host-tools action (the server image's version) and remove this file and its Dependabot entry.
FROM amazon/aws-cli:2.39.3 AS awscli

FROM scratch
COPY --from=awscli /usr/local/aws-cli/v2/current/ /aws-cli/
