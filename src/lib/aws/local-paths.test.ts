import fs from "fs";
import os from "os";
import path from "path";
import { assertLocalPathsAllowed, awsWorkdir, withoutFollowingSymlinks } from "./local-paths";

describe("awsWorkdir", () => {
  test("is LOCALSTACK_AWS_WORKDIR when it is a directory, else an error", () => {
    const dir = fs.realpathSync(os.tmpdir());
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: dir })).toEqual({ workdir: dir });
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: path.join(dir, "no-such-dir-x") })).toMatchObject({
      workdir: null,
      error: expect.stringContaining("not an existing directory"),
    });
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
    "ssm get-parameters --names /a /b",
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
  ])("refuses: %s", (cmd) => {
    expect(() => allowed(cmd.replace(/OUT/g, outside))).toThrow(
      /outside the AWS client's working directory/
    );
  });

  test("without a workdir, every absolute path is refused and relative ones stay private", () => {
    expect(() => allowed("s3 cp in.txt s3://b/k", null)).not.toThrow();
    expect(() => allowed("s3 cp /tmp/x s3://b/k", null)).toThrow(/no working directory/);
    // The private home sits next to the private temp dir.
    expect(() => allowed("s3 cp s3://b/alias ../home/.aws/cli/alias", null)).toThrow(
      /no working directory/
    );
  });

  test("the private home stays off limits inside a broad workdir", () => {
    expect(() =>
      assertLocalPathsAllowed(["s3", "cp", "s3://b/k", "home/x"], outside, {
        home,
        privateHome: path.join(outside, "home"),
      })
    ).toThrow(/outside the AWS client's working directory/);
  });

  test("local transfers get --no-follow-symlinks, and --follow-symlinks is refused", () => {
    expect(withoutFollowingSymlinks(["s3", "--region", "x", "sync", ".", "s3://b"])).toEqual([
      "s3",
      "--region",
      "x",
      "sync",
      ".",
      "s3://b",
      "--no-follow-symlinks",
    ]);
    expect(withoutFollowingSymlinks(["s3", "ls"])).toEqual(["s3", "ls"]);
    expect(() =>
      withoutFollowingSymlinks(["s3", "cp", ".", "s3://b", "--follow-symlinks"])
    ).toThrow("not allowed");
  });
});
