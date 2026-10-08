import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { commandWords, extensionFor, listInstalledExtensions } from "./extension-map";

test("extensionFor matches the exact command path of a missing extension", () => {
  const none = new Set<string>();
  expect(extensionFor(["monitor", "app-insights"], none)).toBe("application-insights");
  expect(extensionFor(["network", "vwan"], none)).toBe("virtual-wan");
  expect(extensionFor(["afd", "bogus"], none)).toBeUndefined();
  expect(extensionFor(["graph"], new Set(["resource-graph"]))).toBeUndefined();
  expect(commandWords(["graph", "query", "-q", "x"])).toEqual(["graph", "query"]);
});

test("listInstalledExtensions counts directories with package metadata", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lsmcp-ext-"));
  mkdirSync(path.join(dir, "fleet", "fleet-1.0.0.dist-info"), { recursive: true });
  mkdirSync(path.join(dir, "half-installed"));
  writeFileSync(path.join(dir, "stray.txt"), "");
  expect(listInstalledExtensions(dir)).toEqual(new Set(["fleet"]));
  expect(listInstalledExtensions(path.join(dir, "missing"))).toEqual(new Set());
});
