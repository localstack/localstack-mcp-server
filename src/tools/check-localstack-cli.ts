import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { checkLocalStackCli as checkCli } from "../lib/localstack-utils";

// Define the schema for tool parameters
export const schema = {
  // No parameters needed for this tool
};

// Define tool metadata
export const metadata: ToolMetadata = {
  name: "check-localstack-cli",
  description: "Check if LocalStack CLI is installed and available in the system PATH",
  annotations: {
    title: "Check LocalStack CLI Installation",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

// Tool implementation
export default async function checkLocalStackCli(_params: InferSchema<typeof schema>) {
  const cliCheck = await checkCli();
  
  if (cliCheck.isAvailable) {
    const result = `✅ LocalStack CLI is installed and available!\nVersion: ${cliCheck.version}`;
    return {
      content: [{ type: "text", text: result }],
    };
  } else {
    return {
      content: [{ type: "text", text: cliCheck.errorMessage! }],
    };
  }
} 