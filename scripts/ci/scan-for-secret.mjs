#!/usr/bin/env node
// CI: fail when any given file (or any file under a given directory) contains a secret,
// before logs and artifacts are uploaded (plan section 8; review R02, N22). GitHub masks
// registered secrets in step logs, but not inside uploaded artifacts. The secret's value
// is read from the environment and never printed.
//
//   node scripts/ci/scan-for-secret.mjs <file-or-dir>... [--env LOCALSTACK_AUTH_TOKEN]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const names = envIndex >= 0 ? args.splice(envIndex, 2)[1].split(",") : ["LOCALSTACK_AUTH_TOKEN"];
const secrets = names
  .map((name) => [name, process.env[name]])
  .filter(([, value]) => typeof value === "string" && value.length >= 8);

if (secrets.length === 0) {
  console.log(`scan-for-secret: none of ${names.join(", ")} is set; nothing to scan for`);
  process.exit(0);
}

const files = [];
const walk = (p) => {
  if (!existsSync(p)) return;
  const stat = statSync(p);
  if (stat.isDirectory()) for (const entry of readdirSync(p)) walk(join(p, entry));
  else if (stat.isFile()) files.push(p);
};
for (const target of args) walk(target);

const hits = [];
for (const file of files) {
  const content = readFileSync(file);
  for (const [name, value] of secrets) {
    if (content.includes(Buffer.from(value))) hits.push(`${file} (${name})`);
  }
}

if (hits.length) {
  console.error(`scan-for-secret: a secret appears in ${hits.length} file(s); not uploading:`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`scan-for-secret: ${files.length} file(s) clean of ${names.join(", ")}`);
