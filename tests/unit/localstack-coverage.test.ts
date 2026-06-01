import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Must be set before importing the tool so import.meta.url is never evaluated in CJS/Jest
const DB_PATH = resolve(__dirname, "../../data/coverage.db");
process.env.LOCALSTACK_COVERAGE_DB = DB_PATH;

import { friendlyName, FRIENDLY_NAMES } from "../../src/tools/localstack-coverage";
import { DatabaseSync } from "node:sqlite";

const dbAvailable = existsSync(DB_PATH);

// ---------------------------------------------------------------------------
// friendlyName mapping
// ---------------------------------------------------------------------------

describe("friendlyName", () => {
  it("maps known Terraform types", () => {
    expect(friendlyName("aws_sqs_queue")).toBe("SQS queue");
    expect(friendlyName("aws_lambda_function")).toBe("Lambda function");
    expect(friendlyName("aws_dynamodb_table")).toBe("DynamoDB table");
    expect(friendlyName("aws_s3_bucket")).toBe("S3 bucket");
    expect(friendlyName("aws_iam_role")).toBe("IAM role");
  });

  it("maps known CloudFormation types", () => {
    expect(friendlyName("AWS::SQS::Queue")).toBe("SQS queue");
    expect(friendlyName("AWS::Lambda::Function")).toBe("Lambda function");
    expect(friendlyName("AWS::DynamoDB::Table")).toBe("DynamoDB table");
    expect(friendlyName("AWS::S3::Bucket")).toBe("S3 bucket");
    expect(friendlyName("AWS::IAM::Role")).toBe("IAM role");
  });

  it("falls back to raw type when no mapping exists", () => {
    expect(friendlyName("aws_unknown_widget")).toBe("aws_unknown_widget");
    expect(friendlyName("AWS::Unknown::Thing")).toBe("AWS::Unknown::Thing");
  });

  it("all FRIENDLY_NAMES values are non-empty strings", () => {
    for (const [type, name] of Object.entries(FRIENDLY_NAMES)) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toContain("aws_");
      expect(name).not.toMatch(/^AWS::/);
    }
  });
});

// ---------------------------------------------------------------------------
// checkResources output format (requires coverage.db)
// ---------------------------------------------------------------------------

const describeIfDb = dbAvailable ? describe : describe.skip;

describeIfDb("checkResources output format", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(DB_PATH, { open: true });
  });

  afterAll(() => {
    db.close();
  });

  function callCheckResources(types: string[]): string {
    // Import dynamically so DB path is resolved at test time
    const stmt = db.prepare(
      `SELECT rto.operation, rto.required, o.implemented
       FROM   resource_type_ops rto
       JOIN   operations o ON rto.service = o.service AND rto.operation = o.operation
       WHERE  rto.resource_type = ?
       ORDER  BY rto.required DESC, rto.operation`
    );

    const lines: string[] = [];
    lines.push("**Terraform**", "");
    lines.push("| Resource | Status |");
    lines.push("|---|---|");

    const comments: string[] = [];

    for (const rt of types) {
      const rows = stmt.all(rt) as Array<{ operation: string; required: number; implemented: number }>;
      if (rows.length === 0) {
        lines.push(`| ${rt} | ❌ |`);
        comments.push(`- **${rt}**: not in coverage database`);
        continue;
      }
      const blocking = rows.filter((r) => r.required === 1 && r.implemented === 0).map((r) => r.operation);
      const status = blocking.length > 0 ? "❌" : "✅";
      lines.push(`| ${friendlyName(rt)} | ${status} |`);
      if (blocking.length > 0) {
        comments.push(`- **${friendlyName(rt)}** (\`${rt}\`): missing ${blocking.join(", ")}`);
      }
    }

    lines.push("");
    if (comments.length > 0) {
      lines.push(`**${comments.length} blocker(s) found.**`);
      lines.push("", "Comments:");
      lines.push(...comments);
    } else {
      lines.push("**No blockers.** All resources should deploy cleanly on LocalStack.");
    }

    return lines.join("\n");
  }

  it("produces a table with Resource and Status columns", () => {
    const output = callCheckResources(["aws_sqs_queue", "aws_lambda_function"]);
    expect(output).toContain("| Resource | Status |");
    expect(output).toContain("|---|---|");
  });

  it("uses friendly names not raw type names in the table", () => {
    const output = callCheckResources(["aws_sqs_queue"]);
    expect(output).toContain("SQS queue");
    expect(output).not.toMatch(/\| aws_sqs_queue \|/);
  });

  it("shows ✅ for fully supported resources", () => {
    const output = callCheckResources(["aws_sqs_queue"]);
    expect(output).toContain("✅");
  });

  it("shows ❌ for unknown resource types", () => {
    const output = callCheckResources(["aws_totally_unknown_widget_xyz"]);
    expect(output).toContain("❌");
  });

  it("includes Comments section only when there are blockers", () => {
    const withBlocker = callCheckResources(["aws_totally_unknown_widget_xyz"]);
    expect(withBlocker).toContain("Comments:");

    const noBlocker = callCheckResources(["aws_sqs_queue"]);
    expect(noBlocker).not.toContain("Comments:");
  });

  it("includes No blockers line when all resources pass", () => {
    const output = callCheckResources(["aws_sqs_queue", "aws_lambda_function"]);
    expect(output).toContain("**No blockers.**");
  });
});

// ---------------------------------------------------------------------------
// direct MCP tool list test
// ---------------------------------------------------------------------------

describeIfDb("coverage DB sanity", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(DB_PATH, { open: true });
  });

  afterAll(() => {
    db.close();
  });

  it("has operations table with rows", () => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM operations").get() as { n: number };
    expect(row.n).toBeGreaterThan(100);
  });

  it("has resource_type_ops table with rows", () => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM resource_type_ops").get() as { n: number };
    expect(row.n).toBeGreaterThan(10);
  });

  it("aws_sqs_queue has at least one required operation", () => {
    const rows = db
      .prepare("SELECT * FROM resource_type_ops WHERE resource_type = ? AND required = 1")
      .all("aws_sqs_queue") as Array<{ operation: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });
});
