import type Database from "better-sqlite3";
import type { AdjudicationRow, Surface, Verdict } from "../../adjudicator/types.js";
import { dispatchFilter, keptDispatch, keptModel } from "../dispatch.js";
import type {
  AdjudicationInput,
  AdjudicationListFilter,
  AdjudicationPatch,
  AdjudicationSummary,
  AdjudicatorBiasRow,
  AdjudicatorCacheEntry,
  AdjudicatorProviderState,
  AdjudicatorStore,
  ExchangeInput,
  ExchangeRow,
  ExchangeSummaryRow,
  LatencyStats,
} from "../types.js";
import { healAdjudicatorColumns } from "./schema.js";

type Row = Record<string, unknown>;

/** The columns summary() reads. */
const SUMMARY_COLUMNS = `surface, source, provider_status, action, outcome, latency_ms,
  provider_latency_ms, cost_usd, savings_usd, model_final, actual_model, run_id, task_id,
  model_requested, scores`;

/** Advise-mode actions: the follow rate's denominator. */
const ADVISE_ACTIONS = new Set(["advised", "followed", "ignored"]);

/** Every `adjudications` column except id, as [camelCase field, snake_case column]. */
const COLUMNS: ReadonlyArray<readonly [Exclude<keyof AdjudicationRow, "id">, string]> = [
  ["ts", "ts"],
  ["surface", "surface"],
  ["sessionId", "session_id"],
  ["agentId", "agent_id"],
  ["toolUseId", "tool_use_id"],
  ["runId", "run_id"],
  ["taskId", "task_id"],
  ["parentId", "parent_id"],
  ["inputHash", "input_hash"],
  ["inputHead", "input_head"],
  ["inputChars", "input_chars"],
  ["complexity", "complexity"],
  ["tier", "tier"],
  ["effort", "effort"],
  ["tool", "tool"],
  ["role", "role"],
  ["confidence", "confidence"],
  ["scores", "scores"],
  ["source", "source"],
  ["provider", "provider"],
  ["providerModel", "provider_model"],
  ["providerStatus", "provider_status"],
  ["latencyMs", "latency_ms"],
  ["providerLatencyMs", "provider_latency_ms"],
  ["tokensIn", "tokens_in"],
  ["tokensOut", "tokens_out"],
  ["costUsd", "cost_usd"],
  ["action", "action"],
  ["modelRequested", "model_requested"],
  ["modelFinal", "model_final"],
  ["baselineModel", "baseline_model"],
  ["actualModel", "actual_model"],
  ["actualTokens", "actual_tokens"],
  ["actualCostUsd", "actual_cost_usd"],
  ["baselineCostUsd", "baseline_cost_usd"],
  ["savingsUsd", "savings_usd"],
  ["outcome", "outcome"],
  ["outcomeSource", "outcome_source"],
  ["outcomeTs", "outcome_ts"],
  ["final", "final"],
  ["version", "version"],
  ["feedbackNote", "feedback_note"],
];

const LATENCY_RING = 50;
const MAX_LIST = 500;

/** How many exchanges the log keeps (the newest by id). A constant, not a setting. */
export const EXCHANGE_KEEP = 100;

/** The adjudicator_exchanges columns exchangeList reads: everything but the bodies and error. */
const EXCHANGE_SUMMARY_COLUMNS = `id, ts, call_id, batch, provider, model, surface, context, method,
  target, row_ids, items, outcome, http_status, timed_out, attempts, wait_ms, job_wait_ms, ttfb_ms,
  duration_ms, retry_wait_ms, deadline_ms, budget_ms, tokens_in, tokens_out, cost_usd,
  request_bytes, request_truncated, response_bytes, response_truncated`;

/** Insert order of adjudicator_exchanges (id is assigned by SQLite). */
const EXCHANGE_INSERT_COLUMNS = [
  "ts",
  "call_id",
  "batch",
  "provider",
  "model",
  "surface",
  "context",
  "method",
  "target",
  "row_ids",
  "items",
  "outcome",
  "http_status",
  "timed_out",
  "attempts",
  "wait_ms",
  "job_wait_ms",
  "ttfb_ms",
  "duration_ms",
  "retry_wait_ms",
  "deadline_ms",
  "budget_ms",
  "tokens_in",
  "tokens_out",
  "cost_usd",
  "request_body",
  "request_bytes",
  "request_truncated",
  "response_body",
  "response_bytes",
  "response_truncated",
  "error",
] as const;

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseRowIds(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function toExchangeSummary(r: Row): ExchangeSummaryRow {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    callId: String(r.call_id),
    batch: Number(r.batch ?? 0),
    provider: String(r.provider),
    model: strOrNull(r.model),
    surface: strOrNull(r.surface),
    context: strOrNull(r.context),
    method: String(r.method),
    target: String(r.target),
    rowIds: parseRowIds(r.row_ids),
    items: Number(r.items),
    outcome: String(r.outcome),
    httpStatus: numOrNull(r.http_status),
    timedOut: r.timed_out === 1,
    attempts: Number(r.attempts ?? 1),
    waitMs: numOrNull(r.wait_ms),
    jobWaitMs: numOrNull(r.job_wait_ms),
    ttfbMs: numOrNull(r.ttfb_ms),
    durationMs: numOrNull(r.duration_ms),
    retryWaitMs: Number(r.retry_wait_ms ?? 0),
    deadlineMs: Number(r.deadline_ms),
    budgetMs: numOrNull(r.budget_ms),
    tokensIn: numOrNull(r.tokens_in),
    tokensOut: numOrNull(r.tokens_out),
    costUsd: numOrNull(r.cost_usd),
    requestBytes: Number(r.request_bytes),
    requestTruncated: r.request_truncated === 1,
    responseBytes: numOrNull(r.response_bytes),
    responseTruncated: r.response_truncated === 1,
  };
}

/** A value as SQLite stores it: booleans become 0/1, undefined becomes NULL. */
function toDb(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function toRow(r: Row): AdjudicationRow {
  const out: Record<string, unknown> = { id: r.id };
  for (const [field, col] of COLUMNS) out[field] = field === "final" ? r[col] === 1 : r[col];
  return out as unknown as AdjudicationRow;
}

function parseVerdict(raw: unknown): Verdict | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Verdict) : null;
  } catch {
    return null;
  }
}

function parseLatencies(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
  } catch {
    return [];
  }
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

function latencyStats(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

function bump(map: Record<string, number>, key: unknown): void {
  const k = typeof key === "string" && key ? key : "(none)";
  map[k] = (map[k] ?? 0) + 1;
}

/** SQLite implementation of the adjudicator store; shares the adapter's connection. */
export class SqliteAdjudicatorStore implements AdjudicatorStore {
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();

  private healed = false;

  constructor(private readonly db: Database.Database) {}

  /**
   * Before the first statement, add the v8 columns a pre-release v8 database lacks (schema.ts
   * ADJUDICATOR_LATE_COLUMNS). Done here rather than at open so a disabled adjudicator never
   * touches its tables; the adapter has migrated by the time any store method runs.
   */
  private heal(): void {
    if (this.healed) return;
    try {
      healAdjudicatorColumns(this.db);
      this.healed = true;
    } catch {
      // a read-only or busy database: retried on the next new statement; meanwhile the
      // statement that needs the column reports the error
    }
  }

  private prep(sql: string): Database.Statement<unknown[], unknown> {
    let s = this.stmts.get(sql);
    if (!s) {
      this.heal();
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // --- adjudications ----------------------------------------------------------------

  insert(row: AdjudicationInput): number {
    const full: Omit<AdjudicationRow, "id"> = {
      ...row,
      ts: row.ts ?? Date.now(),
      outcome: row.outcome ?? "pending",
      final: row.final ?? false,
    };
    const cols = COLUMNS.map(([, c]) => c);
    const values = COLUMNS.map(([f]) => toDb(full[f]));
    const info = this.prep(
      `INSERT INTO adjudications (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ).run(...values);
    return Number(info.lastInsertRowid);
  }

  update(id: number, patch: AdjudicationPatch): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, col] of COLUMNS) {
      if (!(field in patch) || patch[field] === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(toDb(patch[field]));
    }
    if (!sets.length) return this.get(id) !== undefined;
    params.push(id);
    return (
      this.prep(`UPDATE adjudications SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes >
      0
    );
  }

  get(id: number): AdjudicationRow | undefined {
    const r = this.prep("SELECT * FROM adjudications WHERE id = ?").get(id) as Row | undefined;
    return r ? toRow(r) : undefined;
  }

  list(filter: AdjudicationListFilter = {}): {
    rows: AdjudicationRow[];
    total: number;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    if (filter.surface) {
      where.push("surface = ?");
      params.push(filter.surface);
    }
    if (filter.provider) {
      where.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.outcome) {
      where.push("outcome = ?");
      params.push(filter.outcome);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.prep(`SELECT COUNT(*) AS n FROM adjudications ${clause}`).get(...params) as {
        n: number;
      }
    ).n;
    const limit = Math.max(1, Math.min(filter.limit ?? 50, MAX_LIST));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.prep(
      `SELECT * FROM adjudications ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Row[];
    return { rows: rows.map(toRow), total };
  }

  latestForSession(sessionId: string, surface: string): AdjudicationRow | undefined {
    const r = this.prep(
      `SELECT * FROM adjudications WHERE session_id = ? AND surface = ?
       ORDER BY ts DESC, id DESC LIMIT 1`,
    ).get(sessionId, surface) as Row | undefined;
    return r ? toRow(r) : undefined;
  }

  byToolUseId(
    toolUseId: string,
    filter: { surface?: string; since?: number } = {},
  ): AdjudicationRow | undefined {
    const r = this.prep(
      `SELECT * FROM adjudications
       WHERE tool_use_id = ? AND (? IS NULL OR surface = ?) AND ts >= ?
       ORDER BY ts DESC, id DESC LIMIT 1`,
    ).get(toolUseId, filter.surface ?? null, filter.surface ?? null, filter.since ?? 0) as
      | Row
      | undefined;
    return r ? toRow(r) : undefined;
  }

  forTask(runId: string, taskId: number): AdjudicationRow[] {
    return (
      this.prep("SELECT * FROM adjudications WHERE run_id = ? AND task_id = ? ORDER BY ts, id").all(
        runId,
        taskId,
      ) as Row[]
    ).map(toRow);
  }

  forRun(runId: string): AdjudicationRow[] {
    return (
      this.prep(
        "SELECT * FROM adjudications WHERE run_id = ? AND task_id IS NOT NULL ORDER BY ts, id",
      ).all(runId) as Row[]
    ).map(toRow);
  }

  nonFinal(limit: number, olderThan?: number): AdjudicationRow[] {
    const n = Math.max(1, Math.min(limit, 10_000));
    const rows =
      olderThan === undefined
        ? this.prep("SELECT * FROM adjudications WHERE final = 0 ORDER BY ts, id LIMIT ?").all(n)
        : this.prep(
            "SELECT * FROM adjudications WHERE final = 0 AND ts < ? ORDER BY ts, id LIMIT ?",
          ).all(olderThan, n);
    return (rows as Row[]).map(toRow);
  }

  // --- cache ------------------------------------------------------------------------

  cacheGet(key: string, now: number, maxAgeMs?: number): AdjudicatorCacheEntry | undefined {
    const r = this.prep("SELECT * FROM adjudicator_cache WHERE key = ?").get(key) as
      | Row
      | undefined;
    if (!r) return undefined;
    const createdAt = Number(r.created_at);
    if (maxAgeMs !== undefined && createdAt < now - maxAgeMs) return undefined;
    const verdict = parseVerdict(r.verdict);
    let hits = Number(r.hits ?? 0);
    let lastHitAt = r.last_hit_at == null ? null : Number(r.last_hit_at);
    if (verdict) {
      try {
        this.prep(
          "UPDATE adjudicator_cache SET hits = hits + 1, last_hit_at = ? WHERE key = ?",
        ).run(now, key);
        hits += 1;
        lastHitAt = now;
      } catch {
        // The hit counter is a statistic: a locked database (SQLITE_BUSY) must not turn a hit
        // the reader can see into a miss, so the bump is skipped instead.
      }
    }
    return {
      key,
      verdict,
      provider: (r.provider as string | null) ?? null,
      createdAt,
      lastHitAt,
      hits,
    };
  }

  cachePut(key: string, verdict: Verdict | null, provider: string | null, now = Date.now()): void {
    this.prep(
      `INSERT INTO adjudicator_cache (key, verdict, provider, created_at, last_hit_at, hits)
       VALUES (?, ?, ?, ?, NULL, 0)
       ON CONFLICT(key) DO UPDATE SET verdict = excluded.verdict, provider = excluded.provider,
         created_at = excluded.created_at, last_hit_at = NULL, hits = 0`,
    ).run(key, verdict ? JSON.stringify(verdict) : null, provider, now);
  }

  cachePrune(maxEntries: number, ttlMs: number, now = Date.now()): number {
    const expired = this.prep("DELETE FROM adjudicator_cache WHERE created_at < ?").run(
      now - ttlMs,
    ).changes;
    const lru = this.prep(
      `DELETE FROM adjudicator_cache WHERE key NOT IN (
         SELECT key FROM adjudicator_cache
         ORDER BY COALESCE(last_hit_at, created_at) DESC, created_at DESC LIMIT ?)`,
    ).run(Math.max(0, maxEntries)).changes;
    return expired + lru;
  }

  // --- provider state ---------------------------------------------------------------

  providerState(provider: string): AdjudicatorProviderState | undefined {
    const r = this.prep("SELECT * FROM adjudicator_provider_state WHERE provider = ?").get(
      provider,
    ) as Row | undefined;
    if (!r) return undefined;
    return {
      provider,
      state: String(r.state),
      failures: Number(r.failures ?? 0),
      retryAt: r.retry_at == null ? null : Number(r.retry_at),
      lastOkAt: r.last_ok_at == null ? null : Number(r.last_ok_at),
      lastErrorAt: r.last_error_at == null ? null : Number(r.last_error_at),
      lastErrorClass: (r.last_error_class as string | null) ?? null,
      latencies: parseLatencies(r.latencies),
      latencyBudgets: parseLatencies(r.latency_budgets),
      spendDay: (r.spend_day as string | null) ?? null,
      spendUsd: Number(r.spend_usd ?? 0),
      calls: Number(r.calls ?? 0),
      authFingerprint: (r.auth_fingerprint as string | null) ?? null,
    };
  }

  saveProviderState(
    provider: string,
    patch: Partial<Omit<AdjudicatorProviderState, "provider">>,
  ): AdjudicatorProviderState {
    const base: AdjudicatorProviderState = this.providerState(provider) ?? {
      provider,
      state: "closed",
      failures: 0,
      retryAt: null,
      lastOkAt: null,
      lastErrorAt: null,
      lastErrorClass: null,
      latencies: [],
      latencyBudgets: [],
      spendDay: null,
      spendUsd: 0,
      calls: 0,
      authFingerprint: null,
    };
    const next: AdjudicatorProviderState = { ...base, provider };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    next.latencies = next.latencies.slice(-LATENCY_RING);
    // Never longer than the ring it annotates (the two are aligned at the end).
    const budgets = next.latencyBudgets ?? [];
    next.latencyBudgets = budgets.slice(Math.max(0, budgets.length - next.latencies.length));
    this.prep(
      `INSERT INTO adjudicator_provider_state (provider, state, failures, retry_at, last_ok_at,
         last_error_at, last_error_class, latencies, latency_budgets, spend_day, spend_usd, calls,
         auth_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET state = excluded.state, failures = excluded.failures,
         retry_at = excluded.retry_at, last_ok_at = excluded.last_ok_at,
         last_error_at = excluded.last_error_at, last_error_class = excluded.last_error_class,
         latencies = excluded.latencies, latency_budgets = excluded.latency_budgets,
         spend_day = excluded.spend_day,
         spend_usd = excluded.spend_usd, calls = excluded.calls,
         auth_fingerprint = excluded.auth_fingerprint`,
    ).run(
      provider,
      next.state,
      next.failures,
      next.retryAt,
      next.lastOkAt,
      next.lastErrorAt,
      next.lastErrorClass,
      JSON.stringify(next.latencies),
      JSON.stringify(next.latencyBudgets),
      next.spendDay,
      next.spendUsd,
      next.calls,
      next.authFingerprint,
    );
    return next;
  }

  atomically<T>(fn: () => T, o: { lockWaitMs?: number | undefined } = {}): T {
    // Heal before BEGIN so the DDL never runs inside the caller's transaction.
    this.heal();
    if (this.db.inTransaction) return fn();
    const tx = () => this.db.transaction(fn).immediate();
    return o.lockWaitMs === undefined ? tx() : this.withLockWait(o.lockWaitMs, tx);
  }

  withLockWait<T>(ms: number, fn: () => T): T {
    const prev = Number(this.db.pragma("busy_timeout", { simple: true }));
    const next = Math.max(0, Math.min(Number.isFinite(prev) ? prev : 0, Math.floor(ms)));
    if (next === prev) return fn();
    this.db.pragma(`busy_timeout = ${next}`);
    try {
      return fn();
    } finally {
      this.db.pragma(`busy_timeout = ${prev}`);
    }
  }

  // --- bias -------------------------------------------------------------------------

  biasAll(): AdjudicatorBiasRow[] {
    return (
      this.prep("SELECT * FROM adjudicator_bias ORDER BY dimension, bucket, option").all() as Row[]
    ).map((r) => ({
      dimension: String(r.dimension),
      bucket: String(r.bucket),
      option: String(r.option),
      n: Number(r.n),
      s: Number(r.s),
      f: Number(r.f),
      costMedian: r.cost_median == null ? null : Number(r.cost_median),
      bias: Number(r.bias),
      updatedAt: r.updated_at == null ? null : Number(r.updated_at),
    }));
  }

  biasUpsert(row: Omit<AdjudicatorBiasRow, "updatedAt"> & { updatedAt?: number | null }): void {
    this.prep(
      `INSERT INTO adjudicator_bias (dimension, bucket, option, n, s, f, cost_median, bias, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dimension, bucket, option) DO UPDATE SET n = excluded.n, s = excluded.s,
         f = excluded.f, cost_median = excluded.cost_median, bias = excluded.bias,
         updated_at = excluded.updated_at`,
    ).run(
      row.dimension,
      row.bucket,
      row.option,
      row.n,
      row.s,
      row.f,
      row.costMedian,
      row.bias,
      row.updatedAt ?? Date.now(),
    );
  }

  biasReset(): number {
    return this.prep("DELETE FROM adjudicator_bias").run().changes;
  }

  // --- summary & purge --------------------------------------------------------------

  summary(since?: number): AdjudicationSummary {
    const rows = (
      since === undefined
        ? this.prep(`SELECT ${SUMMARY_COLUMNS} FROM adjudications`).all()
        : this.prep(`SELECT ${SUMMARY_COLUMNS} FROM adjudications WHERE ts >= ?`).all(since)
    ) as Row[];
    // Each dispatch counted once, by the savings report's rule (src/storage/dispatch.ts): a swarm
    // task by its agent row, by its plan row only when no agent row tracks it. Prompt, mcp and
    // tool rows are no dispatches, so they stay out of the follow rate and keptModel (#81).
    const fields = rows.map((r) => ({
      surface: r.surface as Surface,
      runId: (r.run_id as string | null) ?? null,
      taskId: (r.task_id as number | null) ?? null,
      scores: (r.scores as string | null) ?? null,
      modelRequested: (r.model_requested as string | null) ?? null,
      actualModel: (r.actual_model as string | null) ?? null,
    }));
    const isDispatch = dispatchFilter(fields);
    const bySurface: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byProviderStatus: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    const latency: number[] = [];
    const providerLatency: number[] = [];
    let costUsd = 0;
    let savingsUsd = 0;
    let applyIneffective = 0;
    let applyChecked = 0;
    const kept = { pin: 0, force: 0, fork: 0 };
    let followed = 0;
    let adviseDispatches = 0;
    rows.forEach((r, i) => {
      const f = fields[i] as (typeof fields)[number];
      if (isDispatch(f)) {
        // Dispatches that ran on a model Claude Code chose: the savings report's keptModel.
        const k = keptDispatch(f);
        if (k) kept[k] += 1;
        // A dispatch whose advice named no model has nothing to follow (reconcile never marks
        // it followed), whether or not it has run yet: out of the follow rate.
        if (typeof r.action === "string" && ADVISE_ACTIONS.has(r.action) && !keptModel(f)) {
          adviseDispatches += 1;
          if (r.action === "followed") followed += 1;
        }
      }
      bump(bySurface, r.surface);
      bump(bySource, r.source);
      bump(byProviderStatus, r.provider_status);
      bump(byAction, r.action);
      bump(byOutcome, r.outcome);
      if (typeof r.latency_ms === "number") latency.push(r.latency_ms);
      if (typeof r.provider_latency_ms === "number") providerLatency.push(r.provider_latency_ms);
      if (typeof r.cost_usd === "number") costUsd += r.cost_usd;
      if (typeof r.savings_usd === "number") savingsUsd += r.savings_usd;
      if (r.action === "applied" && typeof r.actual_model === "string" && r.actual_model) {
        applyChecked += 1;
        const want = typeof r.model_final === "string" ? r.model_final.toLowerCase() : "";
        if (!want || !r.actual_model.toLowerCase().includes(want)) applyIneffective += 1;
      }
    });
    const a = (k: string) => byAction[k] ?? 0;
    return {
      since: since ?? null,
      total: rows.length,
      bySurface,
      bySource,
      byProviderStatus,
      byAction,
      byOutcome,
      latency: latencyStats(latency),
      providerLatency: latencyStats(providerLatency),
      rates: {
        follow: ratio(followed, adviseDispatches),
        apply: ratio(a("applied"), a("applied") + a("respected")),
        respect: ratio(a("respected"), a("applied") + a("respected")),
      },
      keptModel: kept,
      costUsd,
      savingsUsd,
      netUsd: savingsUsd - costUsd,
      applyIneffective,
      applyChecked,
    };
  }

  // --- exchange log -----------------------------------------------------------------

  exchangeInsert(xs: ExchangeInput[], keep = EXCHANGE_KEEP): number[] {
    if (!xs.length) return [];
    const kept = Math.max(1, Math.floor(keep));
    const cols = EXCHANGE_INSERT_COLUMNS;
    // Zero lock wait: a busy database throws at once (the caller fails open) instead of
    // stalling a hook. Inside an outer transaction atomically() joins it.
    // secure_delete covers the inserts too: a b-tree split that turns a leaf into an interior
    // page otherwise leaves the old cells' text in the page's unused area, out of reach of
    // the prune's own zeroing.
    const ownTx = !this.db.inTransaction;
    let pruned = 0;
    const out = this.secureDelete(() =>
      this.atomically(
        () => {
          const insert = this.prep(
            `INSERT INTO adjudicator_exchanges (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          );
          const ids: number[] = [];
          for (const x of xs) {
            const info = insert.run(
              x.ts,
              x.callId,
              x.batch ?? 0,
              x.provider,
              toDb(x.model),
              toDb(x.surface),
              toDb(x.context),
              x.method,
              x.target,
              JSON.stringify(x.rowIds ?? []),
              x.items,
              x.outcome,
              toDb(x.httpStatus),
              toDb(x.timedOut ?? false),
              x.attempts ?? 1,
              toDb(x.waitMs),
              toDb(x.jobWaitMs),
              toDb(x.ttfbMs),
              toDb(x.durationMs),
              x.retryWaitMs ?? 0,
              x.deadlineMs,
              toDb(x.budgetMs),
              toDb(x.tokensIn),
              toDb(x.tokensOut),
              toDb(x.costUsd),
              x.requestBody,
              x.requestBytes,
              toDb(x.requestTruncated ?? false),
              toDb(x.responseBody),
              toDb(x.responseBytes),
              toDb(x.responseTruncated ?? false),
              toDb(x.error),
            );
            ids.push(Number(info.lastInsertRowid));
          }
          // Everything older than the newest `kept` ids. A NULL subquery (fewer rows than `kept`)
          // compares false and deletes nothing.
          const prune = this.prep(
            `DELETE FROM adjudicator_exchanges WHERE id < (
             SELECT id FROM adjudicator_exchanges ORDER BY id DESC LIMIT 1 OFFSET ?)`,
          );
          pruned = prune.run(kept - 1).changes;
          return ids;
        },
        { lockWaitMs: 0 },
      ),
    );
    // A pruned body is zeroed in the database pages; its insert frames stay in the -wal until
    // the log is truncated. Only once the transaction is ours (an outer one commits later).
    if (pruned > 0 && ownTx) this.checkpoint();
    return out;
  }

  /**
   * Run `fn` with PRAGMA secure_delete=ON, so the pages a DELETE frees are zeroed rather
   * than left with the old text in the file. Not FAST: exchange bodies sit in overflow
   * pages, which FAST does not clear. Scoped to the exchange writes so the rest of the
   * adjudicator writes keep the cheaper default; the previous value is restored.
   */
  private secureDelete<T>(fn: () => T): T {
    let prev: number | undefined;
    try {
      prev = Number(this.db.pragma("secure_delete", { simple: true }));
      if (prev !== 1) this.db.pragma("secure_delete = ON");
    } catch {
      prev = undefined; // the delete still runs; it just may leave free pages unzeroed
    }
    try {
      return fn();
    } finally {
      if (prev !== undefined && prev !== 1) {
        try {
          this.db.pragma(`secure_delete = ${prev}`);
        } catch {
          // a connection left at ON is only slower, never wrong
        }
      }
    }
  }

  /**
   * Best-effort PRAGMA wal_checkpoint(TRUNCATE): copy the WAL into the database and cut the
   * -wal file to zero bytes, so deleted exchange bodies do not linger in old log frames while
   * another connection (the MCP server, the dashboard) keeps the log alive. Never waits for
   * a lock and never throws: a busy database or an open reader leaves the log as it is.
   * Skipped inside a caller's transaction, where it cannot run.
   */
  private checkpoint(): void {
    if (this.db.inTransaction) return;
    try {
      this.withLockWait(0, () => this.db.pragma("wal_checkpoint(TRUNCATE)"));
    } catch {
      // fail open
    }
  }

  /** False on a database whose schema_version claims v9 but lacks the table (another build). */
  private hasExchangesTable(): boolean {
    try {
      return (
        this.prep(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adjudicator_exchanges'",
        ).get() !== undefined
      );
    } catch {
      return true; // let the statement that needs the table report the real error
    }
  }

  exchangeList(filter: { limit?: number; rowId?: number } = {}): {
    rows: ExchangeSummaryRow[];
    total: number;
  } {
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? EXCHANGE_KEEP), EXCHANGE_KEEP));
    const byRow = filter.rowId !== undefined;
    const clause = byRow
      ? "WHERE EXISTS (SELECT 1 FROM json_each(adjudicator_exchanges.row_ids) WHERE value = ?)"
      : "";
    const params: unknown[] = byRow ? [filter.rowId] : [];
    const total = (
      this.prep(`SELECT COUNT(*) AS n FROM adjudicator_exchanges ${clause}`).get(...params) as {
        n: number;
      }
    ).n;
    const rows = this.prep(
      `SELECT ${EXCHANGE_SUMMARY_COLUMNS} FROM adjudicator_exchanges ${clause}
       ORDER BY id DESC LIMIT ?`,
    ).all(...params, limit) as Row[];
    return { rows: rows.map(toExchangeSummary), total };
  }

  exchangeGet(id: number): ExchangeRow | undefined {
    const r = this.prep("SELECT * FROM adjudicator_exchanges WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!r) return undefined;
    return {
      ...toExchangeSummary(r),
      requestBody: String(r.request_body),
      responseBody: strOrNull(r.response_body),
      error: strOrNull(r.error),
    };
  }

  exchangeCount(): number {
    return (
      this.prep("SELECT COUNT(*) AS n FROM adjudicator_exchanges").get() as {
        n: number;
      }
    ).n;
  }

  exchangePurge(): number {
    if (!this.hasExchangesTable()) return 0;
    const del = this.prep("DELETE FROM adjudicator_exchanges");
    const n = this.secureDelete(() => del.run().changes);
    this.checkpoint();
    return n;
  }

  purge(): void {
    this.db.exec(
      "DELETE FROM adjudications; DELETE FROM adjudicator_cache; DELETE FROM adjudicator_provider_state; DELETE FROM adjudicator_bias;",
    );
    // A database at schema_version >= 9 from another build may lack the table: skip it
    // rather than fail after the deletes above.
    if (!this.hasExchangesTable()) return;
    this.secureDelete(() => this.db.exec("DELETE FROM adjudicator_exchanges"));
    // Inside the adapter's purge transaction this is skipped (the adapter VACUUMs after).
    this.checkpoint();
  }
}
