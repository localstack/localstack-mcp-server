import { sanitizeAwsCliCommand } from "./aws-cli-sanitizer";

describe("sanitizeAwsCliCommand", () => {
  test.each([
    "s3 ls",
    "dynamodb list-tables",
    "ec2 describe-instances --filters 'Name=tag:Name,Values=test instance'",
    "help",
    "version",
    "configure list",
  ])("allows supported AWS CLI input: %s", (command) => {
    expect(sanitizeAwsCliCommand(`  ${command}  `)).toBe(command);
  });

  test.each(["", "   ", "\t\n\r"])("rejects empty input", (command) => {
    expect(() => sanitizeAwsCliCommand(command)).toThrow("Command cannot be empty");
  });

  test.each([
    "s3 ls || echo injected",
    "s3 ls && echo injected",
    "s3 ls; echo injected",
    "s3 ls | tee output",
    "s3 ls &",
    "s3 ls `whoami`",
    "s3 ls $(whoami)",
    "s3 ls ${HOME}",
    "s3 ls > output",
    "s3 ls < input",
    "s3 ls\\necho injected",
    "s3 ls\necho injected",
    "s3 ls\recho injected",
    "s3 ls\techo injected",
  ])("rejects shell syntax: %s", (command) => {
    expect(() => sanitizeAwsCliCommand(command)).toThrow("forbidden shell syntax");
  });

  test.each(["s3 cp ../secret s3://bucket", "s3 cp foo/../../secret s3://bucket"])(
    "rejects path traversal: %s",
    (command) => {
      expect(() => sanitizeAwsCliCommand(command)).toThrow("forbidden path traversal");
    }
  );

  test.each(["aws s3 ls", "awslocal s3 ls", "AWS s3 ls"])(
    "rejects an explicit executable: %s",
    (command) => {
      expect(() => sanitizeAwsCliCommand(command)).toThrow("must not include");
    }
  );

  test.each(["--profile dev s3 ls", "123invalid command", "!invalid command"])(
    "rejects invalid command starts: %s",
    (command) => {
      expect(() => sanitizeAwsCliCommand(command)).toThrow("must start with");
    }
  );

  test.each(["s3 ls 'unterminated", 's3 ls "unterminated'])(
    "rejects unterminated quotes: %s",
    (command) => {
      expect(() => sanitizeAwsCliCommand(command)).toThrow("unterminated quote");
    }
  );
});
