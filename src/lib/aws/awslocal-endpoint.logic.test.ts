import {
  awsCliCommandName,
  awslocalExecEnv,
  buildsClientUrl,
  containerEnvValue,
  containerGatewayEndpoint,
  containerGatewayPort,
} from "./awslocal-endpoint.logic";

describe("containerGatewayEndpoint", () => {
  test("default: no GATEWAY_LISTEN means the gateway on 4566", () => {
    expect(containerGatewayEndpoint(undefined)).toBe("http://localhost:4566");
    expect(containerGatewayEndpoint(["PATH=/usr/bin", "DEBUG=1"])).toBe("http://localhost:4566");
  });

  test("the server's own container spec (:4566,:443) keeps 4566", () => {
    expect(containerGatewayEndpoint(["GATEWAY_LISTEN=:4566,:443"])).toBe("http://localhost:4566");
  });

  test("mapped host port: LOCALSTACK_HOST names the host side and is ignored", () => {
    const env = ["LOCALSTACK_HOST=localhost.localstack.cloud:4700", "PATH=/usr/bin"];
    expect(containerGatewayEndpoint(env)).toBe("http://localhost:4566");
  });

  test("mapped host port with the server's GATEWAY_LISTEN still targets the container port", () => {
    const env = ["LOCALSTACK_HOST=localhost.localstack.cloud:4700", "GATEWAY_LISTEN=:4566,:443"];
    expect(containerGatewayEndpoint(env)).toBe("http://localhost:4566");
  });

  test("custom GATEWAY_LISTEN: the first entry's port", () => {
    expect(containerGatewayEndpoint(["GATEWAY_LISTEN=0.0.0.0:4700"])).toBe("http://localhost:4700");
    expect(containerGatewayEndpoint(["GATEWAY_LISTEN=:5000,:4566"])).toBe("http://localhost:5000");
    expect(containerGatewayEndpoint(["GATEWAY_LISTEN= 127.0.0.1:4800 , :443"])).toBe(
      "http://localhost:4800"
    );
  });

  test("custom GATEWAY_LISTEN together with LOCALSTACK_HOST on another port", () => {
    const env = ["GATEWAY_LISTEN=0.0.0.0:4700", "LOCALSTACK_HOST=localhost.localstack.cloud:5700"];
    expect(containerGatewayEndpoint(env)).toBe("http://localhost:4700");
  });

  test("IPv6 entries", () => {
    expect(containerGatewayPort(["GATEWAY_LISTEN=[::]:4700"])).toBe(4700);
    expect(containerGatewayPort(["GATEWAY_LISTEN=[::1]"])).toBe(4566);
  });

  test("a host without a port keeps the default port, as LocalStack reads it", () => {
    expect(containerGatewayPort(["GATEWAY_LISTEN=0.0.0.0"])).toBe(4566);
  });

  test("LOCALSTACK_GATEWAY_LISTEN wins, since the entrypoint exports it as GATEWAY_LISTEN", () => {
    const env = ["GATEWAY_LISTEN=:4566", "LOCALSTACK_GATEWAY_LISTEN=:4900"];
    expect(containerGatewayPort(env)).toBe(4900);
  });

  test("empty or unreadable values fall back to 4566", () => {
    expect(containerGatewayPort(["GATEWAY_LISTEN="])).toBe(4566);
    expect(containerGatewayPort(["GATEWAY_LISTEN=:abc"])).toBe(4566);
    expect(containerGatewayPort(["GATEWAY_LISTEN=:0"])).toBe(4566);
    expect(containerGatewayPort(["GATEWAY_LISTEN=:70000"])).toBe(4566);
    expect(containerGatewayPort(["GATEWAY_LISTEN=[::1"])).toBe(4566);
  });

  test("a variable whose name only starts with GATEWAY_LISTEN is not read", () => {
    expect(containerGatewayPort(["GATEWAY_LISTEN_EXTRA=:4700"])).toBe(4566);
  });
});

describe("containerEnvValue", () => {
  test("keeps '=' inside the value", () => {
    expect(containerEnvValue(["A=b=c"], "A")).toBe("b=c");
    expect(containerEnvValue(["A=1"], "B")).toBeUndefined();
  });
});

describe("awslocalExecEnv", () => {
  const mapped = ["LOCALSTACK_HOST=localhost.localstack.cloud:4700", "GATEWAY_LISTEN=:4600"];

  test("sets only AWS_ENDPOINT_URL, to the container-side gateway", () => {
    expect(awslocalExecEnv(mapped, ["sqs", "list-queues"])).toEqual([
      "AWS_ENDPOINT_URL=http://localhost:4600",
    ]);
  });

  test.each([
    [["s3", "presign", "s3://bucket/key"]],
    [["s3", "presign", "s3://bucket/key", "--expires-in", "60"]],
    [["--region", "eu-west-1", "s3", "presign", "s3://bucket/key"]],
    [["rds", "generate-db-auth-token", "--hostname", "db", "--port", "5432", "--username", "u"]],
    [["eks", "get-token", "--cluster-name", "c1"]],
    [["dsql", "generate-db-connect-auth-token", "--hostname", "h"]],
    [["dsql", "generate-db-connect-admin-auth-token", "--hostname", "h"]],
  ])("%j builds a URL for the caller, so it keeps awslocal's LOCALSTACK_HOST endpoint", (args) => {
    expect(awslocalExecEnv(mapped, args)).toEqual([]);
  });

  test.each([
    [["s3", "ls"]],
    [["s3", "cp", "presign", "s3://bucket/presign"]],
    [["s3api", "get-object", "--bucket", "presign", "--key", "k", "out"]],
    [["rds", "describe-db-instances"]],
    [["eks", "list-clusters"]],
    [["--output", "s3", "sqs", "list-queues"]],
  ])("%j calls the gateway, so it gets the container-side endpoint", (args) => {
    expect(awslocalExecEnv(mapped, args)).toEqual(["AWS_ENDPOINT_URL=http://localhost:4600"]);
  });
});

describe("awsCliCommandName", () => {
  test("skips global options and their values", () => {
    expect(awsCliCommandName(["--debug", "--profile", "p", "S3", "Presign", "x"])).toBe(
      "s3 presign"
    );
    expect(awsCliCommandName(["--region=us-east-1", "sqs", "list-queues"])).toBe("sqs list-queues");
    expect(awsCliCommandName(["help"])).toBe("help");
    expect(buildsClientUrl([])).toBe(false);
  });
});
