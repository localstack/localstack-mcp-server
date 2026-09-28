// Dev utility: the phase 2 manual live smoke (plan section 5.2, exit gate), against a
// running LocalStack Azure emulator, through the built server over stdio.
//
//   node tests/azure/tools/live-smoke.mjs [--out results.jsonl]
//
// It uses the Azure client only (never management start/stop), resource names
// `mcp<runid>…`, its own temporary config dir and workdir, and deletes its resource
// group at the end. Each step's result is appended to the JSONL file as it lands.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultText, startServer } from "./stdio-client.mjs";

const argv = process.argv.slice(2);
const out = argv.includes("--out")
  ? argv[argv.indexOf("--out") + 1]
  : join(tmpdir(), `live-smoke-${Date.now()}.jsonl`);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const rg = `mcp${runId}-rg`;
const account = `mcp${runId}`.replace(/[^a-z0-9]/g, "").slice(0, 24);
const vault = `mcp${runId}kv`.slice(0, 24);
const root = mkdtempSync(join(tmpdir(), "lsaz-live-"));
const workdir = join(root, "work");
mkdirSync(workdir);
writeFileSync(join(workdir, "hello.txt"), "hello from the live smoke ✓\n");

const baseEnv = {
  // Presence only: the Azure tool never sends the token anywhere (D5).
  LOCALSTACK_AUTH_TOKEN: process.env.LOCALSTACK_AUTH_TOKEN || "ls-local-smoke-presence-only",
  LOCALSTACK_AZ_CONFIG_DIR: join(root, "azure-config"),
  LOCALSTACK_AZ_WORKDIR: workdir,
  LOCALSTACK_AZ_TEST_ENVELOPE: "1",
  MCP_ANALYTICS_DISABLED: "1",
};

function record(entry) {
  appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function envelopeOf(result) {
  const second = result?.content?.[1]?.text;
  try {
    return second ? JSON.parse(second) : undefined;
  } catch {
    return undefined;
  }
}

async function step(server, name, command, check) {
  const started = Date.now();
  let result;
  try {
    result = await server.callTool("localstack-azure-client", { command }, 900_000);
  } catch (error) {
    result = {
      content: [{ type: "text", text: `❌ transport error: ${error?.message ?? error}` }],
    };
  }
  const ms = Date.now() - started;
  const text = resultText(result).split('\n\n{"exitCode"')[0];
  const envelope = envelopeOf(result);
  let ok;
  let why = "";
  try {
    ok = check({ text, envelope, ms });
  } catch (error) {
    ok = false;
    why = String(error?.message ?? error);
  }
  const firstLine = text.split("\n")[0];
  record({
    name,
    command,
    ok: Boolean(ok),
    ms,
    firstLine,
    classId: envelope?.classId ?? null,
    why,
  });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${String(ms).padStart(6)} ms  ${name}: ${firstLine.slice(0, 110)}`
  );
  return { ok: Boolean(ok), text, envelope, ms };
}

const json = (envelope) => JSON.parse(envelope.stdout);

const server = await startServer({ cwd: repoRoot, env: baseEnv });
let failures = 0;
const check = (r) => {
  if (!r.ok) failures++;
  return r;
};
try {
  check(
    await step(
      server,
      "group create",
      `group create --name ${rg} --location westeurope`,
      ({ envelope }) => json(envelope).name === rg
    )
  );
  check(
    await step(
      server,
      "group show",
      `group show --name ${rg} --query name -o tsv`,
      ({ envelope }) => envelope.stdout.trim() === rg
    )
  );
  check(
    await step(
      server,
      "storage account create",
      `storage account create --name ${account} --resource-group ${rg} --location westeurope --sku Standard_LRS`,
      ({ envelope }) => json(envelope).name === account
    )
  );
  check(
    await step(
      server,
      "storage container create",
      `storage container create --name smoke-container --account-name ${account} --auth-mode key`,
      ({ envelope }) => json(envelope).created === true
    )
  );
  check(
    await step(
      server,
      "blob upload (a workdir file)",
      `storage blob upload --container-name smoke-container --name hello.txt --file hello.txt --account-name ${account} --auth-mode key --overwrite`,
      ({ envelope }) => envelope.exitCode === 0
    )
  );
  check(
    await step(
      server,
      "blob list",
      `storage blob list --container-name smoke-container --account-name ${account} --auth-mode key --query "[].name" -o tsv`,
      ({ envelope }) => envelope.stdout.includes("hello.txt")
    )
  );
  check(
    await step(
      server,
      "blob download (inside the workdir)",
      `storage blob download --container-name smoke-container --name hello.txt --file downloaded.txt --account-name ${account} --auth-mode key`,
      ({ envelope }) => envelope.exitCode === 0
    )
  );
  check(
    await step(
      server,
      "keyvault create",
      `keyvault create --name ${vault} --resource-group ${rg} --location westeurope`,
      ({ envelope }) => json(envelope).name === vault
    )
  );
  check(
    await step(
      server,
      "keyvault secret set",
      `keyvault secret set --vault-name ${vault} --name smoke-secret --value "local test value ✓"`,
      ({ envelope }) => json(envelope).value === "local test value ✓"
    )
  );
  check(
    await step(
      server,
      "keyvault secret show",
      `keyvault secret show --vault-name ${vault} --name smoke-secret --query value -o tsv`,
      ({ envelope }) => envelope.stdout.trim() === "local test value ✓"
    )
  );
  check(
    await step(
      server,
      "rest with a relative URL",
      `rest --method get --url "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${rg}?api-version=2022-09-01"`,
      ({ envelope }) => json(envelope).name === rg
    )
  );
  check(
    await step(
      server,
      "rest with an absolute management.azure.com URL (rewritten)",
      `rest --method get --url "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${rg}?api-version=2022-09-01"`,
      ({ text, envelope }) => json(envelope).name === rg && /management\.azure\.com/.test(text)
    )
  );
  check(
    await step(
      server,
      "rest with a third-party URL (refused)",
      `rest --method get --url https://graph.microsoft.com/v1.0/me`,
      ({ text }) => text.startsWith("❌") && !/Command Failed/.test(text.split("\n")[0])
    )
  );
  check(await step(server, "login (refused)", "login", ({ text }) => text.startsWith("❌")));
  check(
    await step(
      server,
      "blocked egress names the host within about 2 s (fail-fast)",
      `storage container list --account-name realacct --blob-endpoint https://realacct.blob.core.windows.net --account-key dGVzdA== -o json`,
      ({ text, envelope, ms }) =>
        envelope?.classId === "egress-refused" &&
        text.includes("realacct.blob.core.windows.net") &&
        ms < 15_000
    )
  );
  check(
    await step(server, "version (local)", "version", ({ text }) => text.includes("azure-cli-core"))
  );
  check(await step(server, "help", "group create --help", ({ text }) => /--location/.test(text)));
} finally {
  // The vault first: a group delete only soft-deletes it, and the emulator is shared.
  await step(server, "cleanup: keyvault delete", `keyvault delete --name ${vault}`, () => true);
  await step(server, "cleanup: keyvault purge", `keyvault purge --name ${vault}`, () => true);
  const cleanup = await step(
    server,
    "cleanup: group delete",
    `group delete --name ${rg} --yes --no-wait`,
    ({ envelope }) => envelope.exitCode === 0
  );
  if (!cleanup.ok) failures++;
  await server.close();
}

// A timeout needs its own server: LOCALSTACK_AZ_TIMEOUT_SECONDS is read at start.
const slow = await startServer({
  cwd: repoRoot,
  env: { ...baseEnv, LOCALSTACK_AZ_TIMEOUT_SECONDS: "5" },
});
try {
  check(
    await step(
      slow,
      "timeout (5 s limit, a wait that never finishes)",
      `group wait --created --name mcp${runId}-never --timeout 120 --interval 5`,
      ({ envelope, ms }) => envelope?.classId === "timeout" && ms < 30_000
    )
  );
} finally {
  await slow.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}; results in ${out}`);
process.exit(failures === 0 ? 0 : 1);
