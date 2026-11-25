import fs from "fs";
import os from "os";
import path from "path";
import { OutsideWorkdirError } from "./local-paths";
import { allowedFolders, askToAllow, consentRequest, resetPathConsent } from "./path-consent";

describe("path consent", () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "consent-")));
    file = path.join(dir, "report.pdf");
    fs.writeFileSync(file, "pdf");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(resetPathConsent);

  const error = (p: string) => new OutsideWorkdirError("outside", p);

  test("asks about the resolved path, with the agent's command on one line", () => {
    const request = consentRequest(error(file), "s3 cp\n  x s3://b", "/w") as any;
    expect(request.message).toContain(`\n${file}\n`);
    expect(request.message).toContain("`s3 cp x s3://b`");
    expect(request.message).toContain("(/w)");
    expect(request.requestedSchema.properties.scope.enum).toEqual(["once", "folder"]);
    expect(request.requestedSchema.properties.scope.enumNames[1]).toContain(dir);
  });

  test("offers no folder that is too wide to allow", () => {
    // A file directly in the home directory: its folder is the home directory.
    const request = consentRequest(error(path.join(os.homedir(), "x.txt")), "s3 ls", null) as any;
    expect(request.requestedSchema.properties.scope.enum).toEqual(["once"]);
  });

  test("allowing the folder keeps it for the session", async () => {
    const elicit = jest.fn().mockResolvedValue({ action: "accept", content: { scope: "folder" } });
    expect(await askToAllow(error(file), { command: "c", workdir: null, elicit })).toEqual({
      allow: dir,
    });
    expect(allowedFolders()).toEqual([dir]);
  });

  test("allowing once keeps nothing", async () => {
    const elicit = jest.fn().mockResolvedValue({ action: "accept", content: { scope: "once" } });
    expect(await askToAllow(error(file), { command: "c", workdir: null, elicit })).toEqual({
      allow: file,
    });
    expect(allowedFolders()).toEqual([]);
  });

  test("a folder answer for a too-wide folder allows only the path", async () => {
    const p = path.join(os.homedir(), "x.txt");
    const elicit = jest.fn().mockResolvedValue({ action: "accept", content: { scope: "folder" } });
    expect(await askToAllow(error(p), { command: "c", workdir: null, elicit })).toEqual({
      allow: p,
    });
    expect(allowedFolders()).toEqual([]);
  });
});
