/**
 * L3, egress (plan section 5.4; reviews F06, F17 and R02): every command of a light scenario runs
 * with the egress guard recording, and the suite fails if the guard refused any host that was
 * not expected. Housekeeping refusals (plan task 2.8) are reported and never fail the run, with
 * one exception: app.aladdin.microsoft.com. The bootstrap turns az's command recommender off
 * (`core.error_recommendation=off`), so any call there is a regression.
 *
 * Also here:
 * - the first command after a fresh bootstrap makes no azcliprod CONNECT and prints no
 *   `WARNING:` line (the versionCheck.json seed, task 2.6);
 * - CI only (AZURE_EGRESS_CI=1): the benchmark's GET and DELETE leak commands
 *   (tests/fixtures/azure/leak-commands.json) replayed on the job's own emulator, each with no
 *   refusal and at least one relayed CONNECT;
 * - CI only (AZURE_EGRESS_CI=1 and AZURE_CI_EMULATOR_CONTAINER): the job's own emulator is
 *   stopped between two calls, and the second gets Appendix G row 2 (or the tool's "emulator not
 *   running" preflight answer) within about 5 s. The emulator is started again afterwards. This
 *   breaks any suite that runs at the same time, so CI runs this project on its own, last.
 *
 *   AZURE_LIVE=1 npx jest -c jest.azure-live.config.js --selectProjects egress --runInBand
 *
 * On a shared emulator it only creates `mcp-<runid>-*` resources, deletes its group with
 * --no-wait, and deletes and purges its vault. It always uses a fresh config dir (it ignores
 * LOCALSTACK_AZ_CONFIG_DIR). AZURE_EGRESS_REPORT=<file> also appends one JSON line per command
 * and the final summary there.
 */
import { execFileSync } from "child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { MARKER_FILE, VERSION_CHECK_FILE } from "../../src/lib/azure/bootstrap";
import { isAllowedEgressHost } from "../../src/lib/azure/egress-proxy";
import {
  az,
  describeLive,
  json,
  names,
  recordEgress,
  runId,
  setupLiveEnv,
  type AzCall,
  type EgressLog,
  type LiveEnv,
} from "./live/harness";

// jest.azure-live.config.js sets testTimeout inside `projects`, where Jest ignores it (it is a
// global option), so without this every test and hook would get the 5 s default.
const LIVE_TIMEOUT_MS = 900_000;
jest.setTimeout(LIVE_TIMEOUT_MS);

type Event = EgressLog["events"][number];

interface Step {
  name: string;
  call: AzCall;
  /** The guard's events while this command ran, the bootstrap's calls included. */
  events: Event[];
}

interface LeakCommand {
  id: string;
  method: string;
  command: string;
}

const UPDATE_CHECK_HOST = "azcliprod.blob.core.windows.net";
const RECOMMENDER_HOST = "app.aladdin.microsoft.com";
const REWRITE_NOTE = "Rewrote the management.azure.com URL";
/** The tool's health preflight; on a busy shared emulator it can miss its 3 s window. */
const NOT_READY = "❌ **LocalStack Azure Emulator Not Ready**";
const RETRY_DELAY_MS = 5_000;
/** Appendix G row 2's answer must come within about 5 s of the stop (review F06). */
const STOPPED_ANSWER_MS = 5_000;
/** The emulator must answer again within this long after `docker start`. */
const RESTART_WAIT_MS = 300_000;
/** The owner's shared emulators: never stopped outside CI, whatever the variables say. */
const SHARED_EMULATOR_NAMES = new Set(["localstack-azure", "localstack-main", "localstack_main"]);

const CI_EGRESS = process.env.AZURE_EGRESS_CI === "1";
const CI_CONTAINER = process.env.AZURE_CI_EMULATOR_CONTAINER?.trim() ?? "";
const describeCi = CI_EGRESS ? describe : describe.skip;
const describeStop = CI_EGRESS && CI_CONTAINER ? describe : describe.skip;

const LEAK_COMMANDS: LeakCommand[] = (
  JSON.parse(
    readFileSync(path.join(__dirname, "..", "fixtures", "azure", "leak-commands.json"), "utf8")
  ) as { commands: LeakCommand[] }
).commands;
/** The others change state, so only these two methods are replayed (plan section 5.4). */
const REPLAYED = LEAK_COMMANDS.filter((c) => c.method === "GET" || c.method === "DELETE");

const reportFile = process.env.AZURE_EGRESS_REPORT?.trim() || undefined;
function report(entry: Record<string, unknown>): void {
  if (!reportFile) return;
  appendFileSync(reportFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const byKind = (events: Event[], kind: Event["kind"]) => events.filter((e) => e.kind === kind);
const hostsOf = (events: Event[]) => [...new Set(events.map((e) => e.host))].sort();
function countHosts(events: Event[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.host] = (counts[e.host] ?? 0) + 1;
  return counts;
}

describeLive("L3 egress: the guard's records over live commands", () => {
  let env: LiveEnv;
  let log: EgressLog;
  let freshConfigDir = false;
  const steps: Step[] = [];
  /** Refusals a test provoked on purpose (the guard's positive control). */
  const expected = new Set<Event>();

  /**
   * Run one command and keep the guard events it caused (calls run one at a time). A "not ready"
   * preflight answer is retried once, as plan section 7 allows for the readiness window: nothing
   * was spawned, so the retry sees the same state. Every retry is logged.
   */
  async function step(
    name: string,
    command: string,
    opts: { retryNotReady?: boolean } = {}
  ): Promise<Step> {
    const from = log.events.length;
    let call = await az(command);
    if (opts.retryNotReady !== false && call.text.startsWith(NOT_READY)) {
      console.log(`L3 retry (emulator not ready): ${name}\n${call.text.slice(0, 300)}`);
      report({ retry: name, firstLine: call.text.split("\n")[0] });
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      call = await az(command);
    }
    const events = log.events.slice(from);
    const result: Step = { name, call, events };
    steps.push(result);
    report({
      step: name,
      command,
      ms: call.ms,
      exitCode: call.exitCode,
      classId: call.classId,
      ok: call.ok,
      firstLine: call.text.split("\n")[0],
      events: events.map((e) => `${e.kind} ${e.host}`),
    });
    return result;
  }

  beforeAll(async () => {
    // The first-command check needs a config dir no bootstrap has touched: the harness makes a
    // new one per process unless this variable points it elsewhere.
    delete process.env.LOCALSTACK_AZ_CONFIG_DIR;
    env = setupLiveEnv();
    freshConfigDir = !existsSync(path.join(env.configDir, MARKER_FILE));
    const recorder = await recordEgress();
    if (!recorder) throw new Error("L3 needs the egress guard: unset LOCALSTACK_AZ_EGRESS_GUARD");
    log = recorder;
    if (reportFile) writeFileSync(reportFile, "");
  });

  afterAll(async () => {
    try {
      if (log) verdict();
    } finally {
      // The guard listens until it is closed, and Jest would never exit.
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const services =
        require("../../src/lib/azure/services") as typeof import("../../src/lib/azure/services");
      await services.resetAzureServices();
    }
  });

  /** Fails the suite on an unexpected refusal or any call to the command recommender. */
  function verdict(): void {
    log.stop();
    const refused = byKind(log.events, "refused").filter((e) => !expected.has(e));
    const housekeeping = byKind(log.events, "housekeeping");
    const recommender = housekeeping.filter((e) => e.host === RECOMMENDER_HOST);
    const summary = {
      commands: steps.length,
      allowed: countHosts(byKind(log.events, "allowed")),
      unexpectedRefused: countHosts(refused),
      expectedRefused: countHosts([...expected]),
      housekeeping: countHosts(housekeeping),
      upstream: countHosts(byKind(log.events, "upstream")),
    };
    report({ summary });
    console.log(`L3 egress summary: ${JSON.stringify(summary, null, 2)}`);
    const problems: string[] = [];
    if (refused.length > 0) {
      const by = steps
        .filter((s) => s.events.some((e) => refused.includes(e)))
        .map((s) => `  ${s.name}: ${hostsOf(s.events.filter((e) => refused.includes(e)))}`);
      problems.push(`the guard refused hosts no test expected:\n${by.join("\n")}`);
    }
    if (recommender.length > 0) {
      problems.push(
        `az called ${RECOMMENDER_HOST} ${recommender.length} time(s): the bootstrap's ` +
          "core.error_recommendation=off no longer holds"
      );
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }

  describe("a light scenario on the emulator", () => {
    const id = runId();
    const group = names.group(id);
    const account = names.storage(id);
    const container = names.container(id);
    const vault = names.vault(id);
    /** A storage account name that exists nowhere: its real-Azure host must be refused. */
    const outsider = names.storage(`${id}nx`);
    const secretValue = `l3 dummy value ${id}`;
    let subscription = "";
    const attempted = { group: false, vault: false };

    const allowedHosts = (s: Step) => hostsOf(byKind(s.events, "allowed"));
    const expectRelayed = (s: Step) => {
      expect(byKind(s.events, "allowed").length).toBeGreaterThan(0);
      for (const host of allowedHosts(s)) expect(isAllowedEgressHost(host)).toBe(true);
    };

    afterAll(async () => {
      // The vault first: a group delete only soft-deletes it, and the emulator may be shared.
      if (attempted.vault) {
        await step("cleanup: keyvault delete", `keyvault delete --name ${vault}`);
        await step("cleanup: keyvault purge", `keyvault purge --name ${vault}`);
      }
      if (attempted.group) {
        await step("cleanup: group delete", `group delete --name ${group} --yes --no-wait`);
      }
    });

    test("the first command after a fresh bootstrap: no update check, no WARNING", async () => {
      attempted.group = true;
      const s = await step(
        "group create (first command, fresh bootstrap)",
        `group create --name ${group} --location westeurope`
      );
      expect(s.call.exitCode).toBe(0);
      const created = json<{ name: string; id: string }>(s.call);
      expect(created.name).toBe(group);
      subscription = /^\/subscriptions\/([^/]+)\//.exec(created.id)?.[1] ?? "";
      expect(subscription).not.toBe("");

      // The call bootstrapped a config dir that nothing had touched before, so its window holds
      // the bootstrap's own az calls too: a missing seed shows up as an azcliprod CONNECT there.
      expect(freshConfigDir).toBe(true);
      expect(existsSync(path.join(env.configDir, MARKER_FILE))).toBe(true);
      expect(existsSync(path.join(env.configDir, VERSION_CHECK_FILE))).toBe(true);
      expect(s.events.filter((e) => e.host === UPDATE_CHECK_HOST)).toEqual([]);
      // A malformed seed makes az log a WARNING on every command (plan task 2.6, review F21).
      expect(s.call.envelope?.stderr ?? "").not.toMatch(/^WARNING:/m);
      expectRelayed(s);
    });

    test("group show", async () => {
      const s = await step("group show", `group show --name ${group} --query name -o tsv`);
      expect(s.call.stdout.trim()).toBe(group);
      expectRelayed(s);
    });

    test("storage account create (a long-running operation)", async () => {
      const s = await step(
        "storage account create",
        `storage account create --name ${account} --resource-group ${group} --location westeurope --sku Standard_LRS`
      );
      expect(json<{ name: string }>(s.call).name).toBe(account);
      expectRelayed(s);
      // Storage drops children created while the account is still being created (plan section 7).
      let state = "";
      for (let i = 0; i < 60 && state !== "Succeeded"; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 5_000));
        const poll = await step(
          "storage account show (provisioningState)",
          `storage account show --name ${account} --resource-group ${group} --query provisioningState -o tsv`
        );
        state = poll.call.stdout.trim();
      }
      expect(state).toBe("Succeeded");
    });

    test("storage container create (the blob data plane)", async () => {
      const s = await step(
        "storage container create",
        `storage container create --name ${container} --account-name ${account} --auth-mode key`
      );
      expect(json<{ created: boolean }>(s.call).created).toBe(true);
      expectRelayed(s);
    });

    test("storage blob upload and list", async () => {
      writeFileSync(path.join(env.workdir, "hello.txt"), `hello from L3 ${id}\n`);
      const upload = await step(
        "storage blob upload",
        `storage blob upload --container-name ${container} --name hello.txt --file hello.txt --account-name ${account} --auth-mode key --overwrite`
      );
      expect(upload.call.exitCode).toBe(0);
      expectRelayed(upload);
      const list = await step(
        "storage blob list",
        `storage blob list --container-name ${container} --account-name ${account} --auth-mode key --query "[].name" -o tsv`
      );
      expect(list.call.stdout.split(/\r?\n/)).toContain("hello.txt");
      expectRelayed(list);
    });

    test("keyvault create, secret set and secret show (the vault data plane)", async () => {
      attempted.vault = true;
      const created = await step(
        "keyvault create",
        `keyvault create --name ${vault} --resource-group ${group} --location westeurope`
      );
      expect(json<{ name: string }>(created.call).name).toBe(vault);
      expectRelayed(created);
      const set = await step(
        "keyvault secret set",
        `keyvault secret set --vault-name ${vault} --name l3-secret --value "${secretValue}"`
      );
      expect(json<{ value: string }>(set.call).value).toBe(secretValue);
      expectRelayed(set);
      const shown = await step(
        "keyvault secret show",
        `keyvault secret show --vault-name ${vault} --name l3-secret --query value -o tsv`
      );
      expect(shown.call.stdout.trim()).toBe(secretValue);
      expectRelayed(shown);
    });

    test("rest with a relative URL", async () => {
      const s = await step(
        "rest (relative URL)",
        `rest --method get --url "/subscriptions/${subscription}/resourceGroups/${group}?api-version=2022-09-01"`
      );
      expect(json<{ name: string }>(s.call).name).toBe(group);
      expectRelayed(s);
    });

    test("rest with an absolute management.azure.com URL is rewritten, not sent there", async () => {
      const s = await step(
        "rest (absolute management.azure.com URL)",
        `rest --method get --url "https://management.azure.com/subscriptions/${subscription}/resourceGroups/${group}?api-version=2022-09-01"`
      );
      expect(json<{ name: string }>(s.call).name).toBe(group);
      expect(s.call.envelope?.notes.some((n) => n.startsWith(REWRITE_NOTE))).toBe(true);
      expect(s.events.filter((e) => /management\.azure\.com$/i.test(e.host))).toEqual([]);
      expectRelayed(s);
    });

    test("a --help page", async () => {
      const s = await step("group create --help", "group create --help");
      expect(s.call.exitCode).toBe(0);
      expect(s.call.text).toContain("--location");
    });

    test("a third-party URL is a policy refusal: nothing is spawned, no CONNECT at all", async () => {
      const s = await step(
        "rest (third-party URL)",
        "rest --method get --url https://graph.microsoft.com/v1.0/me"
      );
      expect(s.call.text.startsWith("❌ **Address not allowed**")).toBe(true);
      expect(s.call.text).toContain("graph.microsoft.com");
      expect(s.call.envelope).toBeUndefined();
      expect(s.events).toEqual([]);
    });

    test("positive control: a real-Azure data-plane host is refused by the guard and named", async () => {
      const host = `${outsider}.blob.core.windows.net`;
      const s = await step(
        "storage container list (a real-Azure endpoint, refused)",
        `storage container list --account-name ${outsider} --blob-endpoint https://${host} --account-key dGVzdA== -o json`
      );
      const refusals = byKind(s.events, "refused");
      for (const e of refusals) if (e.host === host) expected.add(e);
      // Only this host was refused, and the recorder saw it: an empty log would prove nothing.
      expect(hostsOf(refusals)).toEqual([host]);
      expect(s.call.classId).toBe("egress-refused");
      expect(s.call.text).toContain(host);
      // Fail fast: without it the storage SDK retries for about 87 s (C01).
      expect(s.call.ms).toBeLessThan(30_000);
    });

    test("an unknown command (az 2.85 would report it to app.aladdin.microsoft.com)", async () => {
      const s = await step("unknown command", "mcpl3nosuchgroup list");
      expect(s.call.ok).toBe(false);
      expect(s.call.classId).toBe("unknown-command");
      expect(s.events.filter((e) => e.host === RECOMMENDER_HOST)).toEqual([]);
    });
  });

  describeCi("CI only: the benchmark's GET and DELETE leak commands on the job's emulator", () => {
    test("the fixture has GET and DELETE commands to replay", () => {
      expect(REPLAYED.length).toBeGreaterThan(0);
      expect(REPLAYED.every((c) => c.command.includes("https://management.azure.com"))).toBe(true);
    });

    test.each(REPLAYED)("$id ($method) reaches only the emulator", async (leak) => {
      const s = await step(`leak ${leak.id} (${leak.method})`, leak.command);
      // The exit code is not asserted: the targets are gone, and some answers are
      // NotImplemented or validation errors (plan section 5.4).
      expect(byKind(s.events, "refused")).toEqual([]);
      expect(byKind(s.events, "allowed").length).toBeGreaterThan(0);
      for (const host of hostsOf(byKind(s.events, "allowed")))
        expect(isAllowedEgressHost(host)).toBe(true);
      expect(s.call.envelope?.notes.some((n) => n.startsWith(REWRITE_NOTE))).toBe(true);
    });
  });

  describeStop("CI only: the job's own emulator stops between two calls", () => {
    let stopped = false;

    afterAll(async () => {
      if (!stopped) return;
      // Later files and steps expect a running emulator: start the same container again.
      execFileSync("docker", ["start", CI_CONTAINER], { stdio: "pipe", timeout: 120_000 });
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getAzureEmulatorStatus } =
        require("../../src/lib/azure/emulator") as typeof import("../../src/lib/azure/emulator");
      const { azureConfig } =
        require("../../src/lib/azure/services") as typeof import("../../src/lib/azure/services");
      /* eslint-enable @typescript-eslint/no-require-imports */
      const deadline = Date.now() + RESTART_WAIT_MS;
      let status = await getAzureEmulatorStatus(azureConfig());
      while (!status.ok && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        status = await getAzureEmulatorStatus(azureConfig());
      }
      if (!status.ok) throw new Error(`the emulator did not come back: ${status.message}`);
    });

    test("the second call gets the emulator-down answer within about 5 s", async () => {
      if (process.env.CI !== "true" && SHARED_EMULATOR_NAMES.has(CI_CONTAINER)) {
        throw new Error(`refusing to stop ${CI_CONTAINER} outside CI: it is a shared emulator`);
      }
      const before = await step("group list (emulator up)", "group list -o json");
      expect(before.call.exitCode).toBe(0);

      execFileSync("docker", ["stop", CI_CONTAINER], { stdio: "pipe", timeout: 120_000 });
      stopped = true;

      const after = await step("group list (emulator stopped)", "group list -o json", {
        retryNotReady: false,
      });
      expect(after.call.ms).toBeLessThan(STOPPED_ANSWER_MS);
      // With the guard on, Appendix G row 2 comes from the guard's upstream record; a call that
      // starts after the stop is usually caught earlier, by the tool's own health preflight.
      const rowTwo = after.call.classId === "conn-refused";
      const preflight =
        after.call.text.startsWith("❌ **LocalStack Azure Emulator Not Ready**") &&
        after.call.text.includes("is not running at");
      if (!rowTwo && !preflight) {
        throw new Error(
          `expected Appendix G row 2 or the not-running preflight, got:\n${after.call.text.slice(0, 1000)}`
        );
      }
      expect(byKind(after.events, "refused")).toEqual([]);
    });
  });
});
