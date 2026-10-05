import { parseInitFlags, parseRemoveFlags } from "./cli-args.logic";

describe("parseInitFlags", () => {
  it("parses a full non-interactive invocation", () => {
    const { flags, errors } = parseInitFlags([
      "--method",
      "docker",
      "--client",
      "cursor,claude-code",
      "--token",
      "ls-abc",
      "--config",
      "DEBUG=1",
      "--cache-dir",
      "/tmp/cache",
      "--workspace",
      "/tmp/proj",
      "--image-tag",
      "0.5.0",
      "--force",
      "--yes",
    ]);
    expect(errors).toEqual([]);
    expect(flags).toMatchObject({
      method: "docker",
      clients: ["cursor", "claude-code"],
      token: "ls-abc",
      config: "DEBUG=1",
      cacheDir: "/tmp/cache",
      workspace: "/tmp/proj",
      imageTag: "0.5.0",
      force: true,
      yes: true,
    });
  });

  it("supports repeatable --client flags and dedupes", () => {
    const { flags } = parseInitFlags(["--client", "cursor", "--client", "vscode,cursor"]);
    expect(flags?.clients).toEqual(["cursor", "vscode"]);
  });

  it("rejects unknown methods and clients", () => {
    expect(parseInitFlags(["--method", "brew"]).errors[0]).toContain("--method");
    expect(parseInitFlags(["--client", "zed"]).errors[0]).toContain('Unknown client "zed"');
  });

  it("rejects unknown flags", () => {
    expect(parseInitFlags(["--bogus"]).errors.length).toBeGreaterThan(0);
  });

  it("rejects --client with no usable ids instead of falling back to auto-detect", () => {
    expect(parseInitFlags(["--client", ""]).errors[0]).toContain("--client was given");
    expect(parseInitFlags(["--client", ","]).errors[0]).toContain("--client was given");
  });

  it("defaults booleans to false with no flags", () => {
    const { flags, errors } = parseInitFlags([]);
    expect(errors).toEqual([]);
    expect(flags).toMatchObject({ force: false, yes: false, help: false });
    expect(flags?.method).toBeUndefined();
    expect(flags?.clients).toBeUndefined();
  });
});

describe("parseRemoveFlags", () => {
  it("parses clients and force", () => {
    const { flags } = parseRemoveFlags(["--client", "cursor", "--force"]);
    expect(flags).toMatchObject({ clients: ["cursor"], force: true });
  });

  it("treats --yes as --force", () => {
    expect(parseRemoveFlags(["--yes"]).flags?.force).toBe(true);
  });
});
