import { z } from "zod";
import { getCurrentSession } from "../session/current.js";
import { formatRecallStats, RECALL_CATEGORY, recallStats } from "../session/recall.js";
import { formatRoutingStats, ROUTING_CATEGORY, routingStats } from "../session/routing-stats.js";
import { globalDb } from "../stats/global.js";
import { estTokens, fmtTokens, summarize } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import type { StatRow } from "../storage/types.js";
import { usageBrief } from "../usage/brief.js";
import { ingestSession, usageEnabled } from "../usage/ingest.js";
import { formatUsd } from "../usage/pricing.js";
import { rowSavedTokens, savingsKind, splitSavings } from "../usage/savings.js";
import { defineTool, text } from "./types.js";

export const emStats = defineTool({
  name: "em_stats",
  description:
    "Show how much context eminiar has kept out of the conversation (estimated at 4 characters per token, split into measured execution savings and counterfactual knowledge-tool savings): tokens seen vs returned per tool for this session, this project, and lifetime across all projects, plus index/graph sizes, how often routing intercepted native Bash/Read/Grep calls (and by which rule), and how often proactive recall (memories, docs, history before prompts, reads and edits) fired versus stayed quiet, with the reasons.",
  schema: {
    scope: z.enum(["session", "project", "lifetime", "all"]).optional().describe("default all"),
  },
  handler: async (args, ctx) => {
    const scope = args.scope ?? "all";
    const db = getStorage(ctx);
    const sessionId = getCurrentSession(ctx);
    const parts: string[] = [];
    if (scope === "session" || scope === "all") {
      parts.push(
        formatSavingsStats(`session ${sessionId.slice(0, 8)}`, db.statsBySession(sessionId)),
      );
      parts.push(
        formatRoutingStats(
          "routing (session)",
          routingStats(db.eventsBySession(sessionId, { categories: [ROUTING_CATEGORY] })),
        ),
      );
      parts.push(
        formatRecallStats(
          "recall (session)",
          recallStats(db.eventsBySession(sessionId, { categories: [RECALL_CATEGORY] })),
        ),
      );
    }
    if (scope === "project" || scope === "all") {
      parts.push(formatSavingsStats(`project ${ctx.root}`, db.statsAll()));
      parts.push(
        formatRoutingStats(
          "routing (project, last 2000 calls)",
          routingStats(db.eventsRecent(2000, [ROUTING_CATEGORY])),
        ),
      );
      parts.push(
        formatRecallStats(
          "recall (project, last 2000 decisions)",
          recallStats(db.eventsRecent(2000, [RECALL_CATEGORY])),
        ),
      );
    }
    if (scope === "lifetime" || scope === "all") {
      const g = globalDb();
      parts.push(formatSavingsStats("lifetime (all projects)", g.lifetime()));
      const days = g.daily(7);
      if (days.length) {
        parts.push(
          `last 7 days (≈ tokens saved): ${days
            .reverse()
            .map((d) => `${d.day.slice(5)} ${fmtTokens(Math.ceil(d.saved_chars / 4))}`)
            .join(" · ")}`,
        );
      }
    }
    parts.push(SAVINGS_LEGEND);
    parts.push(
      `index: ${db.countDocuments()} documents (${db.countDocuments("exec")} exec, ${db.countDocuments("batch")} batch, ${db.countDocuments("file")} file, ${db.countDocuments("url")} url, ${db.countDocuments("code")} code), ${db.vecCount()} vectors`,
    );
    const cost = usageLine(ctx, sessionId);
    if (cost) parts.push(cost);
    return text(parts.join("\n\n"));
  },
});

/**
 * `usage: today $X · session $Y · see em_usage`, or undefined when nothing has been recorded.
 * A failed ingest is reported in one line rather than hidden: the figures would silently
 * stop moving otherwise.
 */
function usageLine(ctx: Parameters<typeof getStorage>[0], sessionId: string): string | undefined {
  if (!usageEnabled(ctx)) return undefined;
  try {
    const db = getStorage(ctx);
    let failed: string | undefined;
    try {
      ingestSession(db, ctx.root, sessionId, undefined, { overrides: ctx.config.usage.pricing });
    } catch (err) {
      failed = `usage: ingest failed: ${(err as Error).message}`;
    }
    const b = usageBrief(db, ctx, { sessionId });
    const line =
      b.todayUsd || b.sessionUsd
        ? `usage: today ${formatUsd(b.todayUsd)} · session ${formatUsd(b.sessionUsd)} · see em_usage`
        : undefined;
    return [line, failed].filter((s) => s).join("\n") || undefined;
  } catch (err) {
    // opening the database or reading the brief failed, not the ingest
    return `usage: unavailable: ${(err as Error).message}`;
  }
}

/** Printed once under the savings sections: what the ≈ and the two kinds mean. */
export const SAVINGS_LEGEND =
  "≈ token figures are estimates (4 characters per token). measured: execution output (em_execute, em_execute_file, em_batch_execute, em_fetch_and_index) that was produced and kept out of context. counterfactual: what a native Read, Grep or git call might have returned for a search, docs, graph, symbol or history answer; it can overstate.";

/**
 * One savings section: the estimated total split into measured and counterfactual savings,
 * then a per-tool table with each tool's kind. Rows may hold several sessions of a tool; every
 * figure nets per row (rowSavedTokens), so the two kinds, the per-tool column and the total
 * agree with each other and with the statusline, the dashboard and em_usage.
 */
export function formatSavingsStats(title: string, rows: StatRow[]): string {
  const s = summarize(rows);
  const { measuredTokens, counterfactualTokens } = splitSavings(rows);
  const pct = s.rawTokens ? Math.round((s.savedTokens / s.rawTokens) * 100) : 0;
  const lines = [
    `${title}: ${s.calls} call(s), ≈${fmtTokens(s.savedTokens)} tokens saved of ≈${fmtTokens(s.rawTokens)} seen (${pct}% efficient, estimated)`,
  ];
  if (!rows.length) return lines.join("\n");
  lines.push(
    `  measured ≈${fmtTokens(measuredTokens)} (execution output kept out) · counterfactual ≈${fmtTokens(counterfactualTokens)} (vs native calls)`,
  );
  lines.push("  tool                 kind            calls     seen  returned    saved");
  for (const r of mergeByTool(rows).sort((a, b) => b.raw_chars - a.raw_chars)) {
    lines.push(
      `  ${r.tool.padEnd(20)} ${savingsKind(r.tool).padEnd(14)} ${String(r.calls).padStart(6)} ${fmtTokens(estTokens(r.raw_chars)).padStart(8)} ${fmtTokens(estTokens(r.returned_chars)).padStart(9)} ${fmtTokens(r.saved).padStart(8)}`,
    );
  }
  return lines.join("\n");
}

/** One table row per tool; `saved` is the sum of its rows' own savings. */
function mergeByTool(rows: StatRow[]): Array<StatRow & { saved: number }> {
  const m = new Map<string, StatRow & { saved: number }>();
  for (const r of rows) {
    const cur = m.get(r.tool);
    if (!cur) m.set(r.tool, { ...r, saved: rowSavedTokens(r) });
    else {
      cur.calls += r.calls;
      cur.raw_chars += r.raw_chars;
      cur.returned_chars += r.returned_chars;
      cur.duration_ms += r.duration_ms;
      cur.saved += rowSavedTokens(r);
    }
  }
  return [...m.values()];
}
