import {
  formatInstalledExtensions,
  parseExtensionEvents,
  parseInstalledExtensions,
  summarizeInstall,
  summarizeUninstall,
} from "./extensions.logic";

const installSuccessStream = [
  "2026-07-04T10:00:00.000  INFO --- [MainThread] l.p.c.b.licensingv2 : Successfully activated cached license",
  '{"event": "status", "message": "Checking installed extensions"}',
  '{"event": "status", "message": "Installing extension"}',
  '{"event": "pip", "message": "Collecting localstack-extension-httpbin"}',
  "not json at all",
  '{"event": "log", "message": "Extension successfully installed"}',
  '{"event": "extension", "message": "", "extra": {"name": "httpbin"}}',
  '{"event": "status", "message": "Extension installation completed"}',
].join("\n");

describe("parseExtensionEvents", () => {
  test("parses JSON-lines events and skips interleaved log noise", () => {
    const events = parseExtensionEvents(installSuccessStream);
    expect(events.map((event) => event.event)).toEqual([
      "status",
      "status",
      "pip",
      "log",
      "extension",
      "status",
    ]);
  });
});

describe("summarizeInstall", () => {
  test("recognizes a successful install", () => {
    const outcome = summarizeInstall(parseExtensionEvents(installSuccessStream));
    expect(outcome.kind).toBe("installed");
    expect(outcome.success).toBe(true);
    expect(outcome.summaryLines).toContain("Extension successfully installed");
    // pip noise excluded from the summary
    expect(outcome.summaryLines.join("\n")).not.toContain("Collecting");
  });

  test("recognizes already-installed as success", () => {
    const outcome = summarizeInstall(
      parseExtensionEvents(
        '{"event": "log", "message": "Extension localstack-keycloak (0.1.0 by LocalStack Team) already installed"}'
      )
    );
    expect(outcome.kind).toBe("already-installed");
    expect(outcome.success).toBe(true);
  });

  test("maps unresolvable packages (incl. git URLs) to not-found", () => {
    const outcome = summarizeInstall(
      parseExtensionEvents(
        [
          '{"event": "status", "message": "Installing extension"}',
          '{"event": "pip", "message": "ERROR: No matching distribution found for no-such-ext"}',
          '{"event": "error", "message": "Could not resolve package no-such-ext, please check the URL or that the package exists in pypi."}',
        ].join("\n")
      )
    );
    expect(outcome.kind).toBe("not-found");
    expect(outcome.success).toBe(false);
    expect(outcome.errorDetail).toContain("Could not resolve package");
  });

  test("maps module exceptions to failed", () => {
    const outcome = summarizeInstall(
      parseExtensionEvents(
        '{"event": "exception", "message": "Error while installing extension: boom", "extra": {"traceback": "..."}}'
      )
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.errorDetail).toContain("boom");
  });

  test("treats a pip install that registered no extension as no-change failure", () => {
    const outcome = summarizeInstall(
      parseExtensionEvents('{"event": "log", "message": "No change"}')
    );
    expect(outcome.kind).toBe("no-change");
    expect(outcome.success).toBe(false);
  });
});

describe("summarizeUninstall", () => {
  test("recognizes a successful uninstall", () => {
    const outcome = summarizeUninstall(
      parseExtensionEvents(
        [
          '{"event": "log", "message": "Uninstalling extension localstack-extension-httpbin (0.1.0)"}',
          '{"event": "log", "message": "Extension successfully uninstalled"}',
        ].join("\n")
      )
    );
    expect(outcome.kind).toBe("uninstalled");
    expect(outcome.success).toBe(true);
  });

  test("maps not-installed to a distinct failure kind", () => {
    const outcome = summarizeUninstall(
      parseExtensionEvents('{"event": "log", "message": "Extension no-such is not installed"}')
    );
    expect(outcome.kind).toBe("not-installed");
    expect(outcome.success).toBe(false);
  });
});

describe("parseInstalledExtensions / formatInstalledExtensions", () => {
  test("parses list output (one plux metadata object per line)", () => {
    const output = [
      "2026-07-04 INFO license activated",
      JSON.stringify({
        namespace: "localstack.extensions",
        name: "keycloak",
        distribution: {
          name: "localstack-keycloak",
          version: "0.1.0",
          summary: "Keycloak for IAM",
          author: "LocalStack Team",
        },
      }),
    ].join("\n");

    const extensions = parseInstalledExtensions(output);
    expect(extensions).toHaveLength(1);
    const markdown = formatInstalledExtensions(extensions);
    expect(markdown).toContain("Installed LocalStack Extensions");
    expect(markdown).toContain("localstack-keycloak");
    expect(markdown).toContain("0.1.0");
  });

  test("formats an empty list with marketplace guidance", () => {
    expect(formatInstalledExtensions([])).toContain(
      "No LocalStack extensions are currently installed"
    );
  });
});

describe("validateExtensionTarget", () => {
  const { validateExtensionTarget } = jest.requireActual("./extensions.logic");

  test("accepts PyPI-style names, extras, and version pins", () => {
    expect(validateExtensionTarget({ name: "localstack-extension-typedb" })).toBeNull();
    expect(validateExtensionTarget({ name: "localstack-extension-typedb==1.0.0" })).toBeNull();
    expect(validateExtensionTarget({ name: "my_ext[extra1,extra2]==2.0.0rc1" })).toBeNull();
  });

  test("rejects names that look like pip options, paths, or shell noise", () => {
    for (const name of [
      "--index-url=https://evil.example/simple",
      "-e .",
      "../somewhere/local",
      "./pkg",
      "pkg; rm -rf /",
      "pkg name with spaces",
      "pkg>=1.0", // only == pins are supported
    ]) {
      expect(validateExtensionTarget({ name })).toMatch(/not a valid extension package name/);
    }
  });

  test("accepts documented git+https sources on known hosts", () => {
    expect(
      validateExtensionTarget({
        source:
          "git+https://github.com/localstack/localstack-extensions.git#egg=localstack-keycloak&subdirectory=keycloak",
      })
    ).toBeNull();
    expect(
      validateExtensionTarget({ source: "git+https://gitlab.com/org/repo.git@v1.2.3" })
    ).toBeNull();
  });

  test("rejects non-https, unknown-host, and non-git sources", () => {
    for (const source of [
      "git+ssh://git@github.com/org/repo.git",
      "git+https://evil.example/org/repo.git",
      "https://github.com/org/repo.git",
      "file:///etc/passwd",
      "git+https://github.com/org/repo.git --index-url=x",
    ]) {
      expect(validateExtensionTarget({ source })).toMatch(/not a supported extension source/);
    }
  });

  test("rejects host-confusion sources (suffix / userinfo tricks)", () => {
    for (const source of [
      "git+https://github.com.evil.com/org/repo.git",
      "git+https://github.com@evil.com/org/repo.git",
      "git+https://evil.com@github.com/org/repo.git",
      "git+https://github.comX/org/repo.git",
    ]) {
      expect(validateExtensionTarget({ source })).toMatch(/not a supported extension source/);
    }
  });

  test("rejects '..' path traversal in the source fragment (subdirectory=)", () => {
    expect(
      validateExtensionTarget({
        source: "git+https://github.com/org/repo#subdirectory=../../../../opt/code",
      })
    ).toMatch(/'\.\.'/);
    expect(
      validateExtensionTarget({
        source: "git+https://github.com/org/repo#egg=x&subdirectory=../../etc",
      })
    ).toMatch(/'\.\.'/);
  });

  test("treats an empty name as absent so a source-only install is accepted", () => {
    expect(
      validateExtensionTarget({
        name: "",
        source: "git+https://github.com/org/repo.git",
      })
    ).toBeNull();
  });

  test("validates in linear time (no catastrophic backtracking)", () => {
    const evil = "a".repeat(100000);
    const start = Date.now();
    validateExtensionTarget({ name: `${evil} ` }); // fails the regex
    validateExtensionTarget({ source: `git+https://github.com/${evil}` });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
