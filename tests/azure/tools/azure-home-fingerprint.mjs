// Dev and CI utility: fingerprint the user's real ~/.azure by METADATA only (relative
// paths, sizes, mtimes), never opening a file (plan sections 7 and 11; review F33).
// The live suites take one fingerprint before and one after, and fail on any change.
//
//   node tests/azure/tools/azure-home-fingerprint.mjs > before.json
//   node tests/azure/tools/azure-home-fingerprint.mjs --compare before.json
//
// Exit code 1 on --compare when anything was added, removed, resized or touched.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export function fingerprint(root = join(homedir(), ".azure")) {
  const entries = {};
  if (!existsSync(root)) return { root, exists: false, entries };
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      // An unreadable directory (EPERM on Windows) is recorded, never an error.
      entries[relative(root, dir).split("\\").join("/") + "/"] = {
        type: "dir",
        unreadable: error.code,
      };
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      const key = relative(root, full).split("\\").join("/");
      if (stat.isDirectory()) {
        entries[key + "/"] = { type: "dir", mtimeMs: Math.trunc(stat.mtimeMs) };
        walk(full);
      } else {
        entries[key] = {
          type: stat.isSymbolicLink() ? "link" : "file",
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
        };
      }
    }
  };
  walk(root);
  return { root, exists: true, entries };
}

export function compare(before, after) {
  const changes = [];
  if (before.exists !== after.exists)
    changes.push(`~/.azure ${after.exists ? "appeared" : "disappeared"}`);
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const key of [...keys].sort()) {
    const a = before.entries[key];
    const b = after.entries[key];
    if (!a) changes.push(`added: ${key}`);
    else if (!b) changes.push(`removed: ${key}`);
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.type !== b.type)
      changes.push(`changed: ${key}`);
  }
  return changes;
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("\\").join("/").split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const current = fingerprint(process.env.AZURE_HOME_FINGERPRINT_ROOT || undefined);
  if (args[0] === "--compare") {
    const before = JSON.parse(readFileSync(args[1], "utf8"));
    const changes = compare(before, current);
    if (changes.length) {
      console.error(`~/.azure changed:\n${changes.map((c) => `  ${c}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`~/.azure unchanged (${Object.keys(current.entries).length} entries)`);
  } else {
    process.stdout.write(JSON.stringify(current, null, 2) + "\n");
  }
}
