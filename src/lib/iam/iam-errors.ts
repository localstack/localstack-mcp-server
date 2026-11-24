/** Tool responses for failed IAM and App Inspector API calls, shared by localstack-app-inspector and localstack-app-inspector */
import { ResponseBuilder } from "../../core/response-builder";
import type { ApiResult } from "../localstack/localstack.client";
import {
  APP_INSPECTOR_DISABLED,
  IAM_CONFIG_UNAVAILABLE,
  cursorError,
  renderErrorBody,
} from "./iam-actions.logic";

// ─── Errors ──────────────────────────────────────────────────────────────────

export function formatEventsError(result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected App Inspector Result");
  if (result.statusCode === 503) {
    return ResponseBuilder.error("App Inspector Disabled", APP_INSPECTOR_DISABLED);
  }
  if (result.statusCode === 400) {
    const cursor = cursorError(result.message);
    if (cursor) return ResponseBuilder.error("Cursor Not Usable", cursor);
  }
  if (result.statusCode === 404 && !/"code"\s*:/.test(result.message)) {
    return ResponseBuilder.error(
      "Not Available",
      "This IAM data is not available on this LocalStack version."
    );
  }
  return ResponseBuilder.error(
    result.statusCode ? `HTTP ${result.statusCode}` : "App Inspector API Error",
    renderErrorBody(result.message)
  );
}

export function formatIamConfigError(result: ApiResult<unknown>) {
  if (result.success) return ResponseBuilder.error("Unexpected Result");
  if (result.statusCode === 404) {
    return ResponseBuilder.error("IAM Enforcement Not Available", IAM_CONFIG_UNAVAILABLE);
  }
  return ResponseBuilder.error(
    result.statusCode ? `HTTP ${result.statusCode}` : "IAM API Error",
    renderErrorBody(result.message)
  );
}
