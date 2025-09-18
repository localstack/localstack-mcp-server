import { formatScanResults } from "./scoutsuite-reporter";

describe("scoutsuite-reporter", () => {
  it("formats a mixed report with flagged and clean services", () => {
    const report = {
      last_run: {
        summary: {
          s3: { checked_items: 10, flagged_items: 2 },
          iam: { checked_items: 8, flagged_items: 0 },
          ec2: { checked_items: 5, flagged_items: 1 },
        },
      },
      services: {
        s3: {
          findings: {
            s3_public_buckets: {
              description: "S3 buckets allow public read access",
              level: "danger",
              rationale: "Public buckets can expose sensitive data.",
              remediation: "Block public access and update bucket policies.",
              items: ["bucket-a", "bucket-b"],
            },
            s3_no_versioning: {
              description: "Versioning disabled",
              level: "warning",
              rationale: "Deleted or overwritten objects cannot be recovered.",
              remediation: "Enable versioning on critical buckets.",
              items: ["bucket-a"],
            },
          },
        },
        iam: {
          findings: {},
        },
        ec2: {
          findings: {
            ec2_open_security_groups: {
              description: "Security group allows 0.0.0.0/0",
              level: "danger",
              rationale: "Unrestricted ingress increases attack surface.",
              remediation: "Restrict ingress to trusted CIDRs.",
              items: ["sg-123", "sg-456"],
            },
          },
        },
      },
    } as any;

    const markdown = formatScanResults(report);
    expect(markdown).toMatchSnapshot();
  });
});


