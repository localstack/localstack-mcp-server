import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { checkProFeature, ProFeature } from "../lib/localstack/license-checker";
import { CloudPodsApiClient } from "../lib/localstack/localstack.client";
import { ResponseBuilder } from "../core/response-builder";
import { runPreflights, requireLocalStackCli, requireProFeature } from "../core/preflight";

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
  const preflightError = await runPreflights([
    requireLocalStackCli(),
    requireProFeature(ProFeature.CLOUD_PODS),
  ]);
  if (preflightError) return preflightError;

  const client = new CloudPodsApiClient();

  switch (action) {
    case "save": {
      if (!pod_name || pod_name.trim() === "") {
        return ResponseBuilder.error(
          "Missing Required Parameter",
          "The `save` action requires the `pod_name` parameter to be specified."
        );
      }

      const result = await client.savePod(pod_name);
      if (!result.success) {
        if (result.statusCode === 409) {
          return ResponseBuilder.error(
            "Cloud Pods Error",
            `A Cloud Pod named '**${pod_name}**' already exists. Please choose a different name or delete the existing pod first.`
          );
        }
        return ResponseBuilder.error("Cloud Pods Error", result.message);
      }

      return ResponseBuilder.success(`Cloud Pod '**${pod_name}**' was saved successfully.`);
    }

    case "load": {
      if (!pod_name || pod_name.trim() === "") {
        return ResponseBuilder.error(
          "Missing Required Parameter",
          "The `load` action requires the `pod_name` parameter to be specified."
        );
      }

      const result = await client.loadPod(pod_name);
      if (!result.success) {
        if (result.statusCode === 404) {
          return ResponseBuilder.error(
            "Cloud Pods Error",
            `A Cloud Pod named '**${pod_name}**' could not be found.`
          );
        }
        return ResponseBuilder.error("Cloud Pods Error", result.message);
      }

      return ResponseBuilder.success(
        `Cloud Pod '**${pod_name}**' was loaded. Your LocalStack instance has been restored to this snapshot.`
      );
    }

    case "delete": {
      if (!pod_name || pod_name.trim() === "") {
        return ResponseBuilder.error(
          "Missing Required Parameter",
          "The `delete` action requires the `pod_name` parameter to be specified."
        );
      }

      const result = await client.deletePod(pod_name);
      if (!result.success) {
        if (result.statusCode === 404) {
          return ResponseBuilder.error(
            "Cloud Pods Error",
            `A Cloud Pod named '**${pod_name}**' could not be found.`
          );
        }
        return ResponseBuilder.error("Cloud Pods Error", result.message);
      }

      return ResponseBuilder.success(`Cloud Pod '**${pod_name}**' has been permanently deleted.`);
    }

    case "reset": {
      const result = await client.resetState();
      if (!result.success) {
        return ResponseBuilder.error("Cloud Pods Error", result.message);
      }

      return ResponseBuilder.markdown(
        "⚠️ LocalStack state has been reset successfully. **All unsaved state has been permanently lost.**"
      );
    }

    default:
      return ResponseBuilder.error("Unknown action", `Unsupported action: ${action}`);
  }
}
