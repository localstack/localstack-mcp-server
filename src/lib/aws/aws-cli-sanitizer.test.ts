import { sanitizeAwsCliCommand, splitAwsCliArgs } from "./aws-cli-sanitizer";

describe("sanitizeAwsCliCommand", () => {
  test.each([
    "s3 ls",
    "dynamodb list-tables",
    "ec2 describe-instances --filters 'Name=tag:Name,Values=test instance'",
    "s3api head-object --bucket test --key 'price$2026.txt'",
    String.raw`s3api head-object --bucket test --key 'folder\file$2026.txt'`,
    "s3\tls",
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
    "s3 ls\necho injected",
    "s3 ls\recho injected",
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

  test.each([
    "s3 ls --endpoint-url https://s3.amazonaws.com",
    "s3 ls --endpoint-url=https://s3.amazonaws.com",
    "s3 ls --profile prod",
    "sts get-caller-identity --PROFILE=prod",
    "sqs list-queues --endp https://sqs.us-east-1.amazonaws.com --pro prod",
    "sqs list-queues --e=https://sqs.us-east-1.amazonaws.com",
    "sqs list-queues --endpoint-ur=https://sqs.us-east-1.amazonaws.com",
    "sqs list-queues --endpoint https://sqs.us-east-1.amazonaws.com",
    "s3 ls --profil=prod",
    "s3 ls --p prod",
  ])("rejects options that leave LocalStack: %s", (command) => {
    expect(() => sanitizeAwsCliCommand(command)).toThrow("commands always target LocalStack");
  });

  test.each([
    "s3 ls --page-size 10",
    "s3api list-objects --bucket b --prefix logs/",
    "sns subscribe --topic-arn t --protocol email --notification-endpoint a@b.c",
    "ec2 describe-instances --e-tag-x y --region eu-west-1 --output json --debug",
  ])("allows options that are not prefixes of --endpoint-url or --profile: %s", (command) => {
    expect(sanitizeAwsCliCommand(command)).toBe(command);
  });

  test.each([
    "update",
    "login",
    "sso login --profile x",
    "SSO LOGIN",
    "history show",
    "ssm start-session --target i-1",
    "ecs execute-command --cluster c --task t --interactive --command sh",
    "codeartifact login --tool npm --domain d --repository r",
    "eks update-kubeconfig --name c",
    "cloudformation package --template-file t.yaml --s3-bucket b",
    "deploy install --config-file c",
    "agent-toolkit list-installed-skills",
    "wizard",
    "logs start-live-tail --log-group-identifiers g",
    "logs tail /aws/lambda/f --follow",
  ])("refuses commands that act on this machine: %s", (command) => {
    expect(() => sanitizeAwsCliCommand(command)).toThrow(/not allowed|always target LocalStack/);
  });

  test.each([
    "sso list-accounts --access-token t",
    "ssm get-parameter --name p",
    "eks list-clusters",
  ])("allows the API commands of those services: %s", (command) => {
    expect(sanitizeAwsCliCommand(command)).toBe(command);
  });

  test("refuses a leading lstk", () => {
    expect(() => sanitizeAwsCliCommand("lstk aws s3 ls")).toThrow("must not include");
  });

  test.each(["configure", "configure set region eu-west-1", "configure export-credentials"])(
    "rejects configure other than list: %s",
    (command) => {
      expect(() => sanitizeAwsCliCommand(command)).toThrow("Only 'configure list'");
    }
  );

  test.each(["help", "s3 help", "s3 ls help", "sqs list-queues --help", "s3api -h"])(
    "allows a help request: %s",
    (command) => {
      expect(sanitizeAwsCliCommand(command)).toBe(command);
    }
  );

  test.each([
    "sqs list-queues --queue-name-prefix help",
    "sqs send-message --queue-url q --message-body help",
    "s3 cp help s3://bucket/key",
    "sqs list-queues help --region eu-west-1",
    "sqs list-queues --help --endpoint-url-x y",
    "s3api put-object --bucket b --key '--help'",
  ])("rejects a help token that is not a pure help request: %s", (command) => {
    expect(() => sanitizeAwsCliCommand(command)).toThrow("may only end a help request");
  });

  test.each(["s3 ls 'unterminated", 's3 ls "unterminated'])(
    "rejects unterminated quotes: %s",
    (command) => {
      expect(() => sanitizeAwsCliCommand(command)).toThrow("unterminated quote");
    }
  );

  test("parses escaped JSON, dollar signs, backslashes, and tabs as argv", () => {
    const command = String.raw`s3api put-object	--cli-input-json "{\"Bucket\":\"test\",\"Key\":\"folder\\price$2026.txt\"}"`;

    expect(sanitizeAwsCliCommand(command)).toBe(command);
    expect(splitAwsCliArgs(command)).toEqual([
      "s3api",
      "put-object",
      "--cli-input-json",
      '{"Bucket":"test","Key":"folder\\price$2026.txt"}',
    ]);
  });

  test("allows shell metacharacters inside quoted argument values", () => {
    const command = `dynamodb put-item --item '{":value":{"S":"a|b;$c"}}'`;

    expect(splitAwsCliArgs(sanitizeAwsCliCommand(command))).toEqual([
      "dynamodb",
      "put-item",
      "--item",
      '{":value":{"S":"a|b;$c"}}',
    ]);
  });
});
