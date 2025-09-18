import fs from "fs";
import os from "os";
import path from "path";
import { runCommand } from "../../core/command-runner";

/**
 * Execute Scout Suite scan via Docker and return the parsed report JSON.
 */
export async function runScan(services?: string[]): Promise<any> {
  const tmpBase = path.join(os.tmpdir(), "scout-report-");
  const tempDirPath = await fs.promises.mkdtemp(tmpBase);

  try {
    const args: string[] = [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--add-host=host.docker.internal:host-gateway",
      "--add-host=000000000000.host.docker.internal:host-gateway",
      "-e",
      "AWS_ACCESS_KEY_ID=test",
      "-e",
      "AWS_SECRET_ACCESS_KEY=test",
      "-e",
      "AWS_DEFAULT_REGION=us-east-1",
      "-e",
      "AWS_ENDPOINT_URL=http://host.docker.internal:4566",
      "-e",
      "AWS_EC2_METADATA_DISABLED=true",
      "-v",
      `${tempDirPath}:/root/scout-report`,
      "rossja/ncc-scoutsuite",
      "scout",
      "aws",
      "--no-browser",
      "--report-dir",
      "/root/scout-report",
    ];

    if (services && services.length > 0) {
      const normalized = services
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.toLowerCase());
      if (normalized.length > 0) {
        args.push("--services", normalized.join(","));
      }
    }

    const result = await runCommand("docker", args, { timeout: 600000 });

    // Results are written inside the container to /root/scout-report/scoutsuite-results
    // which maps directly to the host path <tempDirPath>/scoutsuite-results
    const resultsDir = path.join(tempDirPath, "scoutsuite-results");
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(resultsDir);
    } catch {}

    const resultsJs = entries.find((f) => f.startsWith("scoutsuite_results_aws-") && f.endsWith(".js"));
    if (resultsJs) {
      const full = path.join(resultsDir, resultsJs);
      const jsContent = await fs.promises.readFile(full, "utf-8");
      const firstBrace = jsContent.indexOf("{");
      const lastBrace = jsContent.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonSlice = jsContent.slice(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(jsonSlice);
        return parsed;
      }
    }

    const errorsJson = entries.find((f) => f.startsWith("scoutsuite_errors_aws-") && f.endsWith(".json"));
    if (errorsJson) {
      const full = path.join(resultsDir, errorsJson);
      const errorsContent = await fs.promises.readFile(full, "utf-8");
      try {
        return JSON.parse(errorsContent);
      } catch {}
    }

    if (result.error) {
      throw result.error;
    }
    throw new Error("Scout Suite report not found after execution");
  } finally {
    await fs.promises.rm(tempDirPath, { recursive: true, force: true });
  }
}


