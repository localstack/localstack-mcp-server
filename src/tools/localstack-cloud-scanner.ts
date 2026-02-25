import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { runScan } from "../lib/scoutsuite/scoutsuite-runner";
import { formatScanResults } from "../lib/scoutsuite/scoutsuite-reporter";

export const schema = {
  action: z.enum(["scan"]).describe("The action to perform."),
  services: z
    .array(z.string())
    .optional()
    .describe(
      "Optional. A list of AWS services to scan (e.g., ['s3', 'iam']). If omitted, all services are scanned."
    ),
  reportFormat: z
    .enum(["summary", "json"])
    .default("summary")
    .describe(
      "The output format. 'summary' for a human-readable report, 'json' for raw data."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-cloud-scanner",
  description:
    "Runs a Scout Suite security scan against the LocalStack environment to find cloud misconfigurations and security risks.",
  annotations: {
    title: "LocalStack Cloud Scanner",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function localstackCloudScanner({
  action,
  services,
  reportFormat,
}: InferSchema<typeof schema>) {
  const preflightError = await runPreflights([requireLocalStackRunning()]);
  if (preflightError) return preflightError;

  if (action !== "scan") {
    return ResponseBuilder.error("Unsupported Action", `Action '${action as string}' is not supported.`);
  }

  try {
    const report = await runScan(services);
    if (reportFormat === "json") {
      const jsonStr = JSON.stringify(report, null, 2);
      return ResponseBuilder.markdown("```json\n" + jsonStr + "\n```");
    }
    const markdown = formatScanResults(report);
    return ResponseBuilder.markdown(markdown);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.error("Scan Failed", message);
  }
}


