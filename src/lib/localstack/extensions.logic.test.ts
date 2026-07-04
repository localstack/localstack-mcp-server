import {
  formatInstalledExtensions,
  parseExtensionEvents,
  parseInstalledExtensions,
  summarizeInstall,
  summarizeUninstall,
} from "./extensions.logic";

const installSuccessStream = [
  '2026-07-04T10:00:00.000  INFO --- [MainThread] l.p.c.b.licensingv2 : Successfully activated cached license',
  '{"event": "status", "message": "Checking installed extensions"}',
  '{"event": "status", "message": "Installing extension"}',
  '{"event": "pip", "message": "Collecting localstack-extension-httpbin"}',
  'not json at all',
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
    expect(formatInstalledExtensions([])).toContain("No LocalStack extensions are currently installed");
  });
});
