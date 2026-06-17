import { parseEnvVarsInput } from "./env-parser.logic";

describe("parseEnvVarsInput", () => {
  it("parses comma-separated KEY=value pairs", () => {
    const { env, errors } = parseEnvVarsInput(
      "DEBUG=1,IMAGE_NAME=localstack/localstack-pro:latest"
    );
    expect(errors).toEqual([]);
    expect(env).toEqual({ DEBUG: "1", IMAGE_NAME: "localstack/localstack-pro:latest" });
  });

  it("tolerates whitespace and empty segments", () => {
    const { env, errors } = parseEnvVarsInput(" DEBUG = 1 , , PERSISTENCE=1 ");
    expect(errors).toEqual([]);
    expect(env).toEqual({ DEBUG: "1", PERSISTENCE: "1" });
  });

  it("keeps '=' characters inside values", () => {
    const { env } = parseEnvVarsInput("EXTRA_CORS_ALLOWED_ORIGINS=http://localhost:3000?a=b");
    expect(env.EXTRA_CORS_ALLOWED_ORIGINS).toBe("http://localhost:3000?a=b");
  });

  it("rejects malformed pairs without dropping valid ones", () => {
    const { env, errors } = parseEnvVarsInput("DEBUG=1,nonsense,2BAD=x,EMPTY=");
    expect(env).toEqual({ DEBUG: "1" });
    expect(errors).toHaveLength(3);
  });

  it("rejects LOCALSTACK_AUTH_TOKEN", () => {
    const { env, errors } = parseEnvVarsInput("LOCALSTACK_AUTH_TOKEN=ls-abc");
    expect(env).toEqual({});
    expect(errors[0]).toContain("LOCALSTACK_AUTH_TOKEN");
  });

  it("returns empty results for empty input", () => {
    expect(parseEnvVarsInput("")).toEqual({ env: {}, errors: [] });
  });
});
