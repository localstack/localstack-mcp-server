import os from "os";
import { runAz } from "./runner";

// A Node script stands in for `az`: node -e <script> <argv...>.
const fakeAz = (script: string) => ({ file: process.execPath, prefixArgs: ["-e", script] });
const env = { ...(process.env as Record<string, string>), AZURE_CONFIG_DIR: os.tmpdir() };
const opts = { timeoutMs: 20_000, cwd: os.tmpdir() };

describe("runAz", () => {
  test("captures stdout, stderr, the exit code and the argv", async () => {
    const result = await runAz(
      fakeAz(
        "console.log(JSON.stringify(process.argv.slice(1)), process.env.AZURE_CONFIG_DIR); console.error('warn'); process.exit(3)"
      ),
      env,
      ["group", "list", "--query", "[?name=='a b']"],
      opts
    );
    expect(result).toMatchObject({
      exitCode: 3,
      stderr: "warn\n",
      timedOut: false,
      truncated: false,
    });
    expect(result.stdout).toBe(`["group","list","--query","[?name=='a b']"] ${os.tmpdir()}\n`);
  });

  test("decodes a character split across two writes", async () => {
    const script =
      "const b = Buffer.from('é€😀'); process.stdout.write(b.subarray(0, 3)); setTimeout(() => process.stdout.write(b.subarray(3)), 50)";
    expect((await runAz(fakeAz(script), env, [], opts)).stdout).toBe("é€😀");
  });

  test("stdin is closed, so a prompt cannot block", async () => {
    const script =
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('eof'))";
    expect((await runAz(fakeAz(script), env, [], opts)).stdout).toBe("eof\n");
  });

  test("stops az at the timeout", async () => {
    const result = await runAz(fakeAz("setInterval(() => {}, 1000)"), env, [], {
      ...opts,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("stops az at the byte cap and marks the output truncated", async () => {
    const script = "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)";
    const result = await runAz(fakeAz(script), env, [], { ...opts, maxStreamBytes: 100_000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100_000);
  });

  test("an aborted call stops az", async () => {
    const controller = new AbortController();
    const pending = runAz(fakeAz("setInterval(() => {}, 1000)"), env, [], {
      ...opts,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    expect((await pending).aborted).toBe(true);
  });

  test("while az runs, the server's exit is hooked to kill its tree; then the hook is gone", async () => {
    const before = process.listenerCount("exit");
    const pending = runAz(fakeAz("setTimeout(() => {}, 300)"), env, [], opts);
    expect(process.listenerCount("exit")).toBe(before + 1);
    await pending;
    expect(process.listenerCount("exit")).toBe(before);
  });

  test("a missing executable is a spawn error, not an exception", async () => {
    const result = await runAz({ file: "/nonexistent/az", prefixArgs: [] }, env, [], opts);
    expect(result.spawnError).toMatch(/ENOENT/);
  });

  test("refuses to run without the tool's own AZURE_CONFIG_DIR", () => {
    const { AZURE_CONFIG_DIR: _omitted, ...without } = env;
    expect(() => runAz(fakeAz(""), without, [], opts)).toThrow(/AZURE_CONFIG_DIR/);
  });
});
