/**
 * Dashboard API for the adjudicator (the Adjudicator tab). Spec: docs/design/adjudicator.md §20.
 *
 *   GET  /api/adjudicator            overview: config, provider resolution, health, summary, charts
 *   GET  /api/adjudicator/decisions  the call log, filtered and paged (no scores JSON)
 *   GET  /api/adjudicator/decision   one row with its parsed scores
 *   GET  /api/adjudicator/savings    savings.savingsReport
 *   GET  /api/adjudicator/eval       the last eval report, or null
 *   GET  /api/adjudicator/jev        Jev impact: what the typesafe provider changed (settles outcomes first)
 *   GET  /api/adjudicator/jev/exchanges  the stored Jev requests, newest first, without bodies
 *   GET  /api/adjudicator/jev/exchange   one stored Jev request with its request/response bodies
 *   POST /api/adjudicator/test       try-it: score a text; never persisted
 *   GET  /api/adjudicator/security[/assessment], POST /security/test   the security panel (security-api.ts)
 *
 * Every GET but /jev/exchange(s) runs learn.reconcile (limit 500) first so outcomes and savings are
 * current. /jev does it after its Jev gate (nothing is read or written when Jev is off): the panel
 * and the overview are fetched together on a refresh, in no fixed order, so it cannot lean on the
 * overview having reconciled.
 * Every query value is validated (a bad since, limit, offset, id or enum is a 400). Payloads never
 * carry a key or header (not even a masked one) or request text beyond the stored, redacted
 * input_head; the one exception is /jev/exchange, which returns the stored (redacted) request and
 * response bodies of a single captured Jev request, and only when privacy.captureExchanges is on.
 * The try-it response does not echo its text. The server checks the loopback origin and the JSON
 * content type of the POST before it gets here.
 */

import { formatAdvice } from "../adjudicator/blend.js";
import { p95, spendToday } from "../adjudicator/breaker.js";
import { type Resolved, resolveAdjudicator } from "../adjudicator/config.js";
import { adjudicateOne } from "../adjudicator/engine.js";
import { complexityBucket, topIntent } from "../adjudicator/heuristic.js";
import {
  type JevImpactInactive,
  type JevImpactPayload,
  jevImpact,
} from "../adjudicator/jev-impact.js";
import { biasFromRows, DEFAULT_LEARNING, reconcile } from "../adjudicator/learn.js";
import { hasProvider, registerProvider } from "../adjudicator/providers/index.js";
import { allRows, savingsReport } from "../adjudicator/savings.js";
import { overviewFlag } from "../adjudicator/security/report.js";
import {
  type AdjudicationOutcome,
  type AdjudicationRow,
  type AdjudicatorProvider,
  EVAL_META_KEY,
  type ExchangeDetail,
  type ExchangeSummary,
  PROVIDER_IDS,
  type ProviderId,
  SURFACES,
  type Surface,
  type Verdict,
} from "../adjudicator/types.js";
import type { AdjudicatorConfig, Config } from "../config.js";
import { loadConfig, projectAdjudicatorWarning } from "../config.js";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { EXCHANGE_KEEP } from "../storage/sqlite/adjudicator.js";
import type {
  AdjudicationSummary,
  AdjudicatorProviderState,
  AdjudicatorStore,
  ExchangeRow,
  ExchangeSummaryRow,
} from "../storage/types.js";
import { parseSince } from "../tools/em_usage.js";
import type { PricingOverrides } from "../usage/pricing.js";
import { securityRoute } from "./security-api.js";
import type { Reply } from "./swarm-api.js";

export const OUTCOMES: readonly AdjudicationOutcome[] = [
  "pending",
  "success",
  "failure",
  "abandoned",
  "n/a",
];
/** Verdict sources, in chart stacking order. */
export const SOURCES = ["heuristic", "blend", "cache", "fallback"] as const;
/** The store's largest page. */
export const DECISIONS_LIMIT_MAX = 500;
export const DECISIONS_LIMIT_DEFAULT = 50;
/** Rows reconcile looks at before each GET. */
export const RECONCILE_LIMIT = 500;
/** The overview's window when no `since` is given. */
export const DEFAULT_SINCE = "30d";
/** Longest try-it text; the engine itself only scans privacy.maxChars of it. */
export const TEST_TEXT_MAX = 20_000;
/** Rows the overview's charts are drawn from (newest win when there are more). */
export const CHART_ROWS_MAX = 20_000;

const DAY_MS = 86_400_000;

const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

/** Test seams; the server passes none. */
export interface AdjudicatorRouteDeps {
  /** Default: loadConfig(ctx.root) on every request, so `eminiar adjudicator enable` shows up live. */
  config?: Config | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
  db?: StorageAdapter | undefined;
  /** POST test: a ready provider instance (null forces the heuristic). */
  provider?: AdjudicatorProvider | null | undefined;
}

// --- sanitising -------------------------------------------------------------------------

/** A URL without userinfo, query or fragment (they may hold credentials). */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

/** The adjudicator section as the dashboard shows it: no URL credentials. keyEnv is a NAME. */
export function sanitizedConfig(a: AdjudicatorConfig) {
  const typesafe = { ...a.typesafe, baseUrl: safeUrl(a.typesafe.baseUrl) };
  const openai: Record<string, unknown> = { ...a.openai };
  if (a.openai.baseUrl !== undefined) openai.baseUrl = safeUrl(a.openai.baseUrl);
  return {
    ...structuredClone(a),
    typesafe,
    openai,
    keyEnv: a.keyEnv ?? null,
  };
}

/** Provider resolution without the key, its mask, or the key file path. */
function providerView(r: Resolved) {
  return {
    configured: r.configured,
    effective: r.provider,
    degraded: r.degraded ?? null,
    detail: r.detail ?? null,
    remote: r.remote,
    configuredRemote: r.configuredRemote,
    local: r.local,
    preset: r.preset ?? null,
    model: r.model ?? null,
    baseUrl: safeUrl(r.baseUrl),
    price: r.price ?? null,
  };
}

// --- validation -------------------------------------------------------------------------

type Parsed<T> = { value: T; error?: undefined } | { value?: undefined; error: Reply };

function sinceOf(q: URLSearchParams, now: number, fallback?: string): Parsed<number | undefined> {
  const raw = q.get("since");
  try {
    if (raw === null || raw.trim() === "")
      return { value: fallback ? parseSince(fallback, now) : undefined };
    if (raw === "all") return { value: undefined };
    return { value: parseSince(raw, now) };
  } catch (err) {
    return { error: fail(400, (err as Error).message) };
  }
}

function intOf(
  q: URLSearchParams,
  key: string,
  opts: { min: number; max: number; fallback: number },
): Parsed<number> {
  const raw = q.get(key);
  if (raw === null || raw === "") return { value: opts.fallback };
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < opts.min || Number(raw) > opts.max)
    return {
      error: fail(400, `${key} must be an integer between ${opts.min} and ${opts.max}`),
    };
  return { value: Number(raw) };
}

function enumOf<T extends string>(
  q: URLSearchParams,
  key: string,
  allowed: readonly T[],
): Parsed<T | undefined> {
  const raw = q.get(key);
  if (raw === null || raw === "") return { value: undefined };
  if (!(allowed as readonly string[]).includes(raw))
    return { error: fail(400, `${key} must be one of ${allowed.join(", ")}`) };
  return { value: raw as T };
}

// --- shared -----------------------------------------------------------------------------

interface Env {
  config: Config;
  db: StorageAdapter;
  now: number;
  env: NodeJS.ProcessEnv | undefined;
}

function envOf(ctx: ProjectContext, deps: AdjudicatorRouteDeps): Env {
  return {
    config: deps.config ?? loadConfig(ctx.root),
    db: deps.db ?? getStorage(ctx),
    now: (deps.now ?? Date.now)(),
    env: deps.env,
  };
}

function resolve(e: Env, cfg: AdjudicatorConfig = e.config.adjudicator): Resolved {
  return resolveAdjudicator(cfg, { context: "server", ...(e.env ? { env: e.env } : {}) });
}

/** reconcile(limit 500) before a GET; a failure is reported, never fatal. */
function reconcileFirst(e: Env) {
  try {
    return { ...reconcile(e.db, { limit: RECONCILE_LIMIT, now: e.now, config: e.config }) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const pricingOf = (c: Config) => c.usage?.pricing as PricingOverrides | undefined;

/** Nearest-rank percentile; null for an empty list. */
function pct(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? null;
}

// --- GET /api/adjudicator ---------------------------------------------------------------

export interface ProviderHealth {
  provider: string;
  /** The configured provider. */
  configured: boolean;
  /** The provider sends text off this machine (the daily cap applies only then). */
  remote: boolean;
  /**
   * Breaker state as stored: closed | open | half_open | slow, or any newer state (e.g.
   * auth_failed); null when the provider has never been called.
   */
  state: string | null;
  failures: number;
  retryAt: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastErrorClass: string | null;
  latency: { n: number; p50: number | null; p95: number | null };
  spendTodayUsd: number;
  /** null for local providers: no cap applies. */
  dailyCapUsd: number | null;
}

function healthOf(
  e: Env,
  id: ProviderId,
  state: AdjudicatorProviderState | undefined,
  configured: ProviderId,
): ProviderHealth {
  const a = e.config.adjudicator;
  const remote = resolveAdjudicator(
    { ...a, provider: id },
    {
      context: "server",
      ...(e.env ? { env: e.env } : {}),
    },
  ).configuredRemote;
  const lat = state?.latencies ?? [];
  return {
    provider: id,
    configured: id === configured,
    remote,
    state: state?.state ?? null,
    failures: state?.failures ?? 0,
    retryAt: state?.retryAt ?? null,
    lastOkAt: state?.lastOkAt ?? null,
    lastErrorAt: state?.lastErrorAt ?? null,
    lastErrorClass: state?.lastErrorClass ?? null,
    latency: { n: lat.length, p50: pct(lat, 0.5), p95: p95(lat) ?? null },
    spendTodayUsd: spendToday(state, e.now),
    dailyCapUsd: remote ? a.budget.dailyUsd : null,
  };
}

export interface DayBucket {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  heuristic: number;
  blend: number;
  cache: number;
  fallback: number;
  total: number;
}

/** Decisions per UTC day by source (every day from the first to the last, gaps as zeros) and the complexity histogram 0..4. */
export function chartsOf(rows: readonly Pick<AdjudicationRow, "ts" | "source" | "complexity">[]): {
  perDay: DayBucket[];
  complexity: number[];
} {
  const complexity = [0, 0, 0, 0, 0];
  const days = new Map<string, DayBucket>();
  const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const blank = (day: string): DayBucket => ({
    day,
    heuristic: 0,
    blend: 0,
    cache: 0,
    fallback: 0,
    total: 0,
  });
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const day = dayOf(r.ts);
    const b = days.get(day) ?? blank(day);
    days.set(day, b);
    b.total++;
    const src = r.source ?? "heuristic";
    if ((SOURCES as readonly string[]).includes(src)) b[src as (typeof SOURCES)[number]]++;
    first = Math.min(first, r.ts);
    last = Math.max(last, r.ts);
    if (typeof r.complexity === "number" && Number.isFinite(r.complexity)) {
      const k = complexityBucket(r.complexity);
      complexity[Math.max(0, Math.min(4, k))]!++;
    }
  }
  const perDay: DayBucket[] = [];
  if (rows.length) {
    const start = Date.parse(dayOf(first));
    for (let t = start; t <= last; t += DAY_MS) {
      const day = dayOf(t);
      perDay.push(days.get(day) ?? blank(day));
    }
  }
  return { perDay, complexity };
}

/** The one-line project-file warning, or null; a read error never breaks the overview. */
function projectIgnoredOf(root: string): string | null {
  try {
    return projectAdjudicatorWarning(root) ?? null;
  } catch {
    return null;
  }
}

export function overviewPayload(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps = {},
  since?: number,
) {
  const e = envOf(ctx, deps);
  const reconciled = reconcileFirst(e);
  const a = e.config.adjudicator;
  const r = resolve(e);
  const store = e.db.adjudicator;
  const summary: AdjudicationSummary = store.summary(since);
  const health = (PROVIDER_IDS.filter((p) => p !== "heuristic") as ProviderId[])
    .map((id) => ({ id, state: store.providerState(id) }))
    .filter((p) => p.state || p.id === r.configured)
    .map((p) => healthOf(e, p.id, p.state, r.configured));
  const rows = allRows(e.db, since === undefined ? {} : { since }, CHART_ROWS_MAX);
  const fallback = summary.bySource.fallback ?? 0;
  return {
    enabled: a.enabled,
    mode: a.mode,
    /** The security panel's gate: when `enabled` is false the web client mounts nothing. */
    security: overviewFlag(a),
    config: sanitizedConfig(a),
    provider: providerView(r),
    /** Where the key would come from; never the key or any part of it. */
    keySource: r.keySource,
    keyFileRefused: r.keyFileRefused === true,
    consent: r.consent,
    /** The origin remote consent must cover; null for a local provider. */
    origin: r.configuredRemote ? (r.origin ?? null) : null,
    /** projectAdjudicatorWarning(): adjudicator keys eminiar.config.json sets that are ignored. */
    projectIgnored: projectIgnoredOf(ctx.root),
    health,
    apply: {
      checked: summary.applyChecked,
      ineffective: summary.applyIneffective,
      effective: summary.applyChecked - summary.applyIneffective,
    },
    summary,
    fallbackRate: summary.total ? fallback / summary.total : null,
    charts: chartsOf(rows),
    chartsCut: rows.length >= CHART_ROWS_MAX,
    filters: { surfaces: SURFACES, providers: PROVIDER_IDS, outcomes: OUTCOMES, sources: SOURCES },
    reconcile: reconciled,
    since: since ?? null,
    now: e.now,
  };
}

// --- GET /api/adjudicator/jev -----------------------------------------------------------

/** The surfaces a Jev report can be narrowed to (test rows are never in it). */
const JEV_SURFACES = SURFACES.filter((s) => s !== "test");

/** What the web client reads from /jev when Jev is configured. */
export type JevApiPayload = JevImpactPayload<{
  configured: string;
  effective: string;
  degraded: string | null;
  model: string | null;
  health: ProviderHealth;
}> & {
  /** What the reconcile before this read did, as on the other tab GETs; `error` is a fixed text. */
  reconcile: ReturnType<typeof reconcileFirst>;
};

export type JevApiResponse = JevApiPayload | JevImpactInactive;

/**
 * Jev is shown when the adjudicator is enabled and typesafe is the configured provider. A
 * configured Jev with no key or consent still shows (provider.degraded says why), because
 * "configured but every call falls back" is what the panel should reveal.
 *
 * The config is read first: when Jev is not in play this returns before the database is
 * opened and before any row is read. Past the gate it runs the same bounded reconcile as the
 * other tab GETs (limit 500, fail-soft; the result is in `reconcile`, with a fixed error text) so
 * the outcomes it reads are current, then only reads the report. A
 * busy or missing database is a 503 with a fixed message, never a thrown error. The payload holds counts,
 * ids, tiers and reason codes; never a key, input text or a prompt.
 */
export function jevPayload(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps = {},
  window: { since?: number | undefined; surface?: Surface | undefined } = {},
): Reply {
  const now = (deps.now ?? Date.now)();
  const config = deps.config ?? loadConfig(ctx.root);
  const a = config.adjudicator;
  if (!a.enabled || a.provider !== "typesafe") {
    const inactive: JevImpactInactive = {
      active: false,
      reason: a.enabled ? "provider" : "disabled",
      provider: a.provider,
      now,
    };
    return ok(inactive);
  }
  try {
    const db = deps.db ?? getStorage(ctx);
    const e: Env = { config, db, now, env: deps.env };
    const r = resolve(e);
    const settled = reconcileFirst(e);
    const reconciled = "error" in settled ? { error: "the outcome reconcile failed" } : settled;
    const state = db.adjudicator.providerState("typesafe");
    const pricing = pricingOf(config);
    const report = jevImpact(db, window, {
      config: a,
      ...(pricing ? { pricing } : {}),
      now,
      degraded: r.degraded ?? null,
      breakerState: state?.state ?? null,
    });
    const payload: JevApiPayload = {
      active: true,
      provider: {
        configured: r.configured,
        effective: r.provider,
        degraded: r.degraded ?? null,
        model: r.model ?? null,
        health: healthOf(e, "typesafe", state, r.configured),
      },
      ...report,
      reconcile: reconciled,
    };
    return ok(payload);
  } catch {
    return fail(503, "the adjudication database is unavailable (busy or missing); try again");
  }
}

// --- GET /api/adjudicator/jev/exchanges + /jev/exchange ---------------------------------

/** Capture is off: the panel says how to turn it on; no exchange row was read. */
export interface JevExchangesCaptureOff {
  active: true;
  capture: false;
  keep: number;
  now: number;
}

export interface JevExchangesPayload {
  active: true;
  capture: true;
  keep: number;
  /** Rows stored for this filter (all of them, or the ones serving `row`). */
  total: number;
  rows: ExchangeSummary[];
  now: number;
}

export interface JevExchangePayload {
  active: true;
  capture: true;
  exchange: ExchangeDetail;
  now: number;
}

export type JevExchangesResponse = JevImpactInactive | JevExchangesCaptureOff | JevExchangesPayload;
export type JevExchangeResponse = JevImpactInactive | JevExchangesCaptureOff | JevExchangePayload;

const JEV_UNAVAILABLE = "the adjudication database is unavailable (busy or missing); try again";

/** The same gate as jevPayload, then the capture switch; both answer before any database read. */
function exchangeGate(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps,
  now: number,
): { reply: Reply } | { reply?: undefined } {
  const a = (deps.config ?? loadConfig(ctx.root)).adjudicator;
  if (!a.enabled || a.provider !== "typesafe") {
    const inactive: JevImpactInactive = {
      active: false,
      reason: a.enabled ? "provider" : "disabled",
      provider: a.provider,
      now,
    };
    return { reply: ok(inactive) };
  }
  if (a.privacy.captureExchanges !== true) {
    const off: JevExchangesCaptureOff = { active: true, capture: false, keep: EXCHANGE_KEEP, now };
    return { reply: ok(off) };
  }
  return {};
}

function toSummary(r: ExchangeSummaryRow): ExchangeSummary {
  return {
    id: r.id,
    ts: r.ts,
    callId: r.callId,
    batch: r.batch,
    surface: r.surface,
    context: r.context,
    model: r.model,
    target: r.target,
    outcome: r.outcome as ExchangeSummary["outcome"],
    status: r.httpStatus,
    timedOut: r.timedOut,
    attempts: r.attempts,
    waitMs: r.waitMs,
    jobWaitMs: r.jobWaitMs,
    ttfbMs: r.ttfbMs,
    durationMs: r.durationMs,
    retryWaitMs: r.retryWaitMs,
    deadlineMs: r.deadlineMs,
    budgetMs: r.budgetMs,
    items: r.items,
    rowIds: r.rowIds,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
    requestBytes: r.requestBytes,
    requestTruncated: r.requestTruncated,
    responseBytes: r.responseBytes,
    responseTruncated: r.responseTruncated,
  };
}

/** A stored body is valid JSON unless it was cut at the cap; the flag tells the viewer which. */
function bodyOf(text: string, bytes: number, truncated: boolean): ExchangeDetail["request"] {
  let json = false;
  if (!truncated) {
    try {
      JSON.parse(text);
      json = true;
    } catch {
      json = false;
    }
  }
  return { text, json, bytes, truncated };
}

function toDetail(r: ExchangeRow): ExchangeDetail {
  return {
    ...toSummary(r),
    request: bodyOf(r.requestBody, r.requestBytes, r.requestTruncated),
    response:
      r.responseBody === null
        ? null
        : bodyOf(r.responseBody, r.responseBytes ?? r.responseBody.length, r.responseTruncated),
    error: r.error,
  };
}

/**
 * The stored Jev requests, newest first, without bodies or error text. The config is read first:
 * Jev off or not the provider answers {active:false}, capture off answers {capture:false}, and
 * neither opens the database. Reads only; never reconciles. A busy or missing database is a 503
 * with a fixed message.
 */
export function jevExchangesPayload(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps = {},
  filter: { limit?: number | undefined; row?: number | undefined } = {},
): Reply {
  const now = (deps.now ?? Date.now)();
  const gate = exchangeGate(ctx, deps, now);
  if (gate.reply) return gate.reply;
  try {
    const db = deps.db ?? getStorage(ctx);
    const { rows, total } = db.adjudicator.exchangeList({
      limit: filter.limit ?? EXCHANGE_KEEP,
      ...(filter.row !== undefined ? { rowId: filter.row } : {}),
    });
    const payload: JevExchangesPayload = {
      active: true,
      capture: true,
      keep: EXCHANGE_KEEP,
      total,
      rows: rows.map(toSummary),
      now,
    };
    return ok(payload);
  } catch {
    return fail(503, JEV_UNAVAILABLE);
  }
}

/** One stored Jev request with its bodies. Same gate and failure mode as jevExchangesPayload. */
export function jevExchangePayload(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps = {},
  id: number,
): Reply {
  const now = (deps.now ?? Date.now)();
  const gate = exchangeGate(ctx, deps, now);
  if (gate.reply) return gate.reply;
  try {
    const db = deps.db ?? getStorage(ctx);
    const r = db.adjudicator.exchangeGet(id);
    if (!r) return fail(404, `request ${id} not found`);
    const payload: JevExchangePayload = {
      active: true,
      capture: true,
      exchange: toDetail(r),
      now,
    };
    return ok(payload);
  } catch {
    return fail(503, JEV_UNAVAILABLE);
  }
}

/** A positive integer id from a query value, or an error reply. */
function idOf(q: URLSearchParams, key: string, required: boolean): Parsed<number | undefined> {
  const raw = q.get(key);
  if (raw === null || raw === "") {
    return required
      ? { error: fail(400, `${key} must be a positive integer`) }
      : { value: undefined };
  }
  if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1)
    return { error: fail(400, `${key} must be a positive integer`) };
  return { value: Number(raw) };
}

// --- GET /api/adjudicator/decisions + /decision -----------------------------------------

/** A call-log row: everything but the scores JSON. input_head is already redacted and ≤ 80 chars. */
export type DecisionRow = Omit<AdjudicationRow, "scores"> & { hasScores: boolean };

function listRow(row: AdjudicationRow): DecisionRow {
  const { scores, ...rest } = row;
  return { ...rest, hasScores: !!scores };
}

function parseScores(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- GET /api/adjudicator/eval ----------------------------------------------------------

/** Drop any `text` / `input` / `prompt` string field: the report must not carry item text. */
function stripText(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => stripText(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((k === "text" || k === "input" || k === "prompt") && typeof x === "string") continue;
    out[k] = stripText(x, depth + 1);
  }
  return out;
}

export function evalPayload(db: StorageAdapter) {
  const raw = db.metaGet(EVAL_META_KEY);
  if (!raw) return { report: null };
  try {
    return { report: stripText(JSON.parse(raw)) };
  } catch {
    return { report: null, error: "the stored eval report is not valid JSON" };
  }
}

// --- POST /api/adjudicator/test ---------------------------------------------------------

/**
 * The store the try-it run sees: breaker state and spend are real (a test call is a real call
 * and counts against the daily cap), but nothing is inserted, cached or read from the cache.
 */
function tryItStore(store: AdjudicatorStore): AdjudicatorStore {
  // Every method spelled out: the store is a class instance, so spreading it would drop them.
  const never = (): never => {
    throw new Error("try-it is never persisted");
  };
  const atomically = store.atomically?.bind(store);
  const withLockWait = store.withLockWait?.bind(store);
  return {
    insert: never,
    update: () => false,
    get: (id) => store.get(id),
    list: (f) => store.list(f),
    latestForSession: (s, surface) => store.latestForSession(s, surface),
    byToolUseId: (id, f) => store.byToolUseId(id, f),
    forTask: (run, task) => store.forTask(run, task),
    forRun: (run) => store.forRun(run),
    nonFinal: (limit, olderThan) => store.nonFinal(limit, olderThan),
    cacheGet: () => undefined,
    cachePut: () => undefined,
    cachePrune: () => 0,
    providerState: (p) => store.providerState(p),
    saveProviderState: (p, patch) => store.saveProviderState(p, patch),
    biasAll: () => store.biasAll(),
    biasUpsert: never,
    biasReset: never,
    summary: (since) => store.summary(since),
    exchangeInsert: never,
    exchangeList: (f) => store.exchangeList(f),
    exchangeGet: (id) => store.exchangeGet(id),
    exchangeCount: () => store.exchangeCount(),
    exchangePurge: never,
    purge: never,
    // The breaker's read-modify-write must stay atomic here too: a try-it call races hooks.
    ...(atomically ? { atomically } : {}),
    // ...and its lock waits stay bounded by the call budget, as in the hooks.
    ...(withLockWait ? { withLockWait } : {}),
  };
}

/** The verdict without its request key or row id. */
function verdictView(v: Verdict) {
  const { key: _key, id: _id, ...rest } = v;
  return rest;
}

export type TryItReason =
  | "used"
  | "disabled"
  | "not_requested"
  | "heuristic_configured"
  | "no_key"
  | "no_consent"
  | "hook_context"
  | "misconfigured";

export async function testPayload(
  ctx: ProjectContext,
  body: Record<string, unknown>,
  deps: AdjudicatorRouteDeps = {},
): Promise<Reply> {
  const text = body.text;
  if (typeof text !== "string" || !text.trim()) return fail(400, "text required");
  if (text.length > TEST_TEXT_MAX)
    return fail(400, `text is longer than ${TEST_TEXT_MAX} characters`);
  if (body.useProvider !== undefined && typeof body.useProvider !== "boolean")
    return fail(400, "useProvider must be a boolean");
  const e = envOf(ctx, deps);
  const a = e.config.adjudicator;
  const r = resolve(e);
  let reason: TryItReason;
  if (!a.enabled) reason = "disabled";
  else if (body.useProvider !== true) reason = "not_requested";
  else if (r.configured === "heuristic") reason = "heuristic_configured";
  else if (r.degraded) reason = r.degraded;
  else reason = "used";
  const useProvider = reason === "used";

  if (useProvider && r.provider === "embedding" && !hasProvider("embedding") && !deps.provider) {
    const { defaultEmbeddingFactory } = await import("../adjudicator/providers/embedding.js");
    registerProvider("embedding", defaultEmbeddingFactory(e.config));
  }
  // Heuristic-only runs score with a heuristic config, so the source reads "heuristic".
  const cfg: AdjudicatorConfig = useProvider ? a : { ...a, provider: "heuristic" };
  const store = tryItStore(e.db.adjudicator);
  let biasRows: ReturnType<AdjudicatorStore["biasAll"]> = [];
  try {
    biasRows = store.biasAll();
  } catch {
    biasRows = [];
  }
  const learning = { ...DEFAULT_LEARNING, ...a.learning };
  const out = await adjudicateOne(
    { key: "test", surface: "test", text },
    {
      config: cfg,
      store,
      context: "server",
      persist: false,
      // Disabled: still score (heuristic only); persist:false keeps it out of the DB.
      ignoreEnabled: !a.enabled,
      ...(useProvider ? {} : { provider: null }),
      ...(useProvider && deps.provider !== undefined ? { provider: deps.provider } : {}),
      ...(e.env ? { env: e.env } : {}),
      bias: (_req, f, h) =>
        biasFromRows(biasRows, learning, {
          complexity: h.complexity,
          intent: topIntent(f) ?? "none",
        }),
    },
  );
  const v = out.verdict;
  return ok({
    enabled: a.enabled,
    usedProvider: useProvider,
    reason,
    provider: providerView(r),
    verdict: verdictView(v),
    features: out.features,
    providerModel: out.providerModel ?? null,
    advice: formatAdvice(v, "prompt"),
    chars: text.length,
    persisted: false,
  });
}

// --- routing ----------------------------------------------------------------------------

/**
 * Route `/api/adjudicator` and `/api/adjudicator/*`. The server has already checked the
 * loopback origin and the JSON content type of every non-GET request.
 */
export async function adjudicatorRoute(
  ctx: ProjectContext,
  req: {
    path: string;
    method: string;
    query: URLSearchParams;
    body: () => Promise<unknown>;
  },
  deps: AdjudicatorRouteDeps = {},
): Promise<Reply> {
  const { path, method, query } = req;
  const isGet = method === "GET" || method === "HEAD";
  const now = (deps.now ?? Date.now)();

  if (path === "/api/adjudicator") {
    if (!isGet) return fail(405, "GET only");
    const since = sinceOf(query, now, DEFAULT_SINCE);
    if (since.error) return since.error;
    return ok(overviewPayload(ctx, deps, since.value));
  }
  if (path === "/api/adjudicator/decisions") {
    if (!isGet) return fail(405, "GET only");
    const since = sinceOf(query, now);
    if (since.error) return since.error;
    const surface = enumOf(query, "surface", SURFACES);
    if (surface.error) return surface.error;
    const provider = enumOf(query, "provider", PROVIDER_IDS);
    if (provider.error) return provider.error;
    const outcome = enumOf(query, "outcome", OUTCOMES);
    if (outcome.error) return outcome.error;
    const limit = intOf(query, "limit", {
      min: 1,
      max: DECISIONS_LIMIT_MAX,
      fallback: DECISIONS_LIMIT_DEFAULT,
    });
    if (limit.error) return limit.error;
    const offset = intOf(query, "offset", { min: 0, max: 100_000_000, fallback: 0 });
    if (offset.error) return offset.error;
    const e = envOf(ctx, deps);
    const reconciled = reconcileFirst(e);
    const { rows, total } = e.db.adjudicator.list({
      since: since.value,
      surface: surface.value,
      provider: provider.value,
      outcome: outcome.value,
      limit: limit.value,
      offset: offset.value,
    });
    return ok({
      rows: rows.map(listRow),
      total,
      limit: limit.value,
      offset: offset.value,
      since: since.value ?? null,
      reconcile: reconciled,
      now: e.now,
    });
  }
  if (path === "/api/adjudicator/decision") {
    if (!isGet) return fail(405, "GET only");
    const raw = query.get("id") ?? "";
    if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1) return fail(400, "id must be a decision id");
    const e = envOf(ctx, deps);
    const reconciled = reconcileFirst(e);
    const row = e.db.adjudicator.get(Number(raw));
    if (!row) return fail(404, `decision ${raw} not found`);
    const { scores, ...rest } = row;
    return ok({ row: rest, scores: parseScores(scores), reconcile: reconciled, now: e.now });
  }
  if (path === "/api/adjudicator/savings") {
    if (!isGet) return fail(405, "GET only");
    const since = sinceOf(query, now, DEFAULT_SINCE);
    if (since.error) return since.error;
    const e = envOf(ctx, deps);
    const reconciled = reconcileFirst(e);
    const pricing = pricingOf(e.config);
    const report = savingsReport(e.db, {
      ...(since.value !== undefined ? { since: since.value } : {}),
      ...(pricing ? { pricing } : {}),
    });
    return ok({ ...report, reconcile: reconciled, now: e.now });
  }
  if (path === "/api/adjudicator/eval") {
    if (!isGet) return fail(405, "GET only");
    const e = envOf(ctx, deps);
    return ok({ ...evalPayload(e.db), now: e.now });
  }
  if (path === "/api/adjudicator/jev") {
    if (!isGet) return fail(405, "GET only");
    const since = sinceOf(query, now, DEFAULT_SINCE);
    if (since.error) return since.error;
    const surface = enumOf(query, "surface", JEV_SURFACES);
    if (surface.error) return surface.error;
    return jevPayload(ctx, deps, { since: since.value, surface: surface.value });
  }
  if (path === "/api/adjudicator/jev/exchanges") {
    if (!isGet) return fail(405, "GET only");
    const limit = intOf(query, "limit", { min: 1, max: EXCHANGE_KEEP, fallback: EXCHANGE_KEEP });
    if (limit.error) return limit.error;
    const row = idOf(query, "row", false);
    if (row.error) return row.error;
    return jevExchangesPayload(ctx, deps, { limit: limit.value, row: row.value });
  }
  if (path === "/api/adjudicator/jev/exchange") {
    if (!isGet) return fail(405, "GET only");
    const id = idOf(query, "id", true);
    if (id.error) return id.error;
    return jevExchangePayload(ctx, deps, id.value as number);
  }
  if (path === "/api/adjudicator/security" || path.startsWith("/api/adjudicator/security/"))
    return securityRoute(ctx, req, deps);
  if (path === "/api/adjudicator/test") {
    if (method !== "POST") return fail(405, "POST only");
    let body: unknown;
    try {
      body = await req.body();
    } catch {
      return fail(400, "invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail(400, "body must be a JSON object");
    return testPayload(ctx, body as Record<string, unknown>, deps);
  }
  return fail(404, "not found");
}
