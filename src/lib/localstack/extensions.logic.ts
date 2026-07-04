/**
 * Parsing for the in-container LocalStack extensions manager
 * (`python -m localstack.pro.core.bootstrap.extensions <verb>`), which streams
 * JSON-lines events: {event: "status"|"log"|"pip"|"error"|"extension"|"exception",
 * message, extra?}. `list` emits one plux metadata JSON object per line instead.
 *
 * Verified against the 2026.x pro image: the module exits 0 even on failure (errors
 * are reported as `error`/`exception` events), so outcomes MUST be derived from the
 * event stream, not the exit code.
 */

export const EXTENSIONS_MANAGER_COMMAND = [
  "/opt/code/localstack/.venv/bin/python",
  "-m",
  "localstack.pro.core.bootstrap.extensions",
];

/**
 * Ensure the extensions venv on /var/lib/localstack is usable before install /
 * uninstall (the manager's `pip` calls need a working interpreter):
 *  - missing venv → `init` (what the CLI's _ensure_venv_initialized did)
 *  - broken interpreter symlinks → the venv on the shared volume was created by an
 *    older image whose python lived at a different path (e.g. /usr/local/bin vs
 *    /usr/bin). Re-link via `venv --upgrade` — repairs scripts without touching
 *    installed packages. (The official CLI fails hard on this case.)
 *  - missing pip → bootstrap via ensurepip.
 */
export const EXTENSIONS_VENV_REPAIR_SCRIPT = [
  'V=/var/lib/localstack/lib/extensions/python_venv',
  'PY=/opt/code/localstack/.venv/bin/python',
  'if [ ! -e "$V/pyvenv.cfg" ]; then "$PY" -m localstack.pro.core.bootstrap.extensions init; fi',
  'if ! "$V/bin/python" -c "import sys" >/dev/null 2>&1; then rm -f "$V/bin/python" "$V/bin/python3" "$V"/bin/python3.*; "$PY" -m venv --upgrade "$V"; fi',
  'if [ ! -x "$V/bin/pip" ]; then "$V/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true; fi',
].join("\n");

export interface ExtensionEvent {
  event: string;
  message?: string;
  extra?: unknown;
}

export interface InstalledExtension {
  name?: string;
  distribution?: {
    name?: string;
    version?: string;
    summary?: string;
    author?: string;
  };
}

/** Parse a JSON-lines stream, skipping non-JSON noise (log lines, pip banners). */
export function parseJsonLines(output: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Interleaved runtime logging (e.g. license activation INFO lines) — skip.
    }
  }
  return parsed;
}

export function parseExtensionEvents(output: string): ExtensionEvent[] {
  return parseJsonLines(output).filter(
    (value): value is ExtensionEvent =>
      !!value && typeof value === "object" && typeof (value as ExtensionEvent).event === "string"
  );
}

export function parseInstalledExtensions(output: string): InstalledExtension[] {
  return parseJsonLines(output).filter(
    (value): value is InstalledExtension =>
      !!value &&
      typeof value === "object" &&
      // plux metadata objects have name + factory/distribution, no `event` key
      (value as ExtensionEvent).event === undefined &&
      typeof (value as InstalledExtension).name === "string"
  );
}

export type ExtensionOutcomeKind =
  | "installed"
  | "already-installed"
  | "no-change"
  | "uninstalled"
  | "not-installed"
  | "not-found"
  | "failed";

export interface ExtensionOutcome {
  kind: ExtensionOutcomeKind;
  success: boolean;
  /** Human-readable log/status/error lines in stream order (pip noise excluded). */
  summaryLines: string[];
  errorDetail?: string;
}

function collectSummaryLines(events: ExtensionEvent[]): string[] {
  return events
    .filter((event) => ["log", "status", "error", "exception"].includes(event.event))
    .map((event) => event.message || "")
    .filter(Boolean);
}

export function summarizeInstall(events: ExtensionEvent[]): ExtensionOutcome {
  const summaryLines = collectSummaryLines(events);
  const logMessages = events
    .filter((event) => event.event === "log")
    .map((event) => event.message || "");
  const errorEvent = events.find((event) => event.event === "error");
  const exceptionEvent = events.find((event) => event.event === "exception");

  if (errorEvent?.message?.includes("Could not resolve package")) {
    return { kind: "not-found", success: false, summaryLines, errorDetail: errorEvent.message };
  }
  if (exceptionEvent || errorEvent) {
    const detail = (exceptionEvent || errorEvent)?.message || "Extension installation failed.";
    return { kind: "failed", success: false, summaryLines, errorDetail: detail };
  }
  if (logMessages.some((message) => message.includes("already installed"))) {
    return { kind: "already-installed", success: true, summaryLines };
  }
  if (logMessages.some((message) => message.includes("Extension successfully installed"))) {
    return { kind: "installed", success: true, summaryLines };
  }
  if (logMessages.some((message) => message.includes("No change"))) {
    return { kind: "no-change", success: false, summaryLines, errorDetail: "The package was installed but did not register any LocalStack extension." };
  }
  return {
    kind: "failed",
    success: false,
    summaryLines,
    errorDetail: "The extension manager did not report a successful installation.",
  };
}

export function summarizeUninstall(events: ExtensionEvent[]): ExtensionOutcome {
  const summaryLines = collectSummaryLines(events);
  const logMessages = events
    .filter((event) => event.event === "log")
    .map((event) => event.message || "");
  const exceptionEvent = events.find(
    (event) => event.event === "exception" || event.event === "error"
  );

  if (exceptionEvent) {
    return {
      kind: "failed",
      success: false,
      summaryLines,
      errorDetail: exceptionEvent.message || "Extension uninstall failed.",
    };
  }
  if (logMessages.some((message) => message.includes("is not installed"))) {
    return { kind: "not-installed", success: false, summaryLines, errorDetail: logMessages.find((m) => m.includes("is not installed")) };
  }
  if (logMessages.some((message) => message.includes("Extension successfully uninstalled"))) {
    return { kind: "uninstalled", success: true, summaryLines };
  }
  return {
    kind: "failed",
    success: false,
    summaryLines,
    errorDetail: "The extension manager did not report a successful uninstall.",
  };
}

export function formatInstalledExtensions(extensions: InstalledExtension[]): string {
  if (extensions.length === 0) {
    return "No LocalStack extensions are currently installed.\n\nUse the `available` action to browse the marketplace.";
  }
  let markdown = `## Installed LocalStack Extensions\n\n${extensions.length} extension(s) installed.\n`;
  for (const extension of extensions) {
    const dist = extension.distribution || {};
    markdown += `\n### ${dist.name || extension.name}\n`;
    const meta = [
      dist.version ? `**Version:** ${dist.version}` : null,
      dist.author ? `**Author:** ${dist.author}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    if (meta) markdown += `${meta}\n`;
    if (dist.summary) markdown += `${dist.summary}\n`;
  }
  return markdown;
}
