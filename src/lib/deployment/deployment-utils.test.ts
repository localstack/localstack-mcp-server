import fs from "fs";
import os from "os";
import path from "path";
import {
  inferProjectType,
  parseCdkOutputs,
  parseTerraformOutputs,
  validateVariables,
} from "./deployment-utils";

describe("deployment-utils", () => {
  describe("validateVariables", () => {
    it("should allow valid variables", () => {
      const errors = validateVariables({ key: "value", ANOTHER_KEY: "some-value-123" });
      expect(errors).toHaveLength(0);
    });
    it("should reject variables with shell metacharacters", () => {
      const errors = validateVariables({ key: "value; ls -la" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("contains forbidden character: ;");
    });
  });

  describe("parseCdkOutputs", () => {
    it("should correctly parse CDK deploy output", () => {
      const stdout = `
        Stack ARN:
        arn:aws:cloudformation:us-east-1:000000000000:stack/MyStack/abc-def

        Outputs:
        MyStack.MyBucketName = my-cdk-bucket
        MyStack.MyLambdaArn = arn:aws:lambda:us-east-1:000:function:MyLambda
      `;
      const result = parseCdkOutputs(stdout);
      expect(result).toContain("| **MyStack.MyBucketName** | `my-cdk-bucket` |");
    });
  });

  describe("parseTerraformOutputs", () => {
    it("should handle empty outputs gracefully", () => {
      const json = JSON.stringify({});
      const result = parseTerraformOutputs(json);
      expect(result).toContain("No outputs defined");
    });
  });

  describe("inferProjectType", () => {
    it("detects SAM projects via samconfig.toml", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-mcp-samcfg-"));
      fs.writeFileSync(path.join(dir, "samconfig.toml"), "version = 0.1");

      await expect(inferProjectType(dir)).resolves.toBe("sam");
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("detects SAM projects via template with AWS::Serverless resources", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-mcp-samtpl-"));
      fs.writeFileSync(
        path.join(dir, "template.yaml"),
        "Resources:\n  MyFunction:\n    Type: AWS::Serverless::Function\n"
      );

      await expect(inferProjectType(dir)).resolves.toBe("sam");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
