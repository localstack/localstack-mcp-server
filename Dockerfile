# syntax=docker/dockerfile:1

# The builder only emits platform-independent JS (dist/), so it runs on the build host's
# platform. A multi-arch build then compiles once instead of once per platform under QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:22-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip git \
      python3 python3-pip python3-venv; \
    install -m 0755 -d /usr/share/keyrings; \
    curl -fsSL https://apt.releases.hashicorp.com/gpg \
      | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg; \
    chmod a+r /usr/share/keyrings/hashicorp-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com bookworm main" \
      > /etc/apt/sources.list.d/hashicorp.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends terraform; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    terraform version

# SAM CLI comes from its official Linux installer, which bundles its own Python and dependencies.
# The checksums are the ones AWS publishes in the release notes. Snowflake CLI gets a venv of its
# own. Installing both with pip into one venv made the resolver backtrack for minutes (they pin
# conflicting `rich` versions) and settle on old releases. Snowflake's single-file binary is no
# alternative: on first run it unpacks ~400 MB of Python into $HOME.
# python3 and python3-pip also serve `sam build` for Python functions (Debian's Python 3.11;
# other Python runtimes need `sam build --use-container`).
ARG TARGETARCH
ARG SAM_CLI_VERSION=1.172.1
ARG SAM_CLI_SHA256_AMD64=aa6a5a785c576f5d8e1b783fe1633cb6eea1cbab382fa5aca1b9e17a9250cc07
ARG SAM_CLI_SHA256_ARM64=fcfc7cd414a75cc17a00c81110b2955ab52b6fae1dd8b7415d637ca95ca931df
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) sam_arch=x86_64; sam_sha="$SAM_CLI_SHA256_AMD64" ;; \
      arm64) sam_arch=arm64; sam_sha="$SAM_CLI_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLo sam.zip "https://github.com/aws/aws-sam-cli/releases/download/v${SAM_CLI_VERSION}/aws-sam-cli-linux-${sam_arch}.zip"; \
    echo "${sam_sha}  sam.zip" | sha256sum -c -; \
    unzip -q sam.zip -d sam-installer; \
    ./sam-installer/install; \
    rm -rf sam.zip sam-installer; \
    sam --version

ARG SNOWFLAKE_CLI_VERSION=3.34.0
RUN python3 -m venv /opt/snowflake-cli \
 && /opt/snowflake-cli/bin/pip install --no-cache-dir --no-compile "snowflake-cli==${SNOWFLAKE_CLI_VERSION}" \
 && find /opt/snowflake-cli/lib \
      \( -type d \( -name __pycache__ -o -name tests -o -name test \) -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) \
      -prune -exec rm -rf '{}' + \
 && ln -s /opt/snowflake-cli/bin/snow /usr/local/bin/snow \
 && snow --version

# lstk wraps terraform, cdk, and sam for the deployer tool. aws-cdk >= 2.1138 honors the
# CDK_S3_FORCE_PATH_STYLE that lstk sets, so S3 assets reach host.docker.internal path-style.
RUN npm install -g aws-cdk@2.1145.0 @localstack/lstk@1.4.2 \
 && npm cache clean --force \
 && lstk --version \
 && cdk --version

WORKDIR /app
RUN mkdir -p /tmp/dockerode-deps \
 && npm install --prefix /tmp/dockerode-deps --omit=dev --ignore-scripts --no-audit --no-fund dockerode@5.0.1 \
 && mkdir -p /app/node_modules \
 && cp -R /tmp/dockerode-deps/node_modules/. /app/node_modules/ \
 && rm -rf /tmp/dockerode-deps \
 && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

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
