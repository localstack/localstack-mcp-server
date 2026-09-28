#!/usr/bin/env node
/**
 * L5 size gate (plan task 5.4; checks C05, C08; review F37). Measures the COMPRESSED size
 * of the image and of the stage images the Dockerfile chains (`docker save | gzip`), never
 * `docker image inspect .Size`: on a containerd image store that reports disk usage
 * (403 MB and 1.28 GB in C05).
 *
 *   node tests/docker/image-size.mjs --base <img> --az <img> --bicep <img> --final <img>
 *        [--record docker/image-size.json] [--write]
 *
 * Fails when the az layers (runtime-az minus runtime-base) add more than 75 MB, the Bicep
 * layer (runtime-bicep minus runtime-az) more than 120 MB, or the final image grew more
 * than 30 MB over the recorded size. `--write` stores the measurement as the new record.
 * MB here is 1,000,000 bytes.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const MB = 1_000_000;
const LIMITS = { azLayers: 75 * MB, bicepLayer: 120 * MB, growth: 30 * MB };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

/** gzip -6 of `docker save`, counted as it streams (nothing is written to disk). */
function compressedSize(image) {
  return new Promise((resolve, reject) => {
    const save = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "pipe"] });
    const gzip = zlib.createGzip({ level: 6 });
    let bytes = 0;
    let stderr = "";
    save.stderr.on("data", (d) => (stderr += d));
    gzip.on("data", (chunk) => (bytes += chunk.length));
    gzip.on("end", () => resolve(bytes));
    gzip.on("error", reject);
    save.on("error", reject);
    save.on("exit", (code) => {
      if (code !== 0) reject(new Error(`docker save ${image} exited ${code}: ${stderr.trim()}`));
    });
    save.stdout.pipe(gzip);
  });
}

const fmt = (n) => `${(n / MB).toFixed(1)} MB`;

async function main() {
  const opt = args(process.argv.slice(2));
  for (const k of ["base", "az", "bicep", "final"]) {
    if (!opt[k]) {
      console.error(`missing --${k} <image>`);
      process.exit(2);
    }
  }
  const sizes = {};
  for (const k of ["base", "az", "bicep", "final"]) {
    sizes[k] = await compressedSize(opt[k]);
    console.log(`${k.padEnd(6)} ${opt[k]}: ${fmt(sizes[k])}`);
  }
  const measured = {
    method: "docker save | gzip -6 (node zlib), bytes",
    base: sizes.base,
    azLayers: sizes.az - sizes.base,
    bicepLayer: sizes.bicep - sizes.az,
    final: sizes.final,
  };

  const failures = [];
  if (measured.azLayers > LIMITS.azLayers)
    failures.push(`the az layers add ${fmt(measured.azLayers)} (limit ${fmt(LIMITS.azLayers)})`);
  if (measured.bicepLayer > LIMITS.bicepLayer)
    failures.push(
      `the Bicep layer adds ${fmt(measured.bicepLayer)} (limit ${fmt(LIMITS.bicepLayer)})`
    );

  let recorded;
  if (opt.record && existsSync(opt.record)) {
    recorded = JSON.parse(readFileSync(opt.record, "utf8"));
    if (typeof recorded.final === "number" && measured.final > recorded.final + LIMITS.growth) {
      failures.push(
        `the image is ${fmt(measured.final)}, more than ${fmt(LIMITS.growth)} over the recorded ${fmt(recorded.final)}` +
          ` (update ${opt.record} with --write if the growth is intended)`
      );
    }
  }

  const lines = [
    "| | compressed |",
    "|---|---|",
    `| pre-az base (runtime-base) | ${fmt(measured.base)} |`,
    `| az layers A + B | ${fmt(measured.azLayers)} (limit ${fmt(LIMITS.azLayers)}) |`,
    `| Bicep layer | ${fmt(measured.bicepLayer)} (limit ${fmt(LIMITS.bicepLayer)}) |`,
    `| final image | ${fmt(measured.final)}${recorded?.final ? ` (recorded ${fmt(recorded.final)}, guard +${fmt(LIMITS.growth)})` : ""} |`,
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Image size (L5)\n\n${lines.join("\n")}\n`);
  }

  if (opt.write && opt.record) {
    const record = { ...measured, measuredAt: new Date().toISOString().slice(0, 10) };
    writeFileSync(opt.record, JSON.stringify(record, null, 2) + "\n");
    console.log(`recorded in ${opt.record}`);
  }
  if (failures.length) {
    for (const f of failures) console.error(`SIZE GATE FAIL: ${f}`);
    process.exit(1);
  }
  console.log("size gate passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
