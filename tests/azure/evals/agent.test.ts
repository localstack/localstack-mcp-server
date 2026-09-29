/**
 * The E2 agent loop against a fake Messages client (no network, no key): the request
 * settings are the fixed ones, the model never sees the test envelope, refusals and
 * pause_turn are handled, the caps and the spend cap stop the loop, errors are classified,
 * and the cost is computed from the fixed prices.
 */
import type Anthropic from "@anthropic-ai/sdk";
import * as A from "./agent";
import type { McpResult, Price } from "./types";

const PRICE: Price = A.PRICES["claude-opus-5-5"];
const ENVELOPE = {
  exitCode: 0,
  stdout: '{\r\n  "name": "ENVELOPE-ONLY-STDOUT-MARKER"\r\n}\r\n',
  stderr: "",
  notes: [],
  classId: null,
  truncated: false,
  stoppedByTool: false,
  emulatorSession: "s-1",
};

function mcp(text: string, envelope: unknown = ENVELOPE): McpResult {
  const content = [{ type: "text", text }];
  if (envelope) content.push({ type: "text", text: JSON.stringify(envelope) });
  return { content };
}

type Resp = Partial<Anthropic.Message> | Error;

function usage(input = 10, output = 5, cacheWrite = 0, cacheRead = 0): Anthropic.Usage {
  const u = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
  return u as unknown as Anthropic.Usage;
}

function fakeClient(responses: Resp[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: A.MessagesClient = {
    messages: {
      create: async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const r = responses.shift();
        if (!r) throw new Error("no scripted response left");
        if (r instanceof Error) throw r;
        return {
          id: `msg_${calls.length}`,
          type: "message",
          role: "assistant",
          model: params.model,
          content: [],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: usage(),
          ...r,
        } as unknown as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

const toolUse = (id: string, command: string) =>
  ({
    type: "tool_use",
    id,
    name: "localstack-azure-client",
    input: { command },
  }) as unknown as Anthropic.ContentBlock;
const text = (t: string) =>
  ({ type: "text", text: t, citations: null }) as unknown as Anthropic.ContentBlock;

function options(client: A.MessagesClient, over: Partial<A.AgentOptions> = {}): A.AgentOptions {
  return {
    client,
    model: "claude-opus-5-5",
    effort: "high",
    tools: [
      {
        name: "localstack-azure-client",
        description: "Run az.",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    prompt: "List the groups.",
    caps: A.CAPS["T-A"],
    price: PRICE,
    perRunUsd: 1,
    remainingUsd: () => 20,
    callTool: async () => {
      const s = A.splitEnvelope(mcp('{\n  "name": "g1"\n}'));
      return {
        text: s.text,
        isError: s.isError,
        ms: 3,
        envelope: s.envelope,
        command: "group list",
      };
    },
    classifyError: () => "api_error",
    scrub: (s) => s,
    ...over,
  };
}

describe("splitEnvelope: the model never sees the test envelope", () => {
  test("the envelope (last text item) is split off", () => {
    const s = A.splitEnvelope(mcp("visible"));
    expect(s.text).toBe("visible");
    expect(s.envelope?.stdout).toContain("ENVELOPE-ONLY-STDOUT-MARKER");
  });

  test("a tool refusal has no envelope: every item stays visible", () => {
    const s = A.splitEnvelope({ content: [{ type: "text", text: "❌ **Command Not Allowed**" }] });
    expect(s).toEqual({ text: "❌ **Command Not Allowed**", envelope: null, isError: false });
  });

  test("a last item that is JSON but not an envelope stays visible", () => {
    const s = A.splitEnvelope({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: '{"x": 1}' },
      ],
    });
    expect(s.text).toBe('a\n{"x": 1}');
    expect(s.envelope).toBeNull();
  });

  test("isError passes through", () => {
    expect(A.splitEnvelope({ content: [{ type: "text", text: "x" }], isError: true }).isError).toBe(
      true
    );
  });
});

describe("egress events", () => {
  test("an egress-refused failure names the host", () => {
    const env = { ...ENVELOPE, exitCode: 1, classId: "egress-refused", notes: [] };
    const t =
      "❌ **Command Failed** (exit 1, egress-refused)\n\nBlocked a connection to `management.azure.com:443`: this tool only lets `az` talk to the local emulator.";
    expect(A.egressOf(2, "rest --url https://x", t, env).events).toEqual([
      {
        call: 2,
        command: "rest --url https://x",
        classId: "egress-refused",
        hosts: ["management.azure.com:443"],
        source: "classId",
      },
    ]);
  });

  test("a blocked host on a successful command is an event; housekeeping blocks are not", () => {
    const env = {
      ...ENVELOPE,
      notes: [
        "Note: the egress guard blocked a connection to `login.microsoftonline.com`; the command still succeeded.",
        "Note: the egress guard also blocked `azcliprod.blob.core.windows.net`, which the tool always refuses (housekeeping calls such as update checks); these blocks are expected.",
      ],
    };
    const r = A.egressOf(0, "c", "ok", env);
    expect(r.events.map((e) => e.hosts)).toEqual([["login.microsoftonline.com"]]);
    expect(r.housekeeping).toEqual(["azcliprod.blob.core.windows.net"]);
  });

  test("no refusal, no event", () => {
    expect(A.egressOf(0, "c", "ok", ENVELOPE)).toEqual({ events: [], housekeeping: [] });
  });
});

describe("runAgent", () => {
  test("the request carries the fixed settings", async () => {
    const { client, calls } = fakeClient([{ content: [text("done")], stop_reason: "end_turn" }]);
    const run = await A.runAgent(options(client));
    expect(run.final_text).toBe("done");
    expect(run.failure).toBeNull();
    const p = calls[0] as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(16000);
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect(p.system).toEqual([
      { type: "text", text: A.SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(p.tool_choice).toBeUndefined();
    expect(p.messages).toEqual([{ role: "user", content: "List the groups." }]);
  });

  test("tool_use -> tool_result without the envelope, and the assistant turn replayed unmodified", async () => {
    const first = {
      content: [text("Checking."), toolUse("tu_1", "group list")],
      stop_reason: "tool_use" as const,
      usage: usage(100, 20),
    };
    const { client, calls } = fakeClient([
      first,
      { content: [text("Found g1.")], stop_reason: "end_turn", usage: usage(50, 10, 0, 100) },
    ]);
    const run = await A.runAgent(options(client));
    expect(run.final_text).toBe("Found g1.");
    expect(run.tool_calls).toHaveLength(1);
    expect(run.tool_calls[0]).toMatchObject({
      name: "localstack-azure-client",
      args: { command: "group list" },
      exit_code: 0,
      ok: true,
    });
    const second = calls[1].messages;
    expect(second[1]).toEqual({
      role: "assistant",
      content: JSON.parse(JSON.stringify(first.content)),
    });
    expect(second[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: '{\n  "name": "g1"\n}',
          is_error: false,
        },
      ],
    });
    // Nothing of the envelope reaches the API, in any request.
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain("ENVELOPE-ONLY-STDOUT-MARKER");
    expect(sent).not.toContain("emulatorSession");
    expect(sent).not.toContain('\\"exitCode\\"');
    expect(run.turns.map((t) => t.stop_reason)).toEqual(["tool_use", "end_turn"]);
  });

  test("every tool_use of a turn goes back in one user message", async () => {
    const { client, calls } = fakeClient([
      {
        content: [toolUse("a", "group list"), toolUse("b", "account show")],
        stop_reason: "tool_use",
      },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    const run = await A.runAgent(options(client));
    expect(run.tool_calls).toHaveLength(2);
    const results = calls[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
  });

  test("egress events of a tool call are collected", async () => {
    const env = { ...ENVELOPE, exitCode: 1, classId: "egress-refused" };
    const { client } = fakeClient([
      {
        content: [toolUse("a", "rest --url https://management.azure.com/x")],
        stop_reason: "tool_use",
      },
      { content: [text("blocked")], stop_reason: "end_turn" },
    ]);
    const run = await A.runAgent(
      options(client, {
        callTool: async () => {
          const s = A.splitEnvelope(
            mcp(
              "❌ x\n\nBlocked a connection to `management.azure.com`: this tool only lets `az` talk",
              env
            )
          );
          return {
            text: s.text,
            isError: false,
            ms: 1,
            envelope: s.envelope,
            command: "rest --url https://management.azure.com/x",
          };
        },
      })
    );
    expect(run.egress).toHaveLength(1);
    expect(run.egress[0].hosts).toEqual(["management.azure.com"]);
  });

  test("a refusal is recorded with its stop details", async () => {
    const details = { type: "refusal", category: "cyber", explanation: "declined" };
    const { client } = fakeClient([
      {
        content: [],
        stop_reason: "refusal" as Anthropic.StopReason,
        stop_details: details as never,
      },
    ]);
    const run = await A.runAgent(options(client));
    expect(run.refusal).toBe(true);
    expect(run.failure).toBe("refusal");
    expect(run.stop_details).toEqual(details);
    expect(run.turns[0].stop_details).toEqual(details);
  });

  test("pause_turn continues with the paused turn in the history", async () => {
    const paused = { content: [text("thinking...")], stop_reason: "pause_turn" as const };
    const { client, calls } = fakeClient([
      paused,
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    const run = await A.runAgent(options(client));
    expect(run.final_text).toBe("done");
    expect(calls[1].messages).toHaveLength(2);
    expect(calls[1].messages[1].role).toBe("assistant");
  });

  test("max_tokens is a failure", async () => {
    const { client } = fakeClient([{ content: [text("cut")], stop_reason: "max_tokens" }]);
    expect((await A.runAgent(options(client))).failure).toBe("max_tokens");
  });

  test("the turn cap stops a loop that never ends", async () => {
    const loop = () => ({
      content: [toolUse(`t${Math.random()}`, "group list")],
      stop_reason: "tool_use" as const,
    });
    const { client, calls } = fakeClient([loop(), loop(), loop(), loop()]);
    const run = await A.runAgent(
      options(client, { caps: { turns: 3, toolCalls: 30, seconds: 600 } })
    );
    expect(run.failure).toBe("cap_exceeded");
    expect(calls).toHaveLength(3);
  });

  test("the per-run spend cap stops the loop before the next request", async () => {
    // 100k output tokens at $20/M = $2 on the first turn, over a $1 per-run cap.
    const big = {
      content: [toolUse("a", "group list")],
      stop_reason: "tool_use" as const,
      usage: usage(10, 100_000),
    };
    const { client, calls } = fakeClient([
      big,
      { content: [text("never sent")], stop_reason: "end_turn" },
    ]);
    const run = await A.runAgent(options(client, { perRunUsd: 1 }));
    expect(run.failure).toBe("spend_cap");
    expect(calls).toHaveLength(1);
  });

  test("the campaign's remaining budget stops the loop too, and a spent cap sends nothing", async () => {
    const { client, calls } = fakeClient([{ content: [text("x")], stop_reason: "end_turn" }]);
    const run = await A.runAgent(options(client, { remainingUsd: () => 0 }));
    expect(run.failure).toBe("spend_cap");
    expect(calls).toHaveLength(0);
  });

  test("each turn's cost is reported as it lands, so a concurrent run's spend stops this one", async () => {
    // Each turn: (1000 * $4 + 100 * $20) / 1M = $0.006. A concurrent run spends $0.01 per
    // tool call of this one; the campaign cap is $0.02.
    const turn = () => ({
      content: [toolUse(`t${Math.random()}`, "group list")],
      stop_reason: "tool_use" as const,
      usage: usage(1000, 100),
    });
    const { client, calls } = fakeClient([turn(), turn(), turn()]);
    const budget = { max: 0.02, spent: 0 };
    const costs: number[] = [];
    const run = await A.runAgent(
      options(client, {
        remainingUsd: () => budget.max - budget.spent,
        onCost: (usd) => {
          costs.push(usd);
          budget.spent += usd;
        },
        callTool: async () => {
          budget.spent += 0.01; // the other run
          return { text: "[]", isError: false, ms: 1, envelope: null };
        },
      })
    );
    expect(costs).toEqual([0.006, 0.006]);
    expect(calls).toHaveLength(2);
    expect(run.failure).toBe("spend_cap");
  });

  test("an API error is classified and scrubbed", async () => {
    const secret = "sk-ant-api03-SECRET";
    const { client } = fakeClient([new Error(`bad key ${secret}`)]);
    const run = await A.runAgent(
      options(client, {
        classifyError: () => "account_error",
        scrub: (s) => s.split(secret).join("[redacted]"),
      })
    );
    expect(run.failure).toBe("account_error");
    expect(run.stop).toBe("Error: bad key [redacted]");
  });

  test("an unknown tool's call reaches the dispatcher (which answers the error)", async () => {
    const { client } = fakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "x",
            name: "nope",
            input: {},
          } as unknown as Anthropic.ContentBlock,
        ],
        stop_reason: "tool_use",
      },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    const seen: string[] = [];
    await A.runAgent(
      options(client, {
        callTool: async (name) => {
          seen.push(name);
          return {
            text: "❌ Unknown tool 'nope' for this run",
            isError: true,
            ms: 0,
            envelope: null,
          };
        },
      })
    );
    expect(seen).toEqual(["nope"]);
  });
});

describe("prewarm", () => {
  test("max_tokens 0, the same thinking and effort, no top-level cache_control", async () => {
    const { client, calls } = fakeClient([
      { content: [], stop_reason: "max_tokens", usage: usage(3, 0, 1200, 0) },
    ]);
    const pw = await A.prewarm(client, "claude-opus-5-5", "high", options(client).tools);
    expect(pw.prefix_tokens).toBe(1200);
    const p = calls[0] as unknown as Record<string, unknown>;
    expect(p.max_tokens).toBe(0);
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.cache_control).toBeUndefined();
  });
});

describe("cost", () => {
  const turn = (input: number, output: number, cache_write: number, cache_read: number) => ({
    usage: { input, output, cache_write, cache_read },
  });

  test("prices: claude-opus-5-5 is $4 / $20, cache $5 / $0.20", () => {
    expect(A.PRICES["claude-opus-5-5"]).toEqual({
      input: 4,
      output: 20,
      cache_write: 5,
      cache_read: 0.2,
    });
    expect(A.priceFor("claude-unknown")).toBeUndefined();
  });

  test("totals and the initial tokens of the first request", () => {
    expect(A.totals([turn(10, 5, 100, 0), turn(20, 7, 0, 100)])).toEqual({
      input: 30,
      output: 12,
      cache_write: 100,
      cache_read: 100,
      initial: 110,
    });
    expect(A.totals([])).toEqual({
      input: 0,
      output: 0,
      cache_write: 0,
      cache_read: 0,
      initial: 0,
    });
  });

  test("billed cost", () => {
    // (1000*4 + 500*20 + 2000*5 + 10000*0.2) / 1e6 = 0.026
    expect(A.costUsd([turn(1000, 500, 2000, 10000)], PRICE)).toBe(0.026);
  });

  test("warm and cold re-pricing of the first turn only", () => {
    const turns = [turn(100, 50, 2000, 0), turn(10, 10, 0, 2100)];
    // warm: the 2,000-token prefix read instead of written
    expect(A.pricedCostUsd(turns, 2000, "warm", PRICE)).toBe(
      A.costUsd([turn(100, 50, 0, 2000), turns[1]], PRICE)
    );
    // cold: a prefix that was read is priced as written
    const read = [turn(100, 50, 0, 2000)];
    expect(A.pricedCostUsd(read, 2000, "cold", PRICE)).toBe(
      A.costUsd([turn(100, 50, 2000, 0)], PRICE)
    );
    expect(A.pricedCostUsd([], 2000, "warm", PRICE)).toBe(0);
    expect(A.pricedCostUsd(turns, null, "warm", PRICE)).toBeNull();
  });

  test("usageOf reads the SDK's usage fields", () => {
    expect(
      A.usageOf({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      })
    ).toEqual({
      input: 1,
      output: 2,
      cache_write: 3,
      cache_read: 4,
    });
    expect(A.usageOf(null)).toEqual({ input: 0, output: 0, cache_write: 0, cache_read: 0 });
  });
});

describe("error classification (account and transient errors)", () => {
  class APIError extends Error {
    constructor(
      public status?: number,
      message = "x",
      public type?: string
    ) {
      super(message);
    }
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class APIConnectionError extends APIError {}
  class RateLimitError extends APIError {}
  class InternalServerError extends APIError {}
  const classify = A.makeErrorClassifier({
    AuthenticationError,
    PermissionDeniedError,
    APIConnectionError,
    RateLimitError,
    InternalServerError,
  });

  test.each([
    [new AuthenticationError(401), "account_error"],
    [new PermissionDeniedError(403), "account_error"],
    [new APIError(402), "account_error"],
    [new APIError(400, "Your credit balance is too low"), "account_error"],
    [new APIError(400, "x", "billing_error"), "account_error"],
    [new APIConnectionError(undefined), "infra_error"],
    [new RateLimitError(429), "infra_error"],
    [new InternalServerError(529), "infra_error"],
    [new APIError(503), "infra_error"],
    [new APIError(400, "tools.0: invalid"), "api_error"],
  ] as Array<[Error, A.ErrorClass]>)("%s -> %s", (e, want) => {
    expect(classify(e)).toBe(want);
  });
});
