import { httpClient, HttpError } from "../../core/http-client";

export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; message: string; statusCode?: number };

export interface AwsConfig {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  region_name?: string;
  endpoint_url?: string;
}

export interface ReplicationJobConfig {
  resource_type?: string;
  resource_identifier?: string;
  resource_arn?: string;
}

export interface StartReplicationJobRequest {
  replication_type: "SINGLE_RESOURCE" | "BATCH";
  replication_job_config: ReplicationJobConfig;
  source_aws_config: AwsConfig;
  target_aws_config?: AwsConfig;
}

export interface ReplicationJobResponse {
  job_id: string;
  state: string;
  error_message?: string | null;
  type?: string;
  replication_type?: string;
  replication_config?: Record<string, unknown>;
  replication_job_config?: Record<string, unknown>;
  result?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReplicationSupportedResource {
  resource_type?: string;
  service?: string;
  identifier?: string;
  policy_statements?: unknown[];
  [key: string]: unknown;
}

export interface AppInspectorStatusResponse {
  status: string;
  note?: string;
}

export interface AppInspectorSetStatusResponse {
  status: string;
  changed: boolean;
}

export type AppInspectorStatus = "enabled" | "disabled";
export type AppInspectorQuery = Record<string, string | number | undefined>;

// Chaos API Client
export class ChaosApiClient {
  private async makeRequest(
    endpoint: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: any
  ): Promise<ApiResult<any>> {
    try {
      const data = await httpClient.request<any>(`/_localstack/chaos${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpError) {
        return {
          success: false,
          message: `❌ **Error:** The LocalStack Chaos API returned an error (Status ${error.status}):\n\`\`\`\n${error.body}\n\`\`\``,
          statusCode: error.status,
        };
      }
      return {
        success: false,
        message: `❌ **Error:** Failed to communicate with LocalStack Chaos API: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  getFaults() {
    return this.makeRequest("/faults", "GET");
  }
  setFaults(rules: any[]) {
    return this.makeRequest("/faults", "POST", rules);
  }
  addFaultRules(rules: any[]) {
    return this.makeRequest("/faults", "PATCH", rules);
  }
  removeFaultRules(rules: any[]) {
    return this.makeRequest("/faults", "DELETE", rules);
  }
  getEffects() {
    return this.makeRequest("/effects", "GET");
  }
  setEffects(effects: any) {
    return this.makeRequest("/effects", "POST", effects);
  }
}

// Cloud Pods API Client
export class CloudPodsApiClient {
  private getAuthHeaders(): { headers: Record<string, string>; error?: string } {
    const authToken = process.env.LOCALSTACK_AUTH_TOKEN;
    if (!authToken) {
      return {
        headers: {},
        error: "❌ **Authentication Error:** `LOCALSTACK_AUTH_TOKEN` is not configured.",
      };
    }
    return {
      headers: { "x-localstack-state-secret": Buffer.from(authToken.trim()).toString("base64") },
    };
  }

  private async makeRequest(
    endpoint: string,
    method: "POST" | "PUT" | "DELETE",
    requiresAuth: boolean,
    body?: any
  ): Promise<ApiResult<any>> {
    const auth = this.getAuthHeaders();
    if (requiresAuth && auth.error) {
      return { success: false, message: auth.error };
    }

    try {
      const data = await httpClient.request<any>(endpoint, {
        method,
        headers: { "Content-Type": "application/json", ...(requiresAuth ? auth.headers : {}) },
        body: body ? JSON.stringify(body) : undefined,
        timeout: 300000,
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 401 || error.status === 403)
          return {
            success: false,
            message:
              "❌ **Authentication Failed:** The configured `LOCALSTACK_AUTH_TOKEN` is invalid.",
            statusCode: error.status,
          };
        if (error.status === 404)
          return {
            success: false,
            message: "❌ **Error:** The requested Cloud Pod could not be found.",
            statusCode: 404,
          };
        if (error.status === 409)
          return {
            success: false,
            message: "❌ **Error:** A Cloud Pod with this name already exists.",
            statusCode: 409,
          };
        return {
          success: false,
          message: `❌ **Error:** The LocalStack API returned an error (Status ${error.status}):\n\`\`\`\n${error.body}\n\`\`\``,
          statusCode: error.status,
        };
      }
      return {
        success: false,
        message: `❌ **Error:** Failed to communicate with LocalStack Cloud Pods API: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  savePod(podName: string) {
    return this.makeRequest(`/_localstack/pods/${encodeURIComponent(podName)}`, "POST", true, {});
  }
  loadPod(podName: string) {
    return this.makeRequest(`/_localstack/pods/${encodeURIComponent(podName)}`, "PUT", true, {});
  }
  deletePod(podName: string) {
    return this.makeRequest(`/_localstack/pods/${encodeURIComponent(podName)}`, "DELETE", true, {});
  }
  resetState() {
    return this.makeRequest("/_localstack/state/reset", "POST", false, {});
  }
}

// AWS Replicator API Client
export class AwsReplicatorApiClient {
  private async makeRequest<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<ApiResult<T>> {
    try {
      const data = await httpClient.request<T>(`/_localstack/replicator${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        timeout: 300000,
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpError) {
        return {
          success: false,
          message: `❌ **Error:** The LocalStack AWS Replicator API returned an error (Status ${error.status}):\n\`\`\`\n${error.body}\n\`\`\``,
          statusCode: error.status,
        };
      }
      return {
        success: false,
        message: `❌ **Error:** Failed to communicate with LocalStack AWS Replicator API: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  startJob(request: StartReplicationJobRequest) {
    return this.makeRequest<ReplicationJobResponse>("/jobs", "POST", request);
  }

  listJobs() {
    return this.makeRequest<ReplicationJobResponse[]>("/jobs", "GET");
  }

  getJobStatus(jobId: string) {
    return this.makeRequest<ReplicationJobResponse>(`/jobs/${encodeURIComponent(jobId)}`, "GET");
  }

  listSupportedResources() {
    return this.makeRequest<ReplicationSupportedResource[]>("/resources", "GET");
  }
}

// App Inspector API Client
export class AppInspectorApiClient {
  private buildQueryString(params: AppInspectorQuery): string {
    const parts = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    return parts.length ? `?${parts.join("&")}` : "";
  }

  private async makeRequest<T>(
    endpoint: string,
    method: "GET" | "PUT" | "DELETE",
    body?: unknown
  ): Promise<ApiResult<T>> {
    try {
      const data = await httpClient.request<T>(`/_localstack/appinspector${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpError) {
        return {
          success: false,
          message: error.body || error.message,
          statusCode: error.status,
        };
      }
      return {
        success: false,
        message: `Failed to communicate with LocalStack App Inspector API: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  getStatus() {
    return this.makeRequest<AppInspectorStatusResponse>("/status", "GET");
  }

  setStatus(status: AppInspectorStatus) {
    return this.makeRequest<AppInspectorSetStatusResponse>("/status", "PUT", { status });
  }

  listTraces(query: AppInspectorQuery) {
    return this.makeRequest<any>(`/v1/traces${this.buildQueryString(query)}`, "GET");
  }

  getTrace(traceId: string) {
    return this.makeRequest<any>(`/v1/traces/${encodeURIComponent(traceId)}`, "GET");
  }

  deleteTraces(traceIds?: string[]) {
    return this.makeRequest<{ deleted_count: number }>(
      "/v1/traces",
      "DELETE",
      traceIds ? { trace_ids: traceIds } : {}
    );
  }

  listSpans(traceId: string, query: AppInspectorQuery) {
    return this.makeRequest<any>(
      `/v1/traces/${encodeURIComponent(traceId)}/spans${this.buildQueryString(query)}`,
      "GET"
    );
  }

  getSpan(traceId: string, spanId: string) {
    return this.makeRequest<any>(
      `/v1/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}`,
      "GET"
    );
  }

  deleteSpans(traceId: string, spanIds?: string[]) {
    return this.makeRequest<{ deleted_count: number }>(
      `/v1/traces/${encodeURIComponent(traceId)}/spans`,
      "DELETE",
      spanIds ? { span_ids: spanIds } : {}
    );
  }

  listEvents(traceId: string, spanId: string, query: AppInspectorQuery) {
    return this.makeRequest<any>(
      `/v1/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}/events${this.buildQueryString(query)}`,
      "GET"
    );
  }

  getEvent(traceId: string, spanId: string, eventId: string) {
    return this.makeRequest<any>(
      `/v1/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}/events/${encodeURIComponent(eventId)}`,
      "GET"
    );
  }

  listIamEvents(traceId: string, spanId: string, query: AppInspectorQuery) {
    return this.makeRequest<any>(
      `/v1/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}/events/iam${this.buildQueryString(query)}`,
      "GET"
    );
  }
}
