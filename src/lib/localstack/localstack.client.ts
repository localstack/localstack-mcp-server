import { httpClient, HttpError } from "../../core/http-client";

export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; message: string; statusCode?: number };

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
