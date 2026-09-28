// Dev utility: call one tool of the built server over stdio and print its answer.
//
//   node tests/azure/tools/call-tool.mjs <tool> '<json args>'
//   node tests/azure/tools/call-tool.mjs localstack-azure-client '{"command":"group list"}'
//
// The server is `node dist/cli.js` from the repo root and gets this shell's whole
// environment (LOCALSTACK_PORT, MAIN_CONTAINER_NAME, the token, ...). Exit code 1 when
// the tool answered with an error.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultText, startServer } from "./stdio-client.mjs";

const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node tests/azure/tools/call-tool.mjs <tool> '<json args>'");
  process.exit(2);
}
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const server = await startServer({ cwd: repoRoot });
let failed = false;
try {
  const started = Date.now();
  const result = await server.callTool(tool, JSON.parse(rawArgs), 3_700_000);
  const text = resultText(result);
  console.log(text);
  console.error(`\n(${tool}: ${Date.now() - started} ms)`);
  failed = Boolean(result.isError) || text.startsWith("❌");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed = true;
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
