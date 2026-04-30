import fs from "fs";
import os from "os";
import path from "path";
import {
  buildStateAnalyticsArgs,
  filterInspectServices,
  formatInspectResult,
  normalizeServices,
  validateStateManagementArgs,
} from "../../tools/localstack-state-management";

describe("localstack-state-management", () => {
  describe("normalizeServices", () => {
    it("accepts comma-delimited and array service inputs", () => {
      expect(normalizeServices("s3, lambda, s3")).toEqual(["s3", "lambda"]);
      expect(normalizeServices(["sqs", "sns", "sqs"])).toEqual(["sqs", "sns"]);
    });
  });

  describe("validateStateManagementArgs", () => {
    it("validates export with file path and services", () => {
      const filePath = path.join(os.tmpdir(), "ls-state-export-test.zip");
      const result = validateStateManagementArgs({
        action: "export",
        file_path: filePath,
        services: ["s3", "lambda"],
      } as any);

      expect(result.error).toBeUndefined();
      expect(result.outputPath).toBe(filePath);
      expect(result.serviceList).toEqual(["s3", "lambda"]);
    });

    it("requires an existing file for import and rejects service filters", () => {
      const filePath = path.join(os.tmpdir(), "ls-state-import-test.zip");
      fs.writeFileSync(filePath, "state");

      try {
        const result = validateStateManagementArgs({
          action: "import",
          file_path: filePath,
          services: "s3",
        } as any);

        expect(result.error?.content[0].text).toContain("Unsupported Service Filter");
      } finally {
        fs.unlinkSync(filePath);
      }
    });

    it("validates service-level reset", () => {
      const result = validateStateManagementArgs({
        action: "reset",
        services: ["s3", "sqs"],
      } as any);

      expect(result.error).toBeUndefined();
      expect(result.serviceList).toEqual(["s3", "sqs"]);
    });

    it("validates inspect without requiring a file path", () => {
      const result = validateStateManagementArgs({
        action: "inspect",
      } as any);

      expect(result.error).toBeUndefined();
      expect(result.serviceList).toEqual([]);
    });
  });

  describe("buildStateAnalyticsArgs", () => {
    it("does not include raw file paths or service names", () => {
      const analyticsArgs = buildStateAnalyticsArgs({
        action: "export",
        file_path: "/tmp/customer-state.zip",
        services: ["s3", "lambda"],
      } as any);

      expect(analyticsArgs).toEqual({
        action: "export",
        has_file_path: true,
        services_count: 2,
      });
      expect(JSON.stringify(analyticsArgs)).not.toContain("/tmp/customer-state.zip");
      expect(JSON.stringify(analyticsArgs)).not.toContain("lambda");
    });
  });

  describe("filterInspectServices", () => {
    it("filters account-scoped inspect data to selected services", () => {
      const filtered = filterInspectServices(
        {
          "000000000000": {
            s3: { buckets: ["test"] },
            lambda: { functions: ["fn"] },
            sqs: { queues: ["q"] },
          },
        },
        ["s3", "sqs"]
      );

      expect(filtered).toEqual({
        "000000000000": {
          s3: { buckets: ["test"] },
          sqs: { queues: ["q"] },
        },
      });
    });
  });

  describe("formatInspectResult", () => {
    it("returns filtered JSON markdown for selected services", () => {
      const result = formatInspectResult(
        {
          "000000000000": {
            s3: { buckets: ["test"] },
            lambda: { functions: ["fn"] },
          },
        },
        ["s3"]
      );

      expect(result.content[0].text).toContain("LocalStack State Inspect");
      expect(result.content[0].text).toContain('"s3"');
      expect(result.content[0].text).not.toContain('"lambda"');
    });
  });
});
