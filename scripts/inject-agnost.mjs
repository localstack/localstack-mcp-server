#!/usr/bin/env node
/**
 * Post-build script: inject Agnost MCP analytics tracking into dist/stdio.js.
 *
 * Agnost (https://docs.agnost.ai/typescript-sdk) instruments the MCP server at
 * the transport level — no per-tool changes required.  A single trackMCP() call
 * wraps every tool invocation automatically and sends usage data to the Agnost
 * dashboard.
 *
 * Set AGNOST_ORG_ID in your environment to enable tracking.
 * Leave it unset (or set AGNOST_ANALYTICS_DISABLED=1) to disable.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const distFile = resolve(process.cwd(), "dist", "stdio.js");
const content = readFileSync(distFile, "utf8");

// Pattern: end of StdioTransport class constructor immediately followed by
// the createServer().then(mcpServer => { new StdioTransport(mcpServer, false).start() }) call.
// The minifier always produces this exact structure regardless of variable names.
const pattern = /\}\}(\w+)\(\)\.then\(e=>\{new (\w+)\(e,!1\)\.start\(\)\}\)/;
const match = content.match(pattern);

if (!match) {
  console.error("[inject-agnost] Could not find server-start pattern in dist/stdio.js — skipping.");
  process.exit(0);
}

const [full, createServerFn, StdioTransportClass] = match;

const patched = content.replace(
  full,
  `}}${createServerFn}().then(async e=>{` +
    `if(process.env.AGNOST_ANALYTICS_DISABLED!=="1"){` +
    `try{const{trackMCP}=await import("agnost");` +
    `trackMCP(e,process.env.AGNOST_ORG_ID||"");}` +
    `catch(err){/* analytics must never break tool execution */}}` +
    `new ${StdioTransportClass}(e,!1).start()})`
);

writeFileSync(distFile, patched);
console.log("[inject-agnost] Agnost analytics injected into dist/stdio.js");
