import { ClientId, ExistingEntrySummary, InstallOutcome, ServerSpec } from "../types";

export interface ClientContext {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

export interface DetectResult {
  installed: boolean;
  /** Set when the client cannot be configured on this platform at all. */
  unsupportedReason?: string;
}

export interface ExistingState {
  entries: ExistingEntrySummary[];
  /** Set when the client's config exists but cannot be safely edited. */
  error?: string;
  /** Non-blocking caveats the user should see (e.g. shadowing entries). */
  warnings?: string[];
}

export interface ClientAdapter {
  id: ClientId;
  label: string;
  /** Shown after a successful install, e.g. "Restart Cursor to load the server." */
  restartNote: string;
  detect(ctx: ClientContext): Promise<DetectResult>;
  getExisting(ctx: ClientContext): Promise<ExistingState>;
  install(spec: ServerSpec, ctx: ClientContext): Promise<InstallOutcome>;
  remove(ctx: ClientContext): Promise<InstallOutcome>;
}
