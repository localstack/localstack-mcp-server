import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { checkProFeature, ProFeature } from "../lib/localstack/license-checker";
import { CloudPodsApiClient } from "../lib/localstack/localstack.client";

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
