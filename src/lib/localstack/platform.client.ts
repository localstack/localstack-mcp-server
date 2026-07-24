import { HttpClient, HttpError } from "../../core/http-client";

export const PLATFORM_API_BASE_URL = "https://api.localstack.cloud/v1";

export interface EphemeralInstance {
  instance_name?: string;
  id?: string;
  status?: string;
  endpoint_url?: string;
  creation_time?: string | number;
  expiry_time?: string | number;
  [key: string]: unknown;
}

export interface CreateEphemeralInstanceRequest {
  name: string;
  lifetime?: number;
  envVars?: Record<string, string>;
}

export interface MarketplaceExtension {
  name?: string;
  summary?: string;
  description?: string;
  author?: string;
  version?: string;
}

/**
 * Client for the LocalStack Cloud platform API — the same REST surface the
 * `localstack ephemeral` CLI commands wrap. Auth is HTTP Basic with an empty
 * username and the auth token as password.
 */
export class PlatformApiClient {
  private readonly http = new HttpClient();

  constructor(private readonly authToken: string) {}

  private headers(): Record<string, string> {
    const encoded = Buffer.from(`:${this.authToken}`).toString("base64");
    return {
      Authorization: `Basic ${encoded}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private request<T>(path: string, options: RequestInit & { timeout?: number } = {}): Promise<T> {
    return this.http.request<T>(path, {
      baseUrl: PLATFORM_API_BASE_URL,
      timeout: options.timeout ?? 60000,
      ...options,
      headers: { ...this.headers(), ...(options.headers as Record<string, string> | undefined) },
    });
  }

  async createEphemeralInstance({
    name,
    lifetime,
    envVars,
  }: CreateEphemeralInstanceRequest): Promise<EphemeralInstance> {
    return this.request<EphemeralInstance>("/compute/instances", {
      method: "POST",
      body: JSON.stringify({
        instance_name: name,
        ...(lifetime !== undefined ? { lifetime } : {}),
        ...(envVars && Object.keys(envVars).length > 0 ? { env_vars: envVars } : {}),
      }),
      // Instance provisioning can take a while server-side.
      timeout: 180000,
    });
  }

  async listEphemeralInstances(): Promise<EphemeralInstance[]> {
    const result = await this.request<EphemeralInstance[] | { instances?: EphemeralInstance[] }>(
      "/compute/instances",
      { method: "GET" }
    );
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.instances)) return result.instances;
    return [];
  }

  async getEphemeralInstanceLogs(name: string): Promise<string> {
    const result = await this.request<Array<{ content?: string }> | string>(
      `/compute/instances/${encodeURIComponent(name)}/logs`,
      { method: "GET", timeout: 120000 }
    );
    if (typeof result === "string") return result;
    if (Array.isArray(result)) {
      return result
        .map((entry) => (typeof entry === "string" ? entry : entry?.content || ""))
        .filter(Boolean)
        .join("\n");
    }
    return JSON.stringify(result, null, 2);
  }

  async deleteEphemeralInstance(name: string): Promise<void> {
    await this.request(`/compute/instances/${encodeURIComponent(name)}`, {
      method: "DELETE",
      timeout: 120000,
    });
  }

  async getExtensionsMarketplace(): Promise<MarketplaceExtension[]> {
    const result = await this.request<MarketplaceExtension[]>("/extensions/marketplace", {
      method: "GET",
    });
    return Array.isArray(result) ? result : [];
  }
}

/** Map platform API failures to the user-facing message pattern used by tools. */
export function describePlatformError(error: unknown, subject: string): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) {
      return `Authentication with the LocalStack platform failed. Ensure LOCALSTACK_AUTH_TOKEN is set correctly and your workspace has access to ${subject}.`;
    }
    if (error.status === 404) {
      return `${subject} was not found.`;
    }
    const body = error.body?.slice(0, 500);
    return `Platform API error (${error.status} ${error.statusText})${body ? `: ${body}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}
