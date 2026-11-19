import fs from "fs";
import os from "os";
import path from "path";
import { runLstkAws } from "./lstk-aws";

// A stand-in `lstk` on the PATH that, like `lstk aws s3 cp - …`, reads stdin to the end before
// answering, then prints what it was run with.
const FAKE_LSTK = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write("> Note: No AWS profile found, run 'lstk setup aws'\\n");
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    input,
    pager: process.env.AWS_PAGER,
    endpoint: process.env.AWS_ENDPOINT_URL,
  }));
});
`;

describe("runLstkAws", () => {
  let binDir: string;
  const saved = {
    PATH: process.env.PATH,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
    LOCALSTACK_HOSTNAME: process.env.LOCALSTACK_HOSTNAME,
  };

  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-lstk-"));
    fs.writeFileSync(path.join(binDir, "lstk"), FAKE_LSTK, { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${saved.PATH}`;
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.LOCALSTACK_HOSTNAME;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test("gives the CLI no stdin, so a command reading it ends instead of waiting", async () => {
    const result = await runLstkAws(["s3", "cp", "-", "s3://bucket/key"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["aws", "s3", "cp", "-", "s3://bucket/key"],
      input: "",
      pager: "",
      endpoint: "http://localhost.localstack.cloud:4566",
    });
  }, 5_000);

  test("refuses an argv that would leave LocalStack before starting anything", async () => {
    await expect(runLstkAws(["sqs", "list-queues", "--endp", "https://x"])).rejects.toThrow(
      "commands always target LocalStack"
    );
    await expect(
      runLstkAws(["cloudformation", "delete-stack", "--stack-name", "help"])
    ).rejects.toThrow("may only end a help request");
  });
});
