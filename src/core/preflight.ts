import { ensureLocalStackCli, getLocalStackStatus } from "../lib/localstack/localstack.utils";
import { checkProFeature, ProFeature } from "../lib/localstack/license-checker";
import { ResponseBuilder } from "./response-builder";

type ToolResponse = ReturnType<typeof ResponseBuilder.error>;

export const requireLocalStackCli = async (): Promise<ToolResponse | null> => {
  const cliCheck = await ensureLocalStackCli();
  return cliCheck ? (cliCheck as ToolResponse) : null;
};

export const requireProFeature = async (feature: ProFeature): Promise<ToolResponse | null> => {
  const licenseCheck = await checkProFeature(feature);
  return !licenseCheck.isSupported
    ? ResponseBuilder.error("Feature Not Available", licenseCheck.errorMessage)
    : null;
};

export const runPreflights = async (
  checks: Array<Promise<ToolResponse | null>>
): Promise<ToolResponse | null> => {
  const results = await Promise.all(checks);
  return results.find((r) => r !== null) || null;
};

export const requireLocalStackRunning = async (): Promise<ToolResponse | null> => {
  const statusResult = await getLocalStackStatus();
  if (!statusResult.isRunning) {
    return ResponseBuilder.error(
      "LocalStack Not Running",
      "LocalStack is not running. Please start LocalStack (e.g., 'localstack start') and try again."
    );
  }
  return null;
};
