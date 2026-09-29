#!/bin/sh
# L5 image assertions. Run inside the image with --entrypoint /bin/sh,
# because the image's ENTRYPOINT is the MCP server:
#
#   docker run --rm --entrypoint /bin/sh \
#     -v "$PWD/docker/azure-extensions.txt:/l5/azure-extensions.txt:ro" \
#     -v "$PWD/tests/docker/l5-image-assertions.sh:/l5/assert.sh:ro" \
#     -e AZ_EXPECTED=2.90.0 -e BICEP_EXPECTED=0.47.16 <image> /l5/assert.sh
#
# The absence checks run FIRST, before any az command in the container, and this script's
# own az call uses AZURE_CONFIG_DIR=/tmp/l5-az, so the test cannot create what it checks
# for.
set -eu
fail() { echo "L5 FAIL: $*" >&2; exit 1; }

# 1. Nothing a build step or a first run would leave behind.
[ ! -e /root/.azure ] || fail "/root/.azure exists in the image"
pyc=$(find /opt/az /opt/az-extensions -name '*.pyc' 2>/dev/null | head -n 1)
[ -z "$pyc" ] || fail "stripped bytecode is back: $pyc"
# -mindepth 1: /tmp itself matches 'tmp*'.
leftover=$(find /tmp -mindepth 1 -maxdepth 1 -name 'tmp*' 2>/dev/null | head -n 1)
[ -z "$leftover" ] || fail "leftover temp dir: $leftover"
[ ! -e /root/.net ] || fail "/root/.net (Bicep's extracted bundle) was left in the image"
echo "L5: absence checks passed"

# 2. The pinned azure-cli.
AZURE_CONFIG_DIR=/tmp/l5-az az version -o json > /tmp/l5-version.json
node -e '
  const v = require("/tmp/l5-version.json")["azure-cli"];
  if (process.env.AZ_EXPECTED && v !== process.env.AZ_EXPECTED) {
    console.error("L5 FAIL: azure-cli " + v + ", expected " + process.env.AZ_EXPECTED);
    process.exit(1);
  }
  console.log("L5: azure-cli " + v);
'

# 3. The baked manifest equals the pin list, names and versions (CRLF-tolerant).
node -e '
  const fs = require("fs");
  const pins = fs.readFileSync("/l5/azure-extensions.txt", "utf8").replace(/\r/g, "").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)).map(([name, version]) => [name, version]);
  const manifest = JSON.parse(fs.readFileSync("/opt/az-extensions/manifest.json", "utf8"));
  const baked = new Map(manifest.map((e) => [e.name, e.version]));
  const wrong = pins.filter(([n, v]) => baked.get(n) !== v).map(([n, v]) => n + " pinned " + v + ", baked " + (baked.get(n) || "none"));
  const extra = [...baked.keys()].filter((n) => !pins.some(([p]) => p === n));
  if (wrong.length || extra.length) {
    console.error("L5 FAIL: manifest does not match the pin list:", JSON.stringify({ wrong, extra }));
    process.exit(1);
  }
  console.log("L5: " + pins.length + " extensions match the pin list");
'

# 4. The bundled Bicep.
version=$(bicep --version)
echo "$version" | grep -q "${BICEP_EXPECTED:-0.47.16}" || fail "bicep reports: $version"
echo "L5: $version"

# 5. The tool's own lookup finds the image's az and Bicep.
[ "$(readlink -f "$(command -v az)")" = /opt/az/bin/az ] || fail "az on PATH is not /opt/az/bin/az"
[ -x /usr/local/bin/bicep ] || fail "no /usr/local/bin/bicep"
echo "L5: image assertions passed"
