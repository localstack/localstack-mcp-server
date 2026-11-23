/**
 * Responses of the IAM actions of `localstack-app-inspector` other than the explanation itself: the IAM mode, a
 * stored policy, and why a query came back empty. LocalStack decides every answer; this module words it and
 * escapes what LocalStack or the caller sent.
 */
import { codeFence, codeSpan } from "./iam-explain.logic";

export const IAM_DENIED_EVENT_NAME = "iam.policy.denied";
export const DEFAULT_DENIALS_LIMIT = 50;
export const PRICING_URL = "https://www.localstack.cloud/pricing";

/** What an IAM mode means for recording denials. Never advises switching enforcement on just to see them. */
export function describeIamMode(state: string): string {
  switch (state) {
    case "ENFORCED":
      return "Unauthorized requests are blocked, as on AWS. Run the workload, then use `list-iam-denials`.";
    case "SOFT_MODE":
      return "Unauthorized requests go through and are recorded as denials (`allow_with_warning`). Run the workload, then use `list-iam-denials`.";
    case "ENGINE_ONLY":
      return "IAM is not enforced, but App Inspector has LocalStack evaluate every request: denials are recorded (`allow_with_warning`) and the auto-derived IAM policies grow. Run the workload, then use `list-iam-denials`.";
    case "DISABLED":
      return "The IAM engine is off: requests are not evaluated, so no denials are recorded and no IAM policies are auto-derived, even with App Inspector enabled. To record denials without blocking anything, use `set-iam-mode` with `SOFT_MODE`, then run the workload again.";
    default:
      return `Unknown mode ${codeSpan(state)}.`;
  }
}

export function renderIamMode(state: string, updated = false): string {
  const title = updated ? "IAM Enforcement Updated" : "IAM Enforcement";
  return `## ${title}\n\n**Mode:** ${codeSpan(state)}\n\n${describeIamMode(state)}`;
}

/** Whether LocalStack says, on any of these spans, that the license hides IAM errors */
export function iamErrorsSuppressed(spansData: unknown): boolean {
  const data = spansData as { spans?: unknown } | unknown[] | null | undefined;
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { spans?: unknown })?.spans)
      ? ((data as { spans: unknown[] }).spans as unknown[])
      : [];
  return list.some(
    (span) => (span as { iam_errors_suppressed?: unknown })?.iam_errors_suppressed === true
  );
}

/**
 * The note appended to an empty IAM result: the license hides IAM events, or else the IAM mode, or, when neither is
 * known, that App Inspector must be enabled.
 */
export function renderEmptyIamNote({
  suppressed,
  iamMode,
}: {
  suppressed: boolean;
  iamMode?: string;
}): string {
  if (suppressed) {
    return `\n\n**IAM results are hidden by your LocalStack license.** It does not include viewing IAM policy errors in App Inspector, so this is not proof that nothing was denied. See ${PRICING_URL} for the plans that include it.`;
  }
  const mode =
    iamMode !== undefined
      ? `\n\nIAM enforcement mode: ${codeSpan(iamMode)}. ${describeIamMode(iamMode)}`
      : "\n\nDenials are recorded while App Inspector is enabled (`get-status`) and the IAM mode is not `DISABLED` (`get-iam-mode`).";
  return `${mode}\n\nApp Inspector does not record requests to STS, IAM and CloudWatch Logs, so a denied \`sts:AssumeRole\` (a role's trust policy) or IAM call never appears here, whatever the mode.`;
}

export function renderNoIamEvaluation(scope: { eventId?: string; spanId: string }): string {
  const target = scope.eventId
    ? `event ${codeSpan(scope.eventId)}`
    : `span ${codeSpan(scope.spanId)}`;
  return `## IAM Evaluation\n\nNo IAM evaluation found for ${target}.`;
}

export function renderEventPolicy(eventId: string, policyKey: string, documents: unknown): string {
  const list = Array.isArray(documents) ? documents : [];
  const note =
    list.length > 1
      ? "\n\nThis policy has several documents (e.g. a resource holding more than one policy); all are listed."
      : "";
  return `## Policy ${codeSpan(policyKey)} of event ${codeSpan(eventId)}\n\nThe current document, as LocalStack stores it now. If its \`hash\` differs from the one in the event, the policy changed after the request.${note}\n\n${codeFence(JSON.stringify(list, null, 2), "json")}`;
}

const EVENT_POLICY_ERRORS: Record<string, string> = {
  event_not_found: "No IAM event with this ID.",
  policy_not_in_event:
    "The event names no policy with this key. explain-iam lists the event's policy keys.",
  policy_unavailable:
    "The event did not store where this policy lives (e.g. a policy LocalStack can't look up again), so it can't be fetched.",
  policy_not_found: "The policy no longer exists: it was deleted or detached after the request.",
  not_entitled: `Your LocalStack license does not include viewing IAM policy errors in App Inspector. See ${PRICING_URL} for the plans that include it.`,
  invalid_parameter: "`event_id` must be the 16-character event ID and `policy_key` a key like p1.",
};

/** The `code` of a LocalStack error body (`{"error": …, "code": …}`), if it has one */
export function apiErrorCode(body: string): string | undefined {
  try {
    const code = JSON.parse(body)?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The explanation of a failed `get-iam-policy`, for the error codes LocalStack documents for the route */
export function eventPolicyError(body: string): { code: string; message: string } | undefined {
  const code = apiErrorCode(body);
  if (!code || !Object.prototype.hasOwnProperty.call(EVENT_POLICY_ERRORS, code)) return undefined;
  return { code, message: EVENT_POLICY_ERRORS[code] };
}

export const AUTO_DERIVED_POLICIES_UNAVAILABLE =
  "This LocalStack does not offer auto-derived IAM policies: the license does not include IAM Policy Stream, or the LocalStack version is too old. Without it, `list-iam-denials` and `explain-iam` still show what was denied and how to fix it.";

export const IAM_CONFIG_UNAVAILABLE =
  "This LocalStack does not offer IAM enforcement settings: the license does not include IAM enforcement, or the LocalStack version is too old.";

/** A LocalStack error body, fenced so it can't break out of the response */
export function renderErrorBody(body: string): string {
  return `LocalStack answered:\n\n${codeFence(body)}`;
}
