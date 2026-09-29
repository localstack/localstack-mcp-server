/**
 * The tool definitions per variant: each variant changes only what it
 * says it changes, fails loudly when the server's description no longer has its anchor,
 * and the long description's adaptation removes exactly the statements that are false for this tool.
 */
import { buildAzureClientDescription } from "../../../src/lib/azure/description";
import * as VT from "./variants";

/** The server's description as it is built today (src/lib/azure/description.ts). */
const COMPACT = [
  "Run an Azure CLI (az) command against the local LocalStack for Azure emulator and return its output.",
  "",
  '- Runs against the local emulator only, never real Azure: the CLI is pre-configured with a "LocalStack" cloud and a dummy login, so all data and secrets are local test data. Subscription: 00000000-0000-0000-0000-000000000000. Default location: westeurope.',
  "- Unsure of a command or its parameters? Run it with --help first.",
  "Examples: group create --name rg1 --location westeurope",
].join("\n");

const LISTED: VT.ListedTool[] = [
  { name: "localstack-docs", description: "Search the docs.", inputSchema: { type: "object" } },
  {
    name: VT.AZURE_TOOL,
    description: COMPACT,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "localstack-management",
    description: "Start and stop emulators.",
    inputSchema: { type: "object" },
  },
];

describe("variants", () => {
  test("the server's real description still has both anchors the variants edit", () => {
    const real = buildAzureClientDescription({ workdir: "/work", maxOutputChars: 30000 });
    expect(real).toContain(VT.HELP_SENTENCE);
    expect(real).toContain(VT.TEST_DATA_CLAUSE);
    expect(real.split("\n")[2]).toBe(COMPACT.split("\n")[2]);
  });

  test("compact sends the server's own description, without the $schema line", () => {
    const vt = VT.buildVariantTools("compact", LISTED);
    expect(vt.tools).toHaveLength(1);
    expect(vt.tools[0]).toEqual({
      name: VT.AZURE_TOOL,
      description: COMPACT,
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    });
    expect(vt.helpTool).toBe(false);
  });

  test("no-test-data drops only the local-test-data clause", () => {
    const d = VT.buildVariantTools("no-test-data", LISTED).azureDescription;
    expect(d).not.toContain("local test data");
    expect(d).toContain(
      'a "LocalStack" cloud and a dummy login. Subscription: 00000000-0000-0000-0000-000000000000.'
    );
    expect(COMPACT.replace(VT.TEST_DATA_CLAUSE, "")).toBe(d);
  });

  test("help-tool replaces --help with az_help and adds the az_help tool", () => {
    const vt = VT.buildVariantTools("help-tool", LISTED);
    expect(vt.tools.map((t) => t.name)).toEqual(["az_help", VT.AZURE_TOOL]);
    expect(vt.azureDescription).toContain("Call `az_help` with the command or group");
    expect(vt.azureDescription).not.toContain("Run it with --help first");
    const help = vt.tools[0];
    expect(help.description).toBe(VT.AZ_HELP_DESCRIPTION);
    expect(help.input_schema).toMatchObject({ required: ["prefix"] });
    expect(vt.helpTool).toBe(true);
  });

  test("long: the long description, adapted in three places", () => {
    const d = VT.buildVariantTools("long", LISTED).azureDescription;
    expect(d).toBe(VT.LONG_DESCRIPTION);
    // what this tool does not do is gone
    expect(d).not.toContain("az_help");
    expect(d).not.toMatch(/list of commands|Batch sequential steps/);
    expect(d).not.toContain("is blocked");
    expect(d).not.toContain("JSON output, parsed");
    // the original text otherwise
    expect(d).toContain("Do not run `az login`, `az logout` or `az cloud ...`");
    expect(d).toContain(
      "One CLI command per string: no pipes (|), redirects (>, <), chaining (&&, ||, ;)"
    );
    expect(d).toContain(
      "If you are unsure of a command's name or parameters, run it with --help first."
    );
    expect(d.length).toBeGreaterThan(COMPACT.length);
  });

  test("a missing anchor fails loudly instead of testing the default", () => {
    const changed = [{ ...LISTED[1], description: "Run az. Help: use --help." }];
    expect(() => VT.buildVariantTools("help-tool", changed)).toThrow(/no longer contains/);
    expect(() => VT.buildVariantTools("no-test-data", changed)).toThrow(/no longer contains/);
    expect(() => VT.buildVariantTools("compact", [LISTED[0]])).toThrow(
      /does not list localstack-azure-client/
    );
  });

  test("--all-tools offers every tool but the withheld management tool, sorted by name", () => {
    const vt = VT.buildVariantTools("compact", LISTED, true);
    expect(vt.tools.map((t) => t.name)).toEqual([VT.AZURE_TOOL, "localstack-docs"]);
    expect(VT.WITHHELD_TOOLS).toContain("localstack-management");
  });

  test("helpCommand builds `<prefix> --help` once", () => {
    expect(VT.helpCommand("storage account create")).toBe("storage account create --help");
    expect(VT.helpCommand("az containerapp env")).toBe("containerapp env --help");
    expect(VT.helpCommand("afd route create --help")).toBe("afd route create --help");
    expect(VT.helpCommand("")).toBe("--help");
  });

  test("isVariant", () => {
    expect(VT.VARIANTS).toEqual(["compact", "long", "help-tool", "no-test-data"]);
    expect(VT.isVariant("long")).toBe(true);
    expect(VT.isVariant("verbose")).toBe(false);
  });
});
