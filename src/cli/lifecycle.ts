/**
 * MCP clients signal shutdown over stdio by closing the server's stdin.
 * The bundled transport only listens for "data", so without this watcher
 * the process outlives its client: `docker run --rm` never removes the
 * container and npx-launched processes linger on the host.
 */

// Must exceed the PostHog flushInterval in core/analytics.ts (1000 ms) so
// telemetry from the final tool call is sent before the process exits.
const TELEMETRY_FLUSH_GRACE_MS = 1250;

export function exitWhenClientDisconnects(stdin: NodeJS.EventEmitter = process.stdin): void {
  let exitScheduled = false;

  const scheduleExit = () => {
    if (exitScheduled) return;
    exitScheduled = true;
    setTimeout(() => process.exit(0), TELEMETRY_FLUSH_GRACE_MS);
  };

  stdin.once("end", scheduleExit);
  stdin.once("close", scheduleExit);
}
