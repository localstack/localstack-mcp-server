import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The shard merge of the L2 operation catalogue (scripts/ci/merge-op-catalogue.cjs), which
// azure-weekly.yml publishes for the portal's inventory gate.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mergeCatalogues, findCatalogues } = require("../../../scripts/ci/merge-op-catalogue.cjs");

const kase = (id: string, result: string, checked = "2026-09-27", command = `cmd ${id}`) => ({
  case: id,
  file: "x.yaml",
  command,
  result,
  classId: null,
  gap: result === "known_gap",
  checked,
});

function shard(
  n: number,
  operations: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-27T00:00:00Z",
    run: `run${n}`,
    matrix: "full",
    shard: `${n}/2`,
    backing: true,
    coverageChecked: n === 1,
    extensionsInstalled: n === 1 ? ["resource-graph"] : ["fleet", "resource-graph"],
    summary: {},
    operations,
    ...extra,
  };
}

describe("mergeCatalogues", () => {
  test("concatenates each key's cases and keeps the best result", () => {
    const merged = mergeCatalogues([
      shard(1, {
        "Microsoft.Storage storageAccounts Create": {
          implemented: true,
          result: "fail",
          cases: [kase("a", "fail")],
        },
        "Microsoft.Web sites Get": {
          implemented: true,
          result: "known_gap",
          cases: [kase("w", "known_gap")],
        },
      }),
      shard(2, {
        "Microsoft.Storage storageAccounts Create": {
          implemented: null,
          result: "pass",
          cases: [kase("b", "pass", "2026-09-26", "storage account create")],
        },
      }),
    ]);
    const storage = merged.operations["Microsoft.Storage storageAccounts Create"];
    expect(storage.cases.map((c: { case: string }) => c.case)).toEqual(["a", "b"]);
    expect(storage.result).toBe("pass");
    expect(storage.verified).toBe("2026-09-26");
    expect(storage.command).toBe("storage account create");
    expect(storage.implemented).toBe(true); // shard 1 checked coverage; shard 2 did not
    expect(merged.operations["Microsoft.Web sites Get"].result).toBe("known_gap");
    expect(merged.summary).toEqual({ operations: 2, pass: 1, known_gap: 1 });
    expect(merged.extensionsInstalled).toEqual(["fleet", "resource-graph"]);
    expect(merged.coverageChecked).toBe(true);
    expect(merged.shard).toBe("merged 1/2,2/2");
  });

  test("the latest passing date wins; a key never passing has no verified date", () => {
    const merged = mergeCatalogues([
      shard(1, { k: { implemented: true, cases: [kase("a", "pass", "2026-09-20")] } }),
      shard(2, { k: { implemented: true, cases: [kase("b", "gap_fixed", "2026-09-27")] } }),
      shard(3, { f: { implemented: true, cases: [kase("c", "fail")] } }),
    ]);
    expect(merged.operations.k.verified).toBe("2026-09-27");
    expect(merged.operations.k.result).toBe("pass");
    expect(merged.operations.f.verified).toBeNull();
  });

  test("refuses another schema version, and an empty list", () => {
    expect(() => mergeCatalogues([shard(1, {}, { schemaVersion: 2 })])).toThrow(/schemaVersion 2/);
    expect(() => mergeCatalogues([])).toThrow(/no catalogues/);
  });
});

test("findCatalogues searches directories for the shard files only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-catalogue-"));
  try {
    fs.mkdirSync(path.join(root, "azure-matrix-shard-1", "test-results"), { recursive: true });
    fs.mkdirSync(path.join(root, "azure-matrix-shard-2", "test-results"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "azure-matrix-shard-1", "test-results", "azure-op-catalogue-1.json"),
      "{}"
    );
    fs.writeFileSync(
      path.join(root, "azure-matrix-shard-2", "test-results", "azure-op-catalogue-2.json"),
      "{}"
    );
    fs.writeFileSync(
      path.join(root, "azure-matrix-shard-2", "test-results", "matrix-results.jsonl"),
      ""
    );
    expect(findCatalogues(root).map((f: string) => path.basename(f))).toEqual([
      "azure-op-catalogue-1.json",
      "azure-op-catalogue-2.json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
