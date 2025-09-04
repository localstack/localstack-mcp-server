import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { checkProFeature, ProFeature } from "../lib/localstack/license-checker";
import { ChaosApiClient } from "../lib/localstack/localstack.client";
import { ResponseBuilder } from "../core/response-builder";
import { runPreflights, requireProFeature } from "../core/preflight";

// Define the fault rule schema
const faultRuleSchema = z
  .object({
    service: z
      .string()
      .optional()
      .describe("Name of the AWS service to affect (e.g., 's3', 'lambda')."),
    region: z.string().optional().describe("Name of the AWS region to affect (e.g., 'us-east-1')."),
    operation: z
      .string()
      .optional()
      .describe("Name of the specific service operation to affect (e.g., 'CreateBucket')."),
    probability: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("The probability (0.0 to 1.0) of the fault occurring."),
    error: z
      .object({
        statusCode: z
          .number()
          .int()
          .optional()
          .describe("The HTTP status code to return (e.g., 503)."),
        code: z
          .string()
          .optional()
          .describe("The AWS error code to return (e.g., 'ServiceUnavailable')."),
      })
      .optional()
      .describe("The custom error to return."),
  })
  .describe("A single rule defining a chaos fault.");

// Define the schema for tool parameters
export const schema = {
  action: z
    .enum([
      "inject-faults",
      "add-fault-rule",
      "remove-fault-rule",
      "get-faults",
      "clear-all-faults",
      "inject-latency",
      "get-latency",
      "clear-latency",
    ])
    .describe("The specific chaos engineering action to perform."),

  rules: z
    .array(faultRuleSchema)
    .optional()
    .describe(
      "An array of fault rules. Required for 'inject-faults', 'add-fault-rule', and 'remove-fault-rule' actions."
    ),

  latency_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Network latency in milliseconds. Required for the 'inject-latency' action."),
};

// Define tool metadata
export const metadata: ToolMetadata = {
  name: "localstack-chaos-injector",
  description:
    "Injects, manages, and clears chaos faults and network effects in LocalStack to test system resilience.",
  annotations: {
    title: "LocalStack Chaos Injector",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

// Check if two fault rules match exactly
function rulesMatch(rule1: any, rule2: any): boolean {
  const keys1 = Object.keys(rule1).sort();
  const keys2 = Object.keys(rule2).sort();

  if (keys1.length !== keys2.length) return false;
  if (keys1.join(",") !== keys2.join(",")) return false;

  for (const key of keys1) {
    if (typeof rule1[key] === "object" && typeof rule2[key] === "object") {
      if (!rulesMatch(rule1[key], rule2[key])) return false;
    } else if (rule1[key] !== rule2[key]) {
      return false;
    }
  }

  return true;
}

// Format fault rules for display
function formatFaultRules(rules: any[]): string {
  if (!rules || rules.length === 0) {
    return "✅ No chaos faults are currently active.";
  }

  return `\`\`\`json\n${JSON.stringify(rules, null, 2)}\n\`\`\``;
}

// Create workflow guidance for injection actions
function addWorkflowGuidance(message: string): string {
  return `${message}

**Next Step:** Now, run your application or tests to observe the system's behavior under these conditions.

Once you are done, ask me to "**analyze the logs for errors**" to see the impact of this chaos experiment.`;
}

export default async function localstackChaosInjector({
  action,
  rules,
  latency_ms,
}: InferSchema<typeof schema>) {
  const preflightError = await runPreflights([requireProFeature(ProFeature.CHAOS_ENGINEERING)]);
  if (preflightError) return preflightError;

  const client = new ChaosApiClient();

  switch (action) {
    case "get-faults": {
      const result = await client.getFaults();
      if (!result.success) {
        return { content: [{ type: "text", text: result.message }] };
      }

      const formattedRules = formatFaultRules(result.data);
      return { content: [{ type: "text", text: formattedRules }] };
    }

    case "clear-all-faults": {
      const result = await client.setFaults([]);
      if (!result.success) {
        return ResponseBuilder.error("Chaos API Error", result.message);
      }

      return ResponseBuilder.success(
        "All chaos faults have been cleared. The system is now operating normally."
      );
    }

    case "inject-faults": {
      if (!rules || rules.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `inject-faults` action requires the `rules` parameter to be specified.",
            },
          ],
        };
      }

      const setResult = await client.setFaults(rules);
      if (!setResult.success) {
        return ResponseBuilder.error("Chaos API Error", setResult.message);
      }

      // Get current state to confirm
      const getCurrentResult = await client.getFaults();
      if (!getCurrentResult.success) {
        return ResponseBuilder.error("Chaos API Error", getCurrentResult.message);
      }

      const message = `✅ New chaos faults have been injected (overwriting any previous rules). The current active faults are:

${formatFaultRules(getCurrentResult.data)}`;

      return ResponseBuilder.markdown(addWorkflowGuidance(message));
    }

    case "add-fault-rule": {
      if (!rules || rules.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `add-fault-rule` action requires the `rules` parameter to be specified.",
            },
          ],
        };
      }

      const addResult = await client.addFaultRules(rules);
      if (!addResult.success) {
        return ResponseBuilder.error("Chaos API Error", addResult.message);
      }

      // Get current state to confirm
      const getCurrentResult = await client.getFaults();
      if (!getCurrentResult.success) {
        return ResponseBuilder.error("Chaos API Error", getCurrentResult.message);
      }

      const message = `✅ New fault rule(s) have been added. The current active faults are:

${formatFaultRules(getCurrentResult.data)}`;

      return ResponseBuilder.markdown(addWorkflowGuidance(message));
    }

    case "remove-fault-rule": {
      if (!rules || rules.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `remove-fault-rule` action requires the `rules` parameter to be specified.",
            },
          ],
        };
      }

      // First get current rules to check if the rule exists
      const getCurrentResult = await client.getFaults();
      if (!getCurrentResult.success) {
        return ResponseBuilder.error("Chaos API Error", getCurrentResult.message);
      }

      // Check if all rules to remove exist in current configuration
      const currentRules = getCurrentResult.data || [];
      const rulesToRemove = rules;

      for (const ruleToRemove of rulesToRemove) {
        const ruleExists = currentRules.some((currentRule: any) =>
          rulesMatch(currentRule, ruleToRemove)
        );
        if (!ruleExists) {
          return ResponseBuilder.markdown(`⚠️ The specified rule was not found in the current configuration. No changes were made.

Current configuration:
${formatFaultRules(currentRules)}`);
        }
      }

      // Rule exists, proceed with removal
      const removeResult = await client.removeFaultRules(rulesToRemove);
      if (!removeResult.success) {
        return ResponseBuilder.error("Chaos API Error", removeResult.message);
      }

      // Get current state after removal to confirm
      const getUpdatedResult = await client.getFaults();
      if (!getUpdatedResult.success) {
        return ResponseBuilder.error("Chaos API Error", getUpdatedResult.message);
      }

      const message = `✅ The specified fault rule(s) have been removed. The current active faults are:

${formatFaultRules(getUpdatedResult.data)}`;

      return ResponseBuilder.markdown(message);
    }

    case "get-latency": {
      const result = await client.getEffects();
      if (!result.success) {
        return ResponseBuilder.error("Chaos API Error", result.message);
      }

      const latency = (result.data as any)?.latency || 0;
      return ResponseBuilder.markdown(`The current network latency is ${latency}ms.`);
    }

    case "clear-latency": {
      const result = await client.setEffects({ latency: 0 });
      if (!result.success) {
        return ResponseBuilder.error("Chaos API Error", result.message);
      }

      // Get current state to confirm
      const getCurrentResult = await client.getEffects();
      if (!getCurrentResult.success) {
        return ResponseBuilder.error("Chaos API Error", getCurrentResult.message);
      }

      const message = `✅ Network latency has been cleared. The current effects are:

\`\`\`json
${JSON.stringify(getCurrentResult.data, null, 2)}
\`\`\``;

      return ResponseBuilder.markdown(message);
    }

    case "inject-latency": {
      if (latency_ms === undefined || latency_ms === null) {
        return {
          content: [
            {
              type: "text",
              text: "❌ **Error:** The `inject-latency` action requires the `latency_ms` parameter to be specified.",
            },
          ],
        };
      }

      const result = await client.setEffects({ latency: latency_ms });
      if (!result.success) {
        return ResponseBuilder.error("Chaos API Error", result.message);
      }

      // Get current state to confirm
      const getCurrentResult = await client.getEffects();
      if (!getCurrentResult.success) {
        return ResponseBuilder.error("Chaos API Error", getCurrentResult.message);
      }

      const message = `✅ Latency of ${latency_ms}ms has been injected. The current network effects are:

\`\`\`json
${JSON.stringify(getCurrentResult, null, 2)}
\`\`\``;

      return ResponseBuilder.markdown(addWorkflowGuidance(message));
    }

    default:
      return ResponseBuilder.error("Unknown action", `Unsupported action: ${action}`);
  }
}
