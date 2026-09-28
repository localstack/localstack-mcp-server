import {
  AZURE_COMMAND_DESCRIPTION,
  AZURE_SUBSCRIPTION_ID,
  buildAzureClientDescription,
} from "./description";

// P2, the unit part (plan task 2.10). The direct test measures the real tools/list
// entry; this one keeps the description itself inside its share of the budget.

describe("buildAzureClientDescription", () => {
  const workdir200 = "C:\\" + "w".repeat(197);

  test("fills the workdir and the output cap, and names the constant subscription", () => {
    const text = buildAzureClientDescription({ workdir: "/work/project", maxOutputChars: 30000 });
    expect(text).toContain("Files must be inside /work/project.");
    expect(text).toContain("truncated past 30,000 characters");
    expect(text).toContain(`Subscription: ${AZURE_SUBSCRIPTION_ID}.`);
    expect(text).toContain("--no-wait");
    expect(text.startsWith("Run an Azure CLI (az) command")).toBe(true);
  });

  test("is deterministic (cache-friendly)", () => {
    const ctx = { workdir: workdir200, maxOutputChars: 30000 };
    expect(buildAzureClientDescription(ctx)).toBe(buildAzureClientDescription(ctx));
  });

  test("with a 200-character workdir, JSON-escaped, it leaves room in the 3,200-byte entry", () => {
    const text = buildAzureClientDescription({ workdir: workdir200, maxOutputChars: 30000 });
    const escaped = Buffer.byteLength(JSON.stringify(text));
    // C04: the input schema is ~241 bytes and xmcp/the SDK add ~137 per tool, plus
    // the name, title and annotations (~250). 2,400 keeps the whole entry under 3,200.
    expect(escaped).toBeLessThanOrEqual(2400);
    expect(Buffer.byteLength(JSON.stringify(AZURE_COMMAND_DESCRIPTION))).toBeLessThan(120);
  });
});
