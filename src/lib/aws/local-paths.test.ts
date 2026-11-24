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
    // Only --website-redirect's value may be a name to s3 cp, mv and sync.
    "s3 cp in.txt s3://b/k --website-redirect /index.html",
    "s3 cp in.txt s3://b/k --website-redirect=/no-such-dir-x/a.html",
    "s3 sync . s3://b --website /index.html",
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
    // Inline documents: CloudFormation, VTL and JSONata references are no paths.
    'apigateway put-integration --request-templates {"application/json":"$input.body"}',
    "cloudformation create-stack --stack-name s --template-body Resources:\n_Q:_!Sub_${AWS::Region}",
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
    // s3 cp, mv and sync create the directories above a local path: no positional is a name.
    "s3 cp s3://b/k /no-such-dir-x/index.js",
    "s3 sync s3://b/pre/ /no-such-dir-x",
    "s3 mv s3://b/k /no-such-dir-x/a/b",
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
    // lstk and the CLI's launcher add variables the server cannot know.
    "s3api put-object --bucket b --key k --body /x/dir$PYTHONUNBUFFERED/secret",
    "s3api put-object --bucket b --key k --body link$_PYI_PARENT_PROCESS_LEVEL/victim.txt",
    "iot create-keys-and-certificate --certificate-pem-outfile $_PYI_ARCHIVE_FILE",
    "sqs send-message --queue-url q --message-body file://link$_PYI_PARENT_PROCESS_LEVEL/v",
    "s3api put-object --bucket b --key k --body .$ANYTHING./x",
    // An inline document is exempt, a file:// path never.
    "sqs send-message --queue-url q --message-body file://{$X}",
  ])("refuses a variable the CLI may replace: %s", (cmd) => {
    expect(() => allowed(cmd)).toThrow("the AWS CLI would replace");
  });

  test("on Windows, %VAR% is a variable too", () => {
    const win = (value: string) =>
      assertLocalPathsAllowed(["s3api", "put-object", "--body", value], workdir, {
        platform: "win32",
      });
    expect(() => win("x%path%y")).toThrow("would replace %path%");
    expect(() => win("x$Path")).toThrow("would replace $Path");
    expect(() => win("50%")).not.toThrow();
  });

  // Windows reads `C://Users/x` as C:\Users\x. The variable shows the value is checked as a path
  // on any platform; on Windows the path itself is refused too.
  test.each(["C://Users/joe/$X", "c://Users/joe/$X", "S3://b/$X"])(
    "checks a drive path or an upper-case scheme as a path: %s",
    (value) => {
      expect(() => allowed(`s3 cp ${value} s3://b/k`)).toThrow("the AWS CLI would replace");
    }
  );

  test.each(["s3://b/$k", "https://example.com/$x"])(
    "does not check a URL as a path: %s",
    (value) => {
      expect(() => allowed(`sqs send-message --queue-url q --message-body ${value}`)).not.toThrow();
    }
  );

  (process.platform === "win32" ? test : test.skip)(
    "on Windows, refuses a drive path outside the workdir",
    () => {
      expect(() => allowed("s3 cp C://Windows/win.ini s3://b/k")).toThrow(/outside|not allowed/);
    }
  );

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

  test.each([
    ".git/config",
    ".git/hooks/pre-commit",
    "sub/.GIT/config",
    ".lstk/config.toml",
    ".git",
    // What a case-insensitive file system takes for .lstk: ſ is s, the Kelvin sign is k.
    ".l\u017ftk/config.toml",
    ".lst\u212a/config.toml",
    // What Windows opens as .git: trailing dots and spaces, a stream, the 8.3 short name.
    ".git./config",
    ".git /config",
    ".git:stream/config",
    "git~1/config",
    "LSTK~1/config.toml",
  ])("refuses paths into .git and .lstk: %s", (p) => {
    expect(() => allowed(`s3api get-object --bucket b --key k ${p}`)).toThrow(
      "files in .git and .lstk configure programs"
    );
    expect(() => allowed(`ssm put-parameter --name p --value file://${p}`)).toThrow(
      "files in .git and .lstk"
    );
  });

  test.each([".github/workflows/ci.yml", ".gitignore", "git~x", ".git-blame-ignore-revs"])(
    "allows names that only look like .git: %s",
    (p) => {
      expect(() => allowed(`s3api get-object --bucket b --key k ${p}`)).not.toThrow();
    }
  );

  test("a path inside the home whose parent is missing is no name: a command may create it", () => {
    const realHome = outside;
    const target = path.join(realHome, ".no-such-agent", "skills");
    const check = (p: string) =>
      assertLocalPathsAllowed(["agent-registry", "x", "--target-directory", p], workdir, {
        home: realHome,
        privateHome: path.join(os.tmpdir(), "no-such-private-home"),
        platform: "linux",
      });
    expect(() => check(target)).toThrow(/outside the AWS client's working directory/);
    // Outside a home, it still is one.
    expect(() => check("/tmp/no-such-dir-x/app")).not.toThrow();
  });

  test.each(["//server/share/new/f", "//server/share"])(
    "refuses a network share before touching it: %s",
    (p) => {
      expect(() => allowed(`s3api get-object --bucket b --key k ${p}`)).toThrow(
        /outside the AWS client's working directory/
      );
    }
  );

  test("to s3 transfers, only s3:// is a URL", () => {
    expect(() => allowed("s3 cp s3://b/k zz://x/.git/config")).toThrow("files in .git and .lstk");
    expect(() => allowed("s3 cp s3://b/k https://x/$HOME")).toThrow("the AWS CLI would replace");
  });

  test("the private home stays off limits inside a broad workdir", () => {
    expect(() =>
      assertLocalPathsAllowed(["s3", "cp", "s3://b/k", "home/x"], outside, {
        home,
        privateHome: path.join(outside, "home"),
      })
    ).toThrow(/outside the AWS client's working directory/);
  });

  const PROTECTED = ["[Gg][Ii][Tt]", "[Ll][Ss\u017f][Tt][Kk\u212a]"]
    .flatMap((name) => [`[.]${name}`, `[.]${name}[. :]*`, `${name}~[0-9]*`])
    .flatMap((alias) => [alias, `*/${alias}`, `${alias}/*`, `*/${alias}/*`])
    .flatMap((p) => ["--exclude", p]);

  test.each(["s3://b/.git", "s3://b/p/.lstk/", "s3://b/.l\u017ftk"])(
    "refuses a transfer of a .git or .lstk object: %s",
    (source) => {
      expect(() => confineTransfers(["s3", "cp", source, "."], workdir)).toThrow(
        "files in .git and .lstk"
      );
    }
  );

  test.each([
    ["s3", "cp", "s3://b/a[x]/", ".", "--recursive"],
    ["s3", "sync", "s3://b/p?/", "."],
    ["s3", "sync", "s3://b", "dir*", "--delete"],
    ["s3", "mv", "s3://b/k", "x]"],
  ])("refuses glob characters that would defuse the filters: %j", (...args) => {
    expect(() => confineTransfers(args, workdir)).toThrow("take no *, ?, [ or ]");
  });

  test("refuses transfers when the working directory's path holds a glob character", () => {
    expect(() => confineTransfers(["s3", "sync", "s3://b", "."], "/tmp/w[1]")).toThrow(
      "has *, ?, [ or ] in its path"
    );
    expect(confineTransfers(["s3", "ls"], "/tmp/w[1]")).toEqual(["s3", "ls"]);
  });

  test("filters keep their glob patterns", () => {
    expect(() =>
      confineTransfers(
        ["s3", "sync", ".", "s3://b", "--exclude", "*.tmp", "--include=a?[0-9]"],
        workdir
      )
    ).not.toThrow();
    expect(() =>
      confineTransfers(["s3", "cp", ".", "s3://b", "--exc", "*"], workdir)
    ).not.toThrow();
  });

  test("local transfers get --no-progress, --no-follow-symlinks and skip .git and .lstk, last", () => {
    expect(confineTransfers(["s3", "--region", "x", "sync", ".", "s3://b"], workdir)).toEqual([
      "s3",
      "--region",
      "x",
      "sync",
      ".",
      "s3://b",
      "--no-progress",
      "--no-follow-symlinks",
      ...PROTECTED,
    ]);
    expect(confineTransfers(["s3", "ls"], workdir)).toEqual(["s3", "ls"]);
    for (const flag of ["--follow-symlinks", "--follow-sym", "--fol", "--FOLLOW"]) {
      expect(() =>
        confineTransfers(["s3", "cp", ".", "s3://b", "--no-follow-symlinks", flag], workdir)
      ).toThrow("not allowed");
    }
    // Always last, since the last of the two flags wins.
    expect(
      confineTransfers(
        ["s3", "cp", "--no-follow-symlinks", ".", "s3://b", "--include", "*"],
        workdir
      )
    ).toEqual([
      "s3",
      "cp",
      "--no-follow-symlinks",
      ".",
      "s3://b",
      "--include",
      "*",
      "--no-progress",
      "--no-follow-symlinks",
      ...PROTECTED,
    ]);
  });
});
