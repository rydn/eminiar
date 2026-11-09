import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { summarize } from "../../src/stats/record.js";
import { renderStatusline, savingsLine } from "../../src/stats/statusline.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { StatRow } from "../../src/storage/types.js";
import { emStats, formatSavingsStats, SAVINGS_LEGEND } from "../../src/tools/em_stats.js";
import { loadUsage, summaryPayload } from "../../src/tools/em_usage.js";
import { statsPayload } from "../../src/ui/api.js";
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

  it("nets each row on its own, floored at 0", () => {
    // em_symbols records raw 0: its returned text takes nothing from the other rows
    const split = splitSavings([
      row("em_execute", 4_000, 400),
      row("em_symbols", 0, 8_000),
      row("em_search", 8_000, 800),
    ]);
    expect(split).toEqual({ measuredTokens: 900, counterfactualTokens: 1_800 });
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

describe("one saved total on every surface", () => {
  let home: string;
  const prevHome = process.env.EMINIAR_HOME;
  const prevSession = process.env.EMINIAR_SESSION_ID;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "em-savings-home-"));
    process.env.EMINIAR_HOME = home;
  });

  afterAll(() => {
    closeAllStorage();
    if (prevHome === undefined) delete process.env.EMINIAR_HOME;
    else process.env.EMINIAR_HOME = prevHome;
    if (prevSession === undefined) delete process.env.EMINIAR_SESSION_ID;
    else process.env.EMINIAR_SESSION_ID = prevSession;
  });

  /** Records the rows in a fresh project's current session, as the em_* tools do. */
  function project(sessionId: string, stats: Array<[string, number, number]>): ProjectContext {
    const root = mkdtempSync(join(tmpdir(), "em-savings-root-"));
    writeFileSync(join(root, "package.json"), "{}");
    resetContextCache();
    const ctx = getContext(root);
    process.env.EMINIAR_SESSION_ID = sessionId; // the session the MCP server attributes to
    const db = getStorage(ctx, { vectors: false });
    for (const [tool, rawChars, returnedChars] of stats)
      db.statRecord(sessionId, tool, { rawChars, returnedChars, durationMs: 1 });
    return ctx;
  }

  /** The saved total each surface shows for the project's current session. */
  async function surfaces(ctx: ProjectContext, sessionId: string) {
    const stats = await emStats.handler({ scope: "session" }, ctx);
    const statsText = stats.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const line = renderStatusline(JSON.stringify({ session_id: sessionId, cwd: ctx.root }));
    const usage = summaryPayload(ctx, loadUsage(ctx, { ingest: false, scope: "session" }));
    return {
      emStats: statsText.match(/≈(\S+) tokens saved/)?.[1],
      emStatsSplit: statsText.match(/measured ≈(\S+) .* counterfactual ≈(\S+) /)?.slice(1),
      statusline: line.match(/^eminiar · ≈(\S+) saved/)?.[1],
      dashboard: statsPayload(ctx).session.savedTokens,
      emUsage: usage.savings.savedTokens,
      emUsageSplit: [usage.savings.measuredTokens, usage.savings.counterfactualTokens],
    };
  }

  it("gives one number when rows return more than they read", async () => {
    // em_symbols and em_reindex record raw 0; they must not pull the em_execute saving down
    const ctx = project("sv-case-1", [
      ["em_execute", 40_000, 4_000],
      ["em_symbols", 0, 30_000],
      ["em_reindex", 0, 2_000],
    ]);
    expect(await surfaces(ctx, "sv-case-1")).toEqual({
      emStats: "9.0k",
      emStatsSplit: ["9.0k", "0"],
      statusline: "9.0k",
      dashboard: 9_000,
      emUsage: 9_000,
      emUsageSplit: [9_000, 0],
    });
  });

  it("gives one number, and one split, when a knowledge tool returns more than it read", async () => {
    const ctx = project("sv-case-2", [
      ["em_execute", 40_000, 4_000],
      ["em_graph_impact", 20_000, 2_000],
      ["em_symbols", 0, 6_000],
    ]);
    expect(await surfaces(ctx, "sv-case-2")).toEqual({
      emStats: "13.5k",
      emStatsSplit: ["9.0k", "4.5k"],
      statusline: "13.5k",
      dashboard: 13_500,
      emUsage: 13_500,
      emUsageSplit: [9_000, 4_500],
    });
  });

  it("gives the project total per session row, not per tool merged across sessions", async () => {
    const ctx = project("sv-case-3", [["em_search", 8_000, 800]]);
    getStorage(ctx, { vectors: false }).statRecord("sv-case-3b", "em_search", {
      rawChars: 0,
      returnedChars: 8_000,
      durationMs: 1,
    });
    const stats = await emStats.handler({ scope: "project" }, ctx);
    const statsText = stats.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const usage = summaryPayload(ctx, loadUsage(ctx, { ingest: false, scope: "project" }));
    expect(statsText).toMatch(/: 2 call\(s\), ≈1\.8k tokens saved/);
    expect(statsText).toMatch(/ {2}em_search +counterfactual +2 +2\.0k +2\.2k +1\.8k$/m);
    expect(statsPayload(ctx).projectTotals.savedTokens).toBe(1_800);
    expect(usage.savings.savedTokens).toBe(1_800);
  });
});
