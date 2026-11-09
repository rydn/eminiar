import { describe, expect, it } from "vitest";
import { tools } from "../../src/tools/index.js";

const byName = (n: string) => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return t;
};

describe("tool annotations", () => {
  it("every registered tool declares all four hints", () => {
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(
          typeof (t.annotations as unknown as Record<string, unknown>)[k],
          `${t.name}.${k}`,
        ).toBe("boolean");
      }
    }
  });

  it("read-only tools are flagged readOnly", () => {
    for (const n of ["em_search", "em_recall", "em_symbols", "em_architecture"])
      expect(byName(n).annotations.readOnlyHint, n).toBe(true);
  });

  it("destructive and mixed tools are not read-only", () => {
    expect(byName("em_purge").annotations.destructiveHint).toBe(true);
    for (const n of ["em_memory", "em_swarm", "em_docs", "em_index", "em_reindex", "em_purge"])
      expect(byName(n).annotations.readOnlyHint, n).toBe(false);
    expect(byName("em_memory").annotations.destructiveHint).toBe(true);
  });

  it("read-only tools are never destructive", () => {
    for (const t of tools)
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
  });
});
