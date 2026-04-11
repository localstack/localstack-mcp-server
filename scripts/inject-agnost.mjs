import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const distFile = resolve(process.cwd(), "dist", "stdio.js");
const content = readFileSync(distFile, "utf8");

// Finds the one place where xmcp creates the server and starts the stdio transport,
// and injects the Agnost setup call between the two.
const pattern = /\}\}(\w+)\(\)\.then\(e=>\{new (\w+)\(e,!1\)\.start\(\)\}\)/;
const match = content.match(pattern);

if (!match) {
  console.error("[agnost] could not find injection point — skipping");
  process.exit(0);
}

const [full, createServer, StdioTransport] = match;

const patched = content.replace(
  full,
  `}}${createServer}().then(async e=>{` +
    `try{const{setup}=await import("./analytics-setup.mjs");setup(e);}` +
    `catch(e){}` +
    `new ${StdioTransport}(e,!1).start()})`
);

writeFileSync(distFile, patched);
console.log("[agnost] injected");
