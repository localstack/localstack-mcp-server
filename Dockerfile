# syntax=docker/dockerfile:1

# Declared globally so the Bicep stage can be picked per architecture (BuildKit sets it).
ARG TARGETARCH

# The pinned Bicep CLI: one sha256-checked binary per
# architecture. `ADD --checksum` fails the build on any mismatch.
FROM scratch AS bicep-amd64
ADD --checksum=sha256:64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a --chmod=755 \
    https://github.com/Azure/bicep/releases/download/v0.47.16/bicep-linux-x64 /bicep

FROM scratch AS bicep-arm64
ADD --checksum=sha256:4406214cc274cfac7c821552aec2178b80aec637d91ed8b244282964c1cf24e3 --chmod=755 \
    https://github.com/Azure/bicep/releases/download/v0.47.16/bicep-linux-arm64 /bicep

FROM bicep-${TARGETARCH} AS bicep

FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

# The runtime is built in chained stages so the size gate can measure the Azure layers
# alone: runtime-base -> runtime-az (layers A and B) -> runtime-bicep -> runtime.
FROM node:22-bookworm-slim AS runtime-base
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}"

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
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
 && pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --no-compile \
      terraform-local \
      aws-sam-cli \
      aws-sam-cli-local \
      snowflake-cli \
 && find /opt/venv/lib \
      \( -type d \( -name __pycache__ -o -name tests -o -name test \) -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) \
      -prune -exec rm -rf '{}' +

FROM runtime-base AS runtime-az

# Layer A: azure-cli in a venv of its own, so it cannot clash
# with the /opt/venv tools. Bytecode is stripped here (+41.6 MB compressed); the tool
# rebuilds what it needs in LOCALSTACK_AZ_PYCACHE_DIR, which saves ~0.7 s per call.
ARG AZURE_CLI_VERSION=2.90.0
# The whole venv is stripped, not only lib/: pip also compiles scripts in bin/ (jp.py; L5
# found /opt/az/bin/__pycache__).
RUN python3 -m venv /opt/az \
 && /opt/az/bin/pip install --no-cache-dir --no-compile "azure-cli==${AZURE_CLI_VERSION}" \
 && find /opt/az \
      \( -type d \( -name __pycache__ -o -name tests -o -name test \) -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) \
      -prune -exec rm -rf '{}' + \
 && ln -s /opt/az/bin/az /usr/local/bin/az

# AZURE_EXTENSION_DIR serves the build-time `az extension add`. The tool's child gets its
# extension dir from LOCALSTACK_AZ_EXTENSION_DIR, because the child environment drops every
# plain AZURE_* variable. DOTNET_SYSTEM_GLOBALIZATION_INVARIANT lets the Linux
# Bicep binary run without ICU (with identical output). The tool's working directory is
# /work: mount your templates and files there.
ENV AZURE_EXTENSION_DIR=/opt/az-extensions \
    AZURE_CORE_COLLECT_TELEMETRY=no \
    LOCALSTACK_AZ_EXTENSION_DIR=/opt/az-extensions \
    LOCALSTACK_AZ_PYCACHE_DIR=/tmp/localstack-az-pycache \
    LOCALSTACK_AZ_WORKDIR=/work \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

# Layer B: the 26 curated extensions, pinned and fail-fast, stripped in the SAME RUN
# (70.0 MB unstripped, ~21 MB stripped). The pin list may arrive with CRLF
# line endings from a Windows checkout, so they are removed first.
COPY docker/azure-extensions.txt /tmp/azure-extensions.txt
RUN set -eu; \
    export AZURE_CONFIG_DIR=/tmp/az-build-config; \
    tr -d '\r' < /tmp/azure-extensions.txt > /tmp/azure-extensions.lf; \
    while read -r name version flag || [ -n "${name:-}" ]; do \
      case "$name" in ''|'#'*) continue;; esac; \
      preview=""; [ "${flag:-}" = preview ] && preview="--allow-preview true"; \
      az extension add --name "$name" --version "$version" $preview --yes --only-show-errors; \
    done < /tmp/azure-extensions.lf; \
    find /opt/az-extensions \( -type d -name __pycache__ -o -type f -name '*.pyc' \) -prune -exec rm -rf '{}' +; \
    rm -f /opt/az-extensions/*/*.whl; \
    rm -rf /tmp/tmp* "$AZURE_CONFIG_DIR" /tmp/azure-extensions.txt /tmp/azure-extensions.lf; \
    AZURE_CONFIG_DIR=/tmp/az-manifest-config az extension list -o json > /opt/az-extensions/manifest.json; \
    rm -rf /tmp/az-manifest-config; \
    mkdir -p /work

FROM runtime-az AS runtime-bicep

# The bundled Bicep CLI: about +110 MB compressed on amd64.
COPY --from=bicep /bicep /usr/local/bin/bicep

FROM runtime-bicep AS runtime

RUN npm install -g aws-cdk@2.1133.0 aws-cdk-local \
 && npm cache clean --force

RUN node <<'NODE'
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const globalRoot = execSync("npm root -g").toString().trim();
const file = path.join(globalRoot, "aws-cdk/lib/index.js");
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
RUN mkdir -p /tmp/dockerode-deps \
 && npm install --prefix /tmp/dockerode-deps --omit=dev --ignore-scripts --no-audit --no-fund dockerode@5.0.1 \
 && mkdir -p /app/node_modules \
 && cp -R /tmp/dockerode-deps/node_modules/. /app/node_modules/ \
 && rm -rf /tmp/dockerode-deps \
 && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# `az version` runs in a throwaway config dir created and removed in the same command: a
# prefix assignment would leave /tmp/tmp.* behind. `bicep --version`
# extracts its .NET bundle and creates a /tmp/.bicep cache; both are removed too, so L5's
# absence checks (no /root/.azure, no /tmp/tmp*) hold and the build leaves nothing behind.
RUN set -eux; \
    terraform version; \
    tflocal --version; \
    sam --version; \
    command -v samlocal; \
    cdklocal --version; \
    snow --version; \
    d=$(mktemp -d); AZURE_CONFIG_DIR="$d" az version; rm -rf "$d"; \
    bicep --version; \
    rm -rf /root/.net /tmp/.net /tmp/.bicep /root/.bicep; \
    node dist/cli.js version; \
    node -e "require('dockerode'); console.log('dockerode ok')"

LABEL org.opencontainers.image.title="LocalStack MCP Server" \
      org.opencontainers.image.description="Self-contained MCP server for managing LocalStack (AWS, Snowflake and Azure)" \
      org.opencontainers.image.source="https://github.com/localstack/localstack-mcp-server" \
      org.opencontainers.image.licenses="Apache-2.0"

ENTRYPOINT ["node", "dist/cli.js"]
