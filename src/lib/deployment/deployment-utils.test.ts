import { parseCdkOutputs, parseTerraformOutputs, validateVariables } from "./deployment-utils";

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
});
