# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM python:3.12-slim-bookworm AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip git; \
    install -m 0755 -d /usr/share/keyrings; \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    curl -fsSL https://apt.releases.hashicorp.com/gpg \
      | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg; \
    chmod a+r /usr/share/keyrings/hashicorp-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com bookworm main" \
      > /etc/apt/sources.list.d/hashicorp.list; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg; \
    chmod a+r /usr/share/keyrings/docker-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs terraform docker-ce-cli; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

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

RUN npm install -g aws-cdk@2.1114.0 aws-cdk-local \
 && npm cache clean --force

RUN node <<'NODE'
const fs = require("fs");
const file = "/usr/lib/node_modules/aws-cdk/lib/index.js";
const source = fs.readFileSync(file, "utf8");
const target = `      s3() {\n        const client = new import_client_s33.S3Client(this.config);`;
const replacement = `      s3() {\n        if (/^(1|true|yes)$/i.test(process.env.AWS_S3_FORCE_PATH_STYLE || "")) {\n          this.config.forcePathStyle = true;\n        }\n        const client = new import_client_s33.S3Client(this.config);`;

if (!source.includes(replacement)) {
  if (!source.includes(target)) {
    throw new Error("Could not patch aws-cdk S3 forcePathStyle hook");
  }
  fs.writeFileSync(file, source.replace(target, replacement));
}
NODE

WORKDIR /app
RUN mkdir -p /usr/lib/localstack /tmp/dockerode-deps \
 && npm install --prefix /tmp/dockerode-deps --omit=dev --ignore-scripts --no-audit --no-fund dockerode@4.0.7 \
 && mkdir -p /app/node_modules \
 && cp -R /tmp/dockerode-deps/node_modules/. /app/node_modules/ \
 && rm -rf /tmp/dockerode-deps \
 && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

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

ENTRYPOINT ["node", "dist/stdio.js"]
