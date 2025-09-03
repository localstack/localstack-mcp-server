import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { checkProFeature, ProFeature } from "../lib/license-checker";

// Define the schema for tool parameters
export const schema = {
  action: z.enum(["save", "load", "delete", "reset"]).describe("The Cloud Pods action to perform."),

  pod_name: z
    .string()
    .optional()
    .describe(
      "The name of the Cloud Pod. This is required for 'save', 'load', and 'delete' actions."
    ),
};

// Define tool metadata
export const metadata: ToolMetadata = {
  name: "localstack-cloud-pods",
  description: "Manages LocalStack Cloud Pods with following actions: save, load, delete, reset",
  annotations: {
    title: "LocalStack Cloud Pods",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

// HTTP client helper for Cloud Pods API requests
class CloudPodsApiClient {
  private baseUrl = "http://localhost:4566";

  // Get authentication headers
  getAuthHeaders(): { headers: Record<string, string>; error?: string } {
    const authToken = process.env.LOCALSTACK_AUTH_TOKEN;

    if (!authToken || authToken.trim() === "") {
      return {
        headers: {},
        error:
          "❌ **Authentication Error:** `LOCALSTACK_AUTH_TOKEN` is not configured. Please configure your MCP server environment with your LocalStack auth token to use Cloud Pods.",
      };
    }

    // Use the auth token directly as the state secret (Base64 encoding)
    const stateSecret = Buffer.from(authToken.trim()).toString("base64");

    return {
      headers: {
        "x-localstack-state-secret": stateSecret,
      },
    };
  }

  async makeRequest(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    requiresAuth: boolean = true,
    body?: any
  ): Promise<any> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const options: RequestInit = {
        method,
      };

      // Initialize headers
      let headers: Record<string, string> = {};

      if (requiresAuth) {
        const authResult = this.getAuthHeaders();
        if (authResult.error) {
          return { error: true, message: authResult.error };
        }
        headers = { ...authResult.headers };
      }

      headers["Content-Type"] = "application/json";

      options.headers = headers;

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        let errorMessage = `Status ${response.status}`;
        try {
          const errorBody = await response.text();
          if (errorBody) {
            // Handle specific error cases
            if (response.status === 401 || response.status === 403) {
              return {
                error: true,
                message:
                  "❌ **Authentication Failed:** The configured `LOCALSTACK_AUTH_TOKEN` is invalid or does not have the required permissions for Cloud Pods.",
              };
            } else if (response.status === 404) {
              return {
                error: true,
                message: "❌ **Error:** The requested Cloud Pod could not be found.",
                statusCode: 404,
              };
            } else if (response.status === 409) {
              return {
                error: true,
                message: "❌ **Error:** A Cloud Pod with this name already exists.",
                statusCode: 409,
              };
            } else {
              errorMessage += `:\n\`\`\`\n${errorBody}\n\`\`\``;
            }
          }
        } catch {
          // If we can't read the error body, just use the status
        }

        return {
          error: true,
          message: `❌ **Error:** The LocalStack API returned an error (${errorMessage})`,
        };
      }

      // Handle empty responses
      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return {};
      }

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error: any) {
      if (error.code === "ECONNREFUSED" || error.message?.includes("ECONNREFUSED")) {
        return {
          error: true,
          message:
            "❌ **Error:** Cannot connect to LocalStack. Please ensure the container is running and accessible.",
        };
      }

      return {
        error: true,
        message: `❌ **Error:** Failed to communicate with LocalStack Cloud Pods API: ${error.message || "Unknown error"}`,
      };
    }
  }

  async savePod(podName: string) {
    return this.makeRequest(`/_localstack/pods/${encodeURIComponent(podName)}`, "POST", true, {});
  }

  async loadPod(podName: string) {
    return this.makeRequest(`/_localstack/pods/${encodeURIComponent(podName)}`, "PUT", true, {});
  }

  async deletePod(podName: string) {
    return this.makeRequest(`/_localstack/pods/${encodeURIComponent(podName)}`, "DELETE", true, {});
  }

  async resetState() {
    return this.makeRequest("/_localstack/state/reset", "POST", false, {});
  }
}

export default async function localstackCloudPods({
  action,
  pod_name,
}: InferSchema<typeof schema>) {
  // Check if Cloud Pods feature is supported
  const licenseCheck = await checkProFeature(ProFeature.CLOUD_PODS);
  if (!licenseCheck.isSupported) {
    return { content: [{ type: "text", text: licenseCheck.errorMessage! }] };
  }

  const client = new CloudPodsApiClient();

  switch (action) {
    case "save": {
      if (!pod_name || pod_name.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `save` action requires the `pod_name` parameter to be specified.",
            },
          ],
        };
      }

      const result = await client.savePod(pod_name);
      if (result.error) {
        // Handle specific error cases for save
        if (result.statusCode === 409) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **Error:** A Cloud Pod named '**${pod_name}**' already exists. Please choose a different name or delete the existing pod first.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: result.message }] };
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Cloud Pod '**${pod_name}**' was saved successfully.`,
          },
        ],
      };
    }

    case "load": {
      if (!pod_name || pod_name.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `load` action requires the `pod_name` parameter to be specified.",
            },
          ],
        };
      }

      const result = await client.loadPod(pod_name);
      if (result.error) {
        // Handle specific error cases for load
        if (result.statusCode === 404) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **Error:** A Cloud Pod named '**${pod_name}**' could not be found.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: result.message }] };
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Cloud Pod '**${pod_name}**' was loaded. Your LocalStack instance has been restored to this snapshot.`,
          },
        ],
      };
    }

    case "delete": {
      if (!pod_name || pod_name.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `delete` action requires the `pod_name` parameter to be specified.",
            },
          ],
        };
      }

      const result = await client.deletePod(pod_name);
      if (result.error) {
        // Handle specific error cases for delete
        if (result.statusCode === 404) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **Error:** A Cloud Pod named '**${pod_name}**' could not be found.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: result.message }] };
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Cloud Pod '**${pod_name}**' has been permanently deleted.`,
          },
        ],
      };
    }

    case "reset": {
      const result = await client.resetState();
      if (result.error) {
        return { content: [{ type: "text", text: result.message }] };
      }

      return {
        content: [
          {
            type: "text",
            text: "⚠️ LocalStack state has been reset successfully. **All unsaved state has been permanently lost.**",
          },
        ],
      };
    }

    default:
      return {
        content: [
          {
            type: "text",
            text: `❌ Unknown action: ${action}. Supported actions: save, load, delete, reset`,
          },
        ],
      };
  }
}
