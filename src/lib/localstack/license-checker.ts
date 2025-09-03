/**
 * Centralized license checker for LocalStack licensed features
 * Provides consistent pre-flight checks for all licensed features
 */

export enum ProFeature {
  IAM_ENFORCEMENT = "localstack.platform.plugin/iam-enforcement",
  CLOUD_PODS = "localstack.platform.plugin/pods",
  CHAOS_ENGINEERING = "localstack.platform.plugin/chaos",
}

export interface LicenseCheckResult {
  isSupported: boolean;
  errorMessage?: string;
}

interface LicenseInfoResponse {
  available_plugins?: string[];
  [key: string]: any;
}

/**
 * Check if a specific licensed feature is supported by the connected LocalStack instance
 * @param feature The licensed feature to check for
 * @returns Promise<LicenseCheckResult> indicating if the feature is supported
 */
import { httpClient, HttpError } from "../../core/http-client";

export async function checkProFeature(feature: ProFeature): Promise<LicenseCheckResult> {
  try {
    const licenseInfo: LicenseInfoResponse = await httpClient.request("/_localstack/licenseinfo", {
      method: "GET",
    });

    if (!licenseInfo.available_plugins || !Array.isArray(licenseInfo.available_plugins)) {
      return {
        isSupported: false,
        errorMessage: `❌ **License Check Failed:** Unable to parse license information from LocalStack. The license response format was unexpected.`,
      };
    }

    const isFeatureAvailable = licenseInfo.available_plugins.includes(feature);
    return isFeatureAvailable
      ? { isSupported: true }
      : {
          isSupported: false,
          errorMessage: `❌ **Feature Not Available:** Your LocalStack license does not seem to include the '${feature}' feature. Please check your license details.`,
        };
  } catch (error: any) {
    if (error instanceof HttpError && error.status === 404) {
      return {
        isSupported: false,
        errorMessage: `❌ **Feature Not Available:** The '${feature}' feature requires a LocalStack license, but the license endpoint was not found. Please ensure you are running LocalStack with a valid Auth Token.`,
      };
    }
    if (error.code === "ECONNREFUSED" || error.message?.includes("ECONNREFUSED")) {
      return {
        isSupported: false,
        errorMessage: `❌ **Connection Error:** Cannot connect to LocalStack. Please ensure LocalStack is running and accessible at http://localhost:4566.`,
      };
    }
    return {
      isSupported: false,
      errorMessage: `❌ **License Check Failed:** Unable to verify feature availability due to an unexpected error: ${error.message || "Unknown error"}`,
    };
  }
}
