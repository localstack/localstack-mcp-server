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
    "find vm",
    "webapp ssh -n app -g rg",
  ])("denies %j", (command) => {
    expect(refusal(command).message).toMatch(/is not allowed here: /);
  });

  test("allows config get, and commands that only share a word with a denied one", () => {
    expect(allowed("config get core.output").argv[0]).toBe("config");
    expect(allowed("cloud show").argv).toEqual(["cloud", "show"]);
    expect(allowed("extension list").argv).toEqual(["extension", "list"]);
  });

  test("denied flags, also as argparse abbreviations", () => {
    expect(refusal("container logs -n c -g rg --follow").title).toBe("Flag not allowed");
    expect(refusal("container logs -n c -g rg --foll").title).toBe("Flag not allowed");
    expect(refusal("webapp up -n app -b").message).toContain(
      "`az webapp up` cannot be run with `-b`"
    );
    expect(allowed("group list -b x").argv).toContain("-b"); // -b is denied only on webapp up
  });

  test.each([
    "storage blob upload -f ../secret.txt -c c -n n",
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

  test("leaves other URLs, and management URLs outside rest, as they are", () => {
    const local = allowed("rest --url https://azure.localhost.localstack.cloud:4566/x");
    expect(local.argv[2]).toBe("https://azure.localhost.localstack.cloud:4566/x");
    expect(allowed("rest --url https://management.azure.com.evil.example/x").notes).toEqual([]);
    expect(allowed("group list --query https://management.azure.com/x").notes).toEqual([]);
  });
});
