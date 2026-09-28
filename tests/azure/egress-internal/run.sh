#!/usr/bin/env bash
# L3 (b), the internal-network egress job (plan section 5.4; review F23). CI ONLY: see README.md.
#
# The emulator is dual-homed: on the default bridge, so it can activate its licence online, and
# on a network created with --internal. The MCP server's container is on the internal network
# only, with LOCALSTACK_AZURE_FORWARD_TARGET=<the emulator's internal IP>. Inside it, the egress
# guard maps the emulator's names to 127.0.0.1 without DNS, and the loopback forwarder relays
# 127.0.0.1 to the emulator. A scenario through localstack-azure-client must then succeed:
# nothing on that network can reach the internet, so success proves that nothing leaked.
#
#   CI=true bash tests/azure/egress-internal/run.sh      (LOCALSTACK_AUTH_TOKEN in the env)
#
# It builds an image, creates a network and starts an emulator and containers, so it refuses to
# run unless CI=true. Never run it on a machine whose Docker engine is shared.
set -euo pipefail

if [ "${CI:-}" != "true" ]; then
  echo "egress-internal: refusing to run: CI is not \"true\". This job starts its own emulator," >&2
  echo "network and containers, and must only run on a CI runner (see README.md)." >&2
  exit 2
fi
if [ -z "${LOCALSTACK_AUTH_TOKEN:-}" ]; then
  echo "egress-internal: LOCALSTACK_AUTH_TOKEN is not set (an Azure-entitled token)." >&2
  exit 2
fi
for tool in docker node curl; do
  command -v "$tool" > /dev/null || { echo "egress-internal: $tool is missing" >&2; exit 2; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_ID="${GITHUB_RUN_ID:-run}-$(date +%s)-$$"
NET="lsmcp-egress-internal-$RUN_ID"
EMU="lsmcp-egress-emulator-$RUN_ID"
MCP_NAME="lsmcp-egress-server-$RUN_ID"
EMU_IMAGE="${LOCALSTACK_AZURE_IMAGE_NAME:-localstack/localstack-azure:latest}"
EMU_PORT="${EGRESS_EMULATOR_HOST_PORT:-4566}"
READY_TIMEOUT="${EGRESS_READY_TIMEOUT_SECONDS:-300}"
OUT_DIR="${EGRESS_INTERNAL_OUT:-${RUNNER_TEMP:-/tmp}/egress-internal-$RUN_ID}"
MCP_IMAGE="${MCP_SERVER_IMAGE:-}"
WORKDIR="$(mktemp -d)"
mkdir -p "$OUT_DIR"

log() { printf 'egress-internal: %s\n' "$*"; }
die() {
  printf 'egress-internal: FAIL: %s\n' "$*" >&2
  exit 1
}

# Replace the token in every file this job wrote, so a later upload step cannot publish it
# (plan section 8, review N22). The value is read from the environment and never printed.
scan_outputs() {
  node - "$OUT_DIR" << 'NODE'
const fs = require("fs");
const path = require("path");
const token = process.env.LOCALSTACK_AUTH_TOKEN || "";
const found = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (token.length >= 8) {
      const text = fs.readFileSync(file, "latin1");
      if (text.includes(token)) {
        fs.writeFileSync(file, text.split(token).join("[redacted]"), "latin1");
        found.push(path.relative(process.argv[2], file));
      }
    }
  }
};
walk(process.argv[2]);
if (found.length > 0) {
  console.error(`egress-internal: FAIL: the auth token appeared in ${found.join(", ")} (redacted)`);
  process.exit(1);
}
NODE
}

cleanup() {
  local code=$?
  set +e
  docker rm -f "$MCP_NAME" > /dev/null 2>&1
  if [ -n "${EMU_STARTED:-}" ]; then
    docker logs "$EMU" > "$OUT_DIR/emulator.log" 2>&1
    docker rm -f "$EMU" > /dev/null 2>&1
  fi
  if [ -n "${NET_CREATED:-}" ]; then
    # Side-car containers the emulator attached to the network would keep it from being removed.
    for c in $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$NET" 2> /dev/null); do
      docker network disconnect -f "$NET" "$c" > /dev/null 2>&1
    done
    docker network rm "$NET" > /dev/null 2>&1 || log "warning: could not remove network $NET"
  fi
  if [ -n "${MCP_IMAGE_BUILT:-}" ]; then docker rmi "$MCP_IMAGE" > /dev/null 2>&1; fi
  rm -rf "$WORKDIR"
  scan_outputs || code=1
  if [ "$code" -eq 0 ]; then log "PASSED (results in $OUT_DIR)"; else log "FAILED (see $OUT_DIR)"; fi
  exit "$code"
}
trap cleanup EXIT

# 1. The MCP server image, which must carry az (plan phase 5, task 5.1).
if [ -z "$MCP_IMAGE" ]; then
  MCP_IMAGE="lsmcp-egress-internal:$RUN_ID"
  log "building $MCP_IMAGE from $REPO_ROOT"
  docker build -q -t "$MCP_IMAGE" "$REPO_ROOT" > /dev/null
  MCP_IMAGE_BUILT=1
fi
docker run --rm --network none --entrypoint /bin/sh "$MCP_IMAGE" -c 'command -v az && command -v curl' > /dev/null \
  || die "$MCP_IMAGE has no az (or no curl); this job needs the image with az from plan task 5.1"

# 2. The emulator on the default bridge (Appendix F's values), published on 127.0.0.1 only, so
#    this script can watch its health from the runner.
docker network create --internal "$NET" > /dev/null
NET_CREATED=1
log "starting $EMU_IMAGE as $EMU"
docker run -d --name "$EMU" \
  -p "127.0.0.1:$EMU_PORT:4566" \
  -e LOCALSTACK_AUTH_TOKEN \
  -e ACTIVATE_PRO=1 -e DNS_ADDRESS=0 -e DISABLE_EVENTS=1 -e "LS_LOG=${EGRESS_LS_LOG:-debug}" \
  -e MSSQL_ACCEPT_EULA=Y \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$EMU_IMAGE" > /dev/null
EMU_STARTED=1

# Health says the edition and whether the licence activated; HTTPS comes up seconds later
# (Appendix F). The ARM name is pinned to 127.0.0.1, so no DNS is involved.
emulator_ready() {
  local health
  health="$(curl -fsS -m 5 "http://127.0.0.1:$EMU_PORT/_localstack/health" 2> /dev/null)" || return 1
  printf '%s' "$health" > "$OUT_DIR/health.json"
  grep -Eq '"edition": *"azure' <<< "$health" || return 1
  grep -Eq '"license": *true' <<< "$health" || return 1
  curl -ksS -m 5 -o /dev/null \
    --resolve "azure.localhost.localstack.cloud:$EMU_PORT:127.0.0.1" \
    "https://azure.localhost.localstack.cloud:$EMU_PORT/_localstack/health" 2> /dev/null
}
deadline=$((SECONDS + READY_TIMEOUT))
until emulator_ready; do
  [ "$SECONDS" -lt "$deadline" ] \
    || die "FEASIBILITY: the emulator did not come up with an active licence within ${READY_TIMEOUT}s (last health in $OUT_DIR/health.json)"
  sleep 5
done
log "emulator ready: Azure edition, licence active, HTTPS up"

# 3. Dual-home it: the internal network joins; the bridge (and its default route) stays.
docker network connect "$NET" "$EMU"
EMU_IP="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$NET\"}}{{.IPAddress}}{{end}}" "$EMU")"
[ -n "$EMU_IP" ] || die "the emulator has no address on $NET"
log "emulator on $NET at $EMU_IP"
emulator_ready || die "FEASIBILITY: the emulator lost its licence or health after joining $NET"

# 4. The internal network reaches the emulator and nothing else.
probe() { docker run --rm --network "$NET" --entrypoint curl "$MCP_IMAGE" "$@"; }
probe -fsS -m 15 -o /dev/null "http://$EMU_IP:4566/_localstack/health" \
  || die "FEASIBILITY: a container on $NET cannot reach the emulator at $EMU_IP:4566"
for outside in https://management.azure.com/ https://1.1.1.1/; do
  if probe -sS -m 10 -o /dev/null "$outside" 2> /dev/null; then
    die "$outside is reachable from $NET: the network is not internal, so a pass would prove nothing"
  fi
done
log "negative controls: management.azure.com and 1.1.1.1 are unreachable from $NET"

# 5. The scenario through the tool, with the server on the internal network only.
printf 'hello from the internal-network job\n' > "$WORKDIR/hello.txt"
cat > "$OUT_DIR/scenario.mjs" << 'NODE'
// Generated by tests/azure/egress-internal/run.sh: one MCP session with the server in a
// container on the internal network only. Each step's result is appended to scenario.jsonl.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const e = process.env;
const { resultText, startServer } = await import(
  pathToFileURL(join(e.REPO_ROOT, "tests", "azure", "tools", "stdio-client.mjs")).href
);
const out = join(e.EGRESS_OUT_DIR, "scenario.jsonl");
const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const rg = `mcp-${id}-rg`;
const account = `mcp${id}`.slice(0, 24);
const container = `mcp-${id}-c`;
const vault = `mcp${id}kv`.slice(0, 24);
const secret = `internal network ${id}`;

const server = await startServer({
  command: "docker",
  args: [
    "run", "-i", "--rm", "--name", e.EGRESS_MCP_NAME, "--network", e.EGRESS_NET,
    // The value comes from this process's environment; it is never on a command line.
    "-e", "LOCALSTACK_AUTH_TOKEN",
    "-e", `LOCALSTACK_AZURE_FORWARD_TARGET=${e.EGRESS_EMU_IP}`,
    "-e", "LOCALSTACK_AZ_TEST_ENVELOPE=1",
    "-e", "MCP_ANALYTICS_DISABLED=1",
    "-e", "LOCALSTACK_AZ_WORKDIR=/work",
    "-v", `${e.EGRESS_WORKDIR}:/work`,
    e.EGRESS_MCP_IMAGE,
  ],
});

let failures = 0;
// In Docker the test envelope carries the forwarder's running connection count.
let envelopeConnections = 0;
async function step(name, command, check) {
  const started = Date.now();
  let text = "";
  let envelope;
  let ok = false;
  let why = "";
  try {
    const result = await server.callTool("localstack-azure-client", { command }, 900_000);
    text = result.content?.[0]?.text ?? resultText(result);
    try {
      envelope = result.content[1] ? JSON.parse(result.content[1].text) : undefined;
    } catch {
      envelope = undefined;
    }
    envelopeConnections = Math.max(envelopeConnections, envelope?.forwarderConnections ?? 0);
    // A command that succeeded while the guard refused a (non-housekeeping) host is a leak
    // attempt, and a refusal class means az needed something outside the emulator.
    if (/the egress guard blocked a connection to/.test(text)) throw new Error("egress blocked");
    if (envelope?.classId === "egress-refused") throw new Error("egress refused");
    ok = Boolean(check({ text, envelope, json: () => JSON.parse(envelope.stdout) }));
  } catch (error) {
    why = String(error?.message ?? error).slice(0, 300);
  }
  if (!ok) failures++;
  const firstLine = text.split("\n")[0];
  appendFileSync(out, `${JSON.stringify({ name, command, ok, ms: Date.now() - started, firstLine, classId: envelope?.classId ?? null, why })}\n`);
  console.log(`${ok ? "PASS" : "FAIL"} ${String(Date.now() - started).padStart(7)} ms  ${name}: ${firstLine.slice(0, 100)}`);
  return { ok, text, envelope };
}

const exit0 = ({ envelope }) => envelope?.exitCode === 0;
let subscription = "";
try {
  // The first call bootstraps the tool's profile through the forwarder: licence, name mapping
  // and routing all have to work for this to pass (the feasibility check of plan task 4.3).
  await step("group list (bootstrap)", "group list -o json", exit0);
  await step("group create", `group create --name ${rg} --location westeurope`, ({ json }) => {
    subscription = /^\/subscriptions\/([^/]+)\//.exec(json().id)?.[1] ?? "";
    return json().name === rg && subscription !== "";
  });
  await step("group show", `group show --name ${rg} --query name -o tsv`, ({ envelope }) => envelope.stdout.trim() === rg);
  await step(
    "storage account create",
    `storage account create --name ${account} --resource-group ${rg} --location westeurope --sku Standard_LRS`,
    ({ json }) => json().name === account
  );
  await step(
    "storage container create",
    `storage container create --name ${container} --account-name ${account} --auth-mode key`,
    ({ json }) => json().created === true
  );
  await step(
    "storage blob upload",
    `storage blob upload --container-name ${container} --name hello.txt --file hello.txt --account-name ${account} --auth-mode key --overwrite`,
    exit0
  );
  await step(
    "storage blob list",
    `storage blob list --container-name ${container} --account-name ${account} --auth-mode key --query "[].name" -o tsv`,
    ({ envelope }) => envelope.stdout.includes("hello.txt")
  );
  await step("keyvault create", `keyvault create --name ${vault} --resource-group ${rg} --location westeurope`, ({ json }) => json().name === vault);
  await step("keyvault secret set", `keyvault secret set --vault-name ${vault} --name internal --value "${secret}"`, ({ json }) => json().value === secret);
  await step(
    "keyvault secret show",
    `keyvault secret show --vault-name ${vault} --name internal --query value -o tsv`,
    ({ envelope }) => envelope.stdout.trim() === secret
  );
  await step(
    "rest (relative URL)",
    `rest --method get --url "/subscriptions/${subscription}/resourceGroups/${rg}?api-version=2022-09-01"`,
    ({ json }) => json().name === rg
  );
  await step(
    "rest (absolute management.azure.com URL, rewritten)",
    `rest --method get --url "https://management.azure.com/subscriptions/${subscription}/resourceGroups/${rg}?api-version=2022-09-01"`,
    ({ json, envelope }) => json().name === rg && envelope.notes.some((n) => n.startsWith("Rewrote the management.azure.com URL"))
  );
  await step("group create --help", "group create --help", ({ text }) => text.includes("--location"));
  await step(
    "rest (third-party URL, a policy refusal)",
    "rest --method get --url https://graph.microsoft.com/v1.0/me",
    ({ text, envelope }) => text.startsWith("❌ **Address not allowed**") && envelope === undefined
  );
} finally {
  await step("cleanup: keyvault delete", `keyvault delete --name ${vault}`, () => true);
  await step("cleanup: keyvault purge", `keyvault purge --name ${vault}`, () => true);
  await step("cleanup: group delete", `group delete --name ${rg} --yes --no-wait`, exit0);
  await server.close();
}

// The forwarder logs its target when it starts, and its connection count at exit; the test
// envelope carries the running count too. Either count proves the traffic went through it.
const stderr = server.stderr();
const target = new RegExp(`forwarder: 127\\.0\\.0\\.1:4566 -> ${e.EGRESS_EMU_IP.replace(/\./g, "\\.")}:4566`);
const atExit = Number(/forwarder connections=(\d+)/.exec(stderr)?.[1] ?? 0);
const connections = Math.max(atExit, envelopeConnections);
appendFileSync(out, `${JSON.stringify({ forwarderTarget: target.test(stderr), atExit, envelopeConnections })}\n`);
if (!target.test(stderr) || connections === 0) {
  console.log(`FAIL forwarder: target seen ${target.test(stderr)}, connections ${connections}`);
  failures++;
} else {
  console.log(`PASS forwarder relayed ${connections} connections to ${e.EGRESS_EMU_IP}`);
}
process.exit(failures === 0 ? 0 : 1);
NODE

log "running the scenario through $MCP_IMAGE on $NET"
REPO_ROOT="$REPO_ROOT" EGRESS_OUT_DIR="$OUT_DIR" EGRESS_NET="$NET" EGRESS_EMU_IP="$EMU_IP" \
  EGRESS_MCP_IMAGE="$MCP_IMAGE" EGRESS_MCP_NAME="$MCP_NAME" EGRESS_WORKDIR="$WORKDIR" \
  node "$OUT_DIR/scenario.mjs" | tee "$OUT_DIR/scenario.log" \
  || die "the scenario failed on the internal network (see $OUT_DIR/scenario.jsonl)"

emulator_ready || die "the emulator's licence or health did not hold through the scenario"
