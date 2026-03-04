import fs from "fs";
import path from "path";
import { TOOL_ARG_ALLOWLIST } from "./analytics";

describe("analytics allowlist coverage", () => {
  it("has allowlist entries for all tool metadata names", () => {
    const toolsDir = path.resolve(__dirname, "../tools");
    const toolFiles = fs
      .readdirSync(toolsDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

    const toolNames = new Set<string>();

    for (const file of toolFiles) {
      const content = fs.readFileSync(path.join(toolsDir, file), "utf-8");
      const match = content.match(/metadata:\s*ToolMetadata\s*=\s*\{[\s\S]*?name:\s*"([^"]+)"/m);
      const name = match?.[1];
      expect(name).toBeTruthy();
      if (name) toolNames.add(name);
    }

    const allowlistNames = new Set(Object.keys(TOOL_ARG_ALLOWLIST));

    for (const name of toolNames) {
      expect(allowlistNames.has(name)).toBe(true);
    }

    for (const name of allowlistNames) {
      expect(toolNames.has(name)).toBe(true);
    }
  });
});
