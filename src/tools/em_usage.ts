/**
 * em_usage: per-model-call usage insights from Claude Code transcripts (tokens, cache,
 * cost, billing blocks, context timeline, tool consumers, insights, eminiar's own savings).
 *
 * The payload builders (`usageView`) and renderers (`renderUsage`, `usageCsv`) are pure
 * over the aggregate objects so the dashboard API, the CLI and the tests reuse them.
 */

import { z } from "zod";
import type { ProjectContext } from "../context.js";
import { getCurrentSession } from "../session/current.js";
import { fmtTokens } from "../stats/record.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type {
  ApiCallRow,
  ContextEventRow,
  StatRow,
  StatuslineSnapshotRow,
  ToolUseRow,
} from "../storage/types.js";
import {
  type AgentBreakdown,
  BURN_MIN_CALLS,
  BURN_MIN_MINUTES,
  type BurnRate,
  burnRate,
  byAgent,
  byEffort,
  byModel,
  bySession,
  bySpeed,
  type CacheStats,
  cacheStats,
  contextTimeline,
  dayKey,
  type Group,
  isRealCall,
  monthKey,
  type TimelinePoint,
  type ToolConsumer,
  topToolConsumers,
  totals,
  type UsageTotals,
  weekKey,
} from "../usage/aggregate.js";
import { activeBlock, type Block, billingBlocks } from "../usage/blocks.js";
import { ingestProject, ingestSession, usageEnabled } from "../usage/ingest.js";
import { detectInsights, type Insight, loadInsightInput, type Score } from "../usage/insights.js";
import { formatUsd } from "../usage/pricing.js";
import { type PricedSavings, pricedSavings } from "../usage/savings.js";
import { defineTool, errorResult, text } from "./types.js";

export const USAGE_VIEWS = [
  "summary",
  "daily",
  "weekly",
  "monthly",
  "models",
  "sessions",
  "blocks",
  "turns",
  "tools",
  "insights",
  "savings",
] as const;
export type UsageView = (typeof USAGE_VIEWS)[number];
export type UsageScope = "session" | "project";

const DAY = 864e5;
const UNITS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: DAY, w: 7 * DAY };

/** Earliest `since` accepted: nothing before this is a Claude Code transcript. */
const SINCE_MIN = Date.UTC(2000, 0, 1);

/**
 * `30d`, `12h`, `2w`, `90m`, `45s` (relative to `now`, up to six digits) or an ISO date
 * (`2026-10-01`, optionally with a time). Returns epoch ms between 2000-01-01 and tomorrow;
 * undefined for an empty value; throws a message naming the accepted forms on anything else.
 */
export function parseSince(value: string | undefined, now = Date.now()): number | undefined {
  const s = value?.trim();
  if (!s) return undefined;
  const bad = () =>
    new Error(
      `invalid since "${value}": use an ISO date (2026-10-01) or a relative value like 30d, 12h, 2w`,
    );
  let ms: number;
  const rel = /^(\d{1,6})([smhdw])$/i.exec(s);
  if (rel) ms = now - Number(rel[1]) * (UNITS[(rel[2] as string).toLowerCase()] ?? DAY);
  else if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s)) ms = Date.parse(s);
  else throw bad();
  if (!Number.isFinite(ms) || ms < SINCE_MIN || ms > now + DAY) throw bad();
  return ms;
}

/** Positive integer rows cap for list views; the default when absent. */
export const LIMIT_MAX = 1000;
export const LIMIT_DEFAULT = 20;

/**
 * `limit` as the tool, the CLI and the API accept it: a whole number from 1 to LIMIT_MAX.
 * Returns the number, or a message explaining why the value is rejected.
 */
export function parseLimit(value: string | number | undefined): number | undefined | string {
  if (value === undefined) return undefined;
  // Strings must be plain digits: no "1e3", no "0x10", no blank.
  const n =
    typeof value === "number"
      ? value
      : /^\d{1,6}$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX)
    return `limit must be a whole number between 1 and ${LIMIT_MAX}`;
  return n;
}

const clampLimit = (n: number | undefined): number =>
  n === undefined || !Number.isFinite(n)
    ? LIMIT_DEFAULT
    : Math.min(LIMIT_MAX, Math.max(1, Math.floor(n)));

// --- loading -------------------------------------------------------------------------

export interface UsageLoadOptions {
  scope?: UsageScope | undefined;
  sessionId?: string | undefined;
  /** Epoch ms, inclusive. */
  since?: number | undefined;
  now?: number | undefined;
  /** Skip the transcript ingest (tests seed the tables directly; the API ingests once). */
  ingest?: boolean | undefined;
}

export interface UsageData {
  scope: UsageScope;
  /** The session the data is about (session scope) or the current one (project scope). */
  sessionId: string;
  since: number | undefined;
  now: number;
  calls: ApiCallRow[];
  toolUses: ToolUseRow[];
  contextEvents: ContextEventRow[];
  stats: StatRow[];
  snapshot: StatuslineSnapshotRow | undefined;
}

/**
 * The dashboard fires several requests per range change and the API must not re-read the
 * transcripts for each: an ingest of a project root (or of one session) is skipped when the
 * same one ran less than this long ago. The MCP tool goes through the same guard, so an
 * explicit call still ingests unless it follows another within the window.
 */
export const INGEST_GUARD_MS = 10_000;
const lastIngest = new Map<string, number>();

const sessionIngestKey = (root: string, sessionId: string) => `${root}\u0000${sessionId}`;

/** True when a project ingest (or, with `sessionId`, that session's) ran within the guard. */
export function recentlyIngested(root: string, sessionId?: string, now = Date.now()): boolean {
  const within = (key: string) => {
    const t = lastIngest.get(key);
    return t !== undefined && now - t < INGEST_GUARD_MS;
  };
  return within(root) || (sessionId !== undefined && within(sessionIngestKey(root, sessionId)));
}

function ingestFor(
  db: StorageAdapter,
  ctx: ProjectContext,
  scope: UsageScope,
  sessionId: string,
  now: number,
) {
  const overrides = ctx.config.usage.pricing;
  const project = scope === "project";
  if (recentlyIngested(ctx.root, project ? undefined : sessionId, now)) return;
  try {
    if (project) ingestProject(db, ctx.root, { overrides });
    else ingestSession(db, ctx.root, sessionId, undefined, { overrides });
  } catch {
    // the warehouse answers from what it has; a missing ~/.claude is not an error
  } finally {
    lastIngest.set(project ? ctx.root : sessionIngestKey(ctx.root, sessionId), now);
  }
}

/** Ingest (unless told not to) and read the rows the views aggregate over. */
export function loadUsage(ctx: ProjectContext, opts: UsageLoadOptions = {}): UsageData {
  const db = getStorage(ctx);
  const scope: UsageScope = opts.scope ?? "project";
  const sessionId = opts.sessionId ?? getCurrentSession(ctx);
  const now = opts.now ?? Date.now();
  if (opts.ingest !== false) ingestFor(db, ctx, scope, sessionId, now);
  const filter =
    scope === "session"
      ? { sessionId, since: opts.since }
      : { since: opts.since, sessionId: undefined };
  return {
    scope,
    sessionId,
    since: opts.since,
    now,
    calls: db.apiCalls(filter).filter(isRealCall),
    toolUses: db.toolUses(filter),
    contextEvents: db.contextEvents(scope === "session" ? { sessionId } : {}),
    stats: scope === "session" ? db.statsBySession(sessionId) : db.statsAll(),
    snapshot: db.statuslineLatest(scope === "session" ? sessionId : undefined),
  };
}

// --- payloads ------------------------------------------------------------------------

export interface ModelSlice {
  model: string;
  calls: number;
  costUsd: number;
  unpricedCalls: number;
}
export interface PeriodRow {
  key: string;
  totals: UsageTotals;
  models: ModelSlice[];
}
export interface ModelRow extends ModelSlice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  /** Share of priced cost, 0..1. */
  share: number;
}
export interface SessionRowUi {
  session: string;
  startedAt: number | null;
  firstCall: number;
  lastCall: number;
  branch: string | null;
  lastPrompt: string | null;
  totals: UsageTotals;
}
export interface SummaryPayload {
  scope: UsageScope;
  sessionId: string;
  since: number | undefined;
  now: number;
  totals: UsageTotals;
  today: UsageTotals;
  last7d: UsageTotals;
  last30d: UsageTotals;
  cache: CacheStats;
  models: ModelRow[];
  burn: BurnRate;
  block: Block | null;
  insights: Insight[];
  scores: Score[];
  savings: PricedSavings;
  snapshot: StatuslineSnapshotRow | null;
}
export interface PeriodsPayload {
  rows: PeriodRow[];
  totals: UsageTotals;
}
export interface ModelsPayload {
  rows: ModelRow[];
  byEffort: Group[];
  bySpeed: Group[];
  agents: AgentBreakdown;
}
export interface SessionsPayload {
  rows: SessionRowUi[];
}
export interface BlocksPayload {
  rows: Block[];
  burn: BurnRate;
}
export interface TurnsPayload {
  sessionId: string;
  timeline: TimelinePoint[];
  compactions: number;
  totals: UsageTotals;
}
export interface ToolsPayload {
  rows: ToolConsumer[];
  totalChars: number;
}
export interface InsightsPayload {
  insights: Insight[];
  scores: Score[];
}
export type SavingsPayload = PricedSavings;

export type UsagePayload =
  | SummaryPayload
  | PeriodsPayload
  | ModelsPayload
  | SessionsPayload
  | BlocksPayload
  | TurnsPayload
  | ToolsPayload
  | InsightsPayload
  | SavingsPayload;

function modelSlices(rows: ApiCallRow[]): ModelSlice[] {
  return byModel(rows)
    .map((g) => ({
      model: g.key,
      calls: g.totals.calls,
      costUsd: g.totals.costUsd,
      unpricedCalls: g.totals.unpricedCalls,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

function periods(calls: ApiCallRow[], keyFn: (ts: number) => string): PeriodRow[] {
  const buckets = new Map<string, ApiCallRow[]>();
  for (const c of calls) {
    const k = keyFn(c.ts);
    const list = buckets.get(k);
    if (list) list.push(c);
    else buckets.set(k, [c]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, rows]) => ({ key, totals: totals(rows), models: modelSlices(rows) }));
}

export function modelRows(calls: ApiCallRow[]): ModelRow[] {
  const all = totals(calls);
  return byModel(calls)
    .map((g) => ({
      model: g.key,
      calls: g.totals.calls,
      costUsd: g.totals.costUsd,
      unpricedCalls: g.totals.unpricedCalls,
      input: g.totals.input,
      output: g.totals.output,
      cacheRead: g.totals.cacheRead,
      cacheWrite: g.totals.cacheCreate5m + g.totals.cacheCreate1h,
      thinking: g.totals.thinking,
      share: all.costUsd > 0 ? g.totals.costUsd / all.costUsd : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

function insightsFor(ctx: ProjectContext, data: UsageData): InsightsPayload {
  const db = getStorage(ctx);
  const input = loadInsightInput(db, ctx, {
    ...(data.scope === "session" ? { sessionId: data.sessionId } : {}),
    ...(data.since !== undefined ? { since: data.since } : {}),
    now: data.now,
  });
  const r = detectInsights(input);
  return { insights: r.insights, scores: r.scores };
}

const SEVERITY_RANK: Record<Insight["severity"], number> = { high: 0, warn: 1, info: 2 };
export function sortInsights(list: Insight[]): Insight[] {
  return list
    .slice()
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (b.estimatedSavingsUsd ?? 0) - (a.estimatedSavingsUsd ?? 0),
    );
}

export function summaryPayload(ctx: ProjectContext, data: UsageData): SummaryPayload {
  const { calls, now } = data;
  const today = dayKey(now);
  const blocks = billingBlocks(calls, now);
  const ins = insightsFor(ctx, data);
  return {
    scope: data.scope,
    sessionId: data.sessionId,
    since: data.since,
    now,
    totals: totals(calls),
    today: totals(calls.filter((c) => dayKey(c.ts) === today)),
    last7d: totals(calls.filter((c) => c.ts >= now - 7 * DAY)),
    last30d: totals(calls.filter((c) => c.ts >= now - 30 * DAY)),
    cache: cacheStats(calls),
    models: modelRows(calls),
    burn: burnRate(calls, now),
    block: activeBlock(blocks, now) ?? null,
    insights: sortInsights(ins.insights).slice(0, 3),
    scores: ins.scores,
    savings: savingsFor(ctx, data),
    snapshot: data.snapshot ?? null,
  };
}

/** eminiar's savings over the stat rows, windowed to sessions active since `data.since`. */
function savingsFor(ctx: ProjectContext, data: UsageData): PricedSavings {
  return pricedSavings(data.stats, data.calls, ctx.config.usage.pricing, { since: data.since });
}

export function sessionsPayload(
  ctx: ProjectContext,
  data: UsageData,
  limit: number,
): SessionsPayload {
  const db = getStorage(ctx);
  const span = new Map<string, { first: number; last: number; branch: string | null }>();
  for (const c of data.calls) {
    const s = span.get(c.session_id);
    if (!s) span.set(c.session_id, { first: c.ts, last: c.ts, branch: c.git_branch });
    else {
      s.first = Math.min(s.first, c.ts);
      if (c.ts >= s.last) {
        s.last = c.ts;
        s.branch = c.git_branch ?? s.branch;
      }
    }
  }
  const rows = bySession(data.calls)
    .map((g) => {
      const s = span.get(g.key);
      const row = db.sessionGet(g.key);
      return {
        session: g.key,
        startedAt: row?.started_at ?? null,
        firstCall: s?.first ?? 0,
        lastCall: s?.last ?? 0,
        branch: s?.branch ?? null,
        lastPrompt: row?.last_prompt ?? null,
        totals: g.totals,
      };
    })
    .sort((a, b) => b.lastCall - a.lastCall);
  return { rows: rows.slice(0, limit) };
}

export function turnsPayload(ctx: ProjectContext, data: UsageData, limit: number): TurnsPayload {
  const db = getStorage(ctx);
  const sessionId = data.sessionId;
  const calls =
    data.scope === "session" ? data.calls : data.calls.filter((c) => c.session_id === sessionId);
  const events = data.scope === "session" ? data.contextEvents : db.contextEvents({ sessionId });
  const timeline = contextTimeline(calls, events);
  return {
    sessionId,
    timeline: timeline.length > limit ? timeline.slice(-limit) : timeline,
    compactions: events.length,
    totals: totals(calls),
  };
}

/**
 * The aggregate object behind one view (JSON-safe). `limit` is clamped to 1..LIMIT_MAX here
 * as the last line of defence; callers validate and report bad values before this.
 */
export function usageView(
  ctx: ProjectContext,
  view: UsageView,
  data: UsageData,
  limitArg: number = LIMIT_DEFAULT,
): UsagePayload {
  const { calls, now } = data;
  const limit = clampLimit(limitArg);
  switch (view) {
    case "summary":
      return summaryPayload(ctx, data);
    case "daily":
      return { rows: periods(calls, (ts) => dayKey(ts)), totals: totals(calls) };
    case "weekly":
      return { rows: periods(calls, (ts) => weekKey(ts)), totals: totals(calls) };
    case "monthly":
      return { rows: periods(calls, (ts) => monthKey(ts)), totals: totals(calls) };
    case "models":
      return {
        rows: modelRows(calls),
        byEffort: byEffort(calls),
        bySpeed: bySpeed(calls),
        agents: byAgent(calls),
      };
    case "sessions":
      return sessionsPayload(ctx, data, limit);
    case "blocks": {
      const blocks = billingBlocks(calls, now).reverse();
      return { rows: blocks.slice(0, limit), burn: burnRate(calls, now) };
    }
    case "turns":
      return turnsPayload(ctx, data, limit);
    case "tools": {
      const rows = topToolConsumers(data.toolUses, limit);
      return {
        rows,
        totalChars: data.toolUses.reduce((n, u) => n + (u.result_chars ?? 0), 0),
      };
    }
    case "insights": {
      const r = insightsFor(ctx, data);
      return { insights: sortInsights(r.insights), scores: r.scores };
    }
    case "savings":
      return savingsFor(ctx, data);
  }
}

// --- rendering -----------------------------------------------------------------------

type Align = "l" | "r";

/** Fixed-width text table in the style of formatStats (two-space indent, padded columns). */
export function textTable(headers: string[], rows: string[][], aligns?: Align[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    `  ${cells
      .map((c, i) => {
        const w = widths[i] ?? c.length;
        return (aligns?.[i] ?? (i === 0 ? "l" : "r")) === "l" ? c.padEnd(w) : c.padStart(w);
      })
      .join("  ")
      .trimEnd()}`;
  return [line(headers), ...rows.map(line)].join("\n");
}

const usd = (n: number) => formatUsd(n);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const shortId = (id: string) => id.slice(0, 8);
/** Times in the text views are UTC (the ISO form), and every column that shows one says so. */
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 19);
const dateTime = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
/** `claude-sonnet-4-5-20250929[1m]` → `sonnet-4-5[1m]`. */
export const shortModel = (m: string): string =>
  m.replace(/^claude-/, "").replace(/-\d{8}(\[1m\])?$/, "$1");
/** "<1h" under an hour, otherwise h:mm. */
export function fmtGap(ms: number): string {
  if (!(ms >= 36e5)) return "<1h";
  const h = Math.floor(ms / 36e5);
  const m = Math.floor((ms % 36e5) / 6e4);
  return `${h}:${String(m).padStart(2, "0")}`;
}
const burnLine = (b: BurnRate): string =>
  b.reliable
    ? `${usd(b.usdPerHour)}/h · ${fmtTokens(Math.round(b.tokensPerMin))} tok/min · projected ${usd(b.projectedBlockUsd ?? 0)}`
    : `burn n/a (needs ${BURN_MIN_CALLS}+ calls over ${BURN_MIN_MINUTES}+ min)`;
const EST_NOTE = "est. at list price";

function totalsLine(t: UsageTotals): string {
  const unpriced = t.unpricedCalls ? ` · ${t.unpricedCalls} unpriced` : "";
  return `${t.calls} calls · ${usd(t.costUsd)}${unpriced} · in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache read ${fmtTokens(t.cacheRead)} · cache write ${fmtTokens(t.cacheCreate5m + t.cacheCreate1h)} · ${pct(t.cacheHitRate)} cache hits`;
}

function scopeTitle(p: {
  scope: UsageScope;
  sessionId: string;
  since: number | undefined;
}): string {
  const s = p.scope === "session" ? `session ${shortId(p.sessionId)}` : "project";
  return p.since ? `${s} since ${dateTime(p.since)} UTC` : s;
}

export function renderSummary(p: SummaryPayload): string {
  const out: string[] = [`usage (${scopeTitle(p)}, ${EST_NOTE}): ${totalsLine(p.totals)}`];
  out.push(
    `  cost: today ${usd(p.today.costUsd)} (${p.today.calls} calls) · 7d ${usd(p.last7d.costUsd)} · 30d ${usd(p.last30d.costUsd)}`,
  );
  out.push(
    `  cache: ${pct(p.cache.hitRate)} hit rate · ${fmtTokens(p.cache.cacheReads)} read · ${fmtTokens(p.cache.cacheWrites)} written · ${p.cache.coldCalls} cold call(s)${p.cache.share1h > 0 ? ` · ${pct(p.cache.share1h)} 1h writes` : ""}`,
  );
  if (p.models.length)
    out.push(
      `  models: ${p.models
        .map(
          (m) =>
            `${shortModel(m.model)} ${m.calls} calls ${usd(m.costUsd)}${m.unpricedCalls ? ` (${m.unpricedCalls} unpriced)` : ""}`,
        )
        .join(" · ")}`,
    );
  if (p.block)
    out.push(
      `  active block: started ${hhmm(p.block.start)} UTC · ${p.block.calls} calls · ${usd(p.block.costUsd)} · ${burnLine(p.burn)}`,
    );
  else out.push("  active block: none (no calls in the current 5-hour window)");
  if (p.snapshot && (p.snapshot.five_hour_pct != null || p.snapshot.seven_day_pct != null)) {
    // Only the windows the statusline reported; Claude Code omits 7d on some plans.
    const plan = [
      p.snapshot.five_hour_pct != null ? `5h ${p.snapshot.five_hour_pct}%` : "",
      p.snapshot.seven_day_pct != null ? `7d ${p.snapshot.seven_day_pct}%` : "",
      p.snapshot.ctx_used_pct != null ? `ctx ${p.snapshot.ctx_used_pct}%` : "",
    ].filter(Boolean);
    out.push(`  plan: ${plan.join(" · ")}`);
  }
  if (p.insights.length) {
    out.push("  insights:");
    for (const i of p.insights) out.push(`    [${i.severity}] ${i.title}: ${i.reason}`);
  } else out.push("  insights: none");
  out.push(
    `  eminiar savings: ${fmtTokens(p.savings.savedTokens)} tokens kept out of context ≈ ${usd(p.savings.directUsd)} direct + ${usd(p.savings.compoundingUsd)} compounding (see em_usage view:"savings")`,
  );
  if (p.totals.unpricedCalls)
    out.push(
      `  note: ${p.totals.unpricedCalls} call(s) use a model without a bundled price; add config.usage.pricing to price them`,
    );
  return out.join("\n");
}

export function renderPeriods(label: string, p: PeriodsPayload): string {
  if (!p.rows.length) return `${label}: no API calls recorded`;
  const rows = p.rows.map((r) => [
    r.key,
    String(r.totals.calls),
    usd(r.totals.costUsd),
    fmtTokens(r.totals.input),
    fmtTokens(r.totals.output),
    fmtTokens(r.totals.cacheRead),
    fmtTokens(r.totals.cacheCreate5m + r.totals.cacheCreate1h),
    pct(r.totals.cacheHitRate),
    r.models.map((m) => `${shortModel(m.model)} ${usd(m.costUsd)}`).join(", ") +
      (r.totals.unpricedCalls ? ` (${r.totals.unpricedCalls} unpriced)` : ""),
  ]);
  return `${label}: ${totalsLine(p.totals)}\n${textTable(
    ["period", "calls", "cost", "in", "out", "cache rd", "cache wr", "hits", "models"],
    rows,
    ["l", "r", "r", "r", "r", "r", "r", "r", "l"],
  )}\n  periods are local calendar days; cost ${EST_NOTE}`;
}

export function renderModels(p: ModelsPayload): string {
  if (!p.rows.length) return "models: no API calls recorded";
  const out = [
    "models:",
    textTable(
      ["model", "calls", "cost", "share", "in", "out", "cache rd", "cache wr", "thinking"],
      p.rows.map((m) => [
        shortModel(m.model) + (m.unpricedCalls ? " (unpriced)" : ""),
        String(m.calls),
        usd(m.costUsd),
        pct(m.share),
        fmtTokens(m.input),
        fmtTokens(m.output),
        fmtTokens(m.cacheRead),
        fmtTokens(m.cacheWrite),
        fmtTokens(m.thinking),
      ]),
    ),
  ];
  const line = (title: string, groups: Group[]) =>
    `  ${title}: ${groups.map((g) => `${g.key} ${g.totals.calls} calls ${usd(g.totals.costUsd)}`).join(" · ")}`;
  if (p.byEffort.length > 1) out.push(line("effort", p.byEffort));
  if (p.bySpeed.some((g) => g.key === "fast")) out.push(line("speed", p.bySpeed));
  if (p.agents.subagents.length)
    out.push(
      `  subagents: ${p.agents.subagents.length} · ${usd(p.agents.subagents.reduce((s, a) => s + a.totals.costUsd, 0))} (${pct(p.agents.delegationShare)} of cost)`,
    );
  out.push(`  cost ${EST_NOTE}`);
  return out.join("\n");
}

export function renderSessions(p: SessionsPayload): string {
  if (!p.rows.length) return "sessions: no API calls recorded";
  return `sessions:\n${textTable(
    ["session", "last call (UTC)", "branch", "calls", "cost", "in", "out", "hits", "prompt"],
    p.rows.map((s) => [
      shortId(s.session),
      dateTime(s.lastCall),
      s.branch ?? "",
      String(s.totals.calls),
      usd(s.totals.costUsd),
      fmtTokens(s.totals.input),
      fmtTokens(s.totals.output),
      pct(s.totals.cacheHitRate),
      (s.lastPrompt ?? "").replace(/\s+/g, " ").slice(0, 50),
    ]),
    ["l", "l", "l", "r", "r", "r", "r", "r", "l"],
  )}`;
}

export function renderBlocks(p: BlocksPayload): string {
  if (!p.rows.length) return "blocks: no API calls recorded";
  const rows = p.rows.map((b) => [
    `${dateTime(b.start)}${b.active ? " *" : ""}`,
    `${hhmm(b.firstCall)}–${hhmm(b.lastCall)}`,
    String(b.calls),
    usd(b.costUsd),
    fmtTokens(b.tokens.input + b.tokens.output + b.tokens.cacheCreate + b.tokens.cacheRead),
    b.gapBefore != null ? fmtGap(b.gapBefore) : "",
    b.models.map(shortModel).join(", ") + (b.unpricedCalls ? ` (${b.unpricedCalls} unpriced)` : ""),
  ]);
  const out = [
    "5-hour billing blocks (times in UTC, * = active):",
    textTable(["block (UTC)", "calls at (UTC)", "calls", "cost", "tokens", "gap", "models"], rows, [
      "l",
      "l",
      "r",
      "r",
      "r",
      "r",
      "l",
    ]),
  ];
  if (p.rows.some((b) => b.active))
    out.push(
      p.burn.reliable
        ? `  burn: ${usd(p.burn.usdPerHour)}/h · ${fmtTokens(Math.round(p.burn.tokensPerMin))} tok/min over ${Math.round(p.burn.windowMinutes)} min · projected ${usd(p.burn.projectedBlockUsd ?? 0)} for the block`
        : `  ${burnLine(p.burn)}`,
    );
  return out.join("\n");
}

export function renderTurns(p: TurnsPayload): string {
  if (!p.timeline.length) return `turns (session ${shortId(p.sessionId)}): no API calls recorded`;
  const rows = p.timeline.map((t) => [
    hhmm(t.ts),
    shortModel(t.model),
    fmtTokens(t.contextTokens),
    fmtTokens(t.output),
    usd(t.costUsd),
    t.compactBefore ? "compacted before this call" : "",
  ]);
  const shown = p.timeline.length;
  const count =
    shown < p.totals.calls ? `last ${shown} of ${p.totals.calls} calls` : `${shown} calls`;
  return `turns (session ${shortId(p.sessionId)}): ${count} · ${p.compactions} compaction(s) · ${usd(p.totals.costUsd)}\n${textTable(
    ["time (UTC)", "model", "context", "output", "cost", ""],
    rows,
    ["l", "l", "r", "r", "r", "l"],
  )}`;
}

export function renderTools(p: ToolsPayload): string {
  if (!p.rows.length) return "tools: no tool results recorded";
  return `tool results in context (${fmtTokens(Math.ceil(p.totalChars / 4))} est. tokens total):\n${textTable(
    ["tool", "calls", "chars", "est tokens", "avg chars", "errors"],
    p.rows.map((r) => [
      r.tool,
      String(r.calls),
      fmtTokens(r.chars),
      fmtTokens(r.estTokens),
      fmtTokens(r.avgChars),
      String(r.errors),
    ]),
  )}`;
}

export function renderInsights(p: InsightsPayload): string {
  const out: string[] = [];
  if (p.insights.length) {
    out.push(`insights (${p.insights.length}):`);
    for (const i of p.insights) {
      out.push(`  [${i.severity}] ${i.title} (${i.id}, ${i.scope})`);
      out.push(`    ${i.reason}`);
      if (i.recommendation) out.push(`    → ${i.recommendation}`);
      if (i.estimatedSavingsUsd) out.push(`    est. savings ${usd(i.estimatedSavingsUsd)}`);
    }
  } else out.push("insights: nothing to flag");
  if (p.scores.length) {
    out.push("scores (0–100, higher is better):");
    for (const s of p.scores) {
      out.push(`  ${s.id.padEnd(16)} ${String(Math.round(s.value)).padStart(3)}`);
      for (const r of s.reasons) out.push(`    - ${r}`);
    }
  }
  return out.join("\n");
}

export function renderSavings(p: SavingsPayload): string {
  const out = [
    `eminiar savings: ${fmtTokens(p.savedTokens)} tokens kept out of context`,
    `  direct      ${usd(p.directUsd)}  (never written to cache: cache-write price of ${shortModel(p.model)})`,
    `  compounding ${usd(p.compoundingUsd)}  (never re-read on later turns: cache-read price × ${p.laterCallsPerSession.toFixed(1)} later calls per session)`,
    "  assumptions:",
    ...p.assumptions.map((a) => `    - ${a}`),
  ];
  return out.join("\n");
}

export function renderUsage(view: UsageView, payload: UsagePayload): string {
  switch (view) {
    case "summary":
      return renderSummary(payload as SummaryPayload);
    case "daily":
      return renderPeriods("daily", payload as PeriodsPayload);
    case "weekly":
      return renderPeriods("weekly (Monday)", payload as PeriodsPayload);
    case "monthly":
      return renderPeriods("monthly", payload as PeriodsPayload);
    case "models":
      return renderModels(payload as ModelsPayload);
    case "sessions":
      return renderSessions(payload as SessionsPayload);
    case "blocks":
      return renderBlocks(payload as BlocksPayload);
    case "turns":
      return renderTurns(payload as TurnsPayload);
    case "tools":
      return renderTools(payload as ToolsPayload);
    case "insights":
      return renderInsights(payload as InsightsPayload);
    case "savings":
      return renderSavings(payload as SavingsPayload);
  }
}

// --- csv -----------------------------------------------------------------------------

export const CSV_VIEWS: ReadonlySet<UsageView> = new Set([
  "daily",
  "weekly",
  "monthly",
  "models",
  "sessions",
  "blocks",
]);

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const T_COLS = [
  "calls",
  "cost_usd",
  "unpriced",
  "input",
  "output",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "thinking",
  "cache_hit_rate",
];
const tCells = (t: UsageTotals) => [
  t.calls,
  t.costUsd.toFixed(6),
  t.unpricedCalls,
  t.input,
  t.output,
  t.cacheRead,
  t.cacheCreate5m,
  t.cacheCreate1h,
  t.thinking,
  t.cacheHitRate.toFixed(4),
];

/** Header row plus one row per aggregate; undefined for views without a tabular shape. */
export function usageCsv(view: UsageView, payload: UsagePayload): string | undefined {
  let header: string[];
  let rows: unknown[][];
  switch (view) {
    case "daily":
    case "weekly":
    case "monthly":
      header = ["period", ...T_COLS, "models"];
      rows = (payload as PeriodsPayload).rows.map((r) => [
        r.key,
        ...tCells(r.totals),
        r.models.map((m) => `${m.model}=${m.costUsd.toFixed(6)}`).join(";"),
      ]);
      break;
    case "models":
      header = [
        "model",
        "calls",
        "cost_usd",
        "share",
        "unpriced",
        "input",
        "output",
        "cache_read",
        "cache_write",
        "thinking",
      ];
      rows = (payload as ModelsPayload).rows.map((m) => [
        m.model,
        m.calls,
        m.costUsd.toFixed(6),
        m.share.toFixed(4),
        m.unpricedCalls,
        m.input,
        m.output,
        m.cacheRead,
        m.cacheWrite,
        m.thinking,
      ]);
      break;
    case "sessions":
      header = ["session", "started_at", "first_call", "last_call", "branch", ...T_COLS];
      rows = (payload as SessionsPayload).rows.map((s) => [
        s.session,
        s.startedAt ? new Date(s.startedAt).toISOString() : "",
        new Date(s.firstCall).toISOString(),
        new Date(s.lastCall).toISOString(),
        s.branch ?? "",
        ...tCells(s.totals),
      ]);
      break;
    case "blocks":
      header = [
        "block_start",
        "block_end",
        "first_call",
        "last_call",
        "active",
        "calls",
        "cost_usd",
        "unpriced",
        "input",
        "output",
        "cache_write",
        "cache_read",
        "gap_before_ms",
        "models",
      ];
      rows = (payload as BlocksPayload).rows.map((b) => [
        b.id,
        new Date(b.end).toISOString(),
        new Date(b.firstCall).toISOString(),
        new Date(b.lastCall).toISOString(),
        b.active ? 1 : 0,
        b.calls,
        b.costUsd.toFixed(6),
        b.unpricedCalls,
        b.tokens.input,
        b.tokens.output,
        b.tokens.cacheCreate,
        b.tokens.cacheRead,
        b.gapBefore ?? "",
        b.models.join(";"),
      ]);
      break;
    default:
      return undefined;
  }
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

// --- the tool ------------------------------------------------------------------------

export const emUsage = defineTool({
  name: "em_usage",
  description:
    "Token, cache and cost insights for Claude Code sessions, from the transcripts on this machine: cost today / 7d / 30d, cache hit rate, per-model and per-session breakdowns, 5-hour billing blocks with burn rate, the context timeline of a session with compactions, which tools put the most into context, detected insights with scores, and what eminiar's own tools saved. Cost is an estimate at list prices; everything stays local.",
  schema: {
    scope: z.enum(["session", "project"]).optional().describe("default project"),
    view: z.enum(USAGE_VIEWS).optional().describe("default summary"),
    since: z
      .string()
      .optional()
      .describe("ISO date/time or relative: 30d, 12h, 2w (default: everything)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(LIMIT_MAX)
      .optional()
      .describe(`rows for list views (${LIMIT_DEFAULT})`),
    json: z.boolean().optional().describe("return the aggregate object instead of text"),
  },
  handler: async (args, ctx) => {
    if (!usageEnabled(ctx))
      return text("usage insights are off (config.usage.enabled = false); nothing is ingested");
    const view: UsageView = args.view ?? "summary";
    let since: number | undefined;
    try {
      since = parseSince(args.since);
    } catch (err) {
      return errorResult((err as Error).message);
    }
    const limit = parseLimit(args.limit);
    if (typeof limit === "string") return errorResult(limit);
    const data = loadUsage(ctx, { scope: args.scope ?? "project", since });
    const payload = usageView(ctx, view, data, limit ?? LIMIT_DEFAULT);
    if (args.json) return text(JSON.stringify({ view, scope: data.scope, ...payload }));
    return text(renderUsage(view, payload));
  },
});
