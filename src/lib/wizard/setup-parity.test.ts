import fs from "fs";
import path from "path";

// The setup wizard treats every tool alike: it configures MCP clients and never checks, asks
// about or installs a tool's own CLI. The Snowflake tool's `snow` never appears in it, and
// neither do the Azure tool's `az`, its extensions or Bicep (those have their own command,
// `install-azure-addons`, which the README and the Azure tool's answers name).
const REPO = path.resolve(__dirname, "..", "..", "..");
const WIZARD_SOURCES = [
  "src/cli/init.ts",
  "src/lib/wizard/prereqs.ts",
  "src/lib/wizard/cli-args.logic.ts",
];

describe("the setup wizard has no tool-specific step, as for Snowflake", () => {
  test.each(WIZARD_SOURCES)("%s mentions neither Azure, Bicep nor Snowflake's CLI", (file) => {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    expect(text).not.toMatch(/azure|bicep|snowflake-cli|\bsnow\b/i);
  });
});
