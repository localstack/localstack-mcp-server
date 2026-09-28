// A stand-in for `az` in the runner tests (plan task 2.4, U10). The first argument
// picks a behaviour; the runner spawns it as `node fake-az.mjs <mode> ...`.
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The PID file appears complete or not at all: a test that polls for it must never read it
 * created but still empty ("Unexpected end of JSON input" in a loaded Linux suite).
 */
function writePids(file, pids) {
  writeFileSync(`${file}.tmp`, JSON.stringify(pids));
  renameSync(`${file}.tmp`, file);
}

function spawnSleeper(ms) {
  // Inherits stdout/stderr, so it holds the runner's pipes open (C03 §6).
  return spawn(process.execPath, [`${here}sleeper.mjs`, String(ms)], { stdio: "inherit" });
}

/** CONNECT through HTTPS_PROXY as Python requests does (the tag as Proxy-Authorization). */
async function connectThroughProxy(target) {
  const net = await import("node:net");
  const proxy = new URL(process.env.HTTPS_PROXY);
  const auth = Buffer.from(
    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  ).toString("base64");
  return new Promise((resolve) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    socket.on("error", () => resolve("socket error"));
    socket.once("data", (chunk) => resolve(chunk.toString("latin1").split("\r\n")[0]));
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`
    );
  });
}

switch (mode) {
  case "connect": {
    // A refused host or a dead emulator port, then hang like an SDK retry loop (C01).
    const status = await connectThroughProxy(args[0]);
    process.stderr.write(`proxy answered: ${status}\n`);
    await sleep(Number(args[1] ?? 30000));
    break;
  }
  case "echo": {
    // Report what the runner gave us; stdin must already be at EOF.
    let stdinEnded = false;
    process.stdin.on("data", () => undefined);
    process.stdin.on("end", () => {
      stdinEnded = true;
    });
    await sleep(200);
    process.stdout.write(
      JSON.stringify({
        argv: args,
        cwd: process.cwd(),
        stdinIsTTY: Boolean(process.stdin.isTTY),
        stdinEnded,
        envKeys: Object.keys(process.env).sort(),
        env: process.env,
      })
    );
    break;
  }
  case "sleep":
    await sleep(Number(args[0] ?? 30000));
    break;
  case "timestamps": {
    // For the concurrency test: when this run started and ended.
    const start = Date.now();
    await sleep(Number(args[0] ?? 500));
    process.stdout.write(JSON.stringify({ start, end: Date.now() }));
    break;
  }
  case "utf8":
    process.stdout.write("ü✓é\n");
    process.stderr.write("WARNING: ü✓é\n");
    break;
  case "utf8-boundary": {
    // A ✓ (3 bytes) straddles byte 65,536: per-chunk decoding turns it into U+FFFD.
    process.stdout.write(
      Buffer.from("a".repeat(65535) + "✓".repeat(5) + "b".repeat(70000) + "✓".repeat(5))
    );
    break;
  }
  case "flood": {
    // Writes 3-byte characters until killed; the byte cap must stop it.
    const block = "✓".repeat(4096);
    for (;;) {
      if (!process.stdout.write(block)) await new Promise((r) => process.stdout.once("drain", r));
    }
  }
  case "exit":
    process.stdout.write("line1\r\nline2\r\n");
    process.stderr.write("ERROR: (ResourceNotFound) Resource group 'x' could not be found.\r\n");
    process.exitCode = Number(args[0] ?? 1);
    break;
  case "prompt": {
    // knack's behaviour without a tty: warn and cancel (C03 §7).
    if (process.stdin.isTTY) {
      process.stdout.write("Are you sure you want to perform this operation? (y/n): ");
      await sleep(30000);
    }
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.on("end", resolve));
    process.stderr.write(
      "WARNING: Unable to prompt for confirmation as no tty available. Use --yes.\n"
    );
    process.stderr.write("ERROR: Operation cancelled.\n");
    process.exitCode = 1;
    break;
  }
  case "grandchild": {
    // A tree: this process and a sleeper that holds the pipes. Both PIDs go to a file.
    const sleeper = spawnSleeper(Number(args[1] ?? 30000));
    writePids(args[0], { root: process.pid, grandchild: sleeper.pid });
    await sleep(Number(args[1] ?? 30000));
    break;
  }
  case "orphan": {
    // The root exits at once while its sleeper keeps the pipes open.
    const sleeper = spawnSleeper(Number(args[1] ?? 30000));
    writePids(args[0], { root: process.pid, grandchild: sleeper.pid });
    process.stdout.write("root done\n");
    sleeper.unref();
    process.exit(0);
  }
  default:
    process.stderr.write(`fake-az: unknown mode ${mode}\n`);
    process.exitCode = 2;
}
