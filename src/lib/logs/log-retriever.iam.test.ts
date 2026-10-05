import { LocalStackLogRetriever } from "./log-retriever";

describe("LocalStackLogRetriever IAM denial parsing", () => {
  const parse = (line: string) => (new LocalStackLogRetriever() as any).parseLogLine(line);

  it("parses the legacy 'Request for service ... denied.' format", () => {
    const entry = parse(
      "2025-07-23T10:58:58.710  INFO --- [asgi_gw_1] l.p.c.s.i.p.handler : Request for service 's3' by principal 'arn:aws:iam::000000000000:user/test' for operation 'CreateBucket' denied."
    );
    expect(entry.isIamDenial).toBe(true);
    expect(entry.iamPrincipal).toBe("arn:aws:iam::000000000000:user/test");
    expect(entry.iamAction).toBe("s3:CreateBucket");
  });

  it("parses the Explainable IAM 'is not authorized to perform' format (ENFORCED and SOFT_MODE)", () => {
    const entry = parse(
      "2026-10-05T15:16:27.431  INFO --- [et.reactor-2] l.p.c.s.i.p.handler        : User: arn:aws:iam::000000000000:user/probe-user is not authorized to perform: dynamodb:Scan on resource: arn:aws:dynamodb:us-east-1:000000000000:table/probe-table because no identity-based policy allows the dynamodb:Scan action"
    );
    expect(entry.isIamDenial).toBe(true);
    expect(entry.isError).toBe(true);
    expect(entry.service).toBe("dynamodb");
    expect(entry.iamPrincipal).toBe("arn:aws:iam::000000000000:user/probe-user");
    expect(entry.iamAction).toBe("dynamodb:Scan");
    expect(entry.iamResource).toBe("arn:aws:dynamodb:us-east-1:000000000000:table/probe-table");
  });

  it("parses assumed-role principals and object-level S3 resources", () => {
    const entry = parse(
      "2026-10-05T15:16:27.039  INFO --- [et.reactor-1] l.p.c.s.i.p.handler        : User: arn:aws:sts::000000000000:assumed-role/my-fn-role/my-fn is not authorized to perform: s3:PutObject on resource: arn:aws:s3:::probe-bucket/hello.txt because no identity-based policy allows the s3:PutObject action"
    );
    expect(entry.isIamDenial).toBe(true);
    expect(entry.iamPrincipal).toBe("arn:aws:sts::000000000000:assumed-role/my-fn-role/my-fn");
    expect(entry.iamAction).toBe("s3:PutObject");
    expect(entry.iamResource).toBe("arn:aws:s3:::probe-bucket/hello.txt");
  });

  it("does not flag the DEBUG 'Necessary permissions' lines as denials but still extracts the resource", () => {
    const entry = parse(
      "2026-10-05T15:16:27.431 DEBUG --- [et.reactor-2] l.p.c.s.i.p.handler        : Necessary permissions for this action: [\"Action 'dynamodb:Scan' for 'arn:aws:dynamodb:us-east-1:000000000000:table/probe-table'\"]"
    );
    expect(entry.isIamDenial).toBeUndefined();
    expect(entry.iamAction).toBe("dynamodb:Scan");
    expect(entry.iamResource).toBe("arn:aws:dynamodb:us-east-1:000000000000:table/probe-table");
  });
});
