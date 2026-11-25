import fs from "fs";
import os from "os";
import path from "path";
import { OutsideWorkdirError } from "./local-paths";
import {
  allowedFolders,
  askToAllow,
  consentRequest,
  readConsent,
  resetPathConsent,
} from "./path-consent";

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
  const ask = (p: string, command = "c", allowed: string[] = []) =>
    askToAllow(error(p), { command, workdir: null, allowed, rounds: 0 });
  const answer = (action: string, scope?: string) => ({
    allow_path: { action, ...(scope ? { content: { scope } } : {}) },
  });
  const retry = (state: string | undefined, inputResponses: unknown, command = "c") =>
    readConsent(command, {
      requestState: (() => state) as any,
      inputResponses: inputResponses as any,
    });

  test("asks about the resolved path, with the agent's command on one line", () => {
    const request = consentRequest(error(file), "s3 cp\n  x s3://b", "/w");
    expect(request.message).toContain(`\n${file}\n`);
    expect(request.message).toContain("`s3 cp x s3://b`");
    expect(request.message).toContain("(/w)");
    expect(request.requestedSchema.properties.scope.enum).toEqual(["once", "folder"]);
    expect(request.requestedSchema.properties.scope.enumNames[1]).toContain(dir);
  });

  test("offers no folder that is too wide to allow", () => {
    // A file directly in the home directory: its folder is the home directory.
    const request = consentRequest(error(path.join(os.homedir(), "x.txt")), "s3 ls", null);
    expect(request.requestedSchema.properties.scope.enum).toEqual(["once"]);
  });

  test("returns an input-required result with a form and signed state", async () => {
    const result = (await ask(file)) as any;
    expect(result.resultType).toBe("input_required");
    expect(result.inputRequests.allow_path.method).toBe("elicitation/create");
    expect(result.inputRequests.allow_path.params.message).toContain(file);
    expect(typeof result.requestState).toBe("string");
  });

  test("allowing once allows the path for this call only", async () => {
    const { requestState } = (await ask(file)) as any;
    expect(await retry(requestState, answer("accept", "once"))).toEqual({
      allowed: [file],
      rounds: 1,
    });
    expect(allowedFolders()).toEqual([]);
  });

  test("allowing the folder keeps it for the session", async () => {
    const { requestState } = (await ask(file)) as any;
    expect(await retry(requestState, answer("accept", "folder"))).toEqual({
      allowed: [dir],
      rounds: 1,
    });
    expect(allowedFolders()).toEqual([dir]);
  });

  test("a folder answer for a too-wide folder allows only the path", async () => {
    const p = path.join(os.homedir(), "x.txt");
    const { requestState } = (await ask(p)) as any;
    expect(await retry(requestState, answer("accept", "folder"))).toEqual({
      allowed: [p],
      rounds: 1,
    });
    expect(allowedFolders()).toEqual([]);
  });

  test.each([
    ["declines", answer("decline")],
    ["cancels", answer("cancel")],
    ["sends no answer", undefined],
  ])("the user who %s allows nothing", async (_label, responses) => {
    const { requestState } = (await ask(file)) as any;
    expect(await retry(requestState, responses)).toEqual({ declined: file });
  });

  test("state that is forged, tampered with or for another command allows nothing", async () => {
    const { requestState } = (await ask(file)) as any;
    const [version, body, mac] = requestState.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    payload.p.allowed = ["/etc"];
    const tampered = [
      version,
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      mac,
    ].join(".");
    const fresh = { allowed: [], rounds: 0 };
    expect(await retry(tampered, answer("accept", "once"))).toEqual(fresh);
    expect(await retry("v1.e30.AAAA", answer("accept", "once"))).toEqual(fresh);
    expect(await retry(requestState, answer("accept", "once"), "other command")).toEqual(fresh);
  });

  test("carries paths allowed in earlier rounds", async () => {
    const { requestState } = (await askToAllow(error(file), {
      command: "c",
      workdir: null,
      allowed: ["/first"],
      rounds: 1,
    })) as any;
    expect(await retry(requestState, answer("accept", "once"))).toEqual({
      allowed: ["/first", file],
      rounds: 2,
    });
  });
});
