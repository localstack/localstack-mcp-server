// Dev utility: measure the built server's tools/list catalogue.
//
//   node tests/azure/tools/mcp-catalogue.mjs [--out catalogue.json]
//
// Prints each tool's JSON size (bytes of JSON.stringify(tool); tokens ~ bytes/4) and the
// total. The PR 2 description records the numbers before and after.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./stdio-client.mjs";

const argv = process.argv.slice(2);
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

const server = await startServer({ cwd: repoRoot });
try {
  const tools = await server.listTools();
  const rows = tools.map((tool) => ({
    name: tool.name,
    bytes: bytes(tool),
    descriptionBytes: Buffer.byteLength(tool.description || "", "utf8"),
    schemaBytes: tool.inputSchema ? bytes(tool.inputSchema) : 0,
  }));
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  console.log(`${tools.length} tools`);
  console.log("bytes  ~tok  desc  schema  name");
  for (const row of rows) {
    console.log(
      `${String(row.bytes).padStart(5)} ${String(Math.round(row.bytes / 4)).padStart(5)} ` +
        `${String(row.descriptionBytes).padStart(5)} ${String(row.schemaBytes).padStart(6)}  ${row.name}`
    );
  }
  console.log(`TOTAL ${total} bytes ~ ${Math.round(total / 4)} tokens`);
  if (out) writeFileSync(out, JSON.stringify({ tools, rows, total }, null, 2));
} finally {
  await server.close();
}
