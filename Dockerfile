# syntax=docker/dockerfile:1
#
# LocalStack MCP Server — self-contained image.
#
# Bakes in everything the server shells out to (LocalStack CLI, awslocal, Terraform
# + tflocal, AWS CDK + cdklocal, AWS SAM + samlocal, Snowflake `snow`, Docker CLI),
# so the only host dependency is Docker itself.
#
# Architecture (Docker-out-of-Docker): the container talks to the HOST Docker daemon
# through the bind-mounted /var/run/docker.sock, so `localstack start` launches a
# SIBLING LocalStack container on the host. The server + IaC CLIs reach that sibling
# via the host gateway — set LOCALSTACK_HOSTNAME (e.g. host.docker.internal) at run time.
#
# Multi-arch: built for linux/amd64 + linux/arm64 via buildx. Every arch-specific
# install (Terraform, Docker CLI) auto-selects via `dpkg --print-architecture`.

############################
# Stage 1 — build the server
############################
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install JS deps first for layer caching, then build.
# `xmcp build` bundles the code + zod/posthog-node/xmcp INTO dist/, but dockerode
# is loaded via eval("require") and stays external.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

############################
# Stage 2 — runtime
############################
# Python 3.12 base: the current LocalStack CLI ships PEP 701 f-string syntax that
# does not parse on Python 3.11, so a 3.12+ interpreter is required. Node.js 22 is
# layered on via NodeSource for the server + AWS CDK / cdklocal.
FROM python:3.12-slim-bookworm AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1

# --- System toolchain: Node.js 22, Terraform, Docker CLI ---
# Terraform + Docker CLI come from their official apt repos (multi-arch via the
# arch=$(dpkg --print-architecture) field); the codename is hardcoded to bookworm
# because the slim base ships neither lsb_release nor UBUNTU_CODENAME.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip git; \
    install -m 0755 -d /usr/share/keyrings; \
    # Node.js 22 (NodeSource) — adds its apt repo
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    # HashiCorp (Terraform)
    curl -fsSL https://apt.releases.hashicorp.com/gpg \
      | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg; \
    chmod a+r /usr/share/keyrings/hashicorp-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com bookworm main" \
      > /etc/apt/sources.list.d/hashicorp.list; \
    # Docker CLI (client only; the daemon is the host's, via the mounted socket)
    curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg; \
    chmod a+r /usr/share/keyrings/docker-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs terraform docker-ce-cli; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# --- Python toolchain (official python image permits global pip; no PEP 668 marker) ---
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --no-compile \
      localstack \
      awscli \
      awscli-local \
      terraform-local \
      aws-sam-cli \
      aws-sam-cli-local \
      snowflake-cli \
 && find /usr/local/lib/python3.12/site-packages \
      \( -type d \( -name __pycache__ -o -name tests -o -name test \) -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) \
      -prune -exec rm -rf '{}' +

# --- Node IaC toolchain (AWS CDK + the LocalStack cdklocal wrapper) ---
RUN npm install -g aws-cdk aws-cdk-local \
 && npm cache clean --force

# --- The MCP server itself: bundled dist/ + dockerode runtime dependency ---
WORKDIR /app
RUN mkdir -p /usr/lib/localstack /tmp/dockerode-deps \
 && npm install --prefix /tmp/dockerode-deps --omit=dev --ignore-scripts --no-audit --no-fund dockerode@4.0.7 \
 && mkdir -p /app/node_modules \
 && cp -R /tmp/dockerode-deps/node_modules/. /app/node_modules/ \
 && rm -rf /tmp/dockerode-deps \
 && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# --- Build-time sanity: every CLI resolves and dockerode loads at runtime ---
RUN set -eux; \
    localstack --version; \
    aws --version; \
    awslocal --version; \
    terraform version; \
    tflocal --version; \
    sam --version; \
    command -v samlocal; \
    cdklocal --version; \
    snow --version; \
    docker --version; \
    node -e "require('dockerode'); console.log('dockerode ok')"

LABEL org.opencontainers.image.title="LocalStack MCP Server" \
      org.opencontainers.image.description="Self-contained MCP server for managing LocalStack (CLI, CDK, Terraform, SAM, awslocal baked in)" \
      org.opencontainers.image.source="https://github.com/localstack/localstack-mcp-server" \
      org.opencontainers.image.licenses="Apache-2.0"

# The MCP client launches this over stdio: `docker run -i --rm ... <image>`.
ENTRYPOINT ["node", "dist/stdio.js"]
