import fs from "fs";
import os from "os";
import path from "path";
import { assertLocalPathsAllowed, awsWorkdir } from "./local-paths";

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
    fs.symlinkSync(outside, path.join(workdir, "escape"));
  });
  afterAll(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const allowed = (cmd: string, dir: string | null = workdir) =>
    assertLocalPathsAllowed(cmd.split(" "), dir, { home });

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
  ])("refuses: %s", (cmd) => {
    expect(() => allowed(cmd)).toThrow(/outside the AWS client's working directory/);
  });

  test("without a workdir, every absolute path is refused and relative ones stay private", () => {
    expect(() => allowed("s3 cp in.txt s3://b/k", null)).not.toThrow();
    expect(() => allowed("s3 cp /tmp/x s3://b/k", null)).toThrow(/no working directory/);
  });
});
