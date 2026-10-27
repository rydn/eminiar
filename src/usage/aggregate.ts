/**
 * Pure aggregations over usage rows: totals, groupings by time / model / session
 * / branch / agent, cache statistics, the per-session context timeline, burn
 * rate over the active billing block, and the tools that eat the most context.
 */

import type { ApiCallRow, ContextEventRow, ToolUseRow } from "../storage/types.js";
import { activeBlock, billingBlocks } from "./blocks.js";
import { estTokensFromChars } from "./pricing.js";

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  thinking: number;
  costUsd: number;
  unpricedCalls: number;
  /** cache_read / (input + cache writes + cache read); 0 when there is no input. */
  cacheHitRate: number;
  /** Calls per model id. */
  models: Record<string, number>;
}

const num = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) ? n : 0;

/**
 * Claude Code writes `<synthetic>` assistant entries for interruptions and local
 * notices; they carry no usage worth counting, so aggregations skip them.
 */
export const isRealCall = (c: Pick<ApiCallRow, "model">): boolean => c.model !== "<synthetic>";

export function totals(calls: ApiCallRow[]): UsageTotals {
  const t: UsageTotals = {
    calls: 0,
    input: 0,
    output: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    thinking: 0,
    costUsd: 0,
    unpricedCalls: 0,
    cacheHitRate: 0,
    models: {},
  };
  for (const c of calls) {
    if (!isRealCall(c)) continue;
    t.calls += 1;
    t.input += num(c.input_tokens);
    t.output += num(c.output_tokens);
    t.cacheCreate5m += num(c.cache_create_5m);
    t.cacheCreate1h += num(c.cache_create_1h);
    t.cacheRead += num(c.cache_read);
    t.thinking += num(c.thinking_tokens);
    if (c.priced && c.cost_usd != null && Number.isFinite(c.cost_usd)) t.costUsd += c.cost_usd;
    else t.unpricedCalls += 1;
    const m = c.model || "unknown";
    t.models[m] = (t.models[m] ?? 0) + 1;
  }
  const denom = t.input + t.cacheCreate5m + t.cacheCreate1h + t.cacheRead;
  t.cacheHitRate = denom > 0 ? t.cacheRead / denom : 0;
  return t;
}

export interface Group {
  key: string;
  totals: UsageTotals;
}

/** Group calls by `keyFn` (a null key drops the call); groups sorted by key. */
export function groupBy(
  calls: ApiCallRow[],
  keyFn: (call: ApiCallRow) => string | null | undefined,
): Group[] {
  const buckets = new Map<string, ApiCallRow[]>();
  for (const c of calls) {
    if (!isRealCall(c)) continue;
    const k = keyFn(c);
    if (k == null) continue;
    const list = buckets.get(k);
    if (list) list.push(c);
    else buckets.set(k, [c]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, rows]) => ({ key, totals: totals(rows) }));
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? "";
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    });
    fmtCache.set(key, f);
  }
  return f;
}

/** Calendar day of `ts` in `tz` (default: the process's local zone). */
function localYmd(ts: number, tz?: string): Ymd {
  const parts = formatter(tz).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymdKey = ({ y, m, d }: Ymd) => `${y}-${pad2(m)}-${pad2(d)}`;

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ts: number, tz?: string): string {
  return ymdKey(localYmd(ts, tz));
}

/** Monday of the ISO week containing the local day, YYYY-MM-DD. */
export function weekKey(ts: number, tz?: string): string {
  const { y, m, d } = localYmd(ts, tz);
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = (date.getUTCDay() + 6) % 7; // Monday → 0, Sunday → 6
  date.setUTCDate(date.getUTCDate() - back);
  return ymdKey({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
}

/** Local calendar month, YYYY-MM. */
export function monthKey(ts: number, tz?: string): string {
  const { y, m } = localYmd(ts, tz);
  return `${y}-${pad2(m)}`;
}

export const byDay = (calls: ApiCallRow[], tz?: string): Group[] =>
  groupBy(calls, (c) => dayKey(c.ts, tz));
export const byWeek = (calls: ApiCallRow[], tz?: string): Group[] =>
  groupBy(calls, (c) => weekKey(c.ts, tz));
export const byMonth = (calls: ApiCallRow[], tz?: string): Group[] =>
  groupBy(calls, (c) => monthKey(c.ts, tz));
export const byModel = (calls: ApiCallRow[]): Group[] =>
  groupBy(calls, (c) => c.model || "unknown");
export const bySession = (calls: ApiCallRow[]): Group[] => groupBy(calls, (c) => c.session_id);
export const byBranch = (calls: ApiCallRow[]): Group[] =>
  groupBy(calls, (c) => c.git_branch || "(none)");
export const byEffort = (calls: ApiCallRow[]): Group[] =>
  groupBy(calls, (c) => c.effort || "default");
/** "fast" (fast mode) vs "standard". */
export const bySpeed = (calls: ApiCallRow[]): Group[] =>
  groupBy(calls, (c) => (c.speed === "fast" ? "fast" : "standard"));

export interface AgentBreakdown {
  main: UsageTotals;
  /** Sorted by cost desc, then calls desc. */
  subagents: Array<{ agentId: string; totals: UsageTotals }>;
  /** Subagent cost / total cost (0 when nothing is priced). */
  delegationShare: number;
}

/** Roll sidechain calls up by agent id next to the main thread. */
export function byAgent(calls: ApiCallRow[]): AgentBreakdown {
  const mainRows = calls.filter((c) => !c.sidechain);
  const side = calls.filter((c) => !!c.sidechain);
  const main = totals(mainRows);
  const subagents = groupBy(side, (c) => c.agent_id || "unknown")
    .map((g) => ({ agentId: g.key, totals: g.totals }))
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.calls - a.totals.calls);
  const subCost = subagents.reduce((s, a) => s + a.totals.costUsd, 0);
  const total = main.costUsd + subCost;
  return { main, subagents, delegationShare: total > 0 ? subCost / total : 0 };
}

export interface CacheStats {
  hitRate: number;
  cacheWrites: number;
  cacheReads: number;
  /** cache writes / cache reads; 0 when there are no reads. */
  writeReadRatio: number;
  /** 1h writes / all writes; 0 when there are no writes. */
  share1h: number;
  /**
   * Calls with zero cache_read other than the single earliest call of their session
   * (ties on the timestamp broken by request_id, so two calls that share the first
   * timestamp count one cold call).
   */
  coldCalls: number;
  calls: number;
}

export function cacheStats(calls: ApiCallRow[]): CacheStats {
  const t = totals(calls);
  const writes = t.cacheCreate5m + t.cacheCreate1h;
  const first = new Map<string, ApiCallRow>();
  for (const c of calls) {
    if (!isRealCall(c)) continue;
    const prev = first.get(c.session_id);
    if (!prev || c.ts < prev.ts || (c.ts === prev.ts && c.request_id < prev.request_id))
      first.set(c.session_id, c);
  }
  let coldCalls = 0;
  for (const c of calls) {
    if (!isRealCall(c) || first.get(c.session_id) === c) continue;
    if (num(c.cache_read) === 0) coldCalls += 1;
  }
  return {
    hitRate: t.cacheHitRate,
    cacheWrites: writes,
    cacheReads: t.cacheRead,
    writeReadRatio: t.cacheRead > 0 ? writes / t.cacheRead : 0,
    share1h: writes > 0 ? t.cacheCreate1h / writes : 0,
    coldCalls,
    calls: t.calls,
  };
}

export interface TimelinePoint {
  ts: number;
  requestId: string;
  model: string;
  /** input + cache writes + cache reads: what the model saw on that call. */
  contextTokens: number;
  output: number;
  costUsd: number;
  /** Set on the first call after a compaction / clear. */
  compactBefore?: boolean;
}

/** Context size per call in order, with compaction markers merged by timestamp. */
export function contextTimeline(
  sessionCalls: ApiCallRow[],
  contextEvents: ContextEventRow[] = [],
): TimelinePoint[] {
  const points: TimelinePoint[] = sessionCalls
    .filter(isRealCall)
    .sort((a, b) => a.ts - b.ts)
    .map((c) => ({
      ts: c.ts,
      requestId: c.request_id,
      model: c.model,
      contextTokens:
        num(c.input_tokens) + num(c.cache_create_5m) + num(c.cache_create_1h) + num(c.cache_read),
      output: num(c.output_tokens),
      costUsd: c.cost_usd != null && Number.isFinite(c.cost_usd) ? c.cost_usd : 0,
    }));
  const events = contextEvents.slice().sort((a, b) => a.ts - b.ts);
  let i = 0;
  for (const ev of events) {
    while (i < points.length && (points[i] as TimelinePoint).ts < ev.ts) i += 1;
    const p = points[i];
    if (p) p.compactBefore = true;
  }
  return points;
}

export interface BurnRate {
  /** All token kinds (input, output, cache writes, cache reads) per minute; 0 when unreliable. */
  tokensPerMin: number;
  /** 0 when unreliable. */
  usdPerHour: number;
  /** Cost so far plus the current rate over the rest of the block; null when unreliable. */
  projectedBlockUsd: number | null;
  /** Minutes from the block's first call to now (0 without an active block). */
  windowMinutes: number;
  /**
   * True only when the active block has at least `BURN_MIN_CALLS` calls spread over at
   * least `BURN_MIN_MINUTES`; a rate extrapolated from one call or a one-minute window
   * says nothing about the next four hours.
   */
  reliable: boolean;
}

export const BURN_MIN_MINUTES = 5;
export const BURN_MIN_CALLS = 2;

/** Burn rate over the active 5-hour block; unreliable (zeros, null projection) without one. */
export function burnRate(calls: ApiCallRow[], now = Date.now()): BurnRate {
  const none: BurnRate = {
    tokensPerMin: 0,
    usdPerHour: 0,
    projectedBlockUsd: null,
    windowMinutes: 0,
    reliable: false,
  };
  const block = activeBlock(billingBlocks(calls, now), now);
  if (!block) return none;
  const windowMinutes = Math.max(0, (Math.min(now, block.end) - block.firstCall) / 60_000);
  if (windowMinutes < BURN_MIN_MINUTES || block.calls < BURN_MIN_CALLS)
    return { ...none, windowMinutes };
  const tokens =
    block.tokens.input + block.tokens.output + block.tokens.cacheCreate + block.tokens.cacheRead;
  const usdPerHour = (block.costUsd / windowMinutes) * 60;
  const remainingHours = Math.max(0, block.end - now) / 3_600_000;
  return {
    tokensPerMin: tokens / windowMinutes,
    usdPerHour,
    projectedBlockUsd: block.costUsd + usdPerHour * remainingHours,
    windowMinutes,
    reliable: true,
  };
}

export interface ToolConsumer {
  tool: string;
  calls: number;
  /** Sum of result_chars. */
  chars: number;
  estTokens: number;
  avgChars: number;
  errors: number;
}

/** Tools ranked by how many characters their results put into context. */
export function topToolConsumers(toolUses: ToolUseRow[], limit = 10): ToolConsumer[] {
  const byTool = new Map<string, ToolConsumer>();
  for (const u of toolUses) {
    const tool = u.tool || "unknown";
    let row = byTool.get(tool);
    if (!row) {
      row = { tool, calls: 0, chars: 0, estTokens: 0, avgChars: 0, errors: 0 };
      byTool.set(tool, row);
    }
    row.calls += 1;
    row.chars += num(u.result_chars);
    if (u.is_error) row.errors += 1;
  }
  return [...byTool.values()]
    .map((r) => ({
      ...r,
      estTokens: estTokensFromChars(r.chars),
      avgChars: r.calls > 0 ? Math.round(r.chars / r.calls) : 0,
    }))
    .sort((a, b) => b.chars - a.chars || b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, Math.max(0, limit));
}

/** Priced calls at or above `thresholdUsd`, most expensive first. */
export function expensiveCalls(calls: ApiCallRow[], thresholdUsd: number): ApiCallRow[] {
  return calls
    .filter((c) => c.cost_usd != null && Number.isFinite(c.cost_usd) && c.cost_usd >= thresholdUsd)
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0));
}
