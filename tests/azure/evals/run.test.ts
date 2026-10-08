/**
 * run.mjs as a program, without dist/, an emulator or a key: Node loads every eval module
 * through its built-in type stripping (so no module uses syntax that needs a transform),
 * and bad options stop with exit 2 before anything starts.
 */
import { spawnSync } from "child_process";
import path from "path";

const RUN = path.join(__dirname, "run.mjs");
const [major, minor] = process.versions.node.split(".").map(Number);
/** Built-in type stripping without a flag: Node 22.18+ and 23.6+. */
const TYPE_STRIPPING = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
const itNode = TYPE_STRIPPING ? test : test.skip;

/** This process's environment without any ANTHROPIC_* variable. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^ANTHROPIC_/i.test(k)) env[k] = v;
  return { ...env, NODE_NO_WARNINGS: "1", ...extra };
}

function run(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [RUN, ...args], {
    env: cleanEnv(extra),
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("run.mjs", () => {
  itNode("--list loads every module and prints the 50 tasks", () => {
    const r = run(["--list"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[lines.length - 1]).toBe("50 tasks");
    expect(r.stdout).toMatch(/^T-A\s+appconfig-kv-unlock\s+Microsoft\.AppConfiguration\//m);
    expect(r.stdout).toMatch(/^T-APIM\s+apim-migrate-stv2\s/m);
  });

  itNode("--list with a tier selects it", () => {
    const r = run(["--list", "--tier", "T-B"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe("8 tasks");
  });

  itNode("--help", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("usage: node tests/azure/evals/run.mjs");
  });

  itNode.each([
    [["--frobnicate"], "unknown argument --frobnicate"],
    [["--oracle", "--negative"], "exclude each other"],
    [["--list", "--variant", "longer"], "unknown variant longer"],
    [["--list", "--tasks", "no-such-task"], "unknown task id(s): no-such-task"],
    [["--list", "--tier", "T-D"], "unknown tier(s): T-D"],
    [["--jobs", "0"], "--jobs must be 1 to 8"],
    [["--runs"], "--runs needs a value"],
    [["--phrasing", "2"], "--phrasing is alt, 0 or 1"],
  ])("%j exits 2: %s", (args, message) => {
    const r = run(args as string[]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });

  itNode("a model run without a price for the model refuses before any server starts", () => {
    // A fake key: the price check stops the run before any client is made.
    const r = run(["--model", "claude-unpriced-1", "--out", "unused"], {
      ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-for-the-price-check",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no price for model claude-unpriced-1");
    expect(`${r.stdout}${r.stderr}`).not.toContain("FAKE-for-the-price-check");
  });
});
