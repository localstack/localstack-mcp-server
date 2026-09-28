import fs from "fs";
import os from "os";
import path from "path";
import {
  analyticsFields,
  DENIED,
  DENIED_FLAGS,
  evaluateAzCommand,
  LOCAL_HOST,
  parseDenylistFile,
  REQUIRED_FLAGS,
  scanBicepModules,
} from "./policy";
import type { PolicyOptions, PolicyResult } from "./types";

// Synthetic win32 paths keep the lexical file rule deterministic on any host: the paths do not
// exist, so the realpath step is skipped and only the pure-lexical logic runs.
const WORKDIR = "C:\\work\\project";
const HOMEDIR = "C:\\work\\.mcp\\azure\\home"; // the tool's private home
const PROTECTED = ["C:\\Users\\me\\.azure", "C:\\Users\\me\\.ssh", "C:\\work\\.mcp\\azure"];

const baseOpts: PolicyOptions = {
  workdir: WORKDIR,
  homeDir: HOMEDIR,
  protectedDirs: PROTECTED,
  platform: "win32",
};

function evalCmd(command: string, overrides: Partial<PolicyOptions> = {}): PolicyResult {
  return evaluateAzCommand(command, { ...baseOpts, ...overrides });
}

function expectOk(result: PolicyResult): Extract<PolicyResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got refusal ${result.ruleId}: ${result.message}`);
  return result;
}

function expectRefused(result: PolicyResult): Extract<PolicyResult, { ok: false }> {
  if (result.ok) throw new Error(`expected refusal, got ok (${JSON.stringify(result.argv)})`);
  return result;
}

describe("evaluateAzCommand: strip, start rule and tokenizer", () => {
  test("strips exactly one leading az", () => {
    expect(expectOk(evalCmd("az group list")).argv).toEqual(["group", "list"]);
    expect(expectOk(evalCmd("group list")).argv).toEqual(["group", "list"]);
  });

  test("refuses a second az (only one is stripped)", () => {
    const r = expectRefused(evalCmd("az az group list"));
    expect(r.ruleId).toBe("start");
    expect(r.argv).toEqual(["az", "group", "list"]);
  });

  test("refuses azlocal", () => {
    expect(expectRefused(evalCmd("azlocal group list")).ruleId).toBe("start");
    expect(expectRefused(evalCmd("az azlocal group list")).ruleId).toBe("start");
  });

  test("refuses a leading global flag", () => {
    expect(expectRefused(evalCmd("--debug group list")).ruleId).toBe("start");
  });

  test("a CliSyntaxError becomes a syntax refusal with the tokenizer's message", () => {
    const r = expectRefused(evalCmd("group list | tee out"));
    expect(r.ruleId).toBe("syntax");
    expect(r.message).toBe("Command contains forbidden shell syntax.");
    const q = expectRefused(evalCmd("group list 'unterminated"));
    expect(q.ruleId).toBe("syntax");
    expect(q.message).toBe("Command contains an unterminated quote.");
  });

  test("keeps quoted control chars, empty quoted args and bash double-quote escapes (variant P)", () => {
    // Newline inside single quotes is data, not a separator (the 72 corpus commands).
    expect(expectOk(evalCmd("monitor diagnostic-settings create --logs '[\n{}]'")).argv).toEqual([
      "monitor",
      "diagnostic-settings",
      "create",
      "--logs",
      "[\n{}]",
    ]);
    // Empty quoted argument kept.
    expect(expectOk(evalCmd('tag create --value ""')).argv).toEqual([
      "tag",
      "create",
      "--value",
      "",
    ]);
  });
});

describe("evaluateAzCommand: denied groups and verbs (one per family)", () => {
  const cases: Array<[string, string]> = [
    ["login", "denied:login"],
    ["logout", "denied:logout"],
    ["account clear", "denied:account-clear"],
    ["cloud set --name x", "denied:cloud-set"],
    ["cloud register --name x", "denied:cloud-register"],
    ["config set x y", "denied:config"],
    ["configure --defaults group=rg", "denied:configure"],
    ["init", "denied:init"],
    ["extension add --name foo", "denied:extension-add"],
    ["upgrade", "denied:upgrade"],
    ["bicep install", "denied:bicep-install"],
    ["bicep restore --file main.bicep", "denied:bicep-restore"],
    ["aks install-cli", "denied:aks-install-cli"],
    ["find --cli x", "denied:find"],
    ["interactive", "denied:interactive"],
    ["aks browse --name c --resource-group rg", "denied:aks-browse"],
    ["webapp ssh --name w --resource-group rg", "denied:webapp-ssh"],
    ["container exec --name c --resource-group rg --exec-command sh", "denied:container-exec"],
    ["webapp log tail --name w --resource-group rg", "denied:webapp-log-tail"],
    ["network bastion ssh --name b --resource-group rg", "denied:network-bastion-ssh"],
    ["acr check-health", "denied:acr-check-health"],
    ["storage copy --source a --destination b", "denied:storage-copy"],
    ["storage blob sync -c c -s src", "denied:storage-blob-sync"],
    ["postgres flexible-server deploy setup", "denied:postgres-flexible-server-deploy"],
    ["cognitiveservices agent create --name a --source .", "denied:cognitiveservices-agent-create"],
    ["devops project list", "denied:devops"],
  ];
  test.each(cases)("refuses `%s`", (command, ruleId) => {
    const r = expectRefused(evalCmd(command));
    expect(r.ruleId).toBe(ruleId);
    expect(r.title).toBeTruthy();
    expect(r.message).toContain("not allowed");
  });

  test("cloud show and cloud list keep working (only mutating verbs are denied)", () => {
    expect(evalCmd("cloud show").ok).toBe(true);
    expect(evalCmd("cloud list").ok).toBe(true);
    expect(expectOk(evalCmd("cloud show --query name")).argv).toEqual([
      "cloud",
      "show",
      "--query",
      "name",
    ]);
  });

  test("config get is allowed, config set is refused", () => {
    expect(evalCmd("config get core.output").ok).toBe(true);
    expect(expectRefused(evalCmd("config set core.output=json")).ruleId).toBe("denied:config");
  });
});

describe("evaluateAzCommand: flag rules", () => {
  test("refuses --follow anywhere", () => {
    expect(
      expectRefused(evalCmd("container logs --name c --resource-group rg --follow")).ruleId
    ).toBe("denied:flag");
  });
  test("refuses --login-with-github", () => {
    expect(
      expectRefused(evalCmd("webapp deployment github-actions add --login-with-github")).ruleId
    ).toBe("denied:flag");
  });
  test("refuses webapp up --launch-browser", () => {
    expect(expectRefused(evalCmd("webapp up --launch-browser --name w")).ruleId).toBe(
      "denied:flag"
    );
  });
  test("refuses containerapp up --source and containerapp create --repo", () => {
    expect(expectRefused(evalCmd("containerapp up --source . --name a")).ruleId).toBe(
      "denied:flag"
    );
    expect(expectRefused(evalCmd("containerapp create --repo o/r --name a")).ruleId).toBe(
      "denied:flag"
    );
  });
  test("acr login is refused without --expose-token and allowed with it", () => {
    const r = expectRefused(evalCmd('acr login --name "myacr"'));
    expect(r.ruleId).toBe("denied:acr-login");
    expect(r.message).toContain("--expose-token");
    expect(evalCmd('acr login --name "myacr" --expose-token').ok).toBe(true);
    expect(evalCmd('acr login --name "myacr" -t').ok).toBe(true);
  });

  test("a required flag is not required to read the command's help", () => {
    // `az acr login --help` only prints help: it never runs docker login.
    for (const cmd of ["acr login --help", "acr login -h", 'acr login --name "myacr" --help']) {
      const r = expectOk(evalCmd(cmd));
      expect(r.isHelp).toBe(true);
    }
    // Help does not lift a denial, though.
    expect(expectRefused(evalCmd("login --help")).ruleId).toMatch(/^denied:/);
  });

  test("prefix-aware: abbreviated denied and required flags are handled", () => {
    expect(expectRefused(evalCmd("container logs --name c --resource-group rg --fol")).ruleId).toBe(
      "denied:flag"
    );
    expect(expectRefused(evalCmd("webapp deployment github-actions add --login-with")).ruleId).toBe(
      "denied:flag"
    );
    expect(expectRefused(evalCmd("webapp up --launch --name w")).ruleId).toBe("denied:flag");
    expect(expectRefused(evalCmd("containerapp up --sour . --name a")).ruleId).toBe("denied:flag");
    // An abbreviation of the required --expose-token satisfies it.
    expect(evalCmd('acr login --name "myacr" --expose').ok).toBe(true);
  });
});

describe("evaluateAzCommand: URL rule (request targets only)", () => {
  test("rewrites a management.azure.com rest --url to a relative path, with a note", () => {
    const r = expectOk(
      evalCmd("rest --url https://management.azure.com/subscriptions/0/x?api-version=2022-09-01")
    );
    expect(r.argv).toEqual(["rest", "--url", "/subscriptions/0/x?api-version=2022-09-01"]);
    expect(r.outcome).toBe("rewritten");
    expect(r.notes.join(" ")).toContain("management.azure.com");
  });

  test("rewrite keeps the leading slash and matches :443 and an upper-case host", () => {
    const r = expectOk(evalCmd("rest --uri=https://MANAGEMENT.AZURE.COM:443/providers/foo"));
    expect(r.argv).toEqual(["rest", "--uri=/providers/foo"]);
    expect(r.outcome).toBe("rewritten");
  });

  test("allows the local emulator hosts unchanged", () => {
    const r = expectOk(
      evalCmd("rest --url https://localhost.localstack.cloud:4566/subscriptions/0")
    );
    expect(r.argv[2]).toBe("https://localhost.localstack.cloud:4566/subscriptions/0");
    expect(r.outcome).toBe("ok");
    expect(evalCmd("rest --url https://azure.localhost.localstack.cloud:4566/x").ok).toBe(true);
    expect(evalCmd("rest --url http://127.0.0.1:4566/x").ok).toBe(true);
  });

  test("refuses other absolute URLs on request-target flags", () => {
    expect(expectRefused(evalCmd("rest --url https://graph.microsoft.com/v1.0/me")).ruleId).toBe(
      "url:blocked"
    );
    expect(
      expectRefused(
        evalCmd(
          "deployment group create -g rg --template-uri https://raw.githubusercontent.com/x/y/main.json"
        )
      ).ruleId
    ).toBe("url:blocked");
    expect(expectRefused(evalCmd("rest --url https://api.loganalytics.io/v1/x")).ruleId).toBe(
      "url:blocked"
    );
  });

  test("acr build refuses a git/github URL source and allows a local dot source", () => {
    expect(expectRefused(evalCmd("acr build --registry r https://github.com/x/y.git")).ruleId).toBe(
      "url:blocked"
    );
    expect(evalCmd("acr build --registry r --image i:v1 .").ok).toBe(true);
  });

  test("prefix-aware: abbreviated URL flags are caught like the full flags", () => {
    expect(expectRefused(evalCmd("rest --ur https://evil.example.com/x")).ruleId).toBe(
      "url:blocked"
    );
    const rewritten = expectOk(evalCmd("rest --ur https://management.azure.com/subscriptions/1"));
    expect(rewritten.argv).toEqual(["rest", "--ur", "/subscriptions/1"]);
    expect(rewritten.outcome).toBe("rewritten");
    expect(
      expectRefused(
        evalCmd(
          "deployment group create -g rg --template-u https://raw.githubusercontent.com/x/main.json"
        )
      ).ruleId
    ).toBe("url:blocked");
  });

  test("IPv6 and odd spellings: the guard's own host check decides (F29)", () => {
    // A bracketed IPv6 host is parsed as a host, not skipped as "not a URL".
    expect(expectRefused(evalCmd("rest --url https://[2001:db8::1]/x")).ruleId).toBe("url:blocked");
    expect(evalCmd("rest --url https://[::1]:4566/subscriptions/0").ok).toBe(true);
    // Canonical loopback spellings the guard relays are allowed here too.
    expect(evalCmd("rest --url https://127.1:4566/subscriptions/0").ok).toBe(true);
    expect(evalCmd("rest --url https://LOCALHOST.localstack.cloud:4566/x").ok).toBe(true);
    // Userinfo never makes a host look like the management host or a local one.
    expect(
      expectRefused(evalCmd("rest --url https://management.azure.com@evil.example/x")).ruleId
    ).toBe("url:blocked");
    expect(expectRefused(evalCmd("rest --url https://localhost@evil.example/x")).ruleId).toBe(
      "url:blocked"
    );
  });

  test("never rewrites the value of an unrelated flag (--resource is a token audience)", () => {
    const r = expectOk(
      evalCmd("account get-access-token --resource=https://management.azure.com/")
    );
    expect(r.argv).toEqual([
      "account",
      "get-access-token",
      "--resource=https://management.azure.com/",
    ]);
    expect(r.outcome).toBe("ok");
  });
});

describe("evaluateAzCommand: file rule", () => {
  test("generated table: storage blob download -f is bounded by the workdir", () => {
    expect(
      expectRefused(evalCmd("storage blob download -c c -n b -f C:\\Windows\\win.ini")).ruleId
    ).toBe("file:outside-workdir");
    expect(evalCmd("storage blob download -c c -n b -f hello.txt").ok).toBe(true);
  });

  test("generated table: bicep build --outfile outside the workdir is refused", () => {
    expect(
      expectRefused(evalCmd("bicep build --file main.bicep --outfile C:\\x.json")).ruleId
    ).toBe("file:outside-workdir");
  });

  test("the outside-workdir refusal says how to move the working directory", () => {
    // A GUI client starts the server in its own folder, so the user must learn the setting's name.
    const r = expectRefused(evalCmd("storage blob upload -c c -n b -f C:\\Users\\me\\data\\x.txt"));
    expect(r.ruleId).toBe("file:outside-workdir");
    expect(r.message).toContain("LOCALSTACK_AZ_WORKDIR");
    // Still value-free: the refused path itself is never echoed.
    expect(r.message).not.toContain("x.txt");
  });

  test("supplement: storage blob download-batch -d ..\\.. is refused", () => {
    expect(expectRefused(evalCmd("storage blob download-batch -c c -d ..\\..")).ruleId).toBe(
      "file:outside-workdir"
    );
  });

  test("prefix-aware: abbreviated file flags are bounded by the workdir", () => {
    expect(
      expectRefused(evalCmd("deployment group create -g rg --template-f C:\\Windows\\win.ini"))
        .ruleId
    ).toBe("file:outside-workdir");
    expect(
      expectRefused(evalCmd("storage blob download -c c -n b --fi C:\\Windows\\win.ini")).ruleId
    ).toBe("file:outside-workdir");
    expect(evalCmd("storage blob download -c c -n b --fi hello.txt").ok).toBe(true);
  });

  test("aks create --ssh-key-value ~/.ssh/id_rsa.pub resolves into the private home (allowed)", () => {
    expect(evalCmd("aks create -g rg -n c --ssh-key-value ~/.ssh/id_rsa.pub").ok).toBe(true);
  });

  test("@~ resolves into the private home; @ the real home is refused", () => {
    expect(evalCmd("ad sp create-for-rbac --cert @~/.ssh/id_rsa").ok).toBe(true);
    const r = expectRefused(evalCmd("ad sp create-for-rbac --cert @C:\\Users\\me\\.ssh\\id_rsa"));
    expect(["file:protected", "file:outside-workdir"]).toContain(r.ruleId);
  });

  test("a `~` path missing from the private home gets a note saying what `~` is", () => {
    const r = expectOk(
      evalCmd("keyvault secret set --vault-name v --name n --file ~/.azure/azureProfile.json")
    );
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain(`private home (${HOMEDIR}), not your home directory`);
    expect(r.notes[0]).toContain("~/.azure/azureProfile.json does not exist there");
    expect(r.notes[0]).toContain("never available through this tool");
    // One note per command, however many `~` arguments it has.
    const two = expectOk(
      evalCmd("rest --method post --url /x --body @~/a.json --headers @~/b.json")
    );
    expect(two.notes).toHaveLength(1);
    // No `~`, no note.
    expect(expectOk(evalCmd("storage blob upload -c c -n b -f hello.txt")).notes).toEqual([]);
  });

  test("a `~` file that exists in the private home gets no note", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lsaz-policy-home-"));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa.pub"), "ssh-rsa AAAA uat");
    const r = expectOk(
      evaluateAzCommand("aks create -g rg -n c --ssh-key-value ~/.ssh/id_rsa.pub", {
        workdir: home,
        homeDir: home,
        protectedDirs: [],
        platform: process.platform,
      })
    );
    expect(r.notes).toEqual([]);
  });

  test("refuses absolute paths outside the workdir", () => {
    expect(expectRefused(evalCmd("storage blob download -c c -n b -f /etc/passwd")).ok).toBe(false);
    expect(
      expectRefused(evalCmd("storage blob upload -c c -n b -f C:\\Windows\\win.ini")).ruleId
    ).toBe("file:outside-workdir");
  });

  test("refuses UNC, \\\\?\\ and drive-relative forms", () => {
    expect(
      expectRefused(evalCmd("storage blob upload -c c -n b -f \\\\host\\share\\x")).ruleId
    ).toBe("file:unsupported-path");
    expect(expectRefused(evalCmd("storage blob upload -c c -n b -f \\\\?\\C:\\x")).ruleId).toBe(
      "file:unsupported-path"
    );
    expect(expectRefused(evalCmd("storage blob upload -c c -n b -f C:relative")).ruleId).toBe(
      "file:unsupported-path"
    );
  });

  test("a workdir-relative file and an absolute file inside the workdir are allowed", () => {
    expect(evalCmd("storage blob upload -c c -n b -f sub/data.bin").ok).toBe(true);
    expect(evalCmd("storage blob upload -c c -n b -f C:\\work\\project\\sub\\data.bin").ok).toBe(
      true
    );
  });

  test("a missing main.bicep inside the workdir passes (files need not exist)", () => {
    const r = expectOk(evalCmd("deployment group create -g rg --template-file main.bicep"));
    expect(r.needsBicep).toBe(true);
  });

  test("ARM ids are not treated as paths", () => {
    expect(
      evalCmd(
        "role assignment create --scope /subscriptions/0/resourceGroups/rg --role Reader --assignee x"
      ).ok
    ).toBe(true);
  });

  test("--parameters: an assignment is not a path; @file and a .bicepparam are", () => {
    expect(evalCmd("deployment group create -g rg --parameters location=westeurope").ok).toBe(true);
    expect(evalCmd("deployment group create -g rg --parameters @params.json").ok).toBe(true);
    const r = expectOk(evalCmd("deployment group create -g rg --parameters main.bicepparam"));
    expect(r.needsBicep).toBe(true);
    expect(
      expectRefused(evalCmd("deployment group create -g rg --parameters ..\\..\\secret.json"))
        .ruleId
    ).toBe("file:outside-workdir");
  });
});

describe("evaluateAzCommand: protected directories (workdir is the user's home)", () => {
  // The server's cwd is a "fake home"; a relative .ssh/.azure path would pass the workdir check.
  const fakeHome = "C:\\fakehome";
  const configDir = "C:\\fakehome\\.mcp\\azure";
  const opts: Partial<PolicyOptions> = {
    workdir: fakeHome,
    homeDir: `${configDir}\\home`,
    protectedDirs: [`${fakeHome}\\.azure`, `${fakeHome}\\.ssh`, configDir],
  };

  test("a relative path into a protected dir is refused", () => {
    expect(
      expectRefused(evalCmd("storage blob upload -c c -n b -f .ssh/id_rsa", opts)).ruleId
    ).toBe("file:protected");
    expect(
      expectRefused(evalCmd("storage blob upload -c c -n b -f .azure/config", opts)).ruleId
    ).toBe("file:protected");
  });

  test("an ordinary project file is allowed", () => {
    expect(evalCmd("storage blob upload -c c -n b -f project/a.txt", opts).ok).toBe(true);
  });

  test("the private home stays allowed even though the config dir contains it", () => {
    expect(evalCmd("aks create -g rg -n c --ssh-key-value ~/.ssh/id_rsa.pub", opts).ok).toBe(true);
  });

  test("a path at the config dir root is refused", () => {
    expect(
      expectRefused(evalCmd(`storage blob download -c c -n b -f ${configDir}\\clouds.config`, opts))
        .ruleId
    ).toBe("file:protected");
  });
});

describe("evaluateAzCommand: arguments az opens a file from by itself", () => {
  // Some arguments are not marked as files in az's metadata, yet az opens the path it is given:
  // a structured (AAZ) argument such as `--tags`, or a `validate_file_or_dict` argument, loads a
  // JSON/YAML file whenever the value names an EXISTING path; and a few plain arguments (such as
  // `rest --output-file`, `apim api import --specification-path`) are opened by az's own code.
  // The existing-path check needs real files, so these tests use a temp tree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-d31-"));
  const workdir = path.join(root, "work");
  const home = path.join(root, "private-home");
  const protectedDir = path.join(root, "userhome", ".azure");
  const outside = path.join(root, "outside");
  for (const d of [workdir, home, protectedDir, outside]) fs.mkdirSync(d, { recursive: true });
  const inProtected = path.join(protectedDir, "probe.json");
  const inOutside = path.join(outside, "o.json");
  const inWorkdir = path.join(workdir, "tags.json");
  for (const f of [inProtected, inOutside, inWorkdir]) fs.writeFileSync(f, '{"k": "v"}');
  const opts: PolicyOptions = {
    workdir,
    homeDir: home,
    protectedDirs: [protectedDir],
    platform: process.platform,
  };
  const run = (command: string) => evaluateAzCommand(command, opts);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test("a structured argument naming an existing file in a protected dir is refused", () => {
    expect(expectRefused(run(`network vnet create -g rg -n v --tags ${inProtected}`)).ruleId).toBe(
      "file:protected"
    );
  });

  test("a structured argument naming an existing file outside the workdir is refused", () => {
    expect(expectRefused(run(`network vnet create -g rg -n v --tags ${inOutside}`)).ruleId).toBe(
      "file:outside-workdir"
    );
  });

  test("inline tags, a file in the workdir and a path that does not exist still work", () => {
    expect(run("network vnet create -g rg -n v --tags env=dev team=a").ok).toBe(true);
    expect(run(`network vnet create -g rg -n v --tags ${inWorkdir}`).ok).toBe(true);
    // az reads only a path that exists, so a missing one is plain text to it.
    expect(run(`network vnet create -g rg -n v --tags ${path.join(outside, "none.json")}`).ok).toBe(
      true
    );
  });

  test("a value naming an existing DIRECTORY is left alone: az reads only files (--probe-path /)", () => {
    // A remote path that names a local directory (the filesystem root here) is not a file az could
    // read; the L2 matrix's `afd origin-group create --probe-path /` was refused before this.
    const probe =
      "afd origin-group create --origin-group-name og --profile-name p -g rg --probe-path /";
    expect(run(probe).ok).toBe(true);
    expect(run(`network vnet create -g rg -n v --tags ${outside}`).ok).toBe(true);
  });

  test("every value after a structured argument is checked, not only the first", () => {
    expect(
      expectRefused(run(`network vnet create -g rg -n v --tags env=dev ${inProtected}`)).ruleId
    ).toBe("file:protected");
  });

  test("a validate_file_or_dict argument is covered too", () => {
    const cmd = `vm extension set -g rg --vm-name vm -n ext --publisher p --settings ${inProtected}`;
    expect(expectRefused(run(cmd)).ruleId).toBe("file:protected");
  });

  test("rest --output-file is bounded by the workdir, even for a target that does not exist yet", () => {
    // az WRITES the response here, so the target need not exist: it must be checked unconditionally.
    const url = "--method get --url /subscriptions?api-version=2022-09-01";
    const newTarget = path.join(outside, "does-not-exist-yet.json");
    expect(expectRefused(run(`rest ${url} --output-file ${newTarget}`)).ruleId).toBe(
      "file:outside-workdir"
    );
    expect(expectRefused(run(`rest ${url} --output-file ${inProtected}`)).ruleId).toBe(
      "file:protected"
    );
    expect(run(`rest ${url} --output-file out.json`).ok).toBe(true);
  });

  test("apim api import --specification-path is bounded by the workdir", () => {
    const cmd =
      "apim api import -g rg -n s --path p --specification-format OpenApiJson " +
      `--specification-path ${inOutside}`;
    expect(expectRefused(run(cmd)).ruleId).toBe("file:outside-workdir");
  });
});

describe("evaluateAzCommand: symlink escape (realpath, I/O)", () => {
  test("a symlink out of the workdir is refused via realpath", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-sym-"));
    const workdir = path.join(root, "work");
    const outside = path.join(root, "outside");
    fs.mkdirSync(workdir);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(workdir, "link"), "junction");
      linked = true;
    } catch {
      // No privilege to create a link on this machine: skip the assertion gracefully.
    }
    if (linked) {
      const r = evaluateAzCommand("storage blob upload -c c -n b -f link/secret.txt", {
        workdir,
        homeDir: path.join(root, "home"),
        platform: process.platform,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.ruleId).toBe("file:outside-workdir");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("evaluateAzCommand: bicep detection", () => {
  test("needsBicep for a .bicep template, a .bicepparam file and the bicep group", () => {
    expect(
      expectOk(evalCmd("deployment group create -g rg --template-file main.bicep")).needsBicep
    ).toBe(true);
    expect(
      expectOk(evalCmd("deployment group create -g rg --parameters main.bicepparam")).needsBicep
    ).toBe(true);
    expect(expectOk(evalCmd("bicep build --file main.bicep")).needsBicep).toBe(true);
  });
  test("no bicep for an ARM JSON template", () => {
    expect(
      expectOk(evalCmd("deployment group create -g rg --template-file main.json")).needsBicep
    ).toBe(false);
  });
});

describe("evaluateAzCommand: help and version", () => {
  test("--help/-h anywhere sets isHelp", () => {
    expect(expectOk(evalCmd("group create --help")).isHelp).toBe(true);
    expect(expectOk(evalCmd("--help")).isHelp).toBe(true);
    expect(expectOk(evalCmd("group list -h")).isHelp).toBe(true);
  });

  test("version and bare --version return the local marker", () => {
    const v = expectOk(evalCmd("version"));
    expect(v.local).toBe("version");
    expect(v.outcome).toBe("local");
    const dash = expectOk(evalCmd("--version"));
    expect(dash.local).toBe("version");
  });

  test("postgres flexible-server create --version 16 still runs", () => {
    const r = expectOk(evalCmd("postgres flexible-server create -g rg -n s --version 16"));
    expect(r.local).toBeUndefined();
    expect(r.argv).toContain("--version");
  });
});

describe("parseDenylistFile", () => {
  test("splits on whitespace and ignores comments and blank lines", () => {
    const text = [
      "# a comment",
      "",
      "keyvault secret   # inline comment",
      "  storage account ",
      "\t",
    ].join("\n");
    expect(parseDenylistFile(text)).toEqual([
      ["keyvault", "secret"],
      ["storage", "account"],
    ]);
  });

  test("a parsed denylist prefix is enforced", () => {
    const extraDenied = parseDenylistFile("keyvault secret\n# nope\n");
    const r = expectRefused(
      evalCmd("keyvault secret show --vault-name v --name n", { extraDenied })
    );
    expect(r.ruleId).toBe("denied:keyvault-secret");
    expect(evalCmd("keyvault key show --vault-name v --name n", { extraDenied }).ok).toBe(true);
  });
});

describe("analyticsFields (task 2.13): value-free", () => {
  test("command_path and flag_names carry no values; each flag cut at first =", () => {
    const command = 'keyvault secret set --vault-name v --name pw --value "s3cr3t!" --tags a=b';
    const policy = evalCmd(command);
    const fields = analyticsFields(command, policy);
    expect(fields.command_path).toBe("keyvault secret set");
    expect(fields.flag_names).toBe("--vault-name,--name,--value,--tags");
    expect(fields.policy_outcome).toBe("ok");
  });

  test("policy_outcome covers ok, rewritten, local, denied and syntax", () => {
    expect(analyticsFields("group list", evalCmd("group list")).policy_outcome).toBe("ok");
    expect(
      analyticsFields(
        "rest --url https://management.azure.com/x",
        evalCmd("rest --url https://management.azure.com/x")
      ).policy_outcome
    ).toBe("rewritten");
    expect(analyticsFields("version", evalCmd("version")).policy_outcome).toBe("local");
    expect(analyticsFields("login", evalCmd("login")).policy_outcome).toBe("denied:login");
    expect(
      analyticsFields(
        "storage blob download -f C:\\x",
        evalCmd("storage blob download -c c -n b -f C:\\x")
      ).policy_outcome
    ).toBe("denied:file:outside-workdir");
    expect(analyticsFields("group list | x", evalCmd("group list | x")).policy_outcome).toBe(
      "syntax"
    );
  });

  test("property: a random secret never appears in any analytics field", () => {
    const alphabet = "ABCDEFabcdef0123456789!@#$%^&*();:'\"|<>`$ =/\\-_.";
    const randomSecret = (): string => {
      const len = 8 + Math.floor(Math.random() * 24);
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
      return s;
    };
    for (let i = 0; i < 400; i++) {
      const secret = randomSecret();
      const commands = [
        `keyvault secret set --vault-name v --name pw --value ${JSON.stringify(secret)}`,
        `sql server create -g rg -n s --admin-user a --admin-password ${JSON.stringify(secret)}`,
        `storage account keys list --admin-password=${JSON.stringify(secret)}`,
        `storage blob upload --sas-token ${JSON.stringify(secret)} -c c -n n -f f`,
        `webapp config appsettings set --settings ${JSON.stringify("CONN=" + secret + ";Key=" + secret)}`,
        `deployment group create -g rg --parameters @${JSON.stringify(secret + ".json")}`,
      ];
      for (const command of commands) {
        const policy = evalCmd(command);
        const fields = analyticsFields(command, policy);
        for (const value of Object.values(fields)) {
          expect(value.includes(secret)).toBe(false);
        }
      }
    }
  });
});

describe("scanBicepModules", () => {
  test("returns the first registry module reference inside the workdir, else undefined", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-bicep-"));
    fs.writeFileSync(
      path.join(root, "reg.bicep"),
      "module x 'br:myregistry.azurecr.io/bicep/modules/vnet:v1' = {}\n"
    );
    fs.writeFileSync(path.join(root, "local.bicep"), "module y './local.bicep' = {}\n");
    expect(
      scanBicepModules(["deployment", "group", "create", "--template-file", "reg.bicep"], root)
    ).toBe("br:myregistry.azurecr.io/bicep/modules/vnet:v1");
    expect(
      scanBicepModules(["deployment", "group", "create", "--template-file", "local.bicep"], root)
    ).toBeUndefined();
    // A .bicep argument outside the workdir is not read.
    expect(
      scanBicepModules(["deployment", "group", "create", "--template-file", "..\\reg.bicep"], root)
    ).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("uses an injected reader when provided (no disk I/O)", () => {
    const files: Record<string, string> = {
      [path.resolve("/w", "m.bicep")]:
        "module spec 'ts:00000000/rg/spec:1.0' = {\n  name: 'x'\n}\n",
    };
    expect(
      scanBicepModules(["deployment", "group", "create", "-f", "m.bicep"], "/w", (p) => files[p])
    ).toBe("ts:00000000/rg/spec:1.0");
  });

  const scan = (content: string, file = "t.bicep") =>
    scanBicepModules(["deployment", "group", "create", "-f", file], "/w", () => content);

  test("property names that contain `ts:` or `br:` are not registry references (L2)", () => {
    const vnet = [
      "resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {",
      "  name: 'v'",
      "  properties: {",
      "    addressSpace: { addressPrefixes: ['10.0.0.0/16'] }",
      "    subnets: [ { name: 'default', properties: { addressPrefix: '10.0.0.0/24' } } ]",
      "  }",
      "}",
      "output hosts string = 'ts: a timestamp, not a module'",
      "var abr = { cobr: 1, abr: 2 }",
      "module local './nested.bicep' = { name: 'n' }",
    ].join("\n");
    expect(scan(vnet)).toBeUndefined();
  });

  test("every registry reference form is caught: module, using, extends, import", () => {
    expect(scan("module avm 'br/public:avm/res/network/virtual-network:0.1.0' = {")).toBe(
      "br/public:avm/res/network/virtual-network:0.1.0"
    );
    expect(scan("using 'br:contoso.azurecr.io/bicep/app:v2'\nparam x = 1", "p.bicepparam")).toBe(
      "br:contoso.azurecr.io/bicep/app:v2"
    );
    expect(scan("extends 'br:contoso.azurecr.io/params/base:v1'", "p.bicepparam")).toBe(
      "br:contoso.azurecr.io/params/base:v1"
    );
    expect(scan("import { tags } from 'br:contoso.azurecr.io/bicep/shared:v1'")).toBe(
      "br:contoso.azurecr.io/bicep/shared:v1"
    );
  });
});

describe("exported policy data", () => {
  test("DENIED, DENIED_FLAGS, REQUIRED_FLAGS and LOCAL_HOST are populated", () => {
    expect(DENIED.length).toBeGreaterThan(20);
    expect(DENIED_FLAGS.some((f) => f.flag === "--follow")).toBe(true);
    expect(REQUIRED_FLAGS[0].flag).toBe("--expose-token");
    expect(LOCAL_HOST.test("localhost.localstack.cloud")).toBe(true);
    expect(LOCAL_HOST.test("azure.localhost.localstack.cloud")).toBe(true);
    expect(LOCAL_HOST.test("management.azure.com")).toBe(false);
  });
});
