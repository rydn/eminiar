/**
 * Usage insights: detectors over the usage rows (model calls, tool results,
 * compactions, eminiar's own stats, hook events, statusline snapshots) and four
 * 0..100 scores. Every insight carries the numbers that triggered it and every
 * score lists the reasons behind its value; nothing is a bare grade.
 *
 * Thresholds are documented next to each detector; `detectInsights` is pure so
 * the tool, dashboard and hooks can share it, and `loadInsightInput` gathers its
 * input from the storage adapter.
 */

import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type {
  ApiCallRow,
  ContextEventRow,
  EventRow,
  StatRow,
  StatuslineSnapshotRow,
  ToolUseRow,
} from "../storage/types.js";
import { byAgent, dayKey, isRealCall, totals } from "./aggregate.js";
import {
  costOfCall,
  estTokensFromChars,
  type ModelPrice,
  type PricingOverrides,
  resolvePrice,
} from "./pricing.js";
import { FALLBACK_MODEL } from "./savings.js";

export type InsightSeverity = "info" | "warn" | "high";

export interface Insight {
  /** Stable slug, e.g. "cache-thrash", "context-bloat", "opus-for-trivial". */
  id: string;
  severity: InsightSeverity;
  /** Short, human. */
  title: string;
  /** One sentence with the numbers that triggered it. */
  reason: string;
  evidence?: Record<string, number | string>;
  estimatedSavingsUsd?: number;
  recommendation?: string;
  scope: "session" | "project";
  sessionId?: string;
}

export type ScoreId = "context-health" | "cost-efficiency" | "cache-efficiency" | "delegation";

export interface Score {
  id: ScoreId;
  /** 0..100 */
  value: number;
  reasons: string[];
}

export interface InsightInput {
  calls: ApiCallRow[];
  toolUses: ToolUseRow[];
  contextEvents: ContextEventRow[];
  stats: StatRow[];
  events: EventRow[];
  snapshots: StatuslineSnapshotRow[];
  now?: number | undefined;
  budgets?: Config["usage"]["budgets"] | undefined;
  overrides?: Config["usage"]["pricing"] | undefined;
}

export interface InsightResult {
  insights: Insight[];
  scores: Score[];
}

// --- thresholds -------------------------------------------------------------------------

/** cache-thrash: cache writes ≥ this share of the call's context … */
const THRASH_WRITE_SHARE = 0.2;
/** … on at least this many consecutive calls with no compaction between them. */
const THRASH_RUN = 3;
/** cache-cold: default prompt-cache TTL; 60 min when 1h writes dominate the thread. */
const TTL_5M_MS = 5 * 60_000;
const TTL_1H_MS = 60 * 60_000;
/** cache-cold: the call after the gap writes at least this share of its context. */
const COLD_WRITE_SHARE = 0.5;
/** context-bloat: a single Read/Bash/Grep/WebFetch result above this many estimated tokens. */
const BLOAT_TOKENS = 8_000;
const BLOAT_TOOLS = new Set(["Read", "Bash", "Grep", "WebFetch", "Glob"]);
/** compaction-churn: this many compactions in one session … */
const CHURN_COMPACTIONS = 3;
/** … or any compaction while context was below this share of the window. */
const CHURN_EARLY_SHARE = 0.5;
/** Window assumed when no statusline snapshot reports ctx_size. */
const DEFAULT_WINDOW = 200_000;
/** opus-for-trivial: premium calls with fewer output tokens than this and no tool_use … */
const TRIVIAL_OUTPUT = 100;
/** … making up more than this share of premium calls (needs at least MIN_PREMIUM_CALLS). */
const TRIVIAL_SHARE = 0.3;
const MIN_PREMIUM_CALLS = 5;
/** fast-mode-share: fast-mode calls above this share of priced cost. */
const FAST_COST_SHARE = 0.25;
/** thinking-share: thinking tokens above this share of output tokens (≥ MIN_OUTPUT_FOR_THINKING output). */
const THINKING_SHARE = 0.4;
const MIN_OUTPUT_FOR_THINKING = 1_000;
/** subagent-cost: subagents above this share of cost. */
const DELEGATION_SHARE = 0.6;
/** expensive-turn: one call above budgets.turnUsd, or this when unset. */
const DEFAULT_TURN_USD = 1;
/** error-loop: this many consecutive failed uses of the same tool. */
const ERROR_RUN = 3;
/** context-near-limit: latest snapshot ctx_used_pct at or above this (high at NEAR_LIMIT_HIGH). */
const NEAR_LIMIT_PCT = 85;
const NEAR_LIMIT_HIGH = 95;

// --- helpers ----------------------------------------------------------------------------

const num = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) ? n : 0;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const usd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const fmtK = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

const contextOf = (c: ApiCallRow): number =>
  num(c.input_tokens) + num(c.cache_create_5m) + num(c.cache_create_1h) + num(c.cache_read);
const writesOf = (c: ApiCallRow): number => num(c.cache_create_5m) + num(c.cache_create_1h);
const costOf = (c: ApiCallRow): number =>
  c.priced && c.cost_usd != null && Number.isFinite(c.cost_usd) ? c.cost_usd : 0;
const isPremium = (model: string): boolean => /opus|fable|mythos/i.test(model);

/** Calls split into conversation threads (main thread or one subagent) and sorted by time. */
function threads(calls: ApiCallRow[]): Map<string, ApiCallRow[]> {
  const out = new Map<string, ApiCallRow[]>();
  for (const c of calls) {
    const key = `${c.session_id}\u0000${c.sidechain ? (c.agent_id ?? "sidechain") : ""}`;
    const list = out.get(key);
    if (list) list.push(c);
    else out.set(key, [c]);
  }
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
  return out;
}

function groupBySession<T extends { session_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.session_id);
    if (list) list.push(r);
    else out.set(r.session_id, [r]);
  }
  return out;
}

function dominantModel(calls: ApiCallRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [m, k] of counts)
    if (k > n) {
      best = m;
      n = k;
    }
  return best;
}

/** The cache-write price per token that applies to a call (1h rate when 1h writes dominate). */
function writePrice(c: ApiCallRow, p: ModelPrice): number {
  return num(c.cache_create_1h) > num(c.cache_create_5m) ? p.cacheWrite1h : p.cacheWrite5m;
}

interface Scope {
  scope: "session" | "project";
  sessionId?: string;
}

function scopeFor(sessionIds: Iterable<string>): Scope {
  const ids = [...new Set(sessionIds)];
  return ids.length === 1
    ? { scope: "session", sessionId: ids[0] as string }
    : { scope: "project" };
}

function withScope(
  base: Omit<Insight, "scope" | "sessionId">,
  sessionIds: Iterable<string>,
): Insight {
  const s = scopeFor(sessionIds);
  const out: Insight = { ...base, scope: s.scope };
  if (s.sessionId) out.sessionId = s.sessionId;
  return out;
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { high: 0, warn: 1, info: 2 };

// --- detectors --------------------------------------------------------------------------

interface Ctx {
  calls: ApiCallRow[];
  threads: Map<string, ApiCallRow[]>;
  toolUses: ToolUseRow[];
  contextEvents: ContextEventRow[];
  stats: StatRow[];
  events: EventRow[];
  snapshots: StatuslineSnapshotRow[];
  now: number;
  budgets: NonNullable<InsightInput["budgets"]>;
  overrides: PricingOverrides | undefined;
  priceOf: (model: string) => ModelPrice | undefined;
  /** Compaction timestamps per session, sorted. */
  compactionsBySession: Map<string, number[]>;
  /** Count of API calls in a session after a timestamp (for compounding cost). */
  laterCalls: (sessionId: string, ts: number) => number;
}

function hasCompactionBetween(ctx: Ctx, sessionId: string, from: number, to: number): boolean {
  const list = ctx.compactionsBySession.get(sessionId);
  if (!list) return false;
  return list.some((t) => t > from && t <= to);
}

/**
 * cache-thrash: a run of ≥ THRASH_RUN consecutive calls in one thread whose cache
 * writes are ≥ THRASH_WRITE_SHARE of the context, with no compaction inside the run
 * and no cold gap (those are cache-cold). The first call of a thread is exempt.
 */
function detectCacheThrash(ctx: Ctx): Insight | undefined {
  let runs = 0;
  let longest = 0;
  let rewritten = 0;
  let savings = 0;
  const sessions = new Set<string>();
  for (const list of ctx.threads.values()) {
    let run: ApiCallRow[] = [];
    const flush = () => {
      if (run.length >= THRASH_RUN) {
        runs += 1;
        longest = Math.max(longest, run.length);
        for (const c of run) {
          const w = writesOf(c);
          rewritten += w;
          sessions.add(c.session_id);
          const p = ctx.priceOf(c.model);
          if (p) savings += (w * (writePrice(c, p) - p.cacheRead)) / 1_000_000;
        }
      }
      run = [];
    };
    for (let i = 1; i < list.length; i++) {
      const c = list[i] as ApiCallRow;
      const prev = list[i - 1] as ApiCallRow;
      const ctxTokens = contextOf(c);
      const heavy = ctxTokens > 0 && writesOf(c) / ctxTokens >= THRASH_WRITE_SHARE;
      const broken =
        hasCompactionBetween(ctx, c.session_id, prev.ts, c.ts) || c.ts - prev.ts > ttlFor(list);
      if (!heavy || broken) {
        flush();
        continue;
      }
      run.push(c);
    }
    flush();
  }
  if (runs === 0) return undefined;
  return withScope(
    {
      id: "cache-thrash",
      severity: runs >= 3 || rewritten >= 500_000 ? "high" : "warn",
      title: "Prompt cache keeps being rewritten",
      reason: `${runs} run${runs === 1 ? "" : "s"} of ${THRASH_RUN}+ consecutive calls rewrote ≥ ${pct(THRASH_WRITE_SHARE)} of their context (longest run ${longest} calls, ${fmtK(rewritten)} tokens written again).`,
      evidence: { runs, longestRun: longest, tokensRewritten: rewritten },
      estimatedSavingsUsd: round4(savings),
      recommendation:
        "Something early in the prompt changes every turn (system prompt, tool list, a file re-read with a timestamp); keep the stable prefix stable so later calls hit the cache.",
    },
    sessions,
  );
}

/** TTL assumed for a thread: 60 min when its 1h cache writes exceed its 5m writes. */
function ttlFor(list: ApiCallRow[]): number {
  let w5 = 0;
  let w1 = 0;
  for (const c of list) {
    w5 += num(c.cache_create_5m);
    w1 += num(c.cache_create_1h);
  }
  return w1 > w5 ? TTL_1H_MS : TTL_5M_MS;
}

/**
 * cache-cold: a gap between consecutive calls of a thread longer than the cache TTL
 * (5 min, or 60 min when 1h writes dominate) followed by a call that writes
 * ≥ COLD_WRITE_SHARE of its context to cache. Savings: those writes at the cache-read
 * rate instead of the cache-write rate.
 */
function detectCacheCold(ctx: Ctx): Insight | undefined {
  let restarts = 0;
  let rewritten = 0;
  let savings = 0;
  let longestGap = 0;
  const sessions = new Set<string>();
  for (const list of ctx.threads.values()) {
    const ttl = ttlFor(list);
    for (let i = 1; i < list.length; i++) {
      const c = list[i] as ApiCallRow;
      const prev = list[i - 1] as ApiCallRow;
      const gap = c.ts - prev.ts;
      if (gap <= ttl) continue;
      if (hasCompactionBetween(ctx, c.session_id, prev.ts, c.ts)) continue;
      const ctxTokens = contextOf(c);
      const w = writesOf(c);
      if (ctxTokens === 0 || w / ctxTokens < COLD_WRITE_SHARE) continue;
      restarts += 1;
      rewritten += w;
      longestGap = Math.max(longestGap, gap);
      sessions.add(c.session_id);
      const p = ctx.priceOf(c.model);
      if (p) savings += (w * (writePrice(c, p) - p.cacheRead)) / 1_000_000;
    }
  }
  if (restarts === 0) return undefined;
  const minutes = Math.round(longestGap / 60_000);
  return withScope(
    {
      id: "cache-cold",
      severity: restarts >= 2 ? "warn" : "info",
      title: `Cache went cold ${restarts === 1 ? "once" : `${restarts} times`}`,
      reason: `${restarts} pause${restarts === 1 ? "" : "s"} longer than the cache TTL (longest ${minutes} min) forced ${fmtK(rewritten)} tokens to be written to cache again (~${usd(savings)}).`,
      evidence: { restarts, tokensRewritten: rewritten, longestGapMinutes: minutes },
      estimatedSavingsUsd: round4(savings),
      recommendation:
        "Long pauses mid-session re-pay the cache write; for walk-away breaks start a new session, or keep the turn cadence inside the TTL.",
    },
    sessions,
  );
}

/**
 * context-bloat: Read/Bash/Grep/WebFetch/Glob results above BLOAT_TOKENS estimated
 * tokens (chars / 4) that em_execute / em_execute_file / em_search would have kept out
 * of context. Savings follow savings.ts: the oversized tokens at the 5m cache-write
 * rate once, plus at the cache-read rate for every later call of the session.
 */
function detectContextBloat(ctx: Ctx): Insight | undefined {
  const bySession = groupBySession(ctx.calls);
  const modelFor = new Map<string, string | undefined>();
  for (const [sid, rows] of bySession) modelFor.set(sid, dominantModel(rows));
  let count = 0;
  let tokens = 0;
  let savings = 0;
  const byTool = new Map<string, number>();
  const sessions = new Set<string>();
  for (const u of ctx.toolUses) {
    if (!BLOAT_TOOLS.has(u.tool)) continue;
    const est = estTokensFromChars(num(u.result_chars));
    if (est <= BLOAT_TOKENS) continue;
    count += 1;
    tokens += est;
    byTool.set(u.tool, (byTool.get(u.tool) ?? 0) + 1);
    sessions.add(u.session_id);
    const p =
      ctx.priceOf(modelFor.get(u.session_id) ?? FALLBACK_MODEL) ?? ctx.priceOf(FALLBACK_MODEL);
    if (p) {
      const later = ctx.laterCalls(u.session_id, u.ts);
      savings += (est * p.cacheWrite5m + est * p.cacheRead * later) / 1_000_000;
    }
  }
  if (count === 0) return undefined;
  const top = [...byTool.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
  return withScope(
    {
      id: "context-bloat",
      severity: count >= 5 || tokens >= 100_000 ? "high" : "warn",
      title: "Oversized tool results in context",
      reason: `${count} ${[...byTool.keys()].join("/")} result${count === 1 ? "" : "s"} above ${fmtK(BLOAT_TOKENS)} tokens put ~${fmtK(tokens)} tokens into context (mostly ${top[0]}, ${top[1]}×), re-read on every later call.`,
      evidence: { results: count, estTokens: tokens, topTool: top[0], topToolCount: top[1] },
      estimatedSavingsUsd: round4(savings),
      recommendation:
        "Route large outputs through em_execute / em_execute_file / em_search so only the matching sections come back.",
    },
    sessions,
  );
}

/**
 * compaction-churn: ≥ CHURN_COMPACTIONS compactions in one session, or a compaction
 * whose pre_tokens were below CHURN_EARLY_SHARE of the context window (the latest
 * snapshot's ctx_size for that session, else DEFAULT_WINDOW).
 */
function detectCompactionChurn(ctx: Ctx): Insight | undefined {
  const windowFor = new Map<string, number>();
  for (const s of ctx.snapshots) {
    if (num(s.ctx_size) > 0) {
      const prev = windowFor.get(s.session_id);
      if (prev === undefined) windowFor.set(s.session_id, num(s.ctx_size));
    }
  }
  let worstSession: string | undefined;
  let worstCount = 0;
  let early = 0;
  const sessions = new Set<string>();
  for (const [sid, evs] of groupBySession(ctx.contextEvents)) {
    const compactions = evs.filter((e) => e.kind === "compact");
    const window = windowFor.get(sid) ?? DEFAULT_WINDOW;
    const earlyHere = compactions.filter(
      (e) => e.pre_tokens != null && e.pre_tokens > 0 && e.pre_tokens < window * CHURN_EARLY_SHARE,
    ).length;
    if (compactions.length >= CHURN_COMPACTIONS || earlyHere > 0) {
      sessions.add(sid);
      early += earlyHere;
      if (compactions.length > worstCount) {
        worstCount = compactions.length;
        worstSession = sid;
      }
    }
  }
  if (sessions.size === 0) return undefined;
  return withScope(
    {
      id: "compaction-churn",
      severity: worstCount >= CHURN_COMPACTIONS * 2 ? "high" : "warn",
      title: "Frequent context compactions",
      reason: `${sessions.size} session${sessions.size === 1 ? "" : "s"} compacted repeatedly (up to ${worstCount} times in ${(worstSession ?? "").slice(0, 8)}; ${early} below ${pct(CHURN_EARLY_SHARE)} of the window).`,
      evidence: { sessions: sessions.size, maxCompactions: worstCount, earlyCompactions: early },
      recommendation:
        "Each compaction rewrites the whole cache and loses detail; keep raw output out of context (em_* tools) and split long tasks into sessions.",
    },
    sessions,
  );
}

/**
 * opus-for-trivial: premium (Opus / Fable) calls with < TRIVIAL_OUTPUT output tokens and
 * no tool_use, when they are > TRIVIAL_SHARE of at least MIN_PREMIUM_CALLS premium calls.
 * Savings: those calls repriced at Sonnet.
 */
function detectOpusForTrivial(ctx: Ctx): Insight | undefined {
  const toolRequests = new Set<string>();
  for (const u of ctx.toolUses) if (u.request_id) toolRequests.add(u.request_id);
  const premium = ctx.calls.filter((c) => isPremium(c.model));
  if (premium.length < MIN_PREMIUM_CALLS) return undefined;
  const trivial = premium.filter(
    (c) =>
      num(c.output_tokens) < TRIVIAL_OUTPUT &&
      c.stop_reason !== "tool_use" &&
      !toolRequests.has(c.request_id),
  );
  const share = trivial.length / premium.length;
  if (share <= TRIVIAL_SHARE) return undefined;
  const sonnet = resolvePrice(FALLBACK_MODEL, ctx.overrides);
  let spent = 0;
  let repriced = 0;
  for (const c of trivial) {
    spent += costOf(c);
    if (sonnet) repriced += costOfCall(c, sonnet).total;
  }
  const savings = Math.max(0, spent - repriced);
  return withScope(
    {
      id: "opus-for-trivial",
      severity: share >= 0.6 ? "warn" : "info",
      title: "Premium model on trivial turns",
      reason: `${trivial.length} of ${premium.length} premium-model calls (${pct(share)}) produced under ${TRIVIAL_OUTPUT} output tokens with no tool use, costing ${usd(spent)} (~${usd(repriced)} at Sonnet).`,
      evidence: {
        trivialCalls: trivial.length,
        premiumCalls: premium.length,
        share: Math.round(share * 100),
        spentUsd: round4(spent),
      },
      estimatedSavingsUsd: round4(savings),
      recommendation:
        "Short acknowledgements and lookups do not need the premium model; delegate routine turns to a Sonnet/Haiku subagent or switch model for simple work.",
    },
    trivial.map((c) => c.session_id),
  );
}

/** fast-mode-share: calls with speed == "fast" above FAST_COST_SHARE of priced cost. */
function detectFastModeShare(ctx: Ctx): Insight | undefined {
  let fast = 0;
  let fastCalls = 0;
  let total = 0;
  const sessions = new Set<string>();
  for (const c of ctx.calls) {
    const cost = costOf(c);
    total += cost;
    if (c.speed === "fast") {
      fast += cost;
      fastCalls += 1;
      sessions.add(c.session_id);
    }
  }
  if (total <= 0) return undefined;
  const share = fast / total;
  if (share <= FAST_COST_SHARE) return undefined;
  return withScope(
    {
      id: "fast-mode-share",
      severity: "info",
      title: "Fast mode is a large share of spend",
      reason: `${fastCalls} fast-mode calls account for ${usd(fast)} of ${usd(total)} (${pct(share)}) of priced cost.`,
      evidence: {
        fastCalls,
        fastUsd: round4(fast),
        totalUsd: round4(total),
        share: Math.round(share * 100),
      },
      recommendation:
        "Fast mode is billed at a premium; reserve it for interactive turns where latency matters.",
    },
    sessions,
  );
}

/** thinking-share: thinking tokens above THINKING_SHARE of output tokens (≥ MIN_OUTPUT_FOR_THINKING output). */
function detectThinkingShare(ctx: Ctx): Insight | undefined {
  const t = totals(ctx.calls);
  if (t.output < MIN_OUTPUT_FOR_THINKING || t.thinking <= 0) return undefined;
  const share = t.thinking / t.output;
  if (share <= THINKING_SHARE) return undefined;
  return withScope(
    {
      id: "thinking-share",
      severity: "info",
      title: "Most output tokens are thinking",
      reason: `${fmtK(t.thinking)} of ${fmtK(t.output)} output tokens (${pct(share)}) were thinking, billed at the output rate.`,
      evidence: {
        thinkingTokens: t.thinking,
        outputTokens: t.output,
        share: Math.round(share * 100),
      },
      recommendation:
        "Lower the effort level for routine edits and lookups; keep high effort for design and debugging.",
    },
    ctx.calls.map((c) => c.session_id),
  );
}

/** subagent-cost: subagents above DELEGATION_SHARE of priced cost. */
function detectSubagentCost(ctx: Ctx): Insight | undefined {
  const a = byAgent(ctx.calls);
  if (a.delegationShare <= DELEGATION_SHARE) return undefined;
  const subCost = a.subagents.reduce((s, x) => s + x.totals.costUsd, 0);
  const subCalls = a.subagents.reduce((s, x) => s + x.totals.calls, 0);
  return withScope(
    {
      id: "subagent-cost",
      severity: "info",
      title: "Subagents dominate spend",
      reason: `${a.subagents.length} subagent${a.subagents.length === 1 ? "" : "s"} made ${subCalls} calls for ${usd(subCost)}, ${pct(a.delegationShare)} of priced cost (main thread ${usd(a.main.costUsd)}).`,
      evidence: {
        subagents: a.subagents.length,
        subagentCalls: subCalls,
        subagentUsd: round4(subCost),
        share: Math.round(a.delegationShare * 100),
      },
      recommendation:
        "Check that subagents run on the cheapest model that fits (model: sonnet/haiku) and return summaries, not transcripts.",
    },
    ctx.calls.filter((c) => c.sidechain).map((c) => c.session_id),
  );
}

/** What drove an expensive call's cost, from its priced breakdown. */
type CostDriver = "cache-write" | "output" | "context";

const DRIVER_ADVICE: Record<CostDriver, { what: string; recommendation: string }> = {
  "cache-write": {
    what: "cache writes",
    recommendation:
      "Cache writes dominate: a long idle gap or a cache-busting change (edited system prompt, reordered tools) re-wrote the prefix. Keep the prefix stable, or use the 1h cache deliberately for long pauses.",
  },
  output: {
    what: "output",
    recommendation:
      "Output dominates: a long answer or heavy thinking. Lower the effort level or ask for a shorter answer; keep high effort for design and debugging.",
  },
  context: {
    what: "context",
    recommendation:
      "Context dominates: the call re-read a large conversation. Compact, start a fresh session, or move the bulk into a subagent.",
  },
};

/**
 * expensive-turn: a single call above budgets.turnUsd (default DEFAULT_TURN_USD). The
 * reason names the dominant cost term (cache writes vs output vs context = input + cache
 * reads) so the advice fits: a 1h cache write or a long answer is not a context problem.
 */
function detectExpensiveTurn(ctx: Ctx): Insight | undefined {
  const limit = ctx.budgets.turnUsd ?? DEFAULT_TURN_USD;
  const hits = ctx.calls.filter((c) => costOf(c) > limit).sort((a, b) => costOf(b) - costOf(a));
  if (hits.length === 0) return undefined;
  const top = hits[0] as ApiCallRow;
  const price = ctx.priceOf(top.model);
  const b = price
    ? costOfCall(top, price)
    : { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, tools: 0, total: costOf(top) };
  const contextUsd = b.input + b.cacheRead;
  const driver: CostDriver =
    b.cacheWrite > b.output && b.cacheWrite > contextUsd
      ? "cache-write"
      : b.output > contextUsd
        ? "output"
        : "context";
  const advice = DRIVER_ADVICE[driver];
  const n = hits.length;
  return withScope(
    {
      id: "expensive-turn",
      severity: costOf(top) > limit * 3 ? "high" : "warn",
      title: `${n} call${n === 1 ? "" : "s"} over ${usd(limit)}`,
      reason: `${n} call${n === 1 ? "" : "s"} cost more than ${usd(limit)} each; the largest was ${usd(costOf(top))} on ${top.model} with ${fmtK(contextOf(top))} context tokens, driven by ${advice.what} (context ${usd(contextUsd)}, output ${usd(b.output)}, cache writes ${usd(b.cacheWrite)}).`,
      evidence: {
        calls: n,
        maxUsd: round4(costOf(top)),
        model: top.model,
        contextTokens: contextOf(top),
        limitUsd: limit,
        driver,
        contextUsd: round4(contextUsd),
        outputUsd: round4(b.output),
        cacheWriteUsd: round4(b.cacheWrite),
      },
      recommendation: advice.recommendation,
    },
    hits.map((c) => c.session_id),
  );
}

/**
 * error-loop: an iteration_loop event (same tool call repeated 3+ times, recorded by
 * the hooks) or ≥ ERROR_RUN consecutive failed uses of the same tool in a thread.
 */
function detectErrorLoop(ctx: Ctx): Insight | undefined {
  const loops = ctx.events.filter((e) => e.category === "iteration_loop");
  const sessions = new Set<string>(loops.map((e) => e.session_id));
  let worstTool = "";
  let worstRun = 0;
  const byThread = new Map<string, ToolUseRow[]>();
  for (const u of ctx.toolUses) {
    const key = `${u.session_id}\u0000${u.agent_id ?? ""}`;
    const list = byThread.get(key);
    if (list) list.push(u);
    else byThread.set(key, [u]);
  }
  for (const list of byThread.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let run = 0;
    let tool = "";
    for (const u of list) {
      if (u.is_error && u.tool === tool) run += 1;
      else {
        run = u.is_error ? 1 : 0;
        tool = u.is_error ? u.tool : "";
      }
      if (run >= ERROR_RUN) {
        sessions.add(u.session_id);
        if (run > worstRun) {
          worstRun = run;
          worstTool = tool;
        }
      }
    }
  }
  if (loops.length === 0 && worstRun === 0) return undefined;
  const parts: string[] = [];
  if (loops.length)
    parts.push(`${loops.length} repeated-call loop${loops.length === 1 ? "" : "s"} recorded`);
  if (worstRun) parts.push(`${worstRun} consecutive ${worstTool} failures`);
  return withScope(
    {
      id: "error-loop",
      severity: "warn",
      title: "Repeated failures or loops",
      reason: `${parts.join(" and ")}; every retry re-reads the whole context.`,
      evidence: { loops: loops.length, longestErrorRun: worstRun, tool: worstTool },
      recommendation:
        "After two identical failures stop and change approach (em_recall for an earlier fix, read the error, try a different tool).",
    },
    sessions,
  );
}

/** budget: a session above budgets.sessionUsd or the current local day above budgets.dailyUsd. */
function detectBudget(ctx: Ctx): Insight[] {
  const out: Insight[] = [];
  const { sessionUsd, dailyUsd } = ctx.budgets;
  if (sessionUsd) {
    for (const [sid, rows] of groupBySession(ctx.calls)) {
      const cost = totals(rows).costUsd;
      if (cost <= sessionUsd) continue;
      out.push({
        id: "budget",
        severity: "high",
        title: "Session budget exceeded",
        reason: `Session ${sid.slice(0, 8)} has cost ${usd(cost)}, over the ${usd(sessionUsd)} session budget (${pct(cost / sessionUsd)}).`,
        evidence: { sessionUsd: round4(cost), budgetUsd: sessionUsd },
        scope: "session",
        sessionId: sid,
      });
    }
  }
  if (dailyUsd) {
    const today = dayKey(ctx.now);
    const cost = totals(ctx.calls.filter((c) => dayKey(c.ts) === today)).costUsd;
    if (cost > dailyUsd)
      out.push({
        id: "budget",
        severity: "high",
        title: "Daily budget exceeded",
        reason: `Today (${today}) has cost ${usd(cost)}, over the ${usd(dailyUsd)} daily budget (${pct(cost / dailyUsd)}).`,
        evidence: { day: today, todayUsd: round4(cost), budgetUsd: dailyUsd },
        scope: "project",
      });
  }
  return out;
}

/** unpriced-model: calls whose model has no bundled or configured price. */
function detectUnpricedModel(ctx: Ctx): Insight | undefined {
  const unpriced = ctx.calls.filter((c) => !c.priced);
  if (unpriced.length === 0) return undefined;
  const models = [...new Set(unpriced.map((c) => c.model || "unknown"))];
  return withScope(
    {
      id: "unpriced-model",
      severity: "info",
      title: "Some calls are unpriced",
      reason: `${unpriced.length} of ${ctx.calls.length} calls use ${models.length} model${models.length === 1 ? "" : "s"} without a price (${models.slice(0, 3).join(", ")}), so cost totals undercount.`,
      evidence: { calls: unpriced.length, models: models.join(", ") },
      recommendation:
        'Add the model to config.usage.pricing, e.g. {"pricing": {"<model substring>": {"input": 3, "output": 15}}} (USD per MTok).',
    },
    unpriced.map((c) => c.session_id),
  );
}

/** context-near-limit: the latest statusline snapshot reports ctx_used_pct ≥ NEAR_LIMIT_PCT. */
function detectContextNearLimit(ctx: Ctx): Insight | undefined {
  let latest: StatuslineSnapshotRow | undefined;
  for (const s of ctx.snapshots) if (!latest || s.ts > latest.ts) latest = s;
  if (!latest || latest.ctx_used_pct == null || latest.ctx_used_pct < NEAR_LIMIT_PCT)
    return undefined;
  const p = latest.ctx_used_pct;
  return {
    id: "context-near-limit",
    severity: p >= NEAR_LIMIT_HIGH ? "high" : "warn",
    title: "Context window nearly full",
    reason: `The latest statusline reports ${Math.round(p)}% of the ${fmtK(num(latest.ctx_size) || DEFAULT_WINDOW)}-token window in use; the next compaction is close.`,
    evidence: { ctxUsedPct: Math.round(p), ctxSize: num(latest.ctx_size) },
    recommendation:
      "Save durable findings with em_remember now, then compact or start a fresh session.",
    scope: "session",
    sessionId: latest.session_id,
  };
}

// --- scores -----------------------------------------------------------------------------

function findInsight(insights: Insight[], id: string): Insight | undefined {
  return insights.find((i) => i.id === id);
}
const ev = (i: Insight | undefined, key: string): number => {
  const v = i?.evidence?.[key];
  return typeof v === "number" ? v : 0;
};

/**
 * context-health = 100
 *   − 5 per oversized tool result (cap 30)
 *   − 10 per compaction beyond the first in any session (cap 30)
 *   − 20 when the latest snapshot is ≥ 85% of the window
 *   − 10 per error loop / failure run (cap 20)
 */
function scoreContextHealth(ctx: Ctx, insights: Insight[]): Score {
  const reasons: string[] = [];
  let v = 100;
  const bloat = ev(findInsight(insights, "context-bloat"), "results");
  if (bloat) {
    const d = Math.min(30, bloat * 5);
    v -= d;
    reasons.push(`${bloat} oversized tool result${bloat === 1 ? "" : "s"} in context (−${d})`);
  }
  let extra = 0;
  for (const evs of groupBySession(ctx.contextEvents).values())
    extra += Math.max(0, evs.filter((e) => e.kind === "compact").length - 1);
  if (extra) {
    const d = Math.min(30, extra * 10);
    v -= d;
    reasons.push(
      `${extra} compaction${extra === 1 ? "" : "s"} beyond the first per session (−${d})`,
    );
  }
  const near = findInsight(insights, "context-near-limit");
  if (near) {
    v -= 20;
    reasons.push(`context ${ev(near, "ctxUsedPct")}% full (−20)`);
  }
  const loop = findInsight(insights, "error-loop");
  if (loop) {
    const n = ev(loop, "loops") + (ev(loop, "longestErrorRun") ? 1 : 0);
    const d = Math.min(20, n * 10);
    v -= d;
    reasons.push(`${n} error loop${n === 1 ? "" : "s"} (−${d})`);
  }
  if (!reasons.length)
    reasons.push(
      ctx.calls.length
        ? "no oversized results, compaction churn or loops"
        : "no usage recorded yet",
    );
  return { id: "context-health", value: clamp(v), reasons };
}

/**
 * cost-efficiency = 100
 *   − 50 × share of premium calls that were trivial (when opus-for-trivial fires)
 *   − 40 × fast-mode cost share (when fast-mode-share fires)
 *   − 10 per expensive turn (cap 30)
 *   − 20 × share of unpriced calls
 *   − 20 per budget crossed (cap 40)
 */
function scoreCostEfficiency(ctx: Ctx, insights: Insight[]): Score {
  const reasons: string[] = [];
  let v = 100;
  const trivial = findInsight(insights, "opus-for-trivial");
  if (trivial) {
    const d = Math.round((ev(trivial, "share") / 100) * 50);
    v -= d;
    reasons.push(`${ev(trivial, "share")}% of premium-model calls were trivial (−${d})`);
  }
  const fast = findInsight(insights, "fast-mode-share");
  if (fast) {
    const d = Math.round((ev(fast, "share") / 100) * 40);
    v -= d;
    reasons.push(`fast mode is ${ev(fast, "share")}% of spend (−${d})`);
  }
  const exp = findInsight(insights, "expensive-turn");
  if (exp) {
    const n = ev(exp, "calls");
    const d = Math.min(30, n * 10);
    v -= d;
    reasons.push(`${n} call${n === 1 ? "" : "s"} over ${usd(ev(exp, "limitUsd"))} (−${d})`);
  }
  const unpriced = findInsight(insights, "unpriced-model");
  if (unpriced && ctx.calls.length) {
    const share = ev(unpriced, "calls") / ctx.calls.length;
    const d = Math.round(share * 20);
    v -= d;
    reasons.push(`${pct(share)} of calls unpriced (−${d})`);
  }
  const budgets = insights.filter((i) => i.id === "budget").length;
  if (budgets) {
    const d = Math.min(40, budgets * 20);
    v -= d;
    reasons.push(`${budgets} budget${budgets === 1 ? "" : "s"} exceeded (−${d})`);
  }
  if (!reasons.length)
    reasons.push(
      ctx.calls.length ? "no premium waste, fast-mode or budget issues" : "no usage recorded yet",
    );
  return { id: "cost-efficiency", value: clamp(v), reasons };
}

/**
 * cache-efficiency = cache hit rate × 100
 *   − 5 per cold restart (cap 25)
 *   − 10 per thrash run (cap 30)
 */
function scoreCacheEfficiency(ctx: Ctx, insights: Insight[]): Score {
  const reasons: string[] = [];
  const t = totals(ctx.calls);
  if (t.calls === 0)
    return { id: "cache-efficiency", value: 0, reasons: ["no usage recorded yet"] };
  let v = t.cacheHitRate * 100;
  reasons.push(`cache hit rate ${pct(t.cacheHitRate)} over ${t.calls} calls`);
  const cold = ev(findInsight(insights, "cache-cold"), "restarts");
  if (cold) {
    const d = Math.min(25, cold * 5);
    v -= d;
    reasons.push(`${cold} cold restart${cold === 1 ? "" : "s"} (−${d})`);
  }
  const thrash = ev(findInsight(insights, "cache-thrash"), "runs");
  if (thrash) {
    const d = Math.min(30, thrash * 10);
    v -= d;
    reasons.push(`${thrash} cache-rewrite run${thrash === 1 ? "" : "s"} (−${d})`);
  }
  return { id: "cache-efficiency", value: clamp(v), reasons };
}

/**
 * delegation = 60 when no subagent calls exist;
 *   100 when subagents are 0–60% of priced cost;
 *   100 − 150 × (share − 0.6) above that (floor 20);
 *   − 15 when the subagents' own cache hit rate is below 50%.
 */
function scoreDelegation(ctx: Ctx): Score {
  const reasons: string[] = [];
  const a = byAgent(ctx.calls);
  if (ctx.calls.length === 0)
    return { id: "delegation", value: 0, reasons: ["no usage recorded yet"] };
  if (a.subagents.length === 0)
    return {
      id: "delegation",
      value: 60,
      reasons: ["no subagent calls: the main thread carries every tool result itself"],
    };
  let v: number;
  if (a.delegationShare <= DELEGATION_SHARE) {
    v = 100;
    reasons.push(
      `subagents are ${pct(a.delegationShare)} of cost across ${a.subagents.length} agent${a.subagents.length === 1 ? "" : "s"}`,
    );
  } else {
    v = Math.max(20, 100 - 150 * (a.delegationShare - DELEGATION_SHARE));
    reasons.push(
      `subagents are ${pct(a.delegationShare)} of cost, above ${pct(DELEGATION_SHARE)} (−${100 - Math.round(v)})`,
    );
  }
  const sub = totals(ctx.calls.filter((c) => c.sidechain));
  if (sub.calls && sub.cacheHitRate < 0.5) {
    v -= 15;
    reasons.push(`subagent cache hit rate ${pct(sub.cacheHitRate)} (−15)`);
  }
  return { id: "delegation", value: clamp(v), reasons };
}

// --- entry points -----------------------------------------------------------------------

export function detectInsights(input: InsightInput): InsightResult {
  const calls = input.calls.filter(isRealCall);
  const compactionsBySession = new Map<string, number[]>();
  for (const e of input.contextEvents) {
    const list = compactionsBySession.get(e.session_id);
    if (list) list.push(e.ts);
    else compactionsBySession.set(e.session_id, [e.ts]);
  }
  for (const list of compactionsBySession.values()) list.sort((a, b) => a - b);
  const callTs = new Map<string, number[]>();
  for (const [sid, rows] of groupBySession(calls))
    callTs.set(
      sid,
      rows.map((c) => c.ts).sort((a, b) => a - b),
    );
  const priceCache = new Map<string, ModelPrice | undefined>();
  const overrides = input.overrides as PricingOverrides | undefined;
  const ctx: Ctx = {
    calls,
    threads: threads(calls),
    toolUses: input.toolUses,
    contextEvents: input.contextEvents,
    stats: input.stats,
    events: input.events,
    snapshots: input.snapshots,
    now: input.now ?? Date.now(),
    budgets: input.budgets ?? {},
    overrides,
    priceOf: (model) => {
      if (!priceCache.has(model)) priceCache.set(model, resolvePrice(model, overrides));
      return priceCache.get(model);
    },
    compactionsBySession,
    laterCalls: (sid, ts) => (callTs.get(sid) ?? []).filter((t) => t > ts).length,
  };

  const insights: Insight[] = [];
  const push = (i: Insight | undefined) => {
    if (i) insights.push(i);
  };
  push(detectCacheThrash(ctx));
  push(detectCacheCold(ctx));
  push(detectContextBloat(ctx));
  push(detectCompactionChurn(ctx));
  push(detectOpusForTrivial(ctx));
  push(detectFastModeShare(ctx));
  push(detectThinkingShare(ctx));
  push(detectSubagentCost(ctx));
  push(detectExpensiveTurn(ctx));
  push(detectErrorLoop(ctx));
  for (const b of detectBudget(ctx)) push(b);
  push(detectUnpricedModel(ctx));
  push(detectContextNearLimit(ctx));

  insights.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.estimatedSavingsUsd ?? 0) - (a.estimatedSavingsUsd ?? 0) ||
      a.id.localeCompare(b.id),
  );

  const scores: Score[] = [
    scoreContextHealth(ctx, insights),
    scoreCostEfficiency(ctx, insights),
    scoreCacheEfficiency(ctx, insights),
    scoreDelegation(ctx),
  ];
  return { insights, scores };
}

/** Hook event categories the detectors look at. */
export const INSIGHT_EVENT_CATEGORIES = ["iteration_loop", "error", "tool_call"];

/**
 * Gather `detectInsights` input from storage: one session's rows when `sessionId` is
 * given, else the project's rows since `since` (epoch ms), with budgets and price
 * overrides from the project config.
 */
export function loadInsightInput(
  db: StorageAdapter,
  ctx: ProjectContext,
  opts: {
    sessionId?: string | undefined;
    since?: number | undefined;
    now?: number | undefined;
  } = {},
): InsightInput {
  const filter = { sessionId: opts.sessionId, since: opts.since };
  const usage = ctx.config.usage;
  return {
    calls: db.apiCalls(filter),
    toolUses: db.toolUses(filter),
    contextEvents: db.contextEvents(filter),
    snapshots: db.statuslineSnapshots(filter),
    stats: opts.sessionId ? db.statsBySession(opts.sessionId) : db.statsAll(),
    events: opts.sessionId
      ? db.eventsBySession(opts.sessionId, { categories: INSIGHT_EVENT_CATEGORIES })
      : db
          .eventsRecent(500, INSIGHT_EVENT_CATEGORIES)
          .filter((e) => !opts.since || e.ts >= opts.since),
    now: opts.now ?? Date.now(),
    budgets: usage.budgets,
    overrides: usage.pricing,
  };
}
