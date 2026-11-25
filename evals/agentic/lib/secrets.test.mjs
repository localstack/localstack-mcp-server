// node --test evals/agentic/lib/secrets.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { baseEnv, redact } from "./secrets.mjs";

const env = {
  PATH: "/usr/bin",
  HOME: "/home/eval",
  LOCALSTACK_AUTH_TOKEN: "ls-secret-token-1234",
  OPENROUTER_API_KEY: "sk-or-secret-5678",
};

test("the base environment holds no secret", () => {
  const child = baseEnv({ AWS_ACCESS_KEY_ID: "test" }, env);
  assert.deepEqual(child, { PATH: "/usr/bin", HOME: "/home/eval", AWS_ACCESS_KEY_ID: "test" });
});

test("redacts secrets in plain, URL, base64 and JSON-escaped form", () => {
  const token = env.LOCALSTACK_AUTH_TOKEN;
  const text = [
    token,
    encodeURIComponent(env.OPENROUTER_API_KEY),
    Buffer.from(token).toString("base64"),
    JSON.stringify({ env: `LOCALSTACK_AUTH_TOKEN=${token}` }),
  ].join("\n");
  const { text: clean, found } = redact(text, env);
  assert.ok(!clean.includes(token));
  assert.ok(!clean.includes(Buffer.from(token).toString("base64")));
  assert.ok(!clean.includes(env.OPENROUTER_API_KEY));
  assert.deepEqual(found.sort(), ["LOCALSTACK_AUTH_TOKEN", "OPENROUTER_API_KEY"]);
});

test("leaves text without secrets alone", () => {
  assert.deepEqual(redact("nothing here", env), { text: "nothing here", found: [] });
});
