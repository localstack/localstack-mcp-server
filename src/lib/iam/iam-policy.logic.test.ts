import { generateIamPolicy, deduplicatePermissions } from "./iam-policy.logic";
import type { LogEntry } from "../logs/log-retriever";

describe("iam-policy.logic", () => {
  describe("generateIamPolicy", () => {
    it("should generate a valid identity-based policy without a Principal key", () => {
      const denials: LogEntry[] = [
        {
          iamPrincipal: "lambda.amazonaws.com",
          iamAction: "s3:GetObject",
          iamResource: "arn:aws:s3:::my-bucket/*",
          message: "",
          fullLine: "",
          isApiCall: false,
          isError: false,
          isWarning: false,
        },
        {
          iamPrincipal: "lambda.amazonaws.com",
          iamAction: "s3:PutObject",
          iamResource: "arn:aws:s3:::my-bucket/*",
          message: "",
          fullLine: "",
          isApiCall: false,
          isError: false,
          isWarning: false,
        },
        {
          iamPrincipal: "ecs-tasks.amazonaws.com",
          iamAction: "sqs:SendMessage",
          iamResource: "arn:aws:sqs:us-east-1:000:my-queue",
          message: "",
          fullLine: "",
          isApiCall: false,
          isError: false,
          isWarning: false,
        },
      ] as any;

      const permissions = deduplicatePermissions(denials);
      const policy = generateIamPolicy(permissions);

      expect(policy.Version).toBe("2012-10-17");
      expect(policy.Statement.length).toBe(2);
      for (const s of policy.Statement) {
        expect((s as any).Principal).toBeUndefined();
      }

      const s3Statement = policy.Statement.find((s: any) =>
        String(s.Resource).includes("s3")
      ) as any;
      expect(s3Statement.Action).toEqual(["s3:GetObject", "s3:PutObject"]);
    });
  });
});
