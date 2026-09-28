#!/usr/bin/env bash
# CI only: start this job's own LocalStack Azure emulator (plan Appendix F) and wait until
# both the plain-HTTP gateway and the HTTPS ARM endpoint answer. It never runs on a
# developer machine, where an emulator may already be shared.
#
#   AZURE_CI_EMULATOR_CONTAINER  container name (default ls-azure-ci)
#   LOCALSTACK_AZURE_IMAGE_NAME  image (default localstack/localstack-azure:latest)
#   ORYX_BUILD_IMAGE             pinned Oryx build image, as in the typed server's CI
#   LOCALSTACK_AUTH_TOKEN        an Azure-entitled token (never printed)
set -euo pipefail

if [ "${CI:-}" != "true" ]; then
  echo "azure-emulator-up.sh: refusing to run outside CI (CI=true)" >&2
  exit 2
fi

name="${AZURE_CI_EMULATOR_CONTAINER:-ls-azure-ci}"
image="${LOCALSTACK_AZURE_IMAGE_NAME:-localstack/localstack-azure:latest}"
oryx="${ORYX_BUILD_IMAGE:-mcr.microsoft.com/oryx/build:github-actions-debian-bookworm-20260415.1}"
logs="${AZURE_EMULATOR_LOG_DIR:-emulator-logs}"
mkdir -p "$logs"

docker pull --quiet "$image"
# DNS_ADDRESS=0: with the internal DNS on, Cosmos hostnames resolved to the app
# container's own IP (the typed server's CI). The token goes in by name, never by value.
docker run -d --name "$name" \
  -p 127.0.0.1:4566:4566 \
  -p 127.0.0.1:4510-4559:4510-4559 \
  -e LOCALSTACK_AUTH_TOKEN \
  -e ACTIVATE_PRO=1 \
  -e DNS_ADDRESS=0 \
  -e DISABLE_EVENTS=1 \
  -e LS_LOG="${LS_LOG:-DEBUG}" \
  -e MAIN_CONTAINER_NAME="$name" \
  -e MSSQL_ACCEPT_EULA=Y \
  -e STREAM_DOCKER_LOGS=1 \
  -e FRONT_DOOR_CLASSIC_ALLOW_CREATE=1 \
  -e CDN_CLASSIC_ALLOW_CREATE=1 \
  -e LS_AZURE_ORYX_BUILD_IMAGE_TO_USE="$oryx" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$image" >/dev/null

# Poll health, not `localstack wait` (it greps logs and misses the marker under DEBUG).
healthy=0
for _ in $(seq 1 150); do
  if curl -fs http://127.0.0.1:4566/_localstack/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" != 1 ]; then
  docker logs "$name" >"$logs/emulator-start.log" 2>&1 || true
  echo "the emulator did not become healthy in 300 s; logs saved to $logs/ (scan them before upload)" >&2
  exit 1
fi

# HTTPS comes up seconds after plain HTTP.
https_ok=0
for _ in $(seq 1 60); do
  if curl -ksf --resolve azure.localhost.localstack.cloud:4566:127.0.0.1 \
    https://azure.localhost.localstack.cloud:4566/_localstack/health >/dev/null 2>&1; then
    https_ok=1
    break
  fi
  sleep 2
done
[ "$https_ok" = 1 ] || { echo "the HTTPS ARM endpoint did not answer in 120 s" >&2; exit 1; }

# Warm the coverage list: it can be slow right after start (C02).
curl -s -m 120 http://127.0.0.1:4566/_localstack/coverage >/dev/null || true
echo "LocalStack Azure emulator $name is up: $(curl -s http://127.0.0.1:4566/_localstack/health)"
