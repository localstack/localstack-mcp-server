import { HELP_TEXT } from "./help";

// Setup is the same for every tool: `init` configures MCP clients and never installs a tool's
// CLI. The Azure tool's add-ons (its Azure CLI extensions and Bicep) have their own command,
// which the user runs, as they would `pip install snowflake-cli-labs` for the Snowflake tool.
describe("the CLI's help", () => {
  const section = (from: string, to: string) =>
    HELP_TEXT.slice(HELP_TEXT.indexOf(from), HELP_TEXT.indexOf(to));

  test("init's options include nothing for Azure", () => {
    expect(HELP_TEXT).toContain("init options:");
    expect(section("init options:", "remove options:")).not.toMatch(/azure|bicep/i);
  });

  test("lists the install-azure-addons command and its options", () => {
    expect(HELP_TEXT).toMatch(
      /npx -y @localstack\/localstack-mcp-server install-azure-addons\s+Install the Azure CLI extensions and Bicep/
    );
    const addons = section("install-azure-addons options:", "Examples:");
    expect(addons).toContain("--no-extensions");
    expect(addons).toContain("--no-bicep");
  });
});
