import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "fs";
import os from "os";
import path from "path";
import {
  BootstrapError,
  CLI_CONFIG,
  ensureProfile,
  LOCK_DIR,
  MARKER_FILE,
  type BootstrapTarget,
} from "./bootstrap";
import type { AzRunResult } from "./runner";

const ok = (stdout = ""): AzRunResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  aborted: false,
  truncated: false,
});

function fakeAz(answers: Record<string, AzRunResult> = {}) {
  const calls: string[][] = [];
  const key = (argv: string[]) => (argv[0] === "login" ? "login" : argv.slice(0, 2).join(" "));
  const run = jest.fn(async (argv: string[]) => {
    calls.push(argv);
    return answers[key(argv)] ?? ok();
  });
  return { run, calls, steps: () => calls.map(key) };
}

const target = (over: Partial<BootstrapTarget> = {}): BootstrapTarget => ({
  configDir: mkdtempSync(path.join(os.tmpdir(), "lsmcp-bootstrap-")),
  endpoint: "https://azure.localhost.localstack.cloud:4566",
  sessionId: "s1",
  azVersion: "2.91.0",
  cwd: os.tmpdir(),
  timeoutMs: 60_000,
  ...over,
});

describe("ensureProfile", () => {
  test("four az calls point the profile at the emulator, then the marker is written", async () => {
    const az = fakeAz();
    const t = target();
    await ensureProfile(t, az.run);
    expect(az.steps()).toEqual(["cloud register", "cloud set", "config set", "login"]);
    const register = az.calls[0];
    expect(
      JSON.parse(register[register.indexOf("--cloud-config") + 1]).endpoints.resourceManager
    ).toBe(`${t.endpoint}/`);
    expect(az.calls[2]).toEqual(["config", "set", ...CLI_CONFIG, "--only-show-errors"]);
    expect(az.calls[3]).toContain("--service-principal");
    expect(JSON.parse(readFileSync(path.join(t.configDir, MARKER_FILE), "utf8"))).toEqual({
      endpoint: t.endpoint,
      sessionId: "s1",
      azVersion: "2.91.0",
    });
  });

  test("a cloud registered already (by an earlier run or another server) is updated", async () => {
    const taken = {
      ...ok(),
      exitCode: 1,
      stderr: "ERROR: The cloud 'LocalStack' is already registered.",
    };
    const az = fakeAz({ "cloud register": taken });
    await ensureProfile(target(), az.run);
    expect(az.steps()).toEqual([
      "cloud register",
      "cloud update",
      "cloud set",
      "config set",
      "login",
    ]);
  });

  test("concurrent calls share one run; it runs again only for another session", async () => {
    const t = target();
    const az = fakeAz();
    await Promise.all([ensureProfile(t, az.run), ensureProfile(t, az.run)]);
    await ensureProfile(t, az.run);
    expect(az.calls).toHaveLength(4);
    await ensureProfile({ ...t, sessionId: "s2" }, az.run);
    expect(az.calls).toHaveLength(8);
  });

  test("waits for another server's lock, and breaks one a crashed server left", async () => {
    const t = target();
    const lock = path.join(t.configDir, LOCK_DIR);
    mkdirSync(lock);
    const az = fakeAz();
    const pending = ensureProfile(t, az.run);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(az.calls).toHaveLength(0);
    rmSync(lock, { recursive: true });
    await pending;
    expect(az.calls).toHaveLength(4);
    const stale = target();
    mkdirSync(path.join(stale.configDir, LOCK_DIR));
    utimesSync(path.join(stale.configDir, LOCK_DIR), new Date(0), new Date(0));
    await ensureProfile(stale, fakeAz().run);
    expect(readFileSync(path.join(stale.configDir, MARKER_FILE), "utf8")).toContain("s1");
  });

  test("a failed step throws with az's output and leaves no marker, so the next call retries", async () => {
    const t = target();
    const failed = { ...ok(), exitCode: 1, stderr: "ERROR: bad" };
    const az = fakeAz({ login: failed });
    const error = await ensureProfile(t, az.run).catch((e) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect(error).toMatchObject({ step: "login", result: failed });
    expect(() => readFileSync(path.join(t.configDir, MARKER_FILE))).toThrow();
    const retry = fakeAz();
    await ensureProfile(t, retry.run);
    expect(retry.calls).toHaveLength(4);
  });
});
