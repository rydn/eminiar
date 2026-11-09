import { describe, expect, it } from "vitest";
import { summarize } from "../../src/stats/record.js";
import { savingsLine } from "../../src/stats/statusline.js";
import type { StatRow } from "../../src/storage/types.js";
import { formatSavingsStats, SAVINGS_LEGEND } from "../../src/tools/em_stats.js";
import { pricedSavings, savingsKind, splitSavings } from "../../src/usage/savings.js";

const row = (tool: string, raw: number, ret: number, session = "s1"): StatRow => ({
  session_id: session,
  tool,
  calls: 1,
  raw_chars: raw,
  returned_chars: ret,
  duration_ms: 0,
});

// em_execute: 40000 → 4000 chars = 10000 − 1000 = 9000 tokens measured
// em_graph_impact: 20000 → 2000 chars = 5000 − 500 = 4500 tokens counterfactual
// em_search: 8000 → 800 chars = 2000 − 200 = 1800 tokens counterfactual
const rows: StatRow[] = [
  row("em_execute", 40_000, 4_000),
  row("em_graph_impact", 20_000, 2_000),
  row("em_search", 8_000, 800),
];

describe("savingsKind", () => {
  it("counts execution and fetch tools as measured", () => {
    for (const t of ["em_execute", "em_execute_file", "em_batch_execute", "em_fetch_and_index"])
      expect(savingsKind(t)).toBe("measured");
  });

  it("counts knowledge tools, and any tool it does not know, as counterfactual", () => {
    for (const t of [
      "em_search",
      "em_docs",
      "em_graph_query",
      "em_graph_impact",
      "em_graph_changes",
      "em_architecture",
      "em_symbols",
      "em_history",
      "em_reindex",
      "em_future_tool",
    ])
      expect(savingsKind(t)).toBe("counterfactual");
  });
});

describe("splitSavings", () => {
  it("splits saved tokens by kind from the recorded rows", () => {
    expect(splitSavings(rows)).toEqual({ measuredTokens: 9_000, counterfactualTokens: 6_300 });
  });

  it("nets a kind over its own rows only, floored at 0", () => {
    // em_symbols records raw 0: its returned text lowers counterfactual savings, never measured
    const split = splitSavings([row("em_execute", 4_000, 400), row("em_symbols", 0, 8_000)]);
    expect(split).toEqual({ measuredTokens: 900, counterfactualTokens: 0 });
  });

  it("is empty for no rows", () => {
    expect(splitSavings([])).toEqual({ measuredTokens: 0, counterfactualTokens: 0 });
  });
});

describe("pricedSavings split", () => {
  it("reports measured and counterfactual tokens that add up to savedTokens", () => {
    const r = pricedSavings(rows, []);
    expect(r.savedTokens).toBe(15_300);
    expect(r.measuredTokens).toBe(9_000);
    expect(r.counterfactualTokens).toBe(6_300);
    expect(r.assumptions.some((a) => a.startsWith("Measured savings come from"))).toBe(true);
  });
});

describe("em_stats savings section", () => {
  it("labels figures as estimates and shows the split and each tool's kind", () => {
    const out = formatSavingsStats("session abc", rows);
    const [head, split, header, ...table] = out.split("\n");
    expect(head).toBe(
      "session abc: 3 call(s), ≈15.3k tokens saved of ≈17.0k seen (90% efficient, estimated)",
    );
    expect(split).toBe(
      "  measured ≈9.0k (execution output kept out) · counterfactual ≈6.3k (vs native calls)",
    );
    expect(header).toContain("kind");
    expect(table[0]).toMatch(/^ {2}em_execute +measured +1 /);
    expect(table[1]).toMatch(/^ {2}em_graph_impact +counterfactual +1 /);
    expect(table[2]).toMatch(/^ {2}em_search +counterfactual +1 /);
  });

  it("keeps the one-line form when nothing is recorded", () => {
    expect(formatSavingsStats("lifetime", [])).toBe(
      "lifetime: 0 call(s), ≈0 tokens saved of ≈0 seen (0% efficient, estimated)",
    );
  });

  it("explains the estimate and both kinds in the legend", () => {
    expect(SAVINGS_LEGEND).toMatch(/^≈ token figures are estimates \(4 characters per token\)/);
    expect(SAVINGS_LEGEND).toContain("measured:");
    expect(SAVINGS_LEGEND).toContain("counterfactual:");
  });
});

describe("statusline savings", () => {
  it("prefixes estimated figures with ≈ and shows the measured part", () => {
    const session = summarize(rows);
    const life = summarize([...rows, row("em_execute", 400_000, 0, "x")]);
    expect(savingsLine(session, life, 9_000)).toBe(
      "eminiar · ≈15.3k saved (≈9.0k measured) · ≈115.3k lifetime · 90% efficient",
    );
  });

  it("omits the measured part when it is all or nothing of the session", () => {
    const only = summarize([row("em_execute", 4_000, 400)]);
    expect(savingsLine(only, only, 900)).toBe(
      "eminiar · ≈900 saved · ≈900 lifetime · 90% efficient",
    );
    const none = summarize([]);
    expect(savingsLine(none, none, 0)).toBe("eminiar · ≈0 saved · ≈0 lifetime · 0% efficient");
  });
});
