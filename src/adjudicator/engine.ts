/**
 * The adjudication pipeline (docs/design/adjudicator.md §3, §9):
 *
 *   cache → heuristic → gate (enabled, consent, key, breaker, slow, budget) → provider → blend → persist
 *
 * The heuristic scores a plan or agent brief per statement (units.ts): its hardest statement sets
 * the complexity, tier and effort, role and tool are votes summed over the statements, and the
 * routine checks and hand-in steps a brief ends with are left out. Every other surface, and every
 * request when `units` is false, is scored as one text.
 *
 * `adjudicate()` NEVER throws and never waits past its budget: a provider that hangs is cut off
 * by a timer racing the call (its AbortSignal fires at the same moment), so the heuristic comes
 * back within budget + a few ms. Persistence and cache failures (DB busy, v8 not migrated) are
 * swallowed: the verdict is still returned, just not stored. Every write waits for another
 * process's lock no longer than the budget left (LOCK_WAIT_MAX_MS at most), and a breaker gate
 * that cannot be read or written FAILS CLOSED: the provider is not called and the heuristic
 * answers, so a busy database can never bypass an open breaker, the daily caps or an auth
 * lockout.
 *
 * Cache: keyed by sha256(SCORER_VERSION | configured provider | model | surface | inputs | text),
 * where inputs are the hints, tool/role catalogues, tier ladder and weights, plus UNITS_VERSION for
 * a brief scored per statement (cacheKeyFor), so
 * the hooks pick up verdicts the server's embedding provider wrote for the same request. Only provider-blended verdicts
 * are cached (the heuristic is cheaper than a lookup). A null entry is the `pending` marker of a
 * running async job; it dedupes jobs for PENDING_TTL_MS.
 *
 * Call modes: "inline" calls the provider within the budget; "async" leaves the heuristic in
 * place and spawns one detached job per uncached request (async.ts), which later writes the
 * cache and updates the row; "never" makes no network call at all (advise-mode agent dispatch).
 *
 * Exchange log: with privacy.captureExchanges on, Jev the provider and rows to link to (persisted,
 * or the async job's linkRowIds), each HTTP request of the call is stored after its rows
 * (writeExchanges). Off, the provider gets no sink and nothing else runs.
 */

import { createHash } from "node:crypto";
import type { AdjudicatorConfig } from "../config.js";
import type {
  AdjudicationInput,
  AdjudicationPatch,
  AdjudicatorStore,
  ExchangeInput,
} from "../storage/types.js";
import type { AsyncJob } from "./async.js";
import { blend } from "./blend.js";
import {
  authLockout,
  gate,
  overBudget,
  recordFailure,
  recordSuccess,
  unrecorded,
} from "./breaker.js";
import {
  currentKeyFingerprint,
  type Resolved,
  type RuntimeContext,
  resolveAdjudicator,
} from "./config.js";
import { extractFeatures } from "./features.js";
import { type Catalogue, DEFAULT_TIERS, scoreHeuristic } from "./heuristic.js";
import { createProvider, type ProviderDeps, ProviderError } from "./providers/index.js";
import { head, inputHash, normalize } from "./redact.js";
import { security } from "./security/load.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  type Features,
  type ProviderAnswer,
  type ProviderExchange,
  type ProviderId,
  type ProviderResult,
  type ProviderStatus,
  SCORER_VERSION,
  type ScoreSet,
  type Surface,
  type Verdict,
} from "./types.js";
import { type BriefUnits, scoreUnits, UNITS_VERSION, unitScored } from "./units.js";

/** How long a pending marker blocks a second async job for the same key. */
export const PENDING_TTL_MS = 30_000;
/** Text that goes into the cache key (after normalisation). */
export const CACHE_KEY_CHARS = 2000;
/** Prune the cache on about one write in this many (hooks are separate processes). */
export const PRUNE_EVERY = 100;
/**
 * The longest any one statement waits for another process's write lock (MCP server reindex,
 * usage ingest, another hook). Every wait is also capped by what is left of the call budget, so
 * a held lock costs a hook at most its budget plus a few LOCK_WAIT_FLOOR_MS tries.
 */
export const LOCK_WAIT_MAX_MS = 250;
/** Breaker and row writes after the budget is spent still get this long (counters matter). */
export const LOCK_WAIT_FLOOR_MS = 25;

export type CallMode = "inline" | "async" | "never";

export interface EngineOptions {
  /** The adjudicator section of the config. */
  config: AdjudicatorConfig;
  /** Where verdicts, rows and breaker state live; without it nothing is cached or persisted. */
  store?: AdjudicatorStore | undefined;
  /** Precomputed resolution (default: resolveAdjudicator(config, {context, env})). */
  resolved?: Resolved | undefined;
  /** Default "hook": the embedding provider only runs in "server" or "cli". */
  context?: RuntimeContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Default "inline". */
  call?: CallMode | undefined;
  /** Total budget in ms from the call (default: surfaceBudget for the first request's surface). */
  budgetMs?: number | undefined;
  /** Insert one adjudications row per request (default true; needs `store`). */
  persist?: boolean | undefined;
  /** Extra columns for every inserted row (sessionId, agentId, runId, action, ...). */
  row?: Partial<AdjudicationInput> | undefined;
  /** Extra columns per request, by index (e.g. the plan's taskId). */
  rows?: ReadonlyArray<Partial<AdjudicationInput> | undefined> | undefined;
  /** Learned bias as a flat "<dimension>:<option>" map, or a function per request (learn.ts). */
  bias?:
    | Record<string, number>
    | ((req: AdjudicationRequest, f: Features, h: ScoreSet) => Record<string, number>)
    | undefined;
  /** Registered tool ids; narrows the tool table (default TOOL_IDS). */
  tools?: readonly string[] | undefined;
  /** Role options when a request carries no hints.roles (e.g. the active swarm's roles). */
  roles?: ReadonlyArray<{ name: string; description?: string }> | undefined;
  /**
   * Score plan and agent briefs per statement (units.ts). Default true; false scores every
   * request as one text (the eval harness, which compares providers on prompts). An async job's
   * child always uses the default.
   */
  units?: boolean | undefined;
  /** Passed to createProvider (fetch, log, env, tools seams). */
  deps?: ProviderDeps | undefined;
  /** A ready provider (test seam, or the server's long-lived instance); null forces heuristic. */
  provider?: AdjudicatorProvider | null | undefined;
  /**
   * call "async": starts the job; hooks pass spawnAsyncJob from async.ts (the engine does not import
   * it, so async.ts can import the engine without a cycle). Returns false when it could not.
   */
  spawn?: ((job: AsyncJob) => boolean) | undefined;
  /** call "async": the project root the child opens its DB under. */
  projectRoot?: string | undefined;
  /**
   * Row ids of the requests' decisions when this call inserts none itself (the async job's
   * job.rowId), by index: lets a captured Jev exchange name the rows it served.
   */
  linkRowIds?: ReadonlyArray<number | undefined> | undefined;
  /** The async job's queue time (child start − queuedAt), stored with a captured exchange. */
  jobWaitMs?: number | undefined;
  /**
   * The async job's re-check of the CURRENT capture setting (it outlives the config it was queued
   * with). Asked before the provider gets a sink and again right before the exchange is stored;
   * false drops the capture and nothing else.
   */
  captureStillOn?: (() => boolean) | undefined;
  /** Run even when `enabled` is false (the CLI's `test`); nothing is persisted then unless persist is true. */
  ignoreEnabled?: boolean | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
  /** Test seam for the 1-in-PRUNE_EVERY cache prune. */
  random?: (() => number) | undefined;
}

export interface Adjudication {
  request: AdjudicationRequest;
  /** Always carries `heuristicComplexity` (Verdict). */
  verdict: Verdict;
  cacheKey: string;
  features: Features;
  /** The adjudications row, when one was inserted. */
  rowId?: number;
  /** call "async": a job was spawned for this request, or one was already pending. */
  queued?: boolean;
  /** The model the provider reported, when it answered. */
  providerModel?: string;
  /**
   * How a plan or agent brief was scored per statement, with `saturated` (the kept statements
   * sum past the 0..4 clamp) and the heuristic's role confidence; also stored as `units` in the row's
   * scores JSON (units.briefUnitsOf reads it back). Absent for one-text scoring.
   */
  units?: BriefUnits;
}

/** The provider budget for a surface; local providers use timeouts.localMs on hook surfaces. */
export function surfaceBudget(cfg: AdjudicatorConfig, surface: Surface, local = false): number {
  const t = cfg.timeouts;
  switch (surface) {
    case "prompt":
      return local ? t.localMs : t.promptMs;
    case "agent":
    case "tool":
      return local ? t.localMs : t.agentMs;
    default:
      return t.planMs;
  }
}

/**
 * Everything besides the text that changes a blended verdict: the request hints, the tool and
 * role catalogues the heuristic scores over, and the configured tier ladder and weights. Two
 * requests with the same text but different hints or catalogues must not share a cache entry.
 */
export interface CacheKeyContext {
  config?: Pick<AdjudicatorConfig, "tiers" | "weights"> | undefined;
  /** The registered tool ids (EngineOptions.tools); default TOOL_IDS. */
  tools?: readonly string[] | undefined;
  /** Role options used when the request has no hints.roles (EngineOptions.roles). */
  roles?: ReadonlyArray<{ name: string; description?: string }> | undefined;
  /** EngineOptions.units: false keys plan and agent requests as one-text scores. */
  units?: boolean | undefined;
}

/** Whether this request is scored per statement under these options (units.ts). */
function byUnits(surface: string, units: boolean | undefined): boolean {
  return units !== false && unitScored(surface);
}

/** JSON with object keys sorted, so equal inputs always hash the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The cache key (§9): never the text itself, nor any other raw input (all go through sha256). */
export function cacheKeyFor(
  req: Pick<AdjudicationRequest, "surface" | "text" | "hints">,
  r: Pick<Resolved, "configured" | "model">,
  ctx: CacheKeyContext = {},
): string {
  const text = normalize(req.text).toLowerCase().replace(/\s+/g, " ").slice(0, CACHE_KEY_CHARS);
  const h = req.hints;
  const roles = h?.roles ?? ctx.roles;
  const inputs = stableJson({
    files: h?.files,
    deps: h?.deps,
    role: h?.role,
    // Order does not change the scores; descriptions do (the heuristic matches on them).
    roles: roles
      ?.map((x) => ({ name: x.name, description: x.description ?? "" }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    // The docs names change the PKG rule (features.ts); a set, so order and repeats do not count.
    libraries: h?.libraries ? [...new Set(h.libraries)].sort() : undefined,
    tools: ctx.tools ? [...ctx.tools].sort() : undefined,
    // The ladder is ordered, so its order stays.
    tiers: ctx.config?.tiers,
    weights: ctx.config?.weights,
    // A brief scored per statement blends onto another heuristic than the same text scored whole.
    units: byUnits(req.surface, ctx.units) ? UNITS_VERSION : undefined,
    // The security questions change the answer: only a request with a hint is keyed on it.
    security: h?.security ? security().prompt.securityKeyPart(h.security) : undefined,
  });
  return createHash("sha256")
    .update([SCORER_VERSION, r.configured, r.model ?? "", req.surface, inputs, text].join("|"))
    .digest("hex");
}

/** The tool catalogue the engine scores over for these options (prepare() and the cache key). */
function toolsOf(opts: EngineOptions): readonly string[] | undefined {
  return opts.tools ?? opts.deps?.tools;
}

/** The verdict columns of an adjudications row (insert, or the async job's update). */
export function verdictColumns(
  v: Verdict,
  o: {
    features?: Features | undefined;
    providerModel?: string | undefined;
    units?: BriefUnits | undefined;
  } = {},
): AdjudicationPatch {
  const u = v.usage;
  const scores = {
    complexity: v.complexity,
    complexityReasons: v.complexityReasons,
    tool: v.tool,
    tier: v.tier,
    role: v.role,
    effort: v.effort,
    features: o.features,
    alpha: v.alpha,
    bias: v.bias,
    heuristicComplexity: v.heuristicComplexity,
    units: o.units,
    securityModel: v.security,
  };
  return {
    complexity: v.complexity,
    tier: v.tier.choice,
    effort: v.effort,
    tool: v.tool.choice,
    role: v.role.choice,
    confidence: v.tier.confidence,
    scores: JSON.stringify(scores),
    source: v.source,
    provider: v.provider,
    providerModel: o.providerModel ?? null,
    providerStatus: v.providerStatus,
    latencyMs: Math.round(v.latencyMs),
    providerLatencyMs: v.providerLatencyMs !== undefined ? Math.round(v.providerLatencyMs) : null,
    tokensIn: u ? u.inTok : null,
    tokensOut: u ? u.outTok : null,
    costUsd: u ? u.costUsd : null,
    version: v.version,
  };
}

const statusOfDegraded = (r: Resolved): ProviderStatus => {
  switch (r.degraded) {
    case "no_key":
      return "no_key";
    case "no_consent":
      return "no_consent";
    case undefined:
      return "n/a";
    default:
      return "skipped";
  }
};

interface Item {
  req: AdjudicationRequest;
  cfg?: AdjudicatorConfig;
  index: number;
  features: Features;
  h: ScoreSet;
  bias: Record<string, number>;
  cacheKey: string;
  verdict?: Verdict;
  pending?: boolean;
  queued?: boolean;
  providerModel?: string | undefined;
  job?: AsyncJob;
  units?: BriefUnits | undefined;
}

/**
 * Score `reqs` through the whole pipeline. Never throws; resolves within the budget (+ timer
 * slack) even when the provider ignores its AbortSignal.
 */
export async function adjudicate(
  reqs: readonly AdjudicationRequest[],
  opts: EngineOptions,
): Promise<Adjudication[]> {
  const now = opts.now ?? Date.now;
  const start = now();
  const log = opts.log ?? (() => {});
  const items: Item[] = [];
  try {
    const cfg = opts.config;
    for (const [index, req] of reqs.entries()) items.push(prepare(req, index, opts));
    if (!items.length) return [];

    const enabled = cfg.enabled || opts.ignoreEnabled === true;
    const r =
      opts.resolved ??
      resolveAdjudicator(cfg, {
        context: opts.context ?? "hook",
        ...(opts.env ? { env: opts.env } : {}),
      });
    const store = opts.store;
    // Off means nothing is written; the CLI's ignoreEnabled run persists only when asked to.
    const persist =
      !!store && (cfg.enabled ? opts.persist !== false : enabled && opts.persist === true);
    const firstSurface = items[0]?.req.surface ?? "prompt";
    const budgetMs = Math.max(0, opts.budgetMs ?? surfaceBudget(cfg, firstSurface, r.local));
    const locks = new LockBudget(start + budgetMs, now);
    const keyCtx: CacheKeyContext = {
      config: cfg,
      tools: toolsOf(opts),
      roles: opts.roles,
      units: opts.units,
    };
    for (const it of items) it.cacheKey = cacheKeyFor(it.req, r, keyCtx);

    if (!enabled) {
      for (const it of items) it.verdict = heuristicVerdict(it, "heuristic", "heuristic", "n/a");
      return finish(items, opts, start, now, false, locks);
    }

    // 1. Cache (not for a configured heuristic: scoring is cheaper than the lookup).
    const useCache = r.configured !== "heuristic" && !!store;
    if (useCache && store) {
      const ttlMs = cfg.cache.ttlHours * 3_600_000;
      for (const it of items) {
        // The hit counter bump never waits: a locked database still serves the hit.
        const hit = safe(
          () => locks.run(store, 0, () => store.cacheGet(it.cacheKey, now(), ttlMs)),
          log,
        );
        if (!hit) continue;
        if (hit.verdict) {
          // A hit costs nothing and belongs to no earlier row.
          const { id: _id, usage: _usage, providerLatencyMs: _pl, ...cached } = hit.verdict;
          it.verdict = { ...cached, key: it.req.key, source: "cache" };
        } else if (now() - hit.createdAt < PENDING_TTL_MS) {
          it.pending = true;
        }
      }
    }
    const misses = items.filter((it) => !it.verdict);
    if (!misses.length) return finish(items, opts, start, now, persist, locks);

    // 2. Gate: effective provider, call mode, provider instance, breaker / slow / budget.
    const fallback = (status: ProviderStatus) => {
      const source = r.configured === "heuristic" ? "heuristic" : "fallback";
      for (const it of misses) it.verdict = heuristicVerdict(it, r.configured, source, status);
      return finish(items, opts, start, now, persist, locks);
    };
    if (r.provider === "heuristic") return fallback(statusOfDegraded(r));
    const call = opts.call ?? "inline";
    if (call === "never") return fallback("skipped");
    const provider =
      opts.provider !== undefined
        ? opts.provider
        : safe(
            () => createProvider(r, cfg, { log, env: opts.env, tools: opts.tools, ...opts.deps }),
            log,
          );
    if (!provider) return fallback("skipped");

    // Fingerprint of the key in use (never the key): a 401/403 locks out only this key.
    const keyFp = safe(() => currentKeyFingerprint(r, opts.env), log) ?? null;

    if (call === "async") {
      // The hook only peeks at the breaker; the child claims a half-open slot when it runs.
      const peek = store ? safe(() => peekGate(store, r, cfg, now(), keyFp), log) : undefined;
      if (peek) return fallback(peek);
      for (const it of misses) {
        it.verdict = heuristicVerdict(it, r.configured, "fallback", "skipped");
        if (it.pending) it.queued = true;
        else it.job = buildJob(it, cfg, opts, budgetMs);
      }
      // Rows first, so each job can carry the id of the row it will update.
      const out = finish(items, opts, start, now, persist, locks);
      for (const [i, it] of items.entries()) {
        if (!it.job) continue;
        const a = out[i] as Adjudication;
        if (a.rowId !== undefined) it.job.rowId = a.rowId;
        const job = it.job;
        const spawned = opts.spawn ? safe(() => opts.spawn?.(job), log) === true : false;
        if (!opts.spawn) log("adjudicator: async call without a spawn function");
        if (!spawned) continue;
        a.queued = true;
        if (store)
          safe(
            () => locks.run(store, 0, () => store.cachePut(it.cacheKey, null, r.configured, now())),
            log,
          );
      }
      return out;
    }

    let halfOpen = false;
    if (store) {
      // Half of what is left may go to waiting for a lock the gate must write under (a
      // half-open claim); the plain closed / open / over-budget answers only read.
      const g = safe(
        () =>
          locks.guard(() =>
            gate(store, r.provider, cfg, {
              now: now(),
              remote: r.remote,
              keyFingerprint: keyFp,
              lockWaitMs: Math.floor(locks.wait() / 2),
            }),
          ),
        log,
      );
      // No answer (database busy or broken): fail CLOSED. Calling the provider here would
      // ignore an open breaker, an exhausted daily budget or a rejected key.
      if (!g) {
        log(`adjudicator: ${r.provider} gate unavailable; heuristic this call`);
        return fallback("skipped");
      }
      if (!g.allow) return fallback(g.status);
      halfOpen = g.halfOpen;
    }

    // 3. Provider, raced against the remaining budget.
    const remaining = budgetMs - (now() - start);
    if (remaining <= 0) return fallback("timeout");
    // Jev exchange log (privacy.captureExchanges, personal config only): a sink only when on,
    // and only when the decisions it serves have rows to link to.
    const sink =
      cfg.privacy.captureExchanges === true &&
      r.provider === "typesafe" &&
      store &&
      (persist || !!opts.linkRowIds) &&
      (opts.captureStillOn?.() ?? true)
        ? ([] as ProviderExchange[])
        : undefined;
    const callStart = now();
    const outcome = await callWithin(
      provider,
      misses.map((it) => it.req),
      remaining,
      sink,
    );
    const providerLatencyMs = now() - callStart;
    // Warm-up and test/probe calls (surface "test": cold model loads, CLI test, try-it) say
    // nothing about the latency of real work, so they stay out of the slow guard.
    const sample = !misses.some((it) => it.req.surface === "test");

    if (!outcome.ok) {
      const kind = outcome.kind;
      log(`adjudicator: ${r.provider} ${kind}${outcome.status ? ` ${outcome.status}` : ""}`);
      if (store)
        record(store, r.provider, now(), log, locks, () =>
          recordFailure(store, r.provider, cfg, {
            now: now(),
            kind,
            status: outcome.status,
            latencyMs: providerLatencyMs,
            budgetMs,
            halfOpen,
            keyFingerprint: keyFp,
            sample,
            lockWaitMs: locks.wait(LOCK_WAIT_FLOOR_MS),
          }),
        );
      for (const it of misses) {
        it.verdict = heuristicVerdict(it, r.provider, "fallback", kind);
        it.verdict.providerLatencyMs = providerLatencyMs;
      }
      const failed = finish(items, opts, start, now, persist, locks);
      if (sink && store) writeExchanges(store, sink, misses, failed, opts, start, budgetMs, locks);
      return failed;
    }

    // 4. Blend each answered request; missing answers keep the heuristic (per key).
    const res = outcome.result;
    if (store)
      record(store, r.provider, now(), log, locks, () =>
        recordSuccess(store, r.provider, cfg, {
          now: now(),
          // The time this call measured, not what the provider reports: the budget governs
          // the wall clock, and a provider cannot report itself slower or faster than it was.
          latencyMs: providerLatencyMs,
          costUsd: res.usage.costUsd,
          budgetMs,
          sample,
          lockWaitMs: locks.wait(LOCK_WAIT_FLOOR_MS),
        }),
      );
    const byKey = new Map<string, ProviderAnswer>();
    for (const a of res.answers) if (!byKey.has(a.key)) byKey.set(a.key, a);
    const answered = misses.filter((it) => byKey.has(it.req.key)).length;
    // Each answered request carries its share of the batch's usage, so rows and cache entries
    // sum to what the call cost.
    const share = answered ? 1 / answered : 0;
    const u = res.usage;
    const usage = {
      inTok: Math.round(u.inTok * share),
      outTok: Math.round(u.outTok * share),
      costUsd: u.costUsd === null ? null : u.costUsd * share,
    };
    for (const it of misses) {
      const answer = byKey.get(it.req.key);
      if (!answer) {
        it.verdict = heuristicVerdict(it, r.provider, "fallback", "skipped");
        it.verdict.providerLatencyMs = providerLatencyMs;
        continue;
      }
      it.verdict = blend(it.h, answer, it.bias, cfg.weights, {
        key: it.req.key,
        provider: r.provider,
        providerStatus: "ok",
        source: "blend",
        tiers: cfg.tiers,
        providerLatencyMs,
        usage,
      });
      // The model's security answer rides on the verdict (and so in the cache); the combination
      // with the heuristic (it can only raise) is security/combine.ts's.
      if (answer.security) it.verdict.security = answer.security;
      it.providerModel = res.model || r.model;
      if (store) {
        const v = it.verdict;
        safe(
          () => locks.run(store, 0, () => store.cachePut(it.cacheKey, v, r.configured, now())),
          log,
        );
      }
    }
    if (store && answered && (opts.random ?? Math.random)() < answered / PRUNE_EVERY)
      safe(
        () =>
          locks.run(store, 0, () =>
            store.cachePrune(cfg.cache.maxEntries, cfg.cache.ttlHours * 3_600_000, now()),
          ),
        log,
      );
    const out = finish(items, opts, start, now, persist, locks);
    if (sink && store) writeExchanges(store, sink, misses, out, opts, start, budgetMs, locks);
    return out;
  } catch (err) {
    // Last resort: whatever went wrong, every request still gets a heuristic verdict.
    log(`adjudicator: engine error ${(err as Error)?.message ?? String(err)}`);
    for (const [index, req] of reqs.entries()) {
      const it = items[index] ?? safePrepare(req, index, opts);
      if (!it.verdict) it.verdict = heuristicVerdict(it, "heuristic", "heuristic", "n/a");
      items[index] = it;
    }
    return items.map((it) => ({
      request: it.req,
      verdict: {
        ...(it.verdict as Verdict),
        latencyMs: now() - start,
        heuristicComplexity: it.h.complexity,
      },
      cacheKey: it.cacheKey,
      features: it.features,
      ...(it.units ? { units: it.units } : {}),
    }));
  }
}

/** One request through the pipeline; never throws. */
export async function adjudicateOne(
  req: AdjudicationRequest,
  opts: EngineOptions,
): Promise<Adjudication> {
  const [out] = await adjudicate([req], opts);
  return out as Adjudication;
}

// --- internals -----------------------------------------------------------------

function prepare(req: AdjudicationRequest, index: number, opts: EngineOptions): Item {
  const cfg = opts.config;
  const catalogue: Catalogue = { tiers: cfg.tiers };
  const tools = toolsOf(opts);
  if (tools) catalogue.tools = tools;
  const roles = req.hints?.roles ?? opts.roles;
  if (roles?.length) catalogue.roles = roles;
  const weights = { tierCenters: cfg.weights.tierCenters, features: cfg.weights.features };
  // A brief per statement (units.ts); its `features` are the kept statements', not the boilerplate's.
  const brief = byUnits(req.surface, opts.units)
    ? scoreUnits(req.text, req.hints, weights, catalogue)
    : undefined;
  const features = brief?.features ?? extractFeatures(req.text, req.hints);
  const h = brief?.set ?? scoreHeuristic(features, weights, catalogue);
  let bias: Record<string, number> = {};
  if (cfg.learning.enabled && opts.bias)
    bias = typeof opts.bias === "function" ? opts.bias(req, features, h) : opts.bias;
  const it: Item = { req, index, features, h, bias, cacheKey: "", cfg };
  if (brief) it.units = brief.units;
  return it;
}

/** prepare() for the last-resort path: falls back to empty features if scoring itself throws. */
function safePrepare(req: AdjudicationRequest, index: number, opts: EngineOptions): Item {
  try {
    return prepare(req, index, { ...opts, bias: undefined });
  } catch {
    const features = extractFeatures("", undefined);
    const h = scoreHeuristic(features);
    return { req, index, features, h, bias: {}, cacheKey: "" };
  }
}

function heuristicVerdict(
  it: Item,
  provider: ProviderId,
  source: Verdict["source"],
  status: ProviderStatus,
): Verdict {
  return blend(it.h, undefined, it.bias, it.cfg?.weights ?? {}, {
    tiers: it.cfg?.tiers ?? DEFAULT_TIERS,
    key: it.req.key,
    provider,
    providerStatus: status,
    source,
  });
}

function finish(
  items: Item[],
  opts: EngineOptions,
  start: number,
  now: () => number,
  persist: boolean,
  locks: LockBudget,
): Adjudication[] {
  const log = opts.log ?? (() => {});
  const cfg = opts.config;
  const latencyMs = now() - start;
  return items.map((it) => {
    const verdict: Verdict = {
      ...(it.verdict as Verdict),
      latencyMs,
      heuristicComplexity: it.h.complexity,
    };
    const out: Adjudication = {
      request: it.req,
      verdict,
      cacheKey: it.cacheKey,
      features: it.features,
    };
    if (it.queued) out.queued = true;
    if (it.providerModel) out.providerModel = it.providerModel;
    if (it.units) out.units = it.units;
    if (persist && opts.store) {
      const store = opts.store;
      const cols = verdictColumns(verdict, {
        features: it.features,
        providerModel: it.providerModel,
        units: it.units,
      });
      const row: AdjudicationInput = {
        ...(cols as Omit<AdjudicationInput, "surface" | "inputHash">),
        surface: it.req.surface,
        inputHash: inputHash(it.req.text),
        inputHead: cfg.privacy.storeHead ? head(it.req.text) : null,
        inputChars: it.req.text.length,
        ...opts.row,
        ...opts.rows?.[it.index],
      };
      const id = safe(() => locks.run(store, LOCK_WAIT_FLOOR_MS, () => store.insert(row)), log);
      if (id !== undefined) {
        out.rowId = id;
        verdict.id = id;
      }
    }
    return out;
  });
}

type CallOutcome =
  | { ok: true; result: ProviderResult }
  | {
      ok: false;
      kind: "timeout" | "http_error" | "rate_limited" | "invalid" | "no_key";
      status?: number;
    };

/** The provider call, cut off at `ms` whether or not the provider honours its signal. */
async function callWithin(
  provider: AdjudicatorProvider,
  reqs: AdjudicationRequest[],
  ms: number,
  capture?: ProviderExchange[],
): Promise<CallOutcome> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CallOutcome>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ ok: false, kind: "timeout" });
    }, ms);
    timer.unref?.();
  });
  const attempt = (async (): Promise<CallOutcome> => {
    try {
      const result = await provider.adjudicate(
        reqs,
        capture
          ? { signal: ac.signal, deadlineMs: ms, capture }
          : { signal: ac.signal, deadlineMs: ms },
      );
      return { ok: true, result };
    } catch (err) {
      if (err instanceof ProviderError) {
        const o: CallOutcome = { ok: false, kind: err.kind };
        if (err.status !== undefined) o.status = err.status;
        return o;
      }
      if (ac.signal.aborted || (err as Error)?.name === "AbortError")
        return { ok: false, kind: "timeout" };
      return { ok: false, kind: "invalid" };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A read-only gate for the async path: locked out, open, slow or over budget, claiming nothing. */
function peekGate(
  store: AdjudicatorStore,
  r: Resolved,
  cfg: AdjudicatorConfig,
  now: number,
  keyFp: string | null,
): ProviderStatus | undefined {
  const s = store.providerState(r.provider);
  if (!s) return undefined;
  if (authLockout(s, now, keyFp)?.locked) return "auth_failed";
  if ((s.state === "open" || s.state === "half_open") && s.retryAt !== null && now < s.retryAt)
    return "breaker_open";
  if (s.state === "slow" && s.retryAt !== null && now < s.retryAt) return "slow_guard";
  if (r.remote && overBudget(s, cfg, now)) return "over_budget";
  return undefined;
}

function buildJob(
  it: Item,
  cfg: AdjudicatorConfig,
  opts: EngineOptions,
  budgetMs: number,
): AsyncJob {
  // Never the key: the child resolves it itself (env or key file).
  const job: AsyncJob = {
    v: 1,
    projectRoot: opts.projectRoot ?? process.cwd(),
    request: it.req,
    cacheKey: it.cacheKey,
    config: cfg,
    context: opts.context ?? "hook",
    budgetMs: 2 * budgetMs,
    bias: it.bias,
  };
  // The child recomputes the cache key from these, so it must see the same catalogue.
  const tools = toolsOf(opts);
  if (tools) job.tools = [...tools];
  if (opts.roles) job.roles = opts.roles.map((r) => ({ ...r }));
  // Only a captured exchange reads it (its job wait).
  if (cfg.privacy.captureExchanges === true) job.queuedAt = (opts.now ?? Date.now)();
  return job;
}

/**
 * Stores the Jev exchanges of one provider call (privacy.captureExchanges), after finish() so
 * each can name the rows it served. A record still "pending" is the call the engine's timer cut
 * off: it is stored as a timeout with no response. No lock wait and fail open: a busy or
 * read-only database loses the exchanges and never delays or changes a verdict.
 */
function writeExchanges(
  store: AdjudicatorStore,
  sink: readonly ProviderExchange[],
  misses: readonly Item[],
  out: readonly Adjudication[],
  opts: EngineOptions,
  start: number,
  budgetMs: number,
  locks: LockBudget,
): void {
  if (!sink.length) return;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  try {
    if (opts.captureStillOn && !opts.captureStillOn()) return;
    const rowsByKey = new Map<string, number[]>();
    for (const it of misses) {
      const id = out[it.index]?.rowId ?? opts.linkRowIds?.[it.index];
      if (id === undefined) continue;
      const ids = rowsByKey.get(it.req.key);
      if (ids) ids.push(id);
      else rowsByKey.set(it.req.key, [id]);
    }
    const callId = `${start.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const t = now();
    const xs: ExchangeInput[] = sink.map((pe) => {
      const x = pe.http;
      const pending = x.outcome === "pending";
      const outcome = pending ? "timeout" : x.outcome;
      const res = pending ? null : x.response;
      return {
        ts: x.sentAt,
        callId,
        batch: pe.batch,
        provider: pe.provider,
        model: pe.model,
        surface: misses[0]?.req.surface ?? null,
        context: opts.context ?? "hook",
        method: x.method,
        target: x.target,
        rowIds: [...new Set(pe.itemKeys.flatMap((k) => rowsByKey.get(k) ?? []))],
        items: pe.itemKeys.length,
        outcome,
        httpStatus: x.status,
        timedOut: outcome === "timeout",
        attempts: x.attempts,
        waitMs: Math.max(0, x.sentAt - start),
        jobWaitMs: opts.jobWaitMs ?? null,
        ttfbMs: x.ttfbMs,
        durationMs: pending ? Math.max(0, t - x.sentAt) : x.durationMs,
        retryWaitMs: x.retryWaitMs,
        deadlineMs: x.deadlineMs,
        budgetMs,
        tokensIn: pe.tokensIn,
        tokensOut: pe.tokensOut,
        costUsd: pe.costUsd,
        requestBody: x.request.text,
        requestBytes: x.request.bytes,
        requestTruncated: x.request.truncated,
        responseBody: res ? res.text : null,
        responseBytes: res ? res.bytes : null,
        responseTruncated: res ? res.truncated : false,
        error: x.error,
      };
    });
    locks.run(store, 0, () => store.exchangeInsert(xs));
  } catch (err) {
    log(`adjudicator: exchange capture skipped (${(err as Error)?.message ?? String(err)})`);
  }
}

/**
 * How long this call's writes may wait for another process's lock: what is left of the budget,
 * at most LOCK_WAIT_MAX_MS, at least the caller's floor. Once one write found the database
 * busy, the rest only get their floor (try once): the lock is evidently held, and waiting for
 * it again would spend the hook's time on bookkeeping.
 */
class LockBudget {
  private busy = false;

  constructor(
    private readonly deadline: number,
    private readonly now: () => number,
  ) {}

  wait(floor = 0): number {
    if (this.busy) return floor;
    return Math.max(floor, Math.min(LOCK_WAIT_MAX_MS, Math.floor(this.deadline - this.now())));
  }

  /** `fn`, noting a busy database before rethrowing its error. */
  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (isBusy(err)) this.busy = true;
      throw err;
    }
  }

  /** `fn` with every lock wait capped at wait(floor). */
  run<T>(store: AdjudicatorStore, floor: number, fn: () => T): T {
    const ms = this.wait(floor);
    return this.guard(() => bounded(store, ms, fn));
  }
}

/** SQLITE_BUSY / SQLITE_LOCKED (better-sqlite3 sets `code`), or a message saying so. */
function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code)) return true;
  return /database is (locked|busy)|SQLITE_BUSY/i.test((err as Error)?.message ?? "");
}

/** `fn` with every lock wait capped at `ms` when the store supports it. */
function bounded<T>(store: AdjudicatorStore, ms: number, fn: () => T): T {
  return store.withLockWait ? store.withLockWait(ms, fn) : fn();
}

/**
 * A breaker record. When it cannot be written (database busy) the breaker module keeps its call
 * and spend for the next record of this process; a hook process exits first, so say so.
 */
function record(
  store: AdjudicatorStore,
  provider: string,
  now: number,
  log: (line: string) => void,
  locks: LockBudget,
  fn: () => unknown,
): void {
  try {
    locks.guard(fn);
  } catch (err) {
    const u = unrecorded(store, provider, now);
    log(
      `adjudicator: ${provider} breaker state not written (${(err as Error)?.message ?? String(err)}); ` +
        `unrecorded today: ${u.calls} call(s), $${u.spendUsd.toFixed(6)}`,
    );
  }
}

function safe<T>(fn: () => T, log: (line: string) => void): T | undefined {
  try {
    return fn();
  } catch (err) {
    log(`adjudicator: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}
