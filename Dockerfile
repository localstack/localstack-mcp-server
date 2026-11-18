# syntax=docker/dockerfile:1

# Every tool version in this image comes from a file Dependabot updates (.github/dependabot.yml):
#   node, terraform        FROM lines below                    (docker)
#   aws-cdk, lstk          docker/tools/npm/package-lock.json  (npm)
#   uv                     FROM line below                     (docker)
#   aws-sam-cli            docker/tools/sam/uv.lock            (uv)
#   snowflake-cli          docker/tools/snowflake/uv.lock      (uv)
#   dockerode & co.        yarn.lock                           (npm, same lock as CI)
# Debian packages (python3, git, curl) come with the node image's bookworm base.
# Both node FROM lines must stay identical, and their major must match `node-version` in the
# workflows; src/core/dependency-pins.test.ts checks this.

# The builder only emits platform-independent JS (dist/), so it runs on the build host's
# platform. A multi-arch build then compiles once instead of once per platform under QEMU.
FROM --platform=$BUILDPLATFORM node:22.23.5-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

# Terraform's official image ships a static binary, so it runs on Debian as well.
FROM hashicorp/terraform:1.17.2 AS terraform

# uv installs the Python CLIs below; it is mounted at build time and not part of the image.
FROM ghcr.io/astral-sh/uv:0.13.9 AS uv

FROM node:22.23.5-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=0 \
    UV_LINK_MODE=copy

# python3 and python3-pip also serve `sam build` for Python functions (Debian's Python 3.11;
# other Python runtimes need `sam build --use-container`).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip git \
      python3 python3-pip python3-venv; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY --from=terraform /bin/terraform /usr/local/bin/terraform
RUN terraform version

# SAM CLI and Snowflake CLI each get their own venv from their own uv project: they pin
# conflicting `rich` versions, so one environment cannot hold both. uv verifies every package
# against the hashes in uv.lock, and --no-build refuses anything that would need a compiler.
RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=docker/tools/sam,target=/tmp/tools/sam \
    UV_PROJECT_ENVIRONMENT=/opt/aws-sam-cli \
      uv sync --project /tmp/tools/sam --locked --no-install-project --no-build \
        --python /usr/bin/python3 \
 && find /opt/aws-sam-cli/lib -type d \( -name tests -o -name test \) -prune -exec rm -rf '{}' + \
 && ln -s /opt/aws-sam-cli/bin/sam /usr/local/bin/sam \
 && sam --version

RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=docker/tools/snowflake,target=/tmp/tools/snowflake \
    UV_PROJECT_ENVIRONMENT=/opt/snowflake-cli \
      uv sync --project /tmp/tools/snowflake --locked --no-install-project --no-build \
        --python /usr/bin/python3 \
 && find /opt/snowflake-cli/lib -type d \( -name tests -o -name test \) -prune -exec rm -rf '{}' + \
 && ln -s /opt/snowflake-cli/bin/snow /usr/local/bin/snow \
 && snow --version

# lstk wraps terraform, cdk, and sam for the deployer tool. aws-cdk >= 2.1138 honors the
# CDK_S3_FORCE_PATH_STYLE that lstk sets, so S3 assets reach host.docker.internal path-style.
COPY docker/tools/npm/package.json docker/tools/npm/package-lock.json /opt/image-tools/npm/
RUN npm ci --prefix /opt/image-tools/npm --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
ENV PATH="/opt/image-tools/npm/node_modules/.bin:${PATH}"
RUN lstk --version && cdk --version

# The server's runtime dependencies (dockerode and its native-optional ssh2) come from the
# same yarn.lock CI tests with, installed for the target platform.
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production --ignore-scripts --non-interactive \
 && yarn cache clean
COPY --from=builder /app/dist ./dist

# Each tool layer checks its own version above, so this step only checks the per-commit files
# and stays cheap when the tool layers come from cache.
RUN set -eux; \
    node dist/cli.js version; \
    node -e "require('dockerode'); console.log('dockerode ok')"

LABEL org.opencontainers.image.title="LocalStack MCP Server" \
      org.opencontainers.image.description="Self-contained MCP server for managing LocalStack" \
      org.opencontainers.image.source="https://github.com/localstack/localstack-mcp-server" \
      org.opencontainers.image.licenses="Apache-2.0"

ENTRYPOINT ["node", "dist/cli.js"]
