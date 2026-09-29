// Minimal MCP stdio client (newline-delimited JSON-RPC 2.0) for the dev utilities and
// live tests. It spawns the server with the FULL parent environment: the SDK's
// StdioClientTransport passes only a default safe list, which would drop
// LOCALSTACK_PORT, MAIN_CONTAINER_NAME and the token, and a server started without
// them targets the shared emulator on 4566.
import { spawn } from "node:child_process";

/**
 * @param {object} opts
 * @param {string} [opts.command] server executable (default: this Node)
 * @param {string[]} [opts.args] server arguments (default: ["dist/cli.js"])
 * @param {string} [opts.cwd] working directory of the server
 * @param {Record<string,string>} [opts.env] extra variables on top of process.env
 */
export async function startServer({
  command = process.execPath,
  args = ["dist/cli.js"],
  cwd,
  env = {},
} = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { MCP_ANALYTICS_DISABLED: "1", ...process.env, ...env },
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  const pending = new Map();
  const notifications = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      for (const { reject } of pending.values()) {
        reject(new Error(`server exited code=${code} signal=${signal}\n${stderr.slice(-2000)}`));
      }
      pending.clear();
      resolve({ code, signal });
    })
  );

  let nextId = 1;
  function request(method, params, timeoutMs = 120000) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify(message) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n"
    );
  }

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "localstack-azure-dev", version: "0.0.0" },
  });
  if (init.error) throw new Error("initialize failed: " + JSON.stringify(init.error));
  notify("notifications/initialized");

  return {
    child,
    init: init.result,
    request,
    notify,
    notifications,
    stderr: () => stderr,
    async listTools() {
      const tools = [];
      let cursor;
      do {
        const res = await request("tools/list", cursor ? { cursor } : {});
        if (res.error) throw new Error("tools/list failed: " + JSON.stringify(res.error));
        tools.push(...res.result.tools);
        cursor = res.result.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, timeoutMs) {
      const res = await request("tools/call", { name, arguments: args }, timeoutMs);
      if (res.error) throw new Error(`tools/call ${name} failed: ` + JSON.stringify(res.error));
      return res.result;
    },
    /** Close stdin (the server exits on its own) and wait; kill our own child after 5 s. */
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };
}

/** The text of a tool result, joined over its text content items. */
export function resultText(result) {
  return (result?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
