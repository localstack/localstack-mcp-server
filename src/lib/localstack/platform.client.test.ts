import { PlatformApiClient, describePlatformError } from "./platform.client";
import { HttpError } from "../../core/http-client";

const fetchMock = jest.fn();
global.fetch = fetchMock as any;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    url: "https://api.localstack.cloud/v1/test",
    headers: new Map([["content-type", "application/json"]]) as any,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("PlatformApiClient", () => {
  beforeEach(() => fetchMock.mockReset());

  test("sends Basic auth with empty username and the token as password", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const client = new PlatformApiClient("ls-test-token");
    await client.listEphemeralInstances();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.localstack.cloud/v1/compute/instances");
    const expected = `Basic ${Buffer.from(":ls-test-token").toString("base64")}`;
    expect(options.headers.Authorization).toBe(expected);
  });

  test("create posts instance_name/lifetime/env_vars in the CLI wire format", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ instance_name: "demo", status: "creating" }));
    const client = new PlatformApiClient("ls-test-token");
    await client.createEphemeralInstance({
      name: "demo",
      lifetime: 30,
      envVars: { EXTENSION_AUTO_INSTALL: "localstack-extension-httpbin" },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      instance_name: "demo",
      lifetime: 30,
      env_vars: { EXTENSION_AUTO_INSTALL: "localstack-extension-httpbin" },
    });
  });

  test("list tolerates both bare-array and wrapped responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ instances: [{ instance_name: "a" }] }));
    const client = new PlatformApiClient("t");
    expect(await client.listEphemeralInstances()).toEqual([{ instance_name: "a" }]);
  });

  test("logs joins content entries into plain text", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ content: "line 1" }, { content: "line 2" }])
    );
    const client = new PlatformApiClient("t");
    expect(await client.getEphemeralInstanceLogs("demo")).toBe("line 1\nline 2");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.localstack.cloud/v1/compute/instances/demo/logs");
  });
});

describe("describePlatformError", () => {
  test("maps 401/403 to a token hint", () => {
    const error = new HttpError(401, "Unauthorized", "", "HTTP Error");
    expect(describePlatformError(error, "ephemeral instances")).toMatch(/LOCALSTACK_AUTH_TOKEN/);
  });

  test("maps 404 to not-found for the subject", () => {
    const error = new HttpError(404, "Not Found", "", "HTTP Error");
    expect(describePlatformError(error, "ephemeral instance 'x'")).toBe(
      "ephemeral instance 'x' was not found."
    );
  });

  test("passes through non-HTTP errors", () => {
    expect(describePlatformError(new Error("boom"), "x")).toBe("boom");
  });
});
