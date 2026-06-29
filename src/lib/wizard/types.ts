export type InstallMethod = "npx" | "docker";

export type ClientId =
  | "cursor"
  | "antigravity"
  | "claude-code"
  | "claude-desktop"
  | "vscode"
  | "codex"
  | "opencode"
  | "amazon-q";

export const SERVER_NAME = "localstack";
export const NPM_PACKAGE = "@localstack/localstack-mcp-server";
export const DOCKER_IMAGE = "localstack/localstack-mcp-server";
export const AUTH_TOKEN_ENV = "LOCALSTACK_AUTH_TOKEN";

export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DockerOptions {
  cacheDir: string;
  workspaceDir?: string;
  imageTag: string;
}

export interface WizardAnswers {
  method: InstallMethod;
  token: string;
  extraEnv: Record<string, string>;
  docker?: DockerOptions;
  clients: ClientId[];
  force: boolean;
}

export interface ExistingEntrySummary {
  key: string;
  method: InstallMethod | "unknown";
}

export type InstallOutcome =
  | { status: "installed"; detail: string }
  | { status: "skipped"; detail: string }
  | { status: "failed"; detail: string };
