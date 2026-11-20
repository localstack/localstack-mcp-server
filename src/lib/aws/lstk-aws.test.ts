import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { runLstkAws } from "./lstk-aws";

// A stand-in `lstk` on the PATH. Like `lstk aws s3 cp - …` it reads stdin to the end first. It
// then sends one request through the proxy it was given (to the URL in ./target, since its
// environment is allow-listed), and prints what it ran with and what came back.
const FAKE_LSTK = `#!/usr/bin/env node
const http = require("http");
const target = require("fs").readFileSync("target", "utf8");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const proxy = new URL(process.env.HTTP_PROXY);
  const req = http.request(
    { host: proxy.hostname, port: proxy.port, path: target, headers: { host: new URL(target).host } },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        process.stdout.write("> Note: No AWS profile found, run 'lstk setup aws'\\n");
        process.stdout.write(JSON.stringify({
          args: process.argv.slice(2),
          input,
          cwd: process.cwd(),
          status: res.statusCode,
          body,
          env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(AWS_|LSTK_|HOME$|HTTPS?_PROXY$)/.test(k))),
        }));
      });
    }
  );
  req.end();
});
`;

describe("runLstkAws", () => {
  let binDir: string;
  let workdir: string;
  let localstack: http.Server;
  let localstackPort: number;
  const seen: string[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-lstk-"));
    workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-workdir-")));
    fs.writeFileSync(path.join(binDir, "lstk"), FAKE_LSTK, { mode: 0o755 });
    localstack = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      res.end("from localstack");
    });
    await new Promise<void>((resolve) => localstack.listen(0, "127.0.0.1", resolve));
    localstackPort = (localstack.address() as { port: number }).port;

    process.env.PATH = `${binDir}${path.delimiter}${saved.PATH}`;
    delete process.env.LOCALSTACK_HOSTNAME;
    process.env.LOCALSTACK_PORT = String(localstackPort);
    process.env.LOCALSTACK_AWS_WORKDIR = workdir;
    // What a user's shell might hold; none of it may reach the CLI.
    process.env.AWS_PROFILE = "prod";
    process.env.AWS_ACCESS_KEY_ID = "AKIAREALKEY000000000";
    process.env.AWS_ENDPOINT_URL_S3 = "https://s3.amazonaws.com";
    process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
    process.env.LSTK_ENDPOINT_URL = "https://example.com";
    process.env.AWS_REGION = "eu-west-1";
  });

  afterAll(async () => {
    process.env = saved;
    await new Promise<void>((resolve) => localstack.close(() => resolve()));
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  const run = async (target: string, args = ["s3", "ls"]) => {
    fs.writeFileSync(path.join(workdir, "target"), target);
    const result = await runLstkAws(args, { checkLocalPaths: true });
    return { result, out: JSON.parse(result.stdout) };
  };

  test("gives the CLI no stdin, so a command reading it ends instead of waiting", async () => {
    const { result, out } = await run(`http://localhost.localstack.cloud:${localstackPort}/`, [
      "s3",
      "cp",
      "-",
      "s3://bucket/key",
    ]);
    expect(result.exitCode).toBe(0);
    // A local transfer never follows a symlink out of the workdir.
    expect(out.args.slice(0, 6)).toEqual([
      "aws",
      "s3",
      "cp",
      "-",
      "s3://bucket/key",
      "--no-follow-symlinks",
    ]);
    expect(out.input).toBe("");
  }, 10_000);

  test("runs in the workdir with a private home and only the AWS settings it pins", async () => {
    const { out } = await run(`http://localhost.localstack.cloud:${localstackPort}/`);
    expect(out.cwd).toBe(workdir);
    expect(out.env.HOME).not.toBe(os.homedir());
    expect(out.env).toMatchObject({
      AWS_ENDPOINT_URL: `http://localhost.localstack.cloud:${localstackPort}`,
      AWS_ACCESS_KEY_ID: "test",
      AWS_REGION: "eu-west-1",
      AWS_PAGER: "",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "false",
      AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS: "true",
    });
    for (const name of ["AWS_PROFILE", "AWS_ENDPOINT_URL_S3", "LSTK_ENDPOINT_URL"]) {
      expect(out.env).not.toHaveProperty(name);
    }
  }, 10_000);

  test("relays requests for LocalStack and its subdomains, keeping their Host", async () => {
    const host = `bucket.localhost.localstack.cloud:${localstackPort}`;
    const { result, out } = await run(`http://${host}/key`);
    expect(out).toMatchObject({ status: 200, body: "from localstack" });
    expect(seen).toContain(`${host} /key`);
    expect(result.blocked).toEqual([]);
  }, 10_000);

  test("stops a request to any other host and reports it", async () => {
    const { result, out } = await run("http://s3.amazonaws.com/bucket");
    expect(out.status).toBe(403);
    expect(result.blocked).toEqual(["http://s3.amazonaws.com"]);
  }, 10_000);

  test("refuses an argv that would leave LocalStack or the workdir before starting anything", async () => {
    await expect(runLstkAws(["sqs", "list-queues", "--endp", "https://x"])).rejects.toThrow(
      "commands always target LocalStack"
    );
    await expect(
      runLstkAws(["cloudformation", "delete-stack", "--stack-name", "help"])
    ).rejects.toThrow("may only end a help request");
    await expect(
      runLstkAws(["s3", "cp", "/etc/hosts", "s3://b/k"], { checkLocalPaths: true })
    ).rejects.toThrow("outside the AWS client's working directory");
  });
});
