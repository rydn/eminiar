/**
 * Reconcile and learning (docs/design/adjudicator.md §7.7, §13).
 *
 * reconcile(db, {limit}) links non-final adjudication rows to what happened afterwards:
 * - plan / agent rows of a swarm task take the task's status as their outcome and the
 *   worker's api_calls as their tokens;
 * - agent rows without a swarm task are linked to the sidechain agent that starts within 60 s
 *   of the dispatch (outcome_source "link"), jointly across parallel dispatches and only when
 *   the evidence is unambiguous (matchDispatches);
 * - prompt rows take the session's main-thread calls up to the next prompt row.
 * It reprices those calls at the baseline model (savings.ts), credits savings only for
 * followed or applied dispatches, charges a redone failed attempt its full cost, and on the
 * row's transition to final updates the learned bias buckets. Final rows are not re-scanned,
 * so re-runs are idempotent; a final row holds at most one lesson, which a redo relabel or
 * explicit feedback replaces rather than adds to (see "lessons" below).
 *
 * Learning keeps decayed counts per bucket (tier: HEURISTIC complexity bucket × tier, the one
 * lookup can know before a provider answers; role: top intent × role) and turns them into a bounded additive bias with a Beta(2,2) prior:
 *   bias = clamp((s+2)/(n+4) − 0.8 − costWeight·log2(costMedian / bucket median), ±maxBias)
 * applied only when n ≥ minSamples. biasFor() returns it keyed "tier:<option>" /
 * "role:<option>" for blend; learning.enabled=false gives {}.
 */

import type { Config } from "../config.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { AdjudicationPatch, AdjudicatorBiasRow, ApiCallRow } from "../storage/types.js";
import type { TaskRow, WorkerRow } from "../swarm/types.js";
import type { PricingOverrides } from "../usage/pricing.js";
import { dominantEffort, effortFollowOf, rowEffort, withEffortScores } from "./effort.js";
import { complexityBucket, topIntent } from "./heuristic.js";
import {
  actualCost,
  advisedPick,
  allRows,
  dominantModel,
  keptModel,
  repriceAt,
  resolveBaseline,
  tierOf,
  totalTokens,
} from "./savings.js";
import { type AdjudicationOutcome, type AdjudicationRow, type Features, TIERS } from "./types.js";
import { briefUnitsOf } from "./units.js";

// --- constants -----------------------------------------------------------------------

/** Rows younger than this are left alone: their dispatch may still be starting. */
export const SETTLE_MS = 2 * 60_000;
/** A row is final after this long, whatever is known by then. */
export const FINAL_AFTER_MS = 24 * 60 * 60_000;
/** A non-swarm agent's first call must start within this long after the dispatch row. */
export const LINK_WINDOW_MS = 60_000;
/** A linked non-swarm agent silent for this long is taken as finished. */
export const AGENT_IDLE_MS = 30 * 60_000;
/** Main-thread lookback for the session model at a dispatch (baseline step 2). */
const BASELINE_LOOKBACK_MS = 12 * 60 * 60_000;

export interface LearningConfig {
  enabled: boolean;
  maxBias: number;
  minSamples: number;
  halfLife: number;
  costWeight: number;
}

export const DEFAULT_LEARNING: Readonly<LearningConfig> = Object.freeze({
  enabled: true,
  maxBias: 0.3,
  minSamples: 5,
  halfLife: 50,
  costWeight: 0.05,
});

/** The parts of the full config reconcile reads; every field optional. */
export interface LearnConfigInput {
  adjudicator?:
    | { learning?: Partial<LearningConfig> | undefined; tiers?: readonly string[] | undefined }
    | undefined;
  usage?: { pricing?: Config["usage"]["pricing"] | undefined } | undefined;
}

function learningOf(
  explicit: Partial<LearningConfig> | undefined,
  config: LearnConfigInput | undefined,
): LearningConfig {
  return { ...DEFAULT_LEARNING, ...(config?.adjudicator?.learning ?? {}), ...(explicit ?? {}) };
}

// --- bias math -----------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Multiplier applied to a bucket's counts on each update: 2^(−1/halfLife). */
export function decayFactor(halfLife: number): number {
  return halfLife > 0 && Number.isFinite(halfLife) ? 2 ** (-1 / halfLife) : 1;
}

/** Posterior success with a Beta(2,2) prior: (s+2)/(n+4). */
export function posterior(s: number, n: number): number {
  return (s + 2) / (n + 4);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * The bias of one option: 0 below minSamples; otherwise (ŝ − 0.8) minus the cost term
 * costWeight·log2(costMedian / bucketMedian) (0 when either is unknown), clamped to ±maxBias.
 */
export function computeBias(
  row: Pick<AdjudicatorBiasRow, "n" | "s" | "costMedian">,
  bucketMedian: number | null,
  l: LearningConfig,
): number {
  if (!(row.n >= l.minSamples) || row.n <= 0) return 0;
  let b = posterior(row.s, row.n) - 0.8;
  if (row.costMedian && row.costMedian > 0 && bucketMedian && bucketMedian > 0)
    b -= l.costWeight * Math.log2(row.costMedian / bucketMedian);
  return clamp(b, -l.maxBias, l.maxBias);
}

/** Median of the options' cost medians within one (dimension, bucket). */
function bucketMedianOf(rows: readonly AdjudicatorBiasRow[]): number | null {
  return median(
    rows.map((r) => r.costMedian).filter((c): c is number => typeof c === "number" && c > 0),
  );
}

/**
 * Streaming median estimate: step towards the new sample by at most ×1.2 (never past it),
 * so one outlier cannot move the estimate far.
 */
export function stepMedian(current: number | null, sample: number): number {
  if (current === null || !(current > 0)) return sample;
  if (sample > current) return Math.min(sample, current * 1.2);
  if (sample < current) return Math.max(sample, current / 1.2);
  return current;
}

export interface BiasSignal {
  dimension: "tier" | "role";
  bucket: string;
  option: string;
  success: boolean;
  /** Actual cost of the success, feeds cost_median. */
  costUsd?: number | null | undefined;
}

/**
 * Decay and count one signal in its bucket, then recompute the stored bias of every option
 * in that bucket (the cost term depends on the bucket median). No-op when learning is off.
 */
export function recordSignal(
  db: StorageAdapter,
  sig: BiasSignal,
  learning: LearningConfig,
  now = Date.now(),
): void {
  if (!learning.enabled || !sig.option || !sig.bucket) return;
  const inBucket = db.adjudicator
    .biasAll()
    .filter((r) => r.dimension === sig.dimension && r.bucket === sig.bucket);
  let target = inBucket.find((r) => r.option === sig.option);
  if (!target) {
    target = {
      dimension: sig.dimension,
      bucket: sig.bucket,
      option: sig.option,
      n: 0,
      s: 0,
      f: 0,
      costMedian: null,
      bias: 0,
      updatedAt: null,
    };
    inBucket.push(target);
  }
  const d = decayFactor(learning.halfLife);
  target.n = target.n * d + 1;
  target.s = target.s * d + (sig.success ? 1 : 0);
  target.f = target.f * d + (sig.success ? 0 : 1);
  if (sig.success && typeof sig.costUsd === "number" && sig.costUsd > 0)
    target.costMedian = stepMedian(target.costMedian, sig.costUsd);
  target.updatedAt = now;
  const med = bucketMedianOf(inBucket);
  for (const r of inBucket) {
    const bias = computeBias(r, med, learning);
    if (r !== target && bias === r.bias) continue;
    r.bias = bias;
    db.adjudicator.biasUpsert({ ...r, updatedAt: r === target ? now : r.updatedAt });
  }
}

export interface BiasKey {
  /** Continuous complexity; bucketed with complexityBucket. */
  complexity?: number | null | undefined;
  /** Top intent of the request (role bucket). */
  intent?: string | null | undefined;
}

/** Pure form of biasFor over already-loaded bias rows. */
export function biasFromRows(
  rows: readonly AdjudicatorBiasRow[],
  learning: LearningConfig,
  key: BiasKey,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!learning.enabled) return out;
  const tierBucket =
    typeof key.complexity === "number" && Number.isFinite(key.complexity)
      ? String(complexityBucket(key.complexity))
      : undefined;
  const roleBucket = key.intent || "none";
  for (const [dimension, bucket] of [
    ["tier", tierBucket],
    ["role", roleBucket],
  ] as const) {
    if (bucket === undefined) continue;
    const inBucket = rows.filter((r) => r.dimension === dimension && r.bucket === bucket);
    const med = bucketMedianOf(inBucket);
    for (const r of inBucket) {
      const b = computeBias(r, med, learning);
      if (b !== 0) out[`${dimension}:${r.option}`] = b;
    }
  }
  return out;
}

/**
 * Learned additive biases for one request, keyed "tier:<option>" and "role:<option>", from
 * buckets with n ≥ minSamples. Empty when learning is disabled.
 */
export function biasFor(
  db: StorageAdapter,
  learning: Partial<LearningConfig> | undefined,
  key: BiasKey,
): Record<string, number> {
  const l = learningOf(learning, undefined);
  if (!l.enabled) return {};
  return biasFromRows(db.adjudicator.biasAll(), l, key);
}

// --- row helpers ---------------------------------------------------------------------

function parsedFeatures(row: Pick<AdjudicationRow, "scores">): Features | undefined {
  if (!row.scores) return undefined;
  try {
    const s = JSON.parse(row.scores) as { features?: Features } | null;
    return s && typeof s === "object" && s.features && typeof s.features === "object"
      ? s.features
      : undefined;
  } catch {
    return undefined;
  }
}

/** scores.heuristicComplexity (engine.verdictColumns), when the row has it. */
function heuristicComplexityOf(row: Pick<AdjudicationRow, "scores">): number | undefined {
  if (!row.scores) return undefined;
  try {
    const s = JSON.parse(row.scores) as { heuristicComplexity?: unknown } | null;
    const c = s && typeof s === "object" ? s.heuristicComplexity : undefined;
    return typeof c === "number" && Number.isFinite(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The (tier, role) buckets of a row: complexity bucket, and top intent ("none" without one).
 * The tier bucket uses the HEURISTIC complexity, the same one biasFor is looked up with (the
 * provider has not answered at lookup time), so a provider that moves the blended complexity
 * across a bucket boundary cannot teach a bucket the request never reads. Rows written before
 * the heuristic complexity was stored fall back to the row's (blended) complexity.
 */
export function bucketsOf(row: Pick<AdjudicationRow, "complexity" | "scores">): {
  tier: string | undefined;
  role: string;
} {
  const heuristic = heuristicComplexityOf(row);
  const complexity =
    heuristic ??
    (typeof row.complexity === "number" && Number.isFinite(row.complexity)
      ? row.complexity
      : undefined);
  const tier = complexity === undefined ? undefined : String(complexityBucket(complexity));
  const f = parsedFeatures(row);
  const intent = f?.intents && typeof f.intents === "object" ? topIntent(f) : undefined;
  return { tier, role: intent ?? "none" };
}

/** Patch holding only the fields whose value differs from the row. */
function diff(row: AdjudicationRow, patch: AdjudicationPatch): AdjudicationPatch {
  const out: AdjudicationPatch = {};
  for (const [k, v] of Object.entries(patch) as Array<[keyof AdjudicationPatch, unknown]>) {
    if (v === undefined) continue;
    const cur = (row as unknown as Record<string, unknown>)[k] ?? null;
    if (cur === (v ?? null)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// --- reconcile -----------------------------------------------------------------------

export interface ReconcileOptions {
  /** Rows to look at per run (oldest non-final first). Default 200. */
  limit?: number | undefined;
  now?: number | undefined;
  learning?: Partial<LearningConfig> | undefined;
  pricing?: PricingOverrides | undefined;
  /** The loaded config; learning and pricing are read from it when not passed explicitly. */
  config?: LearnConfigInput | undefined;
}

export interface ReconcileResult {
  scanned: number;
  updated: number;
  finalized: number;
  /** Non-swarm agent rows linked to a sidechain agent in this run. */
  linked: number;
  /** Bias signals recorded. */
  learned: number;
}

const CREDITED = new Set(["applied", "followed"]);

/** A non-swarm Agent dispatch row competing for a sidechain agent. */
export interface DispatchCandidate {
  id: number;
  ts: number;
  /** Tier the dispatch asked for (model_final, else model_requested); unknown = undefined. */
  want?: string | undefined;
  /** Ingestion has passed the row's link window, so every agent it could own is visible. */
  settled: boolean;
}

/** A sidechain agent of the session: its first call and the tier it mostly ran on. */
export interface AgentCandidate {
  id: string;
  first: number;
  tier?: string | undefined;
}

/**
 * Pair dispatch rows with the agents they started, linking only what the evidence settles.
 * An agent can belong to a row when its first call falls in [row.ts, row.ts + 60 s]. Rows and
 * agents that share candidates form a component; components with a row whose window is not
 * yet ingested wait. In a component:
 * - one row and one agent: they pair (nothing else could have started it);
 * - otherwise a row pairs with an agent when that agent is the row's only candidate running
 *   the tier it asked for, and every other row that could own the agent asked for a known,
 *   different tier.
 * Paired rows and agents are removed and the rest re-examined, so a row whose agent ran a
 * different tier than asked (apply ineffective) is still linked once the others are settled.
 * Anything else, e.g. two parallel dispatches of the same tier, stays unlinked: a guess would
 * misreport savings and raise a false "apply did not take effect". Returns row id → agent id.
 */
export function matchDispatches(
  rows: readonly DispatchCandidate[],
  agents: readonly AgentCandidate[],
  windowMs = LINK_WINDOW_MS,
): Map<number, string> {
  const out = new Map<number, string>();
  let R = [...rows];
  let A = [...agents];
  const inWindow = (r: DispatchCandidate, a: AgentCandidate) =>
    a.first >= r.ts && a.first <= r.ts + windowMs;
  for (;;) {
    const cand = new Map(R.map((r) => [r.id, A.filter((a) => inWindow(r, a))]));
    const owners = new Map(A.map((a) => [a.id, R.filter((r) => inWindow(r, a))]));
    const pairs: Array<[DispatchCandidate, AgentCandidate]> = [];
    const seen = new Set<number>();
    for (const start of R) {
      if (seen.has(start.id)) continue;
      // The component of `start`: rows and agents reachable through shared windows.
      const rowsC: DispatchCandidate[] = [];
      const agentsC = new Set<AgentCandidate>();
      const queue = [start];
      seen.add(start.id);
      while (queue.length) {
        const r = queue.pop() as DispatchCandidate;
        rowsC.push(r);
        for (const a of cand.get(r.id) ?? []) {
          if (agentsC.has(a)) continue;
          agentsC.add(a);
          for (const o of owners.get(a.id) ?? [])
            if (!seen.has(o.id)) {
              seen.add(o.id);
              queue.push(o);
            }
        }
      }
      if (!agentsC.size || rowsC.some((r) => !r.settled)) continue;
      if (rowsC.length === 1 && agentsC.size === 1) {
        pairs.push([rowsC[0] as DispatchCandidate, [...agentsC][0] as AgentCandidate]);
        continue;
      }
      for (const r of rowsC) {
        if (!r.want) continue;
        const match = (cand.get(r.id) ?? []).filter((a) => a.tier === r.want);
        if (match.length !== 1) continue;
        const a = match[0] as AgentCandidate;
        const rivals = (owners.get(a.id) ?? []).filter((o) => o !== r);
        if (rivals.every((o) => o.want !== undefined && o.want !== a.tier)) pairs.push([r, a]);
      }
    }
    if (!pairs.length) return out;
    for (const [r, a] of pairs) out.set(r.id, a.id);
    const pr = new Set(pairs.map(([r]) => r.id));
    const pa = new Set(pairs.map(([, a]) => a.id));
    R = R.filter((r) => !pr.has(r.id));
    A = A.filter((a) => !pa.has(a.id));
  }
}

class Reconciler {
  readonly result: ReconcileResult = {
    scanned: 0,
    updated: 0,
    finalized: 0,
    linked: 0,
    learned: 0,
  };
  private readonly sessionCalls = new Map<string, ApiCallRow[]>();
  private readonly taskRows = new Map<string, AdjudicationRow[]>();
  private readonly runWorkers = new Map<string, WorkerRow[]>();
  private promptsBySession: Map<string, AdjudicationRow[]> | undefined;
  /** Agent ids already tied to an adjudication row. */
  private readonly taken = new Set<string>();
  /** Row id → the agent linkAgents matched it to in this run. */
  private readonly links = new Map<number, string>();
  private readonly latestCallTs: number | undefined;

  constructor(
    private readonly db: StorageAdapter,
    private readonly now: number,
    private readonly learning: LearningConfig,
    private readonly pricing: PricingOverrides | undefined,
    private readonly sessionsSince: Map<string, number>,
  ) {
    this.latestCallTs = db.apiCallsLatestTs();
  }

  /** Calls of a session from (its oldest pending row − lookback), loaded once per run. */
  private calls(sessionId: string): ApiCallRow[] {
    let c = this.sessionCalls.get(sessionId);
    if (!c) {
      const since = (this.sessionsSince.get(sessionId) ?? this.now) - BASELINE_LOOKBACK_MS;
      c = this.db.apiCalls({ sessionId, since });
      this.sessionCalls.set(sessionId, c);
    }
    return c;
  }

  private siblings(runId: string, taskId: number): AdjudicationRow[] {
    const k = `${runId}#${taskId}`;
    let r = this.taskRows.get(k);
    if (!r) {
      r = this.db.adjudicator.forTask(runId, taskId);
      this.taskRows.set(k, r);
    }
    return r;
  }

  private workers(runId: string): WorkerRow[] {
    let w = this.runWorkers.get(runId);
    if (!w) {
      w = this.db.swarm.workers(runId);
      this.runWorkers.set(runId, w);
    }
    return w;
  }

  private prompts(sessionId: string, since: number): AdjudicationRow[] {
    if (!this.promptsBySession) {
      const m = new Map<string, AdjudicationRow[]>();
      for (const p of allRows(this.db, { surface: "prompt", since })) {
        if (!p.sessionId) continue;
        const list = m.get(p.sessionId);
        if (list) list.push(p);
        else m.set(p.sessionId, [p]);
      }
      this.promptsBySession = m;
    }
    return this.promptsBySession.get(sessionId) ?? [];
  }

  /**
   * Can every agent this row might own be visible? Yes once ingestion holds a call past the
   * row's link window, or once the row is AGENT_IDLE_MS old (a session whose last agents
   * finished inside the window has no later call; by then its transcripts are ingested).
   */
  private windowSeen(row: AdjudicationRow): boolean {
    return (
      this.latestCallTs === undefined ||
      this.latestCallTs >= row.ts + LINK_WINDOW_MS ||
      this.now - row.ts >= AGENT_IDLE_MS
    );
  }

  /**
   * Decide, once per run and jointly per session, which sidechain agent each unlinked
   * non-swarm agent row dispatched (agentRow reads the result). Parallel Agent calls in one
   * message are the common case, so rows are not linked greedily in order: every dispatch
   * row of the session without an agent id competes (final, unsettled and swarm rows too),
   * and matchDispatches links only what the evidence settles. Ambiguous rows stay unlinked.
   */
  linkAgents(targets: readonly AdjudicationRow[]): void {
    const bySession = new Map<string, AdjudicationRow[]>();
    for (const r of targets) {
      if (r.agentId || !r.sessionId) continue;
      const list = bySession.get(r.sessionId);
      if (list) list.push(r);
      else bySession.set(r.sessionId, [r]);
    }
    if (!bySession.size) return;
    const minTs = Math.min(...targets.map((r) => r.ts));
    const near = allRows(this.db, { surface: "agent", since: minTs - LINK_WINDOW_MS });
    for (const [sessionId, mine] of bySession) {
      const maxTs = Math.max(...mine.map((r) => r.ts));
      const linkable = new Set(mine.map((r) => r.id));
      const rows: DispatchCandidate[] = near
        .filter((r) => r.sessionId === sessionId && !r.agentId && r.ts <= maxTs + LINK_WINDOW_MS)
        .map((r) => ({
          id: r.id,
          ts: r.ts,
          want: tierOf(r.modelFinal ?? r.modelRequested),
          settled: this.windowSeen(r),
        }));
      const callsBy = new Map<string, ApiCallRow[]>();
      for (const c of this.calls(sessionId)) {
        if (!c.sidechain || !c.agent_id || this.taken.has(c.agent_id)) continue;
        const list = callsBy.get(c.agent_id);
        if (list) list.push(c);
        else callsBy.set(c.agent_id, [c]);
      }
      const agents: AgentCandidate[] = [...callsBy].map(([id, cs]) => ({
        id,
        first: Math.min(...cs.map((c) => c.ts)),
        tier: tierOf(dominantModel(cs)),
      }));
      for (const [rowId, agentId] of matchDispatches(rows, agents)) {
        // A pair whose row is not in this run's batch still consumes the agent.
        this.taken.add(agentId);
        if (linkable.has(rowId)) this.links.set(rowId, agentId);
      }
    }
  }

  /** Seed `taken` with the agent ids already on agent / plan rows near these rows. */
  seedTaken(since: number): void {
    for (const surface of ["agent", "plan"])
      for (const r of allRows(this.db, { surface, since: since - FINAL_AFTER_MS }))
        if (r.agentId) this.taken.add(r.agentId);
  }

  /**
   * Commit a patch; on the transition to final, record the row's learning signals and keep
   * exactly what was taught on the row (scores.taught, empty when nothing was) so a later
   * relabel or feedback retracts that, not a lesson recomputed from the row's current state.
   */
  private commit(
    row: AdjudicationRow,
    patch: AdjudicationPatch,
    teach?: { tier?: string | undefined; role?: string | undefined } | undefined,
  ): void {
    if (
      patch.outcome &&
      patch.outcome !== "pending" &&
      row.outcomeTs == null &&
      patch.outcomeTs === undefined
    )
      patch.outcomeTs = this.now;
    const d = diff(row, patch);
    if (!Object.keys(d).length) return;
    let lesson: BiasSignal[] | undefined;
    if (d.final === true && !row.final) {
      this.result.finalized++;
      if (teach) {
        const outcome = (d.outcome ?? row.outcome) as AdjudicationOutcome;
        lesson =
          this.learning.enabled && (outcome === "success" || outcome === "failure")
            ? this.lessonOf(row, outcome === "success", teach, d.actualCostUsd ?? row.actualCostUsd)
            : [];
        // d.scores first: a patch (the effort keys, #170) set in this same commit must survive.
        const scores = withTaught(d.scores ?? row.scores, lesson);
        if (scores !== undefined) d.scores = scores;
      }
    }
    this.db.adjudicator.update(row.id, d);
    this.result.updated++;
    for (const sig of lesson ?? []) {
      recordSignal(this.db, sig, this.learning, this.now);
      this.result.learned++;
    }
  }

  /** The signals a finalising swarm row teaches: the tier that ran and the role, if known. */
  private lessonOf(
    row: AdjudicationRow,
    success: boolean,
    what: { tier?: string | undefined; role?: string | undefined },
    cost: number | null | undefined,
  ): BiasSignal[] {
    const b = bucketsOf(row);
    const out: BiasSignal[] = [];
    if (what.tier && b.tier !== undefined)
      out.push({ dimension: "tier", bucket: b.tier, option: what.tier, success, costUsd: cost });
    if (what.role)
      out.push({ dimension: "role", bucket: b.role, option: what.role, success, costUsd: cost });
    return out;
  }

  /**
   * Actual model, tokens and cost of `calls`, the baseline and its cost, follow detection
   * and the credited savings. `calls` empty leaves the token fields alone.
   */
  private pricePatch(
    row: AdjudicationRow,
    calls: ApiCallRow[],
    sessionId: string | undefined,
    redone: boolean,
    outcome: AdjudicationOutcome,
  ): AdjudicationPatch {
    const patch: AdjudicationPatch = {};
    const baseline =
      row.baselineModel ??
      resolveBaseline(undefined, {
        sessionId,
        ts: row.ts,
        calls: sessionId ? this.calls(sessionId) : [],
      }).model;
    if (!row.baselineModel) patch.baselineModel = baseline;

    // Follow detection: the coordinator passed a model; compare it with the advice it saw.
    // A dispatch whose advice named no model (a kept pin, FORCE, a fork: savings.ts keptModel)
    // has nothing to follow: no follow, no credit. The advice is the tier the line or note named
    // (savings.ts advisedPick: the verdict clamped to the apply bounds, and to the role's range
    // for a ranged dispatch). The dispatch row's own pick comes first: it is what the Agent note
    // named for the agent actually dispatched, whose range can differ from the planned role's; a
    // row written without it falls back to the plan row's pick, then the raw verdict tier.
    const deferred = keptModel(row) !== undefined;
    const parent = row.parentId ? this.db.adjudicator.get(row.parentId) : undefined;
    let action = row.action ?? null;
    if (action === "advised" && row.modelRequested && !deferred) {
      const advice =
        advisedPick(row) ??
        (parent ? advisedPick(parent) : undefined) ??
        parent?.tier ??
        row.tier ??
        undefined;
      const requested = tierOf(row.modelRequested) ?? row.modelRequested;
      if (advice && requested === advice) {
        if (advice !== (tierOf(baseline) ?? baseline)) action = "followed";
      } else if (advice) action = "ignored";
      if (action !== row.action) patch.action = action;
    }

    if (!calls.length) return patch;
    this.effortPatch(row, parent, calls, patch);
    const actual = actualCost(calls, this.pricing);
    const base = repriceAt(calls, baseline, this.pricing);
    patch.actualModel = dominantModel(calls) ?? null;
    patch.actualTokens = totalTokens(calls);
    patch.actualCostUsd = actual;
    patch.baselineCostUsd = base;
    let savings: number | null = null;
    if (CREDITED.has(action ?? "") && !deferred) {
      if (redone && outcome === "failure") savings = actual === null ? null : -actual;
      else if (actual !== null && base !== null) savings = base - actual;
    }
    patch.savingsUsd = savings;
    return patch;
  }

  /**
   * Effort follow-through (#170): the level the subagent ran at (the dominant api_calls.effort of
   * its calls) goes into scores.actualEffort; an agent row also gets scores.effortFollow, the
   * verdict of comparing it with the advised effort (effort.ts effortFollowOf: not counted for a
   * fork, the env override or a saturated brief). Writes patch.scores only when it changes.
   */
  private effortPatch(
    row: AdjudicationRow,
    parent: AdjudicationRow | undefined,
    calls: readonly ApiCallRow[],
    patch: AdjudicationPatch,
  ): void {
    const ran = dominantEffort(calls);
    const e = rowEffort(row.scores);
    const follow =
      row.surface === "agent"
        ? effortFollowOf({
            advised: row.effort ?? null,
            ...(ran ? { ran } : {}),
            ...(e.passed ? { passed: e.passed } : {}),
            ...(e.agent ? { agent: e.agent } : {}),
            env: e.env !== undefined,
            fork: keptModel(row) === "fork",
            // The plan row's brief scoring is the decision when there is one (hooks onPreAgent).
            saturated: !!briefUnitsOf((parent ?? row).scores)?.saturated,
          })
        : undefined;
    if (!ran && !follow && !e.follow) return;
    const scores = withEffortScores(row.scores, {
      ...(ran ? { actual: ran } : {}),
      ...(follow ? { follow } : {}),
    });
    if (scores !== undefined && scores !== row.scores) patch.scores = scores;
  }

  /** Apply the redo penalty to earlier credited attempts of a task that already went final. */
  private penaliseEarlier(row: AdjudicationRow, sibs: AdjudicationRow[]): void {
    for (const e of sibs) {
      if (e.surface !== "agent" || e.id >= row.id || !e.final) continue;
      if (!CREDITED.has(e.action ?? "") || typeof e.actualCostUsd !== "number") continue;
      const patch: AdjudicationPatch = { savingsUsd: -e.actualCostUsd };
      // A later dispatch for the same task means this attempt did not hold: relabel it a
      // failure, unless explicit feedback already labelled it (feedback wins over the guess).
      const relabel = e.outcome !== "failure" && feedbackOf(e) === undefined;
      let before: BiasSignal[] = [];
      let after: BiasSignal[] = [];
      if (relabel) {
        patch.outcome = "failure";
        patch.outcomeSource = "redo";
        // The lesson follows the label: the success it taught at finalisation becomes a
        // failure (relabelled, not added), so a final row always holds exactly one lesson.
        before = taughtLesson(this.db, e);
        after = reconcileLesson(this.db, { ...e, outcome: "failure", outcomeSource: "redo" });
        const scores = withTaught(e.scores, this.learning.enabled ? after : before);
        if (scores !== undefined) patch.scores = scores;
      }
      const d = diff(e, patch);
      if (Object.keys(d).length) {
        this.db.adjudicator.update(e.id, d);
        Object.assign(e, d);
        this.result.updated++;
      }
      if (relabel)
        this.result.learned += replaceLesson(this.db, before, after, this.learning, this.now);
    }
  }

  swarmRow(row: AdjudicationRow): void {
    const runId = row.runId as string;
    const taskId = row.taskId as number;
    const run = this.db.swarm.runGet(runId);
    const rawTask = this.db.swarm.taskGet(taskId);
    const task: TaskRow | undefined = rawTask && rawTask.run_id === runId ? rawTask : undefined;
    const sibs = this.siblings(runId, taskId);
    const later = sibs.find((s) => s.surface === "agent" && s.id > row.id);
    const redone = row.surface === "agent" && later !== undefined;
    const age = this.now - row.ts;

    let outcome: AdjudicationOutcome = "pending";
    let source = "swarm";
    if (redone) {
      outcome = "failure";
      source = "redo";
    } else if (task?.status === "done") outcome = "success";
    else if (task?.status === "failed" || task?.status === "blocked") outcome = "failure";
    else if (!task || (run && run.status !== "active")) outcome = "abandoned";
    if (outcome === "pending" && age >= FINAL_AFTER_MS) {
      outcome = "abandoned";
      source = "timeout";
    }

    // The worker that ran this attempt: for an agent row, the first worker of the task
    // spawned at or after the dispatch (and before the next attempt); else the task's agent.
    const workers = this.workers(runId).filter((w) => w.task_id === taskId);
    // Agents already tied to other attempts of this task are not this attempt's worker.
    const otherAttempts = new Set(
      sibs
        .filter((s) => s.surface === "agent" && s.id !== row.id && s.agentId)
        .map((s) => s.agentId),
    );
    let worker: WorkerRow | undefined;
    if (row.surface === "agent") {
      worker = workers
        .filter(
          (w) =>
            !otherAttempts.has(w.agent_id) &&
            w.spawned_at >= row.ts - 5_000 &&
            (!later || w.spawned_at < later.ts),
        )
        .sort((a, b) => a.spawned_at - b.spawned_at)[0];
    }
    const agentId =
      row.agentId ?? worker?.agent_id ?? (redone ? undefined : (task?.agent_id ?? undefined));
    if (!worker && agentId) worker = workers.find((w) => w.agent_id === agentId);
    if (agentId) this.taken.add(agentId);

    const sessionId = row.sessionId ?? run?.session_id ?? worker?.session_id ?? undefined;
    const calls =
      agentId && sessionId
        ? this.calls(sessionId).filter((c) => c.agent_id === agentId && c.ts >= row.ts - 5_000)
        : [];

    const patch: AdjudicationPatch = {
      ...this.pricePatch(row, calls, sessionId, redone, outcome),
      outcome,
      outcomeSource: outcome === "pending" ? row.outcomeSource : source,
    };
    if (agentId && !row.agentId) patch.agentId = agentId;

    // Final once the outcome is known and ingestion has caught up with the attempt's end:
    // the redo dispatch for a superseded attempt, else the task's last update.
    const settledAt = later?.ts ?? task?.updated_at ?? row.ts;
    const caughtUp =
      this.latestCallTs === undefined || this.latestCallTs >= settledAt || calls.length > 0;
    if (age >= FINAL_AFTER_MS || (outcome !== "pending" && caughtUp)) patch.final = true;

    // Learn from the dispatch; a plan row teaches only when no agent row tracks the task.
    const teaches = row.surface === "agent" || !sibs.some((s) => s.surface === "agent");
    const teach = teaches
      ? {
          tier: tierOf(patch.actualModel ?? row.actualModel),
          role: task?.role ?? worker?.role ?? undefined,
        }
      : undefined;
    this.commit(row, patch, teach);
    if (row.surface === "agent") this.penaliseEarlier(row, sibs);
  }

  agentRow(row: AdjudicationRow): void {
    const sessionId = row.sessionId ?? undefined;
    const age = this.now - row.ts;
    const all = sessionId ? this.calls(sessionId) : [];
    let agentId = row.agentId ?? undefined;
    let linkedNow = false;
    if (!agentId) {
      agentId = this.links.get(row.id);
      if (agentId) {
        linkedNow = true;
        this.result.linked++;
      }
    }
    const calls = agentId ? all.filter((c) => c.agent_id === agentId) : [];
    const patch: AdjudicationPatch = this.pricePatch(row, calls, sessionId, false, row.outcome);
    if (linkedNow) {
      patch.agentId = agentId;
      patch.outcomeSource = "link";
    }
    const last = calls.length ? (calls[calls.length - 1] as ApiCallRow).ts : undefined;
    const idle = last !== undefined && this.now - last >= AGENT_IDLE_MS;
    if (age >= FINAL_AFTER_MS || idle) {
      patch.final = true;
      if (row.outcome === "pending") patch.outcome = "n/a";
    }
    this.commit(row, patch);
  }

  promptRow(row: AdjudicationRow, promptsSince: number): void {
    const sessionId = row.sessionId ?? undefined;
    const age = this.now - row.ts;
    const patch: AdjudicationPatch = { outcome: "n/a", outcomeSource: "window" };
    let closed = false;
    if (sessionId) {
      const next = this.prompts(sessionId, promptsSince).find(
        (p) => p.ts > row.ts || (p.ts === row.ts && p.id > row.id),
      );
      const end = next?.ts ?? Number.POSITIVE_INFINITY;
      const calls = this.calls(sessionId).filter(
        (c) => !c.sidechain && c.ts >= row.ts && c.ts < end,
      );
      if (calls.length) {
        patch.actualModel = dominantModel(calls) ?? null;
        patch.actualTokens = totalTokens(calls);
        patch.actualCostUsd = actualCost(calls, this.pricing);
      }
      if (!row.baselineModel)
        patch.baselineModel = resolveBaseline(undefined, {
          sessionId,
          ts: row.ts,
          calls: this.calls(sessionId),
        }).model;
      // The window is complete once the next prompt exists and ingestion has reached it.
      closed =
        next !== undefined && (this.latestCallTs === undefined || this.latestCallTs >= next.ts);
    }
    if (closed || age >= FINAL_AFTER_MS || !sessionId) patch.final = true;
    // Main-session prompts never teach: there is no outcome to learn from.
    this.commit(row, patch);
  }

  otherRow(row: AdjudicationRow): void {
    this.commit(row, {
      outcome: row.outcome === "pending" ? "n/a" : row.outcome,
      final: true,
    });
  }
}

/**
 * Link outcomes, tokens and savings for up to `limit` non-final rows older than two minutes,
 * finalise what is settled (or 24 h old) and teach the bias buckets. Idempotent: final rows
 * are skipped and repeated runs over pending rows write the same values. One bad row never
 * stops the rest.
 */
export function reconcile(db: StorageAdapter, opts: ReconcileOptions = {}): ReconcileResult {
  const now = opts.now ?? Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 10_000));
  const learning = learningOf(opts.learning, opts.config);
  const pricing = opts.pricing ?? (opts.config?.usage?.pricing as PricingOverrides | undefined);
  const rows = db.adjudicator.nonFinal(limit, now - SETTLE_MS);
  if (!rows.length) return { scanned: 0, updated: 0, finalized: 0, linked: 0, learned: 0 };

  const isSwarm = (r: AdjudicationRow) =>
    (r.surface === "agent" || r.surface === "plan") && !!r.runId && typeof r.taskId === "number";

  // Oldest pending row per session (swarm rows may borrow the run's session).
  const sessionsSince = new Map<string, number>();
  const note = (sid: string | null | undefined, ts: number) => {
    if (!sid) return;
    const cur = sessionsSince.get(sid);
    if (cur === undefined || ts < cur) sessionsSince.set(sid, ts);
  };
  for (const r of rows) {
    note(r.sessionId, r.ts);
    if (isSwarm(r) && !r.sessionId) note(db.swarm.runGet(r.runId as string)?.session_id, r.ts);
  }
  for (const w of rows.filter(isSwarm)) {
    // Worker rows may carry their own session id; include them so their calls load.
    for (const wk of db.swarm.workers(w.runId as string))
      if (wk.task_id === w.taskId) note(wk.session_id, w.ts);
  }

  const minTs = Math.min(...rows.map((r) => r.ts));
  const rec = new Reconciler(db, now, learning, pricing, sessionsSince);
  rec.seedTaken(minTs);
  rec.result.scanned = rows.length;

  // Swarm rows first: they claim their agent ids before best-effort linking runs.
  const swarm = rows.filter(isSwarm);
  const rest = rows.filter((r) => !isSwarm(r));
  for (const row of swarm) {
    try {
      rec.swarmRow(row);
    } catch {
      // Never let one row (or a locked DB) break reconcile for the rest.
    }
  }
  try {
    rec.linkAgents(rest.filter((r) => r.surface === "agent"));
  } catch {
    // Linking is best-effort; unlinked rows simply wait for the next run.
  }
  for (const row of rest) {
    try {
      if (row.surface === "agent") rec.agentRow(row);
      else if (row.surface === "prompt") rec.promptRow(row, minTs);
      else rec.otherRow(row);
    } catch {
      // Never let one row (or a locked DB) break reconcile for the rest.
    }
  }
  return rec.result;
}

// --- lessons -------------------------------------------------------------------------
//
// A final row holds at most ONE lesson in the bias buckets: the signals reconcile taught at
// finalisation, or the signals of the latest feedback on it. Both are derived from the row's
// label (outcome + outcome_source), so a later label REPLACES the earlier lesson (a signal
// whose success flips is relabelled in place, one no longer taught is retracted, a new one is
// recorded) instead of adding to it. Repeated feedback is therefore idempotent, and feedback
// on a row reconcile already learned from never counts it twice.

/** outcome_source of a feedback label: "feedback:<kind>". */
export function feedbackSource(feedback: Feedback): string {
  return `feedback:${feedback}`;
}

/** The feedback a row was labelled with; a bare legacy "feedback" maps by its outcome. */
export function feedbackOf(
  row: Pick<AdjudicationRow, "outcome" | "outcomeSource">,
): Feedback | undefined {
  const src = row.outcomeSource ?? "";
  if (src.startsWith("feedback:")) {
    const k = src.slice("feedback:".length);
    return Object.hasOwn(FEEDBACK_OUTCOME, k) ? (k as Feedback) : undefined;
  }
  if (src === "feedback")
    return row.outcome === "failure" ? "too_small" : row.outcome === "success" ? "good" : undefined;
  return undefined;
}

/** The role a swarm row's work ran as: the task's role, else its worker's. */
function ranAsRole(db: StorageAdapter, row: AdjudicationRow): string | undefined {
  if (!row.runId || typeof row.taskId !== "number") return undefined;
  const task = db.swarm.taskGet(row.taskId);
  if (task && task.run_id === row.runId && task.role) return task.role;
  if (!row.agentId) return undefined;
  return db.swarm.workers(row.runId).find((w) => w.agent_id === row.agentId)?.role ?? undefined;
}

const signalKey = (s: BiasSignal) => `${s.dimension}\u0000${s.bucket}\u0000${s.option}`;

/** One taught signal as kept in scores.taught. */
interface TaughtEntry {
  dimension: "tier" | "role";
  bucket: string;
  option: string;
  success: boolean;
}

function parseScoresObject(scores: string | null | undefined): Record<string, unknown> | null {
  if (!scores) return {};
  try {
    const s = JSON.parse(scores) as unknown;
    return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The signals a row's lesson put in the bias buckets, as recorded in scores.taught when it was
 * taught (empty: nothing was, e.g. learning was off). Undefined for a row with no record (one
 * written before the record existed, or never finalised by reconcile / feedback).
 */
export function taughtOf(row: Pick<AdjudicationRow, "scores">): BiasSignal[] | undefined {
  const s = parseScoresObject(row.scores);
  const raw = s?.taught;
  if (!Array.isArray(raw)) return undefined;
  const out: BiasSignal[] = [];
  for (const t of raw as unknown[]) {
    if (!t || typeof t !== "object") continue;
    const e = t as Partial<TaughtEntry>;
    if (
      (e.dimension === "tier" || e.dimension === "role") &&
      typeof e.bucket === "string" &&
      typeof e.option === "string" &&
      typeof e.success === "boolean"
    )
      out.push({ dimension: e.dimension, bucket: e.bucket, option: e.option, success: e.success });
  }
  return out;
}

/**
 * The scores JSON with `taught` set to these signals (bucket keys and success only).
 * Undefined when the existing scores are not a JSON object, so nothing is overwritten.
 */
export function withTaught(
  scores: string | null | undefined,
  lesson: readonly BiasSignal[],
): string | undefined {
  const s = parseScoresObject(scores);
  if (!s) return undefined;
  const taught: TaughtEntry[] = lesson.map((l) => ({
    dimension: l.dimension,
    bucket: l.bucket,
    option: l.option,
    success: l.success,
  }));
  return JSON.stringify({ ...s, taught });
}

/**
 * What a row's lesson holds in the buckets now: its scores.taught record; for a row without
 * one, the lesson recomputed from its label (its last feedback, else reconcile's lesson).
 */
function taughtLesson(
  db: StorageAdapter,
  row: AdjudicationRow,
  ladder: readonly string[] = TIERS,
): BiasSignal[] {
  const taught = taughtOf(row);
  if (taught) return taught;
  const prior = feedbackOf(row);
  return prior ? feedbackLesson(db, row, prior, ladder) : reconcileLesson(db, row);
}

/**
 * The signals reconcile taught a final swarm row at finalisation (Reconciler.swarmRow): agent
 * rows, and plan rows no agent row tracked by then; success / failure only; the tier that ran
 * and the task's (or worker's) role. Empty for every other row.
 */
export function reconcileLesson(db: StorageAdapter, row: AdjudicationRow): BiasSignal[] {
  if (!row.final || (row.outcomeSource !== "swarm" && row.outcomeSource !== "redo")) return [];
  if (row.outcome !== "success" && row.outcome !== "failure") return [];
  if (!row.runId || typeof row.taskId !== "number") return [];
  if (row.surface === "plan") {
    const cutoff = row.outcomeTs ?? Number.POSITIVE_INFINITY;
    const tracked = db.adjudicator
      .forTask(row.runId, row.taskId)
      .some((s) => s.surface === "agent" && s.ts <= cutoff);
    if (tracked) return [];
  } else if (row.surface !== "agent") return [];
  const success = row.outcome === "success";
  const b = bucketsOf(row);
  const out: BiasSignal[] = [];
  const tier = tierOf(row.actualModel);
  if (tier && b.tier !== undefined)
    out.push({
      dimension: "tier",
      bucket: b.tier,
      option: tier,
      success,
      costUsd: row.actualCostUsd,
    });
  const role = ranAsRole(db, row);
  if (role)
    out.push({
      dimension: "role",
      bucket: b.role,
      option: role,
      success,
      costUsd: row.actualCostUsd,
    });
  return out;
}

/**
 * The signals one feedback teaches: good = success for the tier and role; too_small = failure
 * for the tier; too_big = success for the tier plus one for the next-lower tier. The tier is
 * the one that actually ran when known, else the applied / requested / advised tier; the role
 * is the one the work ran as, else the advised role.
 */
export function feedbackLesson(
  db: StorageAdapter,
  row: AdjudicationRow,
  feedback: Feedback,
  ladder: readonly string[] = TIERS,
): BiasSignal[] {
  const b = bucketsOf(row);
  const success = FEEDBACK_OUTCOME[feedback] === "success";
  const cost = row.actualCostUsd;
  const out: BiasSignal[] = [];
  const tier =
    tierOf(row.actualModel) ??
    tierOf(row.modelFinal) ??
    tierOf(row.modelRequested) ??
    tierOf(row.tier) ??
    undefined;
  if (tier && b.tier !== undefined) {
    out.push({ dimension: "tier", bucket: b.tier, option: tier, success, costUsd: cost });
    if (feedback === "too_big") {
      const at = ladder.indexOf(tier);
      const lower = at > 0 ? ladder[at - 1] : undefined;
      if (lower) out.push({ dimension: "tier", bucket: b.tier, option: lower, success: true });
    }
  }
  if (feedback === "good") {
    const role = ranAsRole(db, row) ?? row.role ?? undefined;
    if (role)
      out.push({ dimension: "role", bucket: b.role, option: role, success: true, costUsd: cost });
  }
  return out;
}

/**
 * Move one bucket option's counts by (dn, ds, df) without decay, clamped to 0 ≤ s, f ≤ n, and
 * recompute the bucket's biases. No-op (false) when the option has no row or learning is off.
 * Undecayed: the signal being replaced has decayed a little since it was counted, so this
 * slightly over-corrects, which the clamps bound.
 */
function adjustSignal(
  db: StorageAdapter,
  sig: BiasSignal,
  dn: number,
  ds: number,
  df: number,
  learning: LearningConfig,
  now: number,
): boolean {
  if (!learning.enabled) return false;
  const inBucket = db.adjudicator
    .biasAll()
    .filter((r) => r.dimension === sig.dimension && r.bucket === sig.bucket);
  const target = inBucket.find((r) => r.option === sig.option);
  if (!target) return false;
  target.n = Math.max(0, target.n + dn);
  target.s = clamp(target.s + ds, 0, target.n);
  target.f = clamp(target.f + df, 0, target.n);
  target.updatedAt = now;
  const med = bucketMedianOf(inBucket);
  for (const r of inBucket) {
    const bias = computeBias(r, med, learning);
    if (r !== target && bias === r.bias) continue;
    r.bias = bias;
    db.adjudicator.biasUpsert({ ...r, updatedAt: r === target ? now : r.updatedAt });
  }
  return true;
}

/**
 * Replace a row's lesson `before` with `after`: a signal in both with the same success stays;
 * one whose success flipped is relabelled (n unchanged), or recorded when its option has no
 * row any more; one only in `before` is retracted; one only in `after` is recorded. Returns
 * how many bucket options changed.
 */
export function replaceLesson(
  db: StorageAdapter,
  before: readonly BiasSignal[],
  after: readonly BiasSignal[],
  learning: LearningConfig,
  now = Date.now(),
): number {
  if (!learning.enabled) return 0;
  const prev = new Map(before.map((s) => [signalKey(s), s]));
  let changed = 0;
  for (const s of after) {
    const k = signalKey(s);
    const p = prev.get(k);
    prev.delete(k);
    if (p === undefined) {
      recordSignal(db, s, learning, now);
      changed++;
    } else if (p.success !== s.success) {
      if (!adjustSignal(db, s, 0, s.success ? 1 : -1, s.success ? -1 : 1, learning, now))
        recordSignal(db, s, learning, now);
      changed++;
    }
  }
  for (const p of prev.values())
    if (adjustSignal(db, p, -1, p.success ? -1 : 0, p.success ? 0 : -1, learning, now)) changed++;
  return changed;
}

// --- feedback ------------------------------------------------------------------------

export type Feedback = "good" | "too_small" | "too_big";

export const FEEDBACK_OUTCOME: Readonly<Record<Feedback, AdjudicationOutcome>> = Object.freeze({
  good: "success",
  too_small: "failure",
  too_big: "success",
});

export interface FeedbackOptions {
  now?: number | undefined;
  learning?: Partial<LearningConfig> | undefined;
  config?: LearnConfigInput | undefined;
  /** The tier ladder used for "next-lower tier"; default config.adjudicator.tiers or TIERS. */
  tiers?: readonly string[] | undefined;
}

export interface FeedbackResult {
  row: AdjudicationRow;
  /** Bucket options the feedback changed; 0 when the bias already held this lesson. */
  learned: number;
}

/**
 * Explicit feedback on one decision: labels the outcome (outcome_source "feedback:<kind>",
 * final) and makes the row's lesson the feedback's (feedbackLesson), replacing what the row
 * taught before — an earlier feedback, or reconcile's lesson at finalisation — rather than
 * adding to it. Sending the same feedback again changes nothing. Undefined for an unknown id.
 */
export function applyFeedbackResult(
  db: StorageAdapter,
  id: number,
  feedback: Feedback,
  opts: FeedbackOptions = {},
): FeedbackResult | undefined {
  const row = db.adjudicator.get(id);
  if (!row) return undefined;
  const now = opts.now ?? Date.now();
  const learning = learningOf(opts.learning, opts.config);
  const ladder = opts.tiers ?? opts.config?.adjudicator?.tiers ?? TIERS;
  const same = feedbackOf(row) === feedback;
  // What the row's lesson actually put in the buckets (scores.taught), not a lesson recomputed
  // from the row, config and swarm ledger as they are now.
  const before = taughtLesson(db, row, ladder);
  const after = feedbackLesson(db, row, feedback, ladder);
  // With learning off nothing moves, so the buckets still hold `before`.
  const scores = withTaught(row.scores, learning.enabled ? after : before);
  db.adjudicator.update(id, {
    outcome: FEEDBACK_OUTCOME[feedback],
    outcomeSource: feedbackSource(feedback),
    // Repeated identical feedback keeps the time it was first given.
    outcomeTs: same && row.outcomeTs != null ? row.outcomeTs : now,
    final: true,
    ...(scores !== undefined ? { scores } : {}),
  });
  const learned = replaceLesson(db, before, after, learning, now);
  const updated = db.adjudicator.get(id);
  return updated ? { row: updated, learned } : undefined;
}

/** applyFeedbackResult, returning only the updated row. */
export function applyFeedback(
  db: StorageAdapter,
  id: number,
  feedback: Feedback,
  opts: FeedbackOptions = {},
): AdjudicationRow | undefined {
  return applyFeedbackResult(db, id, feedback, opts)?.row;
}
