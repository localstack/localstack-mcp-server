import { CliSyntaxError, splitCliArgs, type CliArgsOptions } from "./argv";

// The options the Azure client passes (check C06, "variant P").
const AZURE: CliArgsOptions = {
  quotedControlChars: true,
  keepEmptyQuoted: true,
  bashDoubleQuoteEscapes: true,
};

const errorOf = (fn: () => unknown): CliSyntaxError => {
  try {
    fn();
  } catch (error) {
    return error as CliSyntaxError;
  }
  throw new Error("expected splitCliArgs to throw");
};

describe("splitCliArgs: the AWS behaviour (no options)", () => {
  test.each([
    ["s3 ls", ["s3", "ls"]],
    ["s3\tls", ["s3", "ls"]],
    [
      "ec2 describe-instances --filters 'Name=tag:Name,Values=test instance'",
      ["ec2", "describe-instances", "--filters", "Name=tag:Name,Values=test instance"],
    ],
    [
      "s3api head-object --key 'price$2026.txt'",
      ["s3api", "head-object", "--key", "price$2026.txt"],
    ],
    [
      String.raw`s3api head-object --key 'folder\file$2026.txt'`,
      ["s3api", "head-object", "--key", String.raw`folder\file$2026.txt`],
    ],
    [
      `dynamodb put-item --item '{":value":{"S":"a|b;$c"}}'`,
      ["dynamodb", "put-item", "--item", '{":value":{"S":"a|b;$c"}}'],
    ],
  ])("splits %s", (command, expected) => {
    expect(splitCliArgs(command)).toEqual(expected);
  });

  test("parses escaped JSON, dollar signs, backslashes and tabs as argv", () => {
    const command = String.raw`s3api put-object	--cli-input-json "{\"Bucket\":\"test\",\"Key\":\"folder\\price$2026.txt\"}"`;
    expect(splitCliArgs(command)).toEqual([
      "s3api",
      "put-object",
      "--cli-input-json",
      '{"Bucket":"test","Key":"folder\\price$2026.txt"}',
    ]);
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
  ])("refuses shell syntax: %s", (command) => {
    const error = errorOf(() => splitCliArgs(command));
    expect(error).toBeInstanceOf(CliSyntaxError);
    expect(error.code).toBe("shell-syntax");
    expect(error.message).toBe("Command contains forbidden shell syntax.");
  });

  test.each(["s3 ls 'unterminated", 's3 ls "unterminated'])(
    "refuses unterminated quotes: %s",
    (command) => {
      const error = errorOf(() => splitCliArgs(command));
      expect(error.code).toBe("unterminated-quote");
      expect(error.message).toBe("Command contains an unterminated quote.");
    }
  );

  // The old behaviour is pinned: the options only change things when passed.
  test("drops quoted empty arguments", () => {
    expect(splitCliArgs('keyvault secret set --value ""')).toEqual([
      "keyvault",
      "secret",
      "set",
      "--value",
    ]);
  });

  test("keeps the backslash before $ inside double quotes", () => {
    expect(splitCliArgs('x --consumer-group "\\$Default"')).toEqual([
      "x",
      "--consumer-group",
      "\\$Default",
    ]);
  });

  test.each([
    "monitor diagnostic-settings create --logs '[\n  {\"enabled\": true}\n]'",
    "x --query '{a: join(`,`, b)}'",
  ])("refuses newlines and backticks even inside quotes: %s", (command) => {
    expect(errorOf(() => splitCliArgs(command)).code).toBe("shell-syntax");
  });
});

describe("splitCliArgs: the Azure options (C06 variant P)", () => {
  test("accepts multi-line JSON inside single quotes", () => {
    const command = "monitor diagnostic-settings create --logs '[\n  {\"enabled\": true}\n]'";
    expect(splitCliArgs(command, AZURE)).toEqual([
      "monitor",
      "diagnostic-settings",
      "create",
      "--logs",
      '[\n  {"enabled": true}\n]',
    ]);
  });

  test("accepts CRLF inside quotes and keeps it as data", () => {
    expect(splitCliArgs("x --policy '{\r\n}'", AZURE)).toEqual(["x", "--policy", "{\r\n}"]);
  });

  test("accepts JMESPath backtick literals inside single and double quotes", () => {
    expect(splitCliArgs("x --query '{a: join(`,`, b)}'", AZURE)).toEqual([
      "x",
      "--query",
      "{a: join(`,`, b)}",
    ]);
    // Inside double quotes a backtick stays literal: there is no shell to substitute it.
    expect(splitCliArgs('x --query "[?enabled==`true`]"', AZURE)).toEqual([
      "x",
      "--query",
      "[?enabled==`true`]",
    ]);
  });

  test.each(["x\ny", "x\ry", "x `whoami`"])(
    "still refuses control characters outside quotes: %j",
    (command) => {
      expect(errorOf(() => splitCliArgs(command, AZURE)).code).toBe("shell-syntax");
    }
  );

  test("keeps quoted empty arguments, in both quote styles", () => {
    expect(splitCliArgs('keyvault secret set --value ""', AZURE)).toEqual([
      "keyvault",
      "secret",
      "set",
      "--value",
      "",
    ]);
    expect(splitCliArgs("group update --tags ''", AZURE)).toEqual([
      "group",
      "update",
      "--tags",
      "",
    ]);
    expect(splitCliArgs('x """"', AZURE)).toEqual(["x", ""]);
  });

  test("joins adjacent quoted and unquoted parts into one word, as bash does", () => {
    expect(splitCliArgs("x a\"b c\"d 'e'f", AZURE)).toEqual(["x", "ab cd", "ef"]);
  });

  test("unescapes \\$ and \\` inside double quotes, as bash does", () => {
    expect(
      splitCliArgs('eventhubs eventhub consumer-group show --name "\\$Default"', AZURE)
    ).toEqual(["eventhubs", "eventhub", "consumer-group", "show", "--name", "$Default"]);
    expect(splitCliArgs('x "a\\`b"', AZURE)).toEqual(["x", "a`b"]);
  });

  test("drops a line continuation inside double quotes", () => {
    expect(splitCliArgs('x "a\\\nb"', AZURE)).toEqual(["x", "ab"]);
  });

  test("keeps other backslashes inside double quotes literally", () => {
    expect(splitCliArgs('x "C:\\Program Files\\app"', AZURE)).toEqual([
      "x",
      "C:\\Program Files\\app",
    ]);
  });
});

describe("splitCliArgs: Azure command shapes (inside quotes)", () => {
  test.each([
    [
      `vm list --query "[?location=='westeurope'] | [0].name"`,
      ["vm", "list", "--query", "[?location=='westeurope'] | [0].name"],
    ],
    [
      `appconfig kv list --query "[?key=='A' || key=='B'].key"`,
      ["appconfig", "kv", "list", "--query", "[?key=='A' || key=='B'].key"],
    ],
    [
      `graph query -q "Resources | where type =~ 'microsoft.storage/storageaccounts' | project name"`,
      [
        "graph",
        "query",
        "-q",
        "Resources | where type =~ 'microsoft.storage/storageaccounts' | project name",
      ],
    ],
    [
      `rest --method put --body '{"a":"b c"}'`,
      ["rest", "--method", "put", "--body", '{"a":"b c"}'],
    ],
    [
      `resource update --set properties.x='{"a":1}'`,
      ["resource", "update", "--set", 'properties.x={"a":1}'],
    ],
    [
      `webapp config connection-string set --settings "Db=Server=tcp:x;Database=y;User Id=z"`,
      [
        "webapp",
        "config",
        "connection-string",
        "set",
        "--settings",
        "Db=Server=tcp:x;Database=y;User Id=z",
      ],
    ],
    [
      `apim api policy create --value '<policies><inbound><base /></inbound></policies>'`,
      [
        "apim",
        "api",
        "policy",
        "create",
        "--value",
        "<policies><inbound><base /></inbound></policies>",
      ],
    ],
    [
      `storage blob upload --file "C:\\Users\\me\\My Files\\a.txt"`,
      ["storage", "blob", "upload", "--file", "C:\\Users\\me\\My Files\\a.txt"],
    ],
    [`x --name "tab\there"`, ["x", "--name", "tab\there"]],
    [`group create --name "gruppe-müller-✓"`, ["group", "create", "--name", "gruppe-müller-✓"]],
    [`group update --tags ""`, ["group", "update", "--tags", ""]],
  ])("splits %s", (command, expected) => {
    expect(splitCliArgs(command, AZURE)).toEqual(expected);
  });
});

describe("splitCliArgs: deliberate differences from bash, pinned in both modes", () => {
  test.each([{}, AZURE])("an unquoted backslash stays literal (options: %j)", (opts) => {
    expect(splitCliArgs(String.raw`storage blob upload --file C:\x\y.txt`, opts)).toEqual([
      "storage",
      "blob",
      "upload",
      "--file",
      String.raw`C:\x\y.txt`,
    ]);
  });

  test.each([{}, AZURE])("the POSIX '\\'' idiom is refused (options: %j)", (opts) => {
    expect(errorOf(() => splitCliArgs("x --name 'it'\\''s'", opts)).code).toBe(
      "unterminated-quote"
    );
  });

  test.each([{}, AZURE])("U+00A0 splits like a space (options: %j)", (opts) => {
    expect(splitCliArgs("group\u00a0list", opts)).toEqual(["group", "list"]);
  });

  test.each([{}, AZURE])(
    "an unquoted #word is an argument, not a comment (options: %j)",
    (opts) => {
      expect(splitCliArgs("x --name #tag", opts)).toEqual(["x", "--name", "#tag"]);
    }
  );

  test.each([{}, AZURE])("$VAR outside quotes is passed literally (options: %j)", (opts) => {
    expect(splitCliArgs("x --name $NAME", opts)).toEqual(["x", "--name", "$NAME"]);
  });

  test.each([{}, AZURE])("$( and ${ outside quotes are refused (options: %j)", (opts) => {
    expect(errorOf(() => splitCliArgs("x $(id)", opts)).code).toBe("shell-syntax");
    expect(errorOf(() => splitCliArgs("x ${HOME}", opts)).code).toBe("shell-syntax");
  });
});
