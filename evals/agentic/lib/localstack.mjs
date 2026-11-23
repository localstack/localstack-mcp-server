// LocalStack for the agentic evaluation: an isolated emulator with IAM enforcement and App Inspector, and the API
// calls the runner needs to prepare a scenario and grade its final state.
import { spawnSync } from "node:child_process";
import net from "node:net";

// The scenarios need the IAM event details App Inspector records (the payload with the deciding policies and the
// suggested fix), which the nightly image has before a release does. CI pulls the same tag.
const DEFAULT_IMAGE = "localstack/localstack-pro:dev";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Starts a dedicated LocalStack container on a free port, never 4566, so the evaluation can't disturb an emulator
 * someone is using. Returns the endpoint and a stop function.
 */
export async function startLocalStack({
  image = process.env.EVAL_LOCALSTACK_IMAGE || DEFAULT_IMAGE,
} = {}) {
  if (!process.env.LOCALSTACK_AUTH_TOKEN) {
    throw new Error("LOCALSTACK_AUTH_TOKEN must be set to start LocalStack (or pass --endpoint).");
  }
  const port = await freePort();
  // A neutral name: the agent sees it through the MCP tools, and it should not say the run is an evaluation.
  const name = `localstack-${port}`;
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:4566`,
      // Lambda functions run in containers the emulator starts; named after it, so stop() can find them
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-e",
      `MAIN_CONTAINER_NAME=${name}`,
      "-e",
      "LOCALSTACK_AUTH_TOKEN",
      "-e",
      "ENFORCE_IAM=1",
      "-e",
      "APP_INSPECTOR=1",
      "-e",
      "DISABLE_EVENTS=1",
      "-e",
      `LOCALSTACK_HOST=localhost.localstack.cloud:${port}`,
      image,
    ],
    { encoding: "utf8", env: process.env }
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const endpoint = `http://localhost:${port}`;
  await waitForHealth(endpoint);
  return {
    endpoint,
    port,
    image,
    containerName: name,
    stop: () => {
      spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
      // The Lambda containers the emulator started outlive a forced stop. Their names start with the emulator's.
      const lambdas = spawnSync("docker", ["ps", "-aq", "--filter", `name=^${name}-lambda-`], {
        encoding: "utf8",
      })
        .stdout.split("\n")
        .filter(Boolean);
      if (lambdas.length) spawnSync("docker", ["rm", "-f", ...lambdas], { encoding: "utf8" });
    },
  };
}

async function waitForHealth(endpoint, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/_localstack/health`);
      if (response.ok) {
        const body = await response.json();
        if (body?.services) return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`LocalStack at ${endpoint} did not become healthy within ${timeoutMs / 1000}s`);
}

const RETRYABLE = new Set(["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_CLOSED", "EPIPE"]);

async function call(endpoint, path, { method = "GET", body } = {}) {
  let response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      break;
    } catch (error) {
      // fetch reports only "fetch failed"; the cause says why (refused, reset, timeout)
      const cause = error?.cause?.code ?? error?.cause?.message ?? "";
      // A keep-alive connection LocalStack closed while the agent ran fails once on reuse: retry on a new one.
      if (attempt < 3 && RETRYABLE.has(cause)) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw new Error(`${method} ${path} failed${cause ? ` (${cause})` : ""}: ${error.message}`);
    }
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status}: ${text}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

/** The emulator's version, for the results: a scenario that stops reproducing is often a version change */
export async function localstackVersion(endpoint) {
  const info = await call(endpoint, "/_localstack/info").catch(() => undefined);
  return info?.version;
}

/** Resets the emulator between scenarios and prepares IAM and App Inspector for the next one */
export async function prepareScenario(endpoint, { iamMode }) {
  await call(endpoint, "/_localstack/state/reset", { method: "POST" });
  await call(endpoint, "/_aws/iam/config", { method: "POST", body: { state: iamMode } });
  await call(endpoint, "/_localstack/appinspector/status", {
    method: "PUT",
    body: { status: "enabled" },
  });
  await clearTraces(endpoint);
  await call(endpoint, "/_aws/iam/policies/summary", { method: "DELETE" }).catch(() => undefined);
}

export async function clearTraces(endpoint) {
  await call(endpoint, "/_localstack/appinspector/v1/traces", { method: "DELETE", body: {} });
}

/** The IAM denials App Inspector recorded since the traces were last cleared */
export async function listDenials(endpoint) {
  const page = await call(
    endpoint,
    "/_localstack/appinspector/v1/traces/*/spans/*/events/iam?name=iam.policy.denied&limit=1000"
  );
  return (page?.events ?? []).map((event) => {
    let payload;
    try {
      payload = JSON.parse(event?.attributes?.payload ?? "null");
    } catch {
      payload = undefined;
    }
    return { eventId: event.event_id, payload };
  });
}

async function countSpans(endpoint) {
  const page = await call(endpoint, "/_localstack/appinspector/v1/traces/*/spans?limit=1000");
  return (page?.spans ?? (Array.isArray(page) ? page : [])).length;
}

/**
 * App Inspector writes spans and IAM events in the background, so a read right after the workload can miss them.
 * Waits until the span count has stopped changing for `quietMs` (at least `minMs` after the call, at most
 * `maxMs`), then returns the denials. Without this, "no denials" could pass because nothing was written yet.
 */
export async function settledDenials(
  endpoint,
  { minMs = 3000, quietMs = 4000, maxMs = 60_000 } = {}
) {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    const count = await countSpans(endpoint);
    if (count !== last) {
      last = count;
      stableSince = Date.now();
    } else if (Date.now() - started >= minMs && Date.now() - stableSince >= quietMs) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return listDenials(endpoint);
}
