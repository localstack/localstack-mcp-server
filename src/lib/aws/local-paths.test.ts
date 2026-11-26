import fs from "fs";
import os from "os";
import path from "path";
import {
  assertLocalPathsAllowed,
  awsWorkdir,
  confineTransfers,
  isTooWideToAllow,
  OutsideWorkdirError,
} from "./local-paths";

describe("awsWorkdir", () => {
  test("is LOCALSTACK_AWS_WORKDIR when it is a directory, else an error", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-wd-")));
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: dir })).toEqual({ workdir: dir });
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: path.join(dir, "no-such-dir-x") })).toMatchObject({
      workdir: null,
      error: expect.stringContaining("not an existing directory"),
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refuses the temp directory and above it: the private home lies there", () => {
    const tmp = fs.realpathSync(os.tmpdir());
    for (const dir of [tmp, path.dirname(tmp)]) {
      expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: dir }).error).toContain("temp directory");
      expect(awsWorkdir({}, { cwd: dir, inDocker: false })).toEqual({ workdir: null });
    }
  });

  (fs.existsSync("/private/var") ? test : test.skip)(
    "refuses /private, which holds the temp directory under its other name (macOS)",
    () => {
      expect(fs.realpathSync(os.tmpdir()).startsWith("/private/")).toBe(true);
      expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: "/private" }).error).toContain("temp directory");
      expect(isTooWideToAllow("/private")).toBe(true);
    }
  );

  test("refuses the real directory that holds a home reached through a symlink", () => {
    const hp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-homelink-")));
    try {
      fs.mkdirSync(path.join(hp, "data", "joe"), { recursive: true });
      fs.symlinkSync(path.join(hp, "data", "joe"), path.join(hp, "joe"));
      const home = path.join(hp, "joe");
      expect(
        awsWorkdir({ LOCALSTACK_AWS_WORKDIR: path.join(hp, "data") }, { home }).error
      ).toContain("hold your home directory");
    } finally {
      fs.rmSync(hp, { recursive: true, force: true });
    }
  });

  (fs.existsSync("/System/Volumes/Data/Users") ? test : test.skip)(
    "refuses the home directory under another name (macOS firmlinks)",
    () => {
      const home = fs.realpathSync.native(os.homedir());
      for (const dir of [
        `/System/Volumes/Data${home}`,
        "/System/Volumes/Data/Users",
        "/System/Volumes",
      ]) {
        expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: dir }).error).toContain("must not be /");
      }
    }
  );

  test("refuses /, the home directory and a directory above it as LOCALSTACK_AWS_WORKDIR", () => {
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: "/" }).error).toContain("must not be /");
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: os.homedir() }).error).toContain("must not be /");
    expect(awsWorkdir({ LOCALSTACK_AWS_WORKDIR: path.dirname(os.homedir()) }).error).toContain(
      "hold your home directory"
    );
  });

  test("is the server's directory, but none in Docker, in / or in the home directory", () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-cwd-")));
    const home = fs.realpathSync(os.homedir());
    expect(awsWorkdir({}, { cwd, home, inDocker: false })).toEqual({ workdir: cwd });
    expect(awsWorkdir({}, { cwd, home, inDocker: true })).toEqual({ workdir: null });
    expect(awsWorkdir({}, { cwd: "/", home, inDocker: false })).toEqual({ workdir: null });
    expect(awsWorkdir({}, { cwd: home, home, inDocker: false })).toEqual({ workdir: null });
    expect(awsWorkdir({}, { cwd: path.dirname(home), home, inDocker: false })).toEqual({
      workdir: null,
    });
    fs.rmSync(cwd, { recursive: true, force: true });
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
    fs.symlinkSync(path.join(outside, "new-file"), path.join(workdir, "dangle"));
    fs.symlinkSync(path.join(outside, "new-dir", "f"), path.join(outside, "dangle-out"));
  });

  test("judges a path that cannot be read as a path, without a file-system error", () => {
    expect(() => allowed("ssm get-parameter --name /etc/hosts/x")).toThrow(/outside/);
    // Inside the workdir: the CLI itself fails on it.
    expect(() => allowed("s3api get-object --bucket b --key k in.txt/x")).not.toThrow();
  });

  describe("paths the user may allow", () => {
    const thrown = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    const withAllowed = (cmd: string, allowed: string[]) =>
      assertLocalPathsAllowed(cmd.split(" "), workdir, {
        home,
        cwd: path.join(outside, "tmp"),
        privateHome: path.join(outside, "home"),
        platform: "linux",
        allowed,
      });

    test("a path outside the workdir names its real path, and passes once allowed", () => {
      const error = thrown(() => allowed(`s3 cp ${outside}/key.pem s3://b/k`));
      expect(error).toBeInstanceOf(OutsideWorkdirError);
      expect((error as OutsideWorkdirError).path).toBe(path.join(outside, "key.pem"));
      // Through a symlink in the workdir: the path the CLI opens.
      expect((thrown(() => allowed("s3 cp escape/key.pem s3://b/k")) as any).path).toBe(
        path.join(outside, "key.pem")
      );
      expect(() => withAllowed(`s3 cp ${outside}/key.pem s3://b/k`, [outside])).not.toThrow();
      expect(() =>
        withAllowed(`s3 cp ${outside}/key.pem s3://b/k`, [path.join(outside, "key.pem")])
      ).not.toThrow();
    });

    test.each([
      ["the private home", (o: string) => `s3 cp s3://b/k ${o}/home/.aws/cli/alias`],
      ["/", () => "s3 sync / s3://b"],
      ["another user's home", () => "s3 cp ~bob/x s3://b/k"],
      ["~, the CLI's own home", () => "s3 cp ~/x s3://b/k"],
      ["a network share", () => "s3 cp //server/share/x s3://b/k"],
    ])("%s is never offered to the user", (_label, cmd) => {
      const error = thrown(() => withAllowed(cmd(outside), [outside]));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OutsideWorkdirError);
    });

    test(".git stays refused inside an allowed folder", () => {
      fs.mkdirSync(path.join(outside, "repo", ".git"), { recursive: true });
      expect(() =>
        withAllowed(`s3 cp s3://b/k ${outside}/repo/.git/config`, [path.join(outside, "repo")])
      ).toThrow(/\.git and \.lstk/);
    });

    (fs.existsSync("/.vol") && process.platform === "darwin" ? test : test.skip)(
      "a /.vol path, which opens a file by number, is never offered to the user",
      () => {
        fs.mkdirSync(path.join(outside, "repo", ".git"), { recursive: true });
        const id = fs.statSync(path.join(outside, "repo", ".git"));
        for (const p of [`/.vol/${id.dev}/${id.ino}/config`, `/.VOL/${id.dev}/${id.ino}/config`]) {
          const error = thrown(() => withAllowed(`s3 cp s3://b/k ${p}`, ["/.vol"]));
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(OutsideWorkdirError);
        }
        expect(isTooWideToAllow(`/.vol/${id.dev}/${id.ino}`)).toBe(true);
      }
    );

    test(".git is never offered to the user", () => {
      fs.mkdirSync(path.join(outside, "repo", ".git"), { recursive: true });
      const error = thrown(() => withAllowed(`s3 cp s3://b/k ${outside}/repo/.git/config`, []));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OutsideWorkdirError);
    });

    test.each([
      ["the file itself", (o: string) => path.join(o, "repo", ".git", "config")],
      ["the .git folder", (o: string) => path.join(o, "repo", ".git")],
    ])(".git stays refused when the user allowed %s", (_label, allowedPath) => {
      fs.mkdirSync(path.join(outside, "repo", ".git"), { recursive: true });
      expect(() =>
        withAllowed(`s3 cp s3://b/k ${outside}/repo/.git/config`, [allowedPath(outside)])
      ).toThrow(/\.git and \.lstk/);
    });

    test("a folder that holds the private home is never offered, nor passes once allowed", () => {
      fs.mkdirSync(path.join(outside, "home"), { recursive: true });
      const cmd = `s3 cp s3://b/ ${outside} --recursive`;
      const error = thrown(() => withAllowed(cmd, []));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OutsideWorkdirError);
      expect(() => withAllowed(cmd, [outside])).toThrow(
        /outside the AWS client's working directory/
      );
    });

    (fs.existsSync("/System/Volumes/Data/private") ? test : test.skip)(
      "the private home stays refused under another name (macOS firmlinks)",
      () => {
        fs.mkdirSync(path.join(outside, "home", ".aws"), { recursive: true });
        const alias = `/System/Volumes/Data${outside}/home/.aws/cli/alias`;
        const error = thrown(() => withAllowed(`s3 cp s3://b/k ${alias}`, []));
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(OutsideWorkdirError);
      }
    );
  });

  test("refuses '..' after a symlink, which the OS applies where the symlink points", () => {
    // escape -> outside: escape/../in.txt opens in.txt next to outside, not in the workdir.
    for (const cmd of [
      "s3api get-object --bucket b --key k escape/../in.txt",
      "s3api put-object --bucket b --key k --body escape/../in.txt",
      "lambda invoke --function-name f --payload file://escape/../in.txt out.json",
      `s3api get-object --bucket b --key k ${workdir}/escape/../in.txt`,
    ]) {
      expect(() => allowed(cmd)).toThrow(/goes through the symlink/);
    }
    // Also where path.resolve would make it a name: /.git/config does not exist.
    fs.mkdirSync(path.join(outside, "a", "b", "c"), { recursive: true });
    fs.symlinkSync(path.join(outside, "a", "b", "c"), path.join(outside, "lnk"));
    const up = "/..".repeat(outside.split(path.sep).length);
    expect(() => allowed(`ssm get-parameter --name ${outside}/lnk${up}/.git/config`)).toThrow(
      /goes through the symlink/
    );
    // Without a symlink before it, '..' is resolved as the OS does.
    expect(() => allowed("s3api get-object --bucket b --key k out/../in.txt")).not.toThrow();
  });

  (fs.existsSync("/System/Volumes/Data/private") ? test : test.skip)(
    "a workdir named on the data volume holds its files (macOS firmlinks)",
    () => {
      const dir = `/System/Volumes/Data${workdir}`;
      const { workdir: resolved } = awsWorkdir({ LOCALSTACK_AWS_WORKDIR: dir });
      expect(resolved).toBe(workdir);
      for (const wd of [dir, resolved]) {
        expect(() => allowed("s3api get-object --bucket b --key k out.txt", wd)).not.toThrow();
        expect(() => allowed(`s3 cp s3://b/k ${dir}/x.txt`, wd)).not.toThrow();
      }
    }
  );

  test("a workdir inside a folder named .lstk or .git works", () => {
    const dir = path.join(outside, ".lstk", "proj");
    fs.mkdirSync(dir, { recursive: true });
    expect(() => allowed("sqs list-queues", dir)).not.toThrow();
    expect(() => allowed("s3 cp s3://b/k out.txt", dir)).not.toThrow();
    expect(() => allowed("s3 cp s3://b/k sub/.git/config", dir)).toThrow(/\.git and \.lstk/);
  });

  describe("the user's git and lstk configuration", () => {
    let userHome: string;
    beforeAll(() => {
      userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-userhome-")));
      fs.mkdirSync(path.join(userHome, ".config", "git"), { recursive: true });
      fs.writeFileSync(path.join(userHome, ".gitconfig"), "");
      fs.mkdirSync(path.join(userHome, "Library", "Application Support"), { recursive: true });
      fs.mkdirSync(path.join(userHome, "xdg"));
      fs.mkdirSync(path.join(userHome, "docs"));
    });
    afterAll(() => fs.rmSync(userHome, { recursive: true, force: true }));

    const check = (cmd: string, platform: NodeJS.Platform = "linux", env: object = {}) =>
      assertLocalPathsAllowed(cmd.split(" "), workdir, {
        home: userHome,
        cwd: path.join(outside, "tmp"),
        privateHome: path.join(outside, "home"),
        platform,
        env: env as NodeJS.ProcessEnv,
        // Even with the whole user home allowed.
        allowed: [userHome],
      });

    test.each([
      ["~/.gitconfig", (h: string) => `s3 cp s3://b/k ${h}/.gitconfig`],
      ["~/.config/git/config", (h: string) => `s3 cp s3://b/k ${h}/.config/git/config`],
      ["~/.config/lstk/config.toml", (h: string) => `s3 cp s3://b/k ${h}/.config/lstk/config.toml`],
      ["a folder that holds them", (h: string) => `s3 cp s3://b/ ${h}/.config --recursive`],
      ["their content", (h: string) => `s3 cp ${h}/.gitconfig s3://b/k`],
    ])("refuses %s, whatever the user allowed", (_label, cmd) => {
      expect(() => check(cmd(userHome))).toThrow(/git and lstk read their configuration/);
    });

    test("refuses lstk's macOS config directory, and another case on macOS and Windows", () => {
      expect(() =>
        assertLocalPathsAllowed(
          ["s3", "cp", "s3://b/k", `${userHome}/Library/Application Support/lstk/config.toml`],
          workdir,
          { home: userHome, platform: "darwin", env: {}, allowed: [userHome] }
        )
      ).toThrow(/configuration/);
      expect(() => check(`s3 cp s3://b/k ${userHome}/.config/GIT/config`, "darwin")).toThrow(
        /configuration/
      );
      expect(() => check(`s3 cp s3://b/k ${userHome}/.GitConfig`, "darwin")).toThrow(
        /configuration/
      );
    });

    test("refuses XDG_CONFIG_HOME's git and lstk, and GIT_CONFIG_GLOBAL", () => {
      const env = {
        XDG_CONFIG_HOME: path.join(userHome, "xdg"),
        GIT_CONFIG_GLOBAL: path.join(userHome, "docs", "my.gitconfig"),
      };
      for (const p of ["xdg/git/config", "xdg/lstk/config.toml", "docs/my.gitconfig"]) {
        expect(() => check(`s3 cp s3://b/k ${userHome}/${p}`, "linux", env)).toThrow(
          /configuration/
        );
      }
    });

    test("refuses the names a case-insensitive file system opens them by", () => {
      // APFS opens lſtk as lstk; Windows drops trailing dots and opens streams (.gitconfig:x).
      expect(() =>
        check(`s3 cp s3://b/k ${userHome}/.config/l\u017ftk/config.toml`, "darwin")
      ).toThrow(/configuration/);
      expect(() => check(`s3 cp s3://b/k ${userHome}/.config/lstk./config.toml`, "win32")).toThrow(
        /configuration/
      );
      expect(() => check(`s3 cp s3://b/k ${userHome}/.gitconfig:stream`, "win32")).toThrow(
        /configuration/
      );
    });

    test("refuses the missing target of a config symlink", () => {
      const link = path.join(userHome, "docs", "link.gitconfig");
      fs.symlinkSync(path.join(userHome, "dotfiles", "gitconfig"), link);
      const env = { GIT_CONFIG_GLOBAL: link };
      expect(() =>
        check(`s3api get-object --bucket b --key k ${userHome}/dotfiles/gitconfig`, "linux", env)
      ).toThrow(/configuration/);
    });

    test("follows a chain of dangling symlinks, also above the config path", () => {
      const ext = fs.mkdtempSync(path.join(os.tmpdir(), "aws-ext-"));
      const chainHome = fs.mkdtempSync(path.join(os.tmpdir(), "aws-chainhome-"));
      try {
        // ~/.config -> ext/dotcfg (missing); ext/hop -> ext/final (missing).
        fs.symlinkSync(path.join(ext, "dotcfg"), path.join(chainHome, ".config"));
        fs.symlinkSync(path.join(ext, "final"), path.join(ext, "hop"));
        const env = { GIT_CONFIG_GLOBAL: path.join(ext, "hop", "gitconfig") };
        for (const p of ["dotcfg/git/config", "final/gitconfig"]) {
          expect(() =>
            assertLocalPathsAllowed(["s3", "cp", "s3://b/k", path.join(ext, p)], workdir, {
              home: chainHome,
              platform: "linux",
              env,
              allowed: [fs.realpathSync(ext)],
            })
          ).toThrow(/configuration/);
        }
      } finally {
        fs.rmSync(ext, { recursive: true, force: true });
        fs.rmSync(chainHome, { recursive: true, force: true });
      }
    });

    (fs.existsSync("/System/Volumes/Data/private") ? test : test.skip)(
      "refuses a missing config under its data-volume name (macOS firmlinks)",
      () => {
        for (const p of [".config/git/config", "Library/Application Support/lstk/config.toml"]) {
          expect(() =>
            assertLocalPathsAllowed(
              ["s3", "cp", "s3://b/k", `/System/Volumes/Data${userHome}/${p}`],
              workdir,
              { home: userHome, platform: "darwin", env: {}, allowed: [userHome] }
            )
          ).toThrow(/configuration/);
        }
        // A folder that holds a missing config, named on the data volume.
        expect(() =>
          assertLocalPathsAllowed(
            ["s3", "sync", "s3://b/", `/System/Volumes/Data${userHome}/Library`],
            workdir,
            { home: userHome, platform: "darwin", env: {}, allowed: [userHome] }
          )
        ).toThrow(/configuration/);
      }
    );

    test("resolves a dangling link's relative target against the link's real directory", () => {
      const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-stowhome-")));
      try {
        // As GNU stow writes them: ~/.config -> dotfiles/config, and in it git -> ../../gitstuff/git.
        fs.mkdirSync(path.join(h, "dotfiles", "config"), { recursive: true });
        fs.symlinkSync(path.join(h, "dotfiles", "config"), path.join(h, ".config"));
        fs.symlinkSync("../../gitstuff/git", path.join(h, "dotfiles", "config", "git"));
        expect(() =>
          assertLocalPathsAllowed(
            ["s3", "cp", "s3://b/k", path.join(h, "gitstuff", "git", "config")],
            workdir,
            { home: h, platform: "linux", env: {}, allowed: [h] }
          )
        ).toThrow(/configuration/);
      } finally {
        fs.rmSync(h, { recursive: true, force: true });
      }
    });

    test("allows other files the user allowed", () => {
      expect(() => check(`s3 cp s3://b/k ${userHome}/docs/report.pdf`)).not.toThrow();
      expect(() => check(`s3 cp s3://b/k ${userHome}/.config/other.json`)).not.toThrow();
    });
  });

  test("refuses a path through a symlink whose target is missing", () => {
    for (const cmd of [
      "s3api get-object --bucket b --key k dangle",
      `s3api get-object --bucket b --key k ${workdir}/dangle`,
      "s3 cp s3://b/k dangle",
      `ssm get-parameter --name ${outside}/dangle-out`,
    ]) {
      expect(() => allowed(cmd)).toThrow(/symlink whose target does not exist|outside/);
    }
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

  // On Windows, the CLI writes a key's backslash as a path separator.
  test.each(["s3://b/.git", "s3://b/p/.lstk/", "s3://b/.l\u017ftk", "s3://b/.git\\config"])(
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
