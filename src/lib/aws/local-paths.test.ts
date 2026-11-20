import fs from "fs";
import os from "os";
import path from "path";
import { assertLocalPathsAllowed, awsWorkdir, confineTransfers } from "./local-paths";

describe("awsWorkdir", () => {
  test("is LOCALSTACK_AWS_WORKDIR when it is a directory, else an error", () => {
    const dir = fs.realpathSync(os.tmpdir());
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: dir })).toEqual({ workdir: dir });
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: path.join(dir, "no-such-dir-x") })).toMatchObject({
      workdir: null,
      error: expect.stringContaining("not an existing directory"),
    });
  });

  test("refuses / and the home directory as LOCALSTACK_AWS_WORKDIR", () => {
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: "/" }).error).toContain("must not be /");
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: os.homedir() }).error).toContain("must not be /");
  });

  test("is the server's directory, but none in Docker, in / or in the home directory", () => {
    const cwd = fs.realpathSync(os.tmpdir());
    const home = fs.realpathSync(os.homedir());
    expect(awsWorkdir({}, { cwd, home, inDocker: false })).toEqual({ workdir: cwd });
    expect(awsWorkdir({}, { cwd, home, inDocker: true })).toEqual({ workdir: null });
    expect(awsWorkdir({}, { cwd: "/", home, inDocker: false })).toEqual({ workdir: null });
    expect(awsWorkdir({}, { cwd: home, home, inDocker: false })).toEqual({ workdir: null });
  });
});

describe("assertLocalPathsAllowed", () => {
  let workdir: string;
  let outside: string;
  const home = "/home/someone";

  beforeAll(() => {
    workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-workdir-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-outside-")));
    fs.writeFileSync(path.join(workdir, "in.txt"), "x");
    fs.writeFileSync(path.join(outside, "key.pem"), "secret");
    fs.symlinkSync(outside, path.join(workdir, "escape"));
  });
  afterAll(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const allowed = (cmd: string, dir: string | null = workdir) =>
    assertLocalPathsAllowed(cmd.split(" "), dir, {
      home,
      cwd: path.join(outside, "tmp"),
      privateHome: path.join(outside, "home"),
      // The CLI's environment always holds an empty variable.
      env: {
        AWS_PAGER: "",
        HOME: path.join(outside, "home"),
        TMPDIR: path.join(outside, "tmp"),
        PYTHONUNBUFFERED: "1",
      },
      platform: "linux",
    });

  test.each([
    "s3 cp in.txt s3://b/in.txt",
    "s3 cp s3://b/k out/new.txt",
    "s3 cp IN/in.txt s3://b/k",
    "lambda invoke --function-name f --payload fileb://in.txt out.json",
    "logs filter-log-events --log-group-name /aws/lambda/f",
    "ssm get-parameter --name /prod/db/password",
    "iam create-role --role-name r --path / --assume-role-policy-document file://in.txt",
    "s3api list-objects-v2 --bucket b --prefix /logs/",
    "s3api put-object --bucket b --key /a/b --body in.txt",
    "lambda invoke --function-name f --payload {} out.json",
    "lambda create-function --function-name f --code ZipFile@=fileb://in.txt",
    "ecs run-task --task-definition web:3",
    // Names whose first directory is not on this machine.
    "ssm get-parameters --names /a/b /c/d",
    "sns publish --topic-arn t --message /hello",
    "cloudfront create-invalidation --distribution-id X --paths /index.html /about.html",
    "s3api put-object --bucket b --key /etc-like/key --body in.txt",
    // Neither the path nor its parent exists: the CLI can neither read nor write it.
    "ssm get-parameter --name /dev/db/password",
    "logs create-log-group --log-group-name /tmp/no-such-dir-x/app",
    // A variable the CLI does not know stays as written; JSONata names one in every expression.
    "stepfunctions create-state-machine --name m --role-arn r --definition {%$states.input%}",
    "sns publish --topic-arn t --message price-$5",
    // CloudFormation and VTL references are not environment variables.
    "cloudformation validate-template --template-body Value:!Sub${AWS::Region}-${MyParam}",
    "apigateway put-integration --request-templates application/json=$input.body",
    "s3api put-object --bucket b --key $FOO/x --body in.txt",
  ])("allows: %s", (cmd) => {
    expect(() => allowed(cmd.replace("IN", workdir))).not.toThrow();
  });

  test.each([
    "s3 cp /etc/hosts s3://b/k",
    "s3 cp --recursive /etc s3://b/k",
    "s3 sync --delete / s3://b",
    "s3 cp s3://b/k ~/.zshrc",
    "s3 cp s3://b/k ~root/.ssh/authorized_keys",
    "s3 cp s3://b/k --quiet /tmp/new-file",
    "s3api get-object --bucket b --key k /tmp/out",
    "s3api put-object --bucket b --key k --body /etc/hosts",
    "s3api put-object --bucket b --key k --body=/etc/hosts",
    "lambda invoke --function-name f --payload file:///etc/hosts out.json",
    "sqs send-message --queue-url q --message-body FILE://~/.aws/credentials",
    "s3api put-object --bucket b --key k --body escape/secret",
    "lambda create-function --function-name f --zip-file fileb://escape/x.zip",
    "eks update-kubeconfig --name c --kubeconfig ../x",
    "gamelift upload-build --name b --build-root escape",
    "servicecatalog generate provisioning-artifact --file-path OUT/key.pem --bucket-name b",
    "ec2 get-password-data --instance-id i-1 --priv-launch-key OUT/key.pem",
    "cloudfront sign --url u --key-pair-id k --private-key OUT/key.pem --date-less-than 1",
    "gamelift get-game-session-log --game-session-id g --save-as OUT/log.zip",
    "cloudtrail verify-query-results --local-export-path OUT/x",
    "lambda-web deploy --code OUT",
    "ecs deploy --service s --task-definition OUT/td.json --codedeploy-appspec OUT/a.json",
    "lambda create-function --function-name f --code ZipFile@=fileb://OUT/x.zip",
    "sqs send-message --queue-url q --message-attributes a={DataType=Binary,BinaryValue@=fileb://OUT/key.pem}",
    "s3api head-object --bucket b --key OUT/key.pem",
    "s3 cp ../x s3://b/k",
    "s3 cp s3://b/k sub/../../x",
    "s3 cp escape/secret s3://b/k",
    "s3 cp s3://b/k --quiet ../outside-new",
    "s3 cp --region us-east-1 escape s3://b/k",
    // An abbreviated --public-key-outfile, writing a new file in an existing directory.
    "iot create-keys-and-certificate --public-key OUT/new.fish",
    "iot create-keys-and-certificate --public-key ~/new.fish",
    "s3 sync / s3://b",
  ])("refuses: %s", (cmd) => {
    expect(() => allowed(cmd.replace(/OUT/g, outside))).toThrow(
      /outside the AWS client's working directory/
    );
  });

  test.each([
    // Anywhere in a value: /$AWS_PAGER/x is //x to the CLI, .$AWS_PAGER./x is ../x.
    "s3api put-object --bucket b --key k --body /$AWS_PAGER/x",
    "s3api put-object --bucket b --key k --body /${AWS_PAGER}x",
    "iam create-virtual-mfa-device --virtual-mfa-device-name x --outfile /$AWS_PAGER/x",
    "s3api put-object --bucket b --key k --body .$AWS_PAGER./x",
    "ssm put-parameter --name p --value file://.$AWS_PAGER./x",
    "iam create-virtual-mfa-device --outfile $HOME/.aws/cli/alias",
    "iam create-virtual-mfa-device --outfile ${HOME}/x",
    "iam create-virtual-mfa-device --outfile file://$TMPDIR/x",
    // lstk sets PYTHONUNBUFFERED=1 and its own AWS_* values; it may set more of its kind.
    "s3api put-object --bucket b --key k --body /x/dir$PYTHONUNBUFFERED/secret",
    "s3api put-object --bucket b --key k --body x$AWS_ACCESS_KEY_ID",
    "s3api put-object --bucket b --key k --body .$LSTK_SOMETHING./x",
    "s3api put-object --bucket b --key k --body /$LOCALSTACK_X/x",
  ])("refuses a variable the CLI may replace: %s", (cmd) => {
    expect(() => allowed(cmd)).toThrow("the AWS CLI would replace");
  });

  test("on Windows, %VAR% and names in any case are variables too", () => {
    const win = (value: string) =>
      assertLocalPathsAllowed(["s3api", "put-object", "--body", value], workdir, {
        env: { PATH: "C:\\Windows" },
        platform: "win32",
      });
    expect(() => win("x%path%y")).toThrow("would replace %path%");
    expect(() => win("x$Path")).toThrow("would replace $Path");
    expect(() => win("x%aws_region%")).toThrow("would replace");
    expect(() => win("50%off%")).not.toThrow();
  });

  test("without a workdir, every absolute path is refused and relative ones stay private", () => {
    expect(() => allowed("s3 cp in.txt s3://b/k", null)).not.toThrow();
    expect(() => allowed("s3 cp /tmp/x s3://b/k", null)).toThrow(/no working directory/);
    // The private home sits next to the private temp dir.
    expect(() => allowed("s3 cp s3://b/alias ../home/.aws/cli/alias", null)).toThrow(
      /no working directory/
    );
  });

  test("~ is checked as the private home the CLI expands it to", () => {
    // With the workdir under the real home, ~/<workdir> would pass a check that used it.
    const realHome = path.dirname(workdir);
    const cmd = ["s3", "cp", "s3://b/k", `~/${path.basename(workdir)}/x`];
    expect(() =>
      assertLocalPathsAllowed(cmd, workdir, { home: realHome, cwd: workdir, platform: "linux" })
    ).not.toThrow();
    expect(() =>
      assertLocalPathsAllowed(cmd, workdir, {
        home: realHome,
        privateHome: path.join(outside, "home"),
        platform: "linux",
      })
    ).toThrow(/outside the AWS client's working directory/);
  });

  test.each([".git/config", ".git/hooks/pre-commit", "sub/.GIT/config", ".lstk/config.toml"])(
    "refuses paths into .git and .lstk: %s",
    (p) => {
      expect(() => allowed(`s3api get-object --bucket b --key k ${p}`)).toThrow(
        "files in .git and .lstk configure programs"
      );
      expect(() => allowed(`ssm put-parameter --name p --value file://${p}`)).toThrow(
        "files in .git and .lstk"
      );
    }
  );

  test("the private home stays off limits inside a broad workdir", () => {
    expect(() =>
      assertLocalPathsAllowed(["s3", "cp", "s3://b/k", "home/x"], outside, {
        home,
        privateHome: path.join(outside, "home"),
      })
    ).toThrow(/outside the AWS client's working directory/);
  });

  const PROTECTED = [
    "--exclude",
    "[.][Gg][Ii][Tt]/*",
    "--exclude",
    "*/[.][Gg][Ii][Tt]/*",
    "--exclude",
    "[.][Ll][Ss][Tt][Kk]/*",
    "--exclude",
    "*/[.][Ll][Ss][Tt][Kk]/*",
  ];

  test.each([
    ["s3", "cp", "s3://b/a[x]/", ".", "--recursive"],
    ["s3", "sync", "s3://b/p?/", "."],
    ["s3", "sync", "s3://b", "dir*", "--delete"],
    ["s3", "mv", "s3://b/k", "x]"],
  ])("refuses glob characters that would defuse the filters: %j", (...args) => {
    expect(() => confineTransfers(args)).toThrow("take no *, ?, [ or ]");
  });

  test("filters keep their glob patterns", () => {
    expect(() =>
      confineTransfers(["s3", "sync", ".", "s3://b", "--exclude", "*.tmp", "--include=a?[0-9]"])
    ).not.toThrow();
    expect(() => confineTransfers(["s3", "cp", ".", "s3://b", "--exc", "*"])).not.toThrow();
  });

  test("local transfers get --no-follow-symlinks and skip .git and .lstk, last", () => {
    expect(confineTransfers(["s3", "--region", "x", "sync", ".", "s3://b"])).toEqual([
      "s3",
      "--region",
      "x",
      "sync",
      ".",
      "s3://b",
      "--no-follow-symlinks",
      ...PROTECTED,
    ]);
    expect(confineTransfers(["s3", "ls"])).toEqual(["s3", "ls"]);
    for (const flag of ["--follow-symlinks", "--follow-sym", "--fol", "--FOLLOW"]) {
      expect(() =>
        confineTransfers(["s3", "cp", ".", "s3://b", "--no-follow-symlinks", flag])
      ).toThrow("not allowed");
    }
    // Always last, since the last of the two flags wins.
    expect(
      confineTransfers(["s3", "cp", "--no-follow-symlinks", ".", "s3://b", "--include", "*"])
    ).toEqual([
      "s3",
      "cp",
      "--no-follow-symlinks",
      ".",
      "s3://b",
      "--include",
      "*",
      "--no-follow-symlinks",
      ...PROTECTED,
    ]);
  });
});
