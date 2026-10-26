/**
 * One-line usage summaries for the hooks and the statusline, and the budget
 * warnings the UserPromptSubmit hook adds once per threshold.
 */

import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { ApiCallRow } from "../storage/types.js";
import { dayKey, totals } from "./aggregate.js";
import { detectInsights, type Insight, loadInsightInput } from "./insights.js";
import { formatUsd } from "./pricing.js";

export interface UsageBrief {
  /** Empty when no calls are recorded, so hooks can skip it. */
  line: string;
  sessionUsd: number;
  todayUsd: number;
  /** Today's cache hit rate (the session's when today has no calls). */
  cacheHitRate: number;
  topInsight?: Insight;
}

const DAY_MS = 86_400_000;

/** Calls that fall on the local calendar day of `now` (a day can span up to 36 h of UTC). */
function todaysCalls(db: StorageAdapter, now: number): ApiCallRow[] {
  const today = dayKey(now);
  return db.apiCalls({ since: now - 1.5 * DAY_MS }).filter((c) => dayKey(c.ts) === today);
}

/**
 * `usage: today $4.12 (23 calls, 71% cache hits) · session $0.88 · top insight: cache
 * went cold twice (~$0.40)`. Reads the usage tables as they are; callers ingest first.
 */
export function usageBrief(
  db: StorageAdapter,
  ctx: ProjectContext,
  opts: { sessionId?: string | undefined; now?: number | undefined } = {},
): UsageBrief {
  const now = opts.now ?? Date.now();
  const today = totals(todaysCalls(db, now));
  const session = totals(opts.sessionId ? db.apiCalls({ sessionId: opts.sessionId }) : []);
  const cacheHitRate = today.calls ? today.cacheHitRate : session.cacheHitRate;
  const out: UsageBrief = {
    line: "",
    sessionUsd: session.costUsd,
    todayUsd: today.costUsd,
    cacheHitRate,
  };
  if (today.calls === 0 && session.calls === 0) return out;

  const parts = [
    `today ${formatUsd(today.costUsd)} (${today.calls} call${today.calls === 1 ? "" : "s"}, ${Math.round(cacheHitRate * 100)}% cache hits)`,
  ];
  if (session.calls > 0) parts.push(`session ${formatUsd(session.costUsd)}`);

  try {
    const scope = session.calls > 0 ? { sessionId: opts.sessionId } : { since: now - 1.5 * DAY_MS };
    const { insights } = detectInsights(loadInsightInput(db, ctx, { ...scope, now }));
    const top = insights[0];
    if (top) {
      out.topInsight = top;
      const saving =
        top.estimatedSavingsUsd && top.estimatedSavingsUsd >= 0.005
          ? ` (~${formatUsd(top.estimatedSavingsUsd)})`
          : "";
      parts.push(`top insight: ${top.title.charAt(0).toLowerCase()}${top.title.slice(1)}${saving}`);
    }
  } catch {
    // insights are optional in a brief
  }
  out.line = `usage: ${parts.join(" · ")}`;
  return out;
}

/**
 * Budget warnings for the prompt hook: one line per crossed threshold, each emitted
 * once (meta keys `usage_alert:session:<id>` and `usage_alert:daily:<YYYY-MM-DD>`).
 */
export function budgetWarnings(
  db: StorageAdapter,
  ctx: ProjectContext,
  sessionId: string,
  now = Date.now(),
): string[] {
  const { sessionUsd, dailyUsd } = ctx.config.usage.budgets;
  if (!sessionUsd && !dailyUsd) return [];
  const out: string[] = [];
  if (sessionUsd) {
    const key = `usage_alert:session:${sessionId}`;
    const cost = totals(db.apiCalls({ sessionId })).costUsd;
    if (cost >= sessionUsd && !db.metaGet(key)) {
      db.metaSet(key, String(now));
      out.push(
        `eminiar usage — this session has cost ${formatUsd(cost)}, over its ${formatUsd(sessionUsd)} budget (config.usage.budgets.sessionUsd). Keep raw output out of context, delegate bulk work to a cheaper model, or start a fresh session.`,
      );
    }
  }
  if (dailyUsd) {
    const day = dayKey(now);
    const key = `usage_alert:daily:${day}`;
    const cost = totals(todaysCalls(db, now)).costUsd;
    if (cost >= dailyUsd && !db.metaGet(key)) {
      db.metaSet(key, String(now));
      out.push(
        `eminiar usage — today's sessions have cost ${formatUsd(cost)}, over the ${formatUsd(dailyUsd)} daily budget (config.usage.budgets.dailyUsd). em_usage {view:"insights"} shows where it went.`,
      );
    }
  }
  return out;
}
