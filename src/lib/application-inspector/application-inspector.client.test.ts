import { ApplicationInspectorApiClient } from "./application-inspector.client";

jest.mock("../../core/http-client", () => {
  return {
    httpClient: {
      request: jest.fn(),
    },
    HttpError: class HttpError extends Error {
      status: number;
      statusText: string;
      body: string;
      constructor(status: number, statusText: string, body: string, message: string) {
        super(message);
        this.status = status;
        this.statusText = statusText;
        this.body = body;
      }
    },
  };
});

const { httpClient } = require("../../core/http-client");

describe("ApplicationInspectorApiClient", () => {
  beforeEach(() => {
    (httpClient.request as jest.Mock).mockReset();
  });

  test("getSpans constructs query params from filters including errors_only (maps to status_code=2)", async () => {
    const client = new ApplicationInspectorApiClient();
    (httpClient.request as jest.Mock).mockResolvedValueOnce({ spans: [], next_token: null });

    await client.getSpans({
      limit: 50,
      pagination_token: "abc",
      service_name: "s3",
      operation_name: "PutObject",
      trace_id: "t1",
      errors_only: true,
      region: "us-east-1",
    });

    expect(httpClient.request).toHaveBeenCalledTimes(1);
    const [url, options] = (httpClient.request as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/_localstack/eventstudio/v1/spans?");
    expect(String(url)).toContain("limit=50");
    expect(String(url)).toContain("pagination_token=abc");
    expect(String(url)).toContain("service_name=s3");
    expect(String(url)).toContain("operation_name=PutObject");
    expect(String(url)).toContain("trace_id=t1");
    expect(String(url)).toContain("region=us-east-1");
    // errors_only => status_code=2
    expect(String(url)).toContain("status_code=2");
    expect(options.method).toBe("GET");
  });

  test("clearEvents sends DELETE with body when spanIds provided", async () => {
    const client = new ApplicationInspectorApiClient();
    (httpClient.request as jest.Mock).mockResolvedValueOnce({ deleted_count: 2 });

    const res = await client.clearEvents(["a", "b"]);
    expect(res.deleted_count).toBe(2);

    expect(httpClient.request).toHaveBeenCalledTimes(1);
    const [url, options] = (httpClient.request as jest.Mock).mock.calls[0];
    expect(url).toBe("/_localstack/eventstudio/v1/spans");
    expect(options.method).toBe("DELETE");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual({ span_ids: ["a", "b"] });
  });

  test("clearEvents sends DELETE without body when no spanIds provided", async () => {
    const client = new ApplicationInspectorApiClient();
    (httpClient.request as jest.Mock).mockResolvedValueOnce({ deleted_count: 0 });

    await client.clearEvents();
    const [url, options] = (httpClient.request as jest.Mock).mock.calls[0];
    expect(url).toBe("/_localstack/eventstudio/v1/spans");
    expect(options.method).toBe("DELETE");
    expect(options.body).toBeUndefined();
  });
});
