import * as fs from "fs";
import * as path from "path";
import { parsePinList } from "./extension-map";
import { AZURE_EXTENSION_PINS } from "./extension-pins";

// The wizard's embedded copy of docker/azure-extensions.txt must equal the file, which the
// Docker build and the install script read. Update extension-pins.ts with it.
test("the embedded pin list equals docker/azure-extensions.txt", () => {
  const file = path.join(__dirname, "../../../docker/azure-extensions.txt");
  expect(AZURE_EXTENSION_PINS).toEqual(parsePinList(fs.readFileSync(file, "utf8")));
});
