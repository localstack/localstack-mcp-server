import fs from "fs";
import os from "os";
import path from "path";
import { runCommand, CommandResult } from "../../core/command-runner";
import {
  checkDependencies,
  inferProjectType,
  parseCdkOutputs,
  parseTerraformOutputs,
  validateVariables,
} from "./deployment-utils";

jest.mock("../../core/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

describe("deployment-utils", () => {
  describe("checkDependencies", () => {
    beforeEach(() => mockedRunCommand.mockReset());

    it("requires lstk before the wrapped IaC CLI", async () => {
      mockedRunCommand.mockResolvedValueOnce(result({ error: new Error("spawn lstk ENOENT") }));

      const check = await checkDependencies("terraform");

      expect(check.isAvailable).toBe(false);
      expect(check.tool).toBe("lstk");
      expect(check.errorMessage).toContain("npm install -g @localstack/lstk");
      expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    });

    it("requires the IaC CLI lstk wraps", async () => {
      mockedRunCommand
        .mockResolvedValueOnce(result({ stdout: "lstk 1.4.2\n" }))
        .mockResolvedValueOnce(result({ error: new Error("spawn sam ENOENT") }));

      const check = await checkDependencies("sam");

      expect(check.isAvailable).toBe(false);
      expect(check.tool).toBe("sam");
      expect(mockedRunCommand).toHaveBeenLastCalledWith("sam", ["--version"], expect.anything());
    });

    it("reports both versions when lstk and the IaC CLI are installed", async () => {
      mockedRunCommand
        .mockResolvedValueOnce(result({ stdout: "lstk 1.4.2\n" }))
        .mockResolvedValueOnce(result({ stdout: "Terraform v1.13.0\non darwin_arm64\n" }));

      const check = await checkDependencies("terraform");

      expect(check).toEqual({
        isAvailable: true,
        tool: "lstk terraform",
        version: "lstk 1.4.2; Terraform v1.13.0",
      });
      expect(mockedRunCommand).toHaveBeenLastCalledWith(
        "terraform",
        ["version"],
        expect.anything()
      );
    });
  });

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

    it("should parse CDK deploy output with CRLF (\\r\\n) line endings", () => {
      // Captured child-process stdout on Windows can use CRLF, leaving a
      // trailing \r on each line when split naively on \n.
      const stdout = [
        "Stack ARN:",
        "arn:aws:cloudformation:us-east-1:000000000000:stack/MyStack/abc-def",
        "",
        "Outputs:",
        "MyStack.MyBucketName = my-cdk-bucket",
        "MyStack.MyLambdaArn = arn:aws:lambda:us-east-1:000:function:MyLambda",
      ].join("\r\n");

      const result = parseCdkOutputs(stdout);

      expect(result).not.toContain("No outputs defined");
      expect(result).toContain("| **MyStack.MyBucketName** | `my-cdk-bucket` |");
      expect(result).toContain(
        "| **MyStack.MyLambdaArn** | `arn:aws:lambda:us-east-1:000:function:MyLambda` |"
      );
    });

    it("should parse CDK outputs with flexible spacing around equals signs", () => {
      const stdout = ["Outputs:", "MyStack.Compact=value", "MyStack.Spaced   =   other"].join("\n");

      const result = parseCdkOutputs(stdout);

      expect(result).toContain("| **MyStack.Compact** | `value` |");
      expect(result).toContain("| **MyStack.Spaced** | `other` |");
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
