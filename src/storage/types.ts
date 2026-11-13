import type {
  Autonomy,
  GrantStatus,
  SecurityAction,
  SecurityAssessment,
  Level as SecurityLevel,
  SecurityModelStatus,
  SecuritySurface,
} from "../adjudicator/security/types.js";
import type { AdjudicationRow, Verdict } from "../adjudicator/types.js";

export type ContentType = "prose" | "code" | "json";

/** Well-known sources; any string is accepted so callers can namespace freely. */
export type Source =
  | "exec"
  | "batch"
  | "file"
  | "url"
  | "session"
  | "memory"
  | "code"
  | (string & {});

export interface DocumentInput {
  source: Source;
  title: string;
  uri?: string | undefined;
  contentType: ContentType;
  contentHash: string;
  sessionId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface DocumentRow {
  id: number;
  source: string;
  title: string;
  uri: string | null;
  content_type: ContentType;
  content_hash: string;
  session_id: string | null;
  meta: string | null;
  created_at: number;
}

export interface ChunkInput {
  ord: number;
  title: string;
  body: string;
  contentType: ContentType;
  startLine?: number | undefined;
  endLine?: number | undefined;
  hash: string;
  /** Graph node id (`sym:<rel>#<Qualified>`) this chunk is the body of, for code. */
  symbolId?: string | undefined;
}

export interface ChunkRow {
  id: number;
  document_id: number;
  ord: number;
  title: string;
  body: string;
  content_type: ContentType;
  start_line: number | null;
  end_line: number | null;
  hash: string;
  embedded: number;
  symbol_id: string | null;
}

export interface ChunkWithDoc extends ChunkRow {
  document: DocumentRow;
}

/** A document with its chunk count, for per-source listings. */
export interface DocumentSummaryRow {
  id: number;
  source: string;
  title: string;
  uri: string | null;
  created_at: number;
  chunks: number;
}

/** Document and chunk totals for one source tag. */
export interface SourceStatRow {
  source: string;
  documents: number;
  chunks: number;
  latest: number;
}

export interface SearchFilters {
  source?: string | string[] | undefined;
  /** Every source tag starting with this prefix (e.g. `docs:` for all documentation sources). */
  sourcePrefix?: string | undefined;
  contentType?: ContentType | undefined;
  /** Unix ms; only documents created at or after this time. */
  since?: number | undefined;
  sessionId?: string | undefined;
  documentIds?: number[] | undefined;
}

export interface FtsHit {
  chunkId: number;
  /** Higher is better (negated bm25). */
  score: number;
}

export interface VecHit {
  chunkId: number;
  distance: number;
}

export interface VocabTerm {
  term: string;
  df: number;
}

/** The sources the recall index holds: memories, documentation pages and captured tool errors. */
export type RecallSource = "memory" | "docs" | "error";

export type PurgeScope =
  | "index"
  | "sessions"
  | "graph"
  | "memories"
  | "usage"
  | "adjudicator"
  | "all";

export interface SessionRow {
  id: string;
  project_root: string | null;
  started_at: number | null;
  ended_at: number | null;
  source: string | null;
  last_prompt: string | null;
  transcript_path: string | null;
}

export interface EventInput {
  sessionId: string;
  category: string;
  priority: 1 | 2 | 3 | 4;
  tool?: string | undefined;
  payload: Record<string, unknown>;
  documentId?: number | undefined;
  ts?: number | undefined;
}

export interface EventRow {
  id: number;
  session_id: string;
  ts: number;
  category: string;
  priority: number;
  tool: string | null;
  payload: string;
  document_id: number | null;
}

export interface StatDelta {
  rawChars: number;
  returnedChars: number;
  durationMs: number;
}

export interface StatRow {
  session_id: string;
  tool: string;
  calls: number;
  raw_chars: number;
  returned_chars: number;
  duration_ms: number;
}

export interface MemoryInput {
  kind: string;
  content: string;
  tags?: string[] | undefined;
  nodeIds?: string[] | undefined;
  sessionId?: string | undefined;
  documentId?: number | undefined;
  /** `topic/slug`; the markdown file is `<memories.dir>/<name>.md`. */
  name?: string | undefined;
  /** Project-relative path of that file. */
  path?: string | undefined;
  fileHash?: string | undefined;
  fileMtime?: number | undefined;
  fileSize?: number | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  /** ADR-style lifecycle for decisions: proposed | accepted | superseded | deprecated. */
  status?: string | undefined;
  /** Name of the memory this one replaces. */
  supersedes?: string | undefined;
}

export const MEMORY_STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface MemoryRow {
  id: number;
  kind: string;
  content: string;
  tags: string | null;
  node_ids: string | null;
  session_id: string | null;
  document_id: number | null;
  created_at: number;
  name: string | null;
  path: string | null;
  file_hash: string | null;
  file_mtime: number | null;
  file_size: number | null;
  updated_at: number | null;
  status: string | null;
  supersedes: string | null;
}

/** Who produced a node/edge: a parser, a person, git history, or a derived analysis pass. */
export type GraphSource = "tree-sitter" | "curated" | "git" | "analysis";

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  path?: string | null | undefined;
  startLine?: number | null | undefined;
  endLine?: number | null | undefined;
  source: GraphSource;
  confidence?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface GraphNodeRow {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  source: GraphSource;
  confidence: number;
  meta: string | null;
  updated_at: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: string;
  source: GraphSource;
  confidence?: number | undefined;
  weight?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface GraphEdgeRow {
  src: string;
  dst: string;
  kind: string;
  source: GraphSource;
  confidence: number;
  weight: number;
  meta: string | null;
  updated_at: number;
}

/** indexed: parsed into graph + search; partial: indexed with parse errors; skipped/unsupported: not in the graph. */
export type FileIndexStatus = "indexed" | "partial" | "skipped" | "unsupported";

export interface FileIndexRow {
  path: string;
  hash: string;
  mtime: number | null;
  size: number | null;
  language: string | null;
  indexed_at: number;
  document_id: number | null;
  status: FileIndexStatus;
  /** Why the file is not fully indexed (e.g. "over 1.5 MB", a parser error). */
  reason: string | null;
  /** Symbols the parser found. */
  symbols: number | null;
  errors: string | null;
}

export interface FileIndexInput {
  path: string;
  hash: string;
  mtime: number | null;
  size: number | null;
  language: string | null;
  document_id: number | null;
  status?: FileIndexStatus | undefined;
  reason?: string | null | undefined;
  symbols?: number | null | undefined;
  errors?: string | null | undefined;
}

/** Per-node structural and churn signals; `score` is a hotspot signal, not a quality grade. */
export interface GraphMetricRow {
  node_id: string;
  kind: string;
  path: string | null;
  fan_in: number;
  fan_out: number;
  loc: number;
  complexity: number;
  commits_90d: number;
  score: number;
  cluster: number | null;
  updated_at: number;
}

export type GraphMetricInput = Omit<GraphMetricRow, "updated_at">;

export interface IndexRunRow {
  id: number;
  scope: string;
  started_at: number;
  finished_at: number | null;
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
  errors: number;
  head_sha: string | null;
  detail: string | null;
}

export type IndexRunSummary = Partial<
  Pick<
    IndexRunRow,
    "scanned" | "indexed" | "unchanged" | "skipped" | "removed" | "errors" | "detail"
  >
>;

export interface SnapshotRow {
  id: number;
  session_id: string | null;
  trigger: string | null;
  body: string;
  bytes: number;
  created_at: number;
  consumed_at: number | null;
}

// --- usage (transcript-derived model calls, tool results, context events) --------------

/** One API request as recorded in a Claude Code transcript. Token counts are raw, cost is cached. */
export interface ApiCallRow {
  request_id: string;
  message_id: string;
  session_id: string;
  /** Subagent id when the call came from a sidechain, else null. */
  agent_id: string | null;
  sidechain: number;
  ts: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cache_read: number;
  thinking_tokens: number;
  web_searches: number;
  web_fetches: number;
  service_tier: string | null;
  speed: string | null;
  stop_reason: string | null;
  prompt_id: string | null;
  git_branch: string | null;
  cwd: string | null;
  effort: string | null;
  version: string | null;
  entrypoint: string | null;
  /** Cost at ingest time from the bundled pricing table; null when the model is unknown. */
  cost_usd: number | null;
  /** 1 when cost_usd came from a known price, 0 when the model was not priced. */
  priced: number;
}

export type ApiCallInput = Omit<ApiCallRow, "cost_usd" | "priced"> &
  Partial<Pick<ApiCallRow, "cost_usd" | "priced">>;

/** One tool invocation and its result size, from the transcript. */
export interface ToolUseRow {
  tool_use_id: string;
  session_id: string;
  agent_id: string | null;
  ts: number;
  tool: string;
  input_chars: number;
  /** Characters in the tool_result block; null until the result entry is seen. */
  result_chars: number | null;
  is_error: number;
  /** The request that produced the tool_use block. */
  request_id: string | null;
}

/** Compactions and clears, from `compact_boundary` system entries. */
export interface ContextEventRow {
  id: number;
  session_id: string;
  ts: number;
  kind: "compact" | "clear";
  trigger: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
}
export type ContextEventInput = Omit<ContextEventRow, "id">;

/** Tail state for one transcript file so ingest only reads new bytes. */
export interface TranscriptFileRow {
  path: string;
  session_id: string | null;
  offset: number;
  size: number;
  mtime: number;
  /**
   * sha1 (hex) of the first min(512, size) bytes when the row was written, so a rewrite
   * that keeps the size is still noticed. Null for rows that never read the file.
   */
  head_hash?: string | null;
  ingested_at: number;
}

/** One statusline render, recorded when the figures change. */
export interface StatuslineSnapshotRow {
  id: number;
  session_id: string;
  ts: number;
  model_id: string | null;
  cost_usd: number | null;
  api_ms: number | null;
  duration_ms: number | null;
  ctx_input_tokens: number | null;
  ctx_output_tokens: number | null;
  ctx_size: number | null;
  ctx_used_pct: number | null;
  cache_warm: number | null;
  cache_ttl: string | null;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}
export type StatuslineSnapshotInput = Omit<StatuslineSnapshotRow, "id">;

export interface UsageFilter {
  sessionId?: string | undefined;
  /** Epoch ms, inclusive. */
  since?: number | undefined;
  /** Epoch ms, exclusive. */
  until?: number | undefined;
  /** true = only sidechain rows, false = only main-thread rows, undefined = both. */
  sidechain?: boolean | undefined;
  limit?: number | undefined;
}

// --- adjudicator (docs/design/adjudicator.md §12) ------------------------------------

/** A new `adjudications` row: `id` is assigned, `ts` defaults to now, outcome to pending. */
export type AdjudicationInput = Omit<AdjudicationRow, "id" | "ts" | "outcome" | "final"> & {
  ts?: number | undefined;
  outcome?: AdjudicationRow["outcome"] | undefined;
  final?: boolean | undefined;
};

/** Columns to change; undefined leaves a column alone, null clears it. */
export type AdjudicationPatch = {
  [K in Exclude<keyof AdjudicationRow, "id">]?: AdjudicationRow[K] | undefined;
};

export interface AdjudicationListFilter {
  /** Epoch ms, inclusive. */
  since?: number | undefined;
  surface?: string | undefined;
  provider?: string | undefined;
  outcome?: string | undefined;
  /** Default 50, at most 500. */
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface AdjudicatorCacheEntry {
  key: string;
  /** null is the `pending` marker an async job leaves while it runs. */
  verdict: Verdict | null;
  provider: string | null;
  createdAt: number;
  lastHitAt: number | null;
  hits: number;
}

/** Breaker, latency ring and daily spend of one provider (§9). */
export interface AdjudicatorProviderState {
  provider: string;
  /** closed | open | half_open | slow | auth_failed */
  state: string;
  failures: number;
  retryAt: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastErrorClass: string | null;
  /** The last ≤ 50 provider latencies in ms, oldest first. */
  latencies: number[];
  /**
   * The budget in ms each latency was measured against, index-aligned with the END of
   * `latencies` (a shorter array means the oldest samples predate it; 0 = unknown). The slow
   * guard judges latency / budget, so surfaces with different budgets can share one ring.
   */
  latencyBudgets?: number[];
  /** UTC day (YYYY-MM-DD) that `spendUsd` and `calls` belong to. */
  spendDay: string | null;
  spendUsd: number;
  /** Provider calls made on `spendDay` (budget.dailyCalls). */
  calls: number;
  /**
   * state "auth_failed": sha256(key)[0:12] of the key the provider rejected (401/403); never
   * the key. The provider is skipped until the key changes or retryAt passes.
   */
  authFingerprint: string | null;
}

/** One learned bucket (§7.7): decayed counts n/s/f and the bias they yield. */
export interface AdjudicatorBiasRow {
  dimension: string;
  bucket: string;
  option: string;
  n: number;
  s: number;
  f: number;
  costMedian: number | null;
  bias: number;
  updatedAt: number | null;
}

export interface LatencyStats {
  /** Rows with a value. */
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface AdjudicationSummary {
  since: number | null;
  total: number;
  bySurface: Record<string, number>;
  bySource: Record<string, number>;
  byProviderStatus: Record<string, number>;
  byAction: Record<string, number>;
  byOutcome: Record<string, number>;
  latency: LatencyStats;
  providerLatency: LatencyStats;
  /**
   * follow = followed / advice-mode dispatches (advised, followed or ignored), each dispatch
   * counted once (src/storage/dispatch.ts dispatchFilter: a swarm task by its agent row, by its
   * plan row only when it has none; prompt rows are no dispatches) and leaving out those whose
   * advice named no model (a KeptModel flag: nothing to follow). apply = applied / (applied +
   * respected) and respect = respected / (applied + respected): apply-mode dispatches. null when
   * the denominator is 0.
   */
  rates: {
    follow: number | null;
    apply: number | null;
    respect: number | null;
    /** effortFollowed / (effortFollowed + effortIgnored); null with no counted dispatch. */
    effortFollow: number | null;
  };
  /** Dispatches whose scores.effortFollow is "followed" (see src/adjudicator/effort.ts). */
  effortFollowed: number;
  /** Dispatches whose scores.effortFollow is "ignored". */
  effortIgnored: number;
  /**
   * Dispatches whose set effort (effortApplied when the hook applied one, else passedEffort)
   * differs from the level that ran (actualEffort).
   */
  effortIneffective: number;
  /** Dispatches with both a set effort (effortApplied or passedEffort) and actualEffort (the m of "n of m"). */
  effortChecked: number;
  /**
   * Dispatches that ran on a model the advice did not name, counted exactly like the savings
   * report's keptModel (src/storage/dispatch.ts keptDispatch): the agent's pin was kept and it
   * ran on it, CLAUDE_CODE_SUBAGENT_MODEL_FORCE set the model, or a fork ran on the main
   * session's model. Only rows reconcile has priced (an actual model) count here; flagged rows
   * leave the follow rate even before that.
   */
  keptModel: { pin: number; force: number; fork: number };
  /** Σ cost_usd: the adjudicator's own provider spend. */
  costUsd: number;
  /** Σ savings_usd as reconcile credited it. */
  savingsUsd: number;
  /** savingsUsd − costUsd. */
  netUsd: number;
  /** Applied rows whose actual_model does not name model_final. */
  applyIneffective: number;
  /** Applied rows with an actual_model to compare against (the m of "n of m"). */
  applyChecked: number;
}

/**
 * One request sent to a provider and its answer, as stored in adjudicator_exchanges (Jev
 * exchange log). Bodies arrive already redacted and capped; the store keeps them verbatim.
 */
export interface ExchangeInput {
  /** When the request was sent (epoch ms). */
  ts: number;
  /** Groups the parallel batches of one provider call. */
  callId: string;
  batch?: number;
  provider: string;
  model?: string | null;
  surface?: string | null;
  context?: string | null;
  method: string;
  /** Host and path only: no query string, no credentials. */
  target: string;
  /** adjudications.id of the items in this request. */
  rowIds?: number[];
  items: number;
  /** ok | timeout | http_error | rate_limited | invalid */
  outcome: string;
  httpStatus?: number | null;
  timedOut?: boolean;
  attempts?: number;
  waitMs?: number | null;
  jobWaitMs?: number | null;
  ttfbMs?: number | null;
  durationMs?: number | null;
  retryWaitMs?: number;
  deadlineMs: number;
  budgetMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  requestBody: string;
  requestBytes: number;
  requestTruncated?: boolean;
  responseBody?: string | null;
  responseBytes?: number | null;
  responseTruncated?: boolean;
  /** Already-scrubbed error message. */
  error?: string | null;
}

/** A stored exchange without its bodies or error text: what the list reads. */
export interface ExchangeSummaryRow {
  id: number;
  ts: number;
  callId: string;
  batch: number;
  provider: string;
  model: string | null;
  surface: string | null;
  context: string | null;
  method: string;
  target: string;
  rowIds: number[];
  items: number;
  outcome: string;
  httpStatus: number | null;
  timedOut: boolean;
  attempts: number;
  waitMs: number | null;
  jobWaitMs: number | null;
  ttfbMs: number | null;
  durationMs: number | null;
  retryWaitMs: number;
  deadlineMs: number;
  budgetMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  requestBytes: number;
  requestTruncated: boolean;
  responseBytes: number | null;
  responseTruncated: boolean;
}

/** A stored exchange in full. */
export interface ExchangeRow extends ExchangeSummaryRow {
  requestBody: string;
  responseBody: string | null;
  error: string | null;
}

/** Persistence of the adjudicator; synchronous, every hook write is one statement. */
export interface AdjudicatorStore {
  insert(row: AdjudicationInput): number;
  /** Returns false when no row has that id. */
  update(id: number, patch: AdjudicationPatch): boolean;
  get(id: number): AdjudicationRow | undefined;
  /** Newest first; `total` counts every row matching the filter. */
  list(filter?: AdjudicationListFilter): { rows: AdjudicationRow[]; total: number };
  latestForSession(sessionId: string, surface: string): AdjudicationRow | undefined;
  /**
   * The newest row whose tool_use_id is `toolUseId` (indexed), optionally only of `surface` and
   * with ts >= `since`.
   */
  byToolUseId(
    toolUseId: string,
    filter?: { surface?: string; since?: number },
  ): AdjudicationRow | undefined;
  /** Oldest first. */
  forTask(runId: string, taskId: number): AdjudicationRow[];
  /** Every row of a swarm run (those with a task id), oldest first: one query for a whole run. */
  forRun(runId: string): AdjudicationRow[];
  /** Rows with final = 0, oldest first; `olderThan` (epoch ms) keeps only rows with ts < it. */
  nonFinal(limit: number, olderThan?: number): AdjudicationRow[];

  /**
   * The cache entry for `key`. A hit with a verdict bumps hits and last_hit_at to `now`.
   * With `maxAgeMs`, an entry created before now − maxAgeMs is a miss (and is not bumped).
   */
  cacheGet(key: string, now: number, maxAgeMs?: number): AdjudicatorCacheEntry | undefined;
  /** Insert or replace; `null` writes the pending marker. */
  cachePut(key: string, verdict: Verdict | null, provider: string | null, now?: number): void;
  /** Drop entries older than ttlMs, then all but the maxEntries most recently used. Returns rows deleted. */
  cachePrune(maxEntries: number, ttlMs: number, now?: number): number;

  providerState(provider: string): AdjudicatorProviderState | undefined;
  /** Merge `patch` into the stored state (or a closed default) and save it; returns the result. */
  saveProviderState(
    provider: string,
    patch: Partial<Omit<AdjudicatorProviderState, "provider">>,
  ): AdjudicatorProviderState;
  /**
   * Run `fn` as one write transaction that takes the write lock up front (SQLite BEGIN
   * IMMEDIATE), so a read-modify-write of the provider state (half-open claim, spend and call
   * counters) cannot interleave with another hook process. Nested calls join the outer one.
   * Optional: a store without it (a test double, the try-it wrapper) runs `fn` directly.
   * `lockWaitMs` caps how long BEGIN IMMEDIATE (and every statement in `fn`) waits for another
   * connection's lock before it throws SQLITE_BUSY (default: the connection's own busy timeout).
   */
  atomically?<T>(fn: () => T, o?: { lockWaitMs?: number | undefined }): T;
  /**
   * Run `fn` with every lock wait capped at `ms` (SQLite busy_timeout; 0 = try once), then
   * restore the connection's own timeout. It only ever lowers the wait. A busy database makes
   * the statement throw instead of stalling the hook past its budget. Optional, like atomically.
   */
  withLockWait?<T>(ms: number, fn: () => T): T;

  biasAll(): AdjudicatorBiasRow[];
  biasUpsert(row: Omit<AdjudicatorBiasRow, "updatedAt"> & { updatedAt?: number | null }): void;
  /** Clears the bias table only; returns rows deleted. */
  biasReset(): number;

  summary(since?: number): AdjudicationSummary;

  /**
   * Stores exchanges and, in the same transaction, deletes all but the newest `keep` (default
   * EXCHANGE_KEEP = 100) by id. Takes no lock wait: a busy database throws SQLITE_BUSY at once
   * and the caller (the engine) swallows it, so capture never delays or changes a verdict.
   * Returns the new ids.
   */
  exchangeInsert(xs: ExchangeInput[], keep?: number): number[];
  /**
   * Newest first, without bodies. `limit` is clamped to 1..100; `rowId` keeps the exchanges
   * that carried that adjudications.id; `total` counts every match.
   */
  exchangeList(filter?: { limit?: number; rowId?: number }): {
    rows: ExchangeSummaryRow[];
    total: number;
  };
  /** One exchange with its bodies. */
  exchangeGet(id: number): ExchangeRow | undefined;
  exchangeCount(): number;
  /** Deletes every stored exchange; returns how many. */
  exchangePurge(): number;
  /** Clears all five adjudicator tables (the exchange log included). */
  purge(): void;
}

/**
 * One security assessment as stored in adjudicator_security. Only ids, numbers, tags and the
 * 80-char redacted head: never a secret, a tool argument, a path or a matched text. The store
 * redacts and caps again on the way in, so a careless caller cannot widen what is kept.
 */
export interface SecurityInput {
  /** Epoch ms; default now. */
  ts?: number;
  surface: SecuritySurface;
  sessionId?: string | null;
  toolUseId?: string | null;
  agentType?: string | null;
  runId?: string | null;
  taskId?: number | null;
  /** adjudications.id of the routing row this assessment sits beside. */
  adjudicationId?: number | null;
  inputHash?: string | null;
  /** Redacted head of the assessed text (at most 80 characters); null when privacy.storeHead is off. */
  inputHead?: string | null;
  level: SecurityLevel;
  score: number;
  action: SecurityAction;
  heuristicLevel: SecurityLevel;
  heuristicScore: number;
  modelLevel?: SecurityLevel | null;
  modelScore?: number | null;
  modelStatus: SecurityModelStatus;
  source: SecurityAssessment["source"];
  autonomy?: Autonomy | null;
  grantStatus?: GrantStatus | null;
  /** Rule and floor ids that fired. */
  rules?: string[];
  /**
   * Exposures, rule adds, floors, the model answer, the remedy, the normalised tools and the
   * reasons. Sanitised on insert (secret-named keys and argument-like keys dropped, strings
   * redacted and cut) and capped at SECURITY_DETAIL_MAX bytes.
   */
  detail?: unknown;
  /** True when a line was shown to the agent or the user. */
  noted?: boolean;
  version?: string;
}

export interface SecurityRow {
  id: number;
  ts: number;
  surface: SecuritySurface;
  sessionId: string | null;
  toolUseId: string | null;
  agentType: string | null;
  runId: string | null;
  taskId: number | null;
  adjudicationId: number | null;
  inputHash: string | null;
  inputHead: string | null;
  level: SecurityLevel;
  score: number;
  action: SecurityAction;
  heuristicLevel: SecurityLevel;
  heuristicScore: number;
  modelLevel: SecurityLevel | null;
  modelScore: number | null;
  modelStatus: string;
  source: string;
  autonomy: string | null;
  grantStatus: string | null;
  rules: string[];
  detail: unknown;
  noted: boolean;
  version: string;
}

export interface SecurityListFilter {
  /** ts >= since (epoch ms) */
  since?: number;
  /** Exactly this level. */
  level?: SecurityLevel;
  /** This level or worse. */
  minLevel?: SecurityLevel;
  surface?: SecuritySurface;
  runId?: string;
  taskId?: number;
  /** Clamped to 1..500 (default 50). */
  limit?: number;
  offset?: number;
}

export interface SecuritySummary {
  total: number;
  byLevel: Record<SecurityLevel, number>;
  bySurface: Record<string, number>;
  /** Oldest day first; UTC days (YYYY-MM-DD). */
  perDay: Array<{ day: string } & Record<SecurityLevel, number>>;
  /** Rule and floor ids by how many assessments fired them, most first. */
  rules: Array<{ id: string; n: number }>;
  /** matrix[heuristic level][final level]: what the model changed. */
  matrix: Record<SecurityLevel, Record<SecurityLevel, number>>;
  /** model_status of every assessment. */
  byStatus: Record<string, number>;
  /** Assessments the model answered, split by how its level compared with the heuristic's. */
  modelRaised: number;
  modelLower: number;
  modelAgreed: number;
  /** Assessments without a model answer. */
  heuristicOnly: number;
}

/**
 * Persistence of security assessments (table adjudicator_security, migration v13). A separate
 * store from AdjudicatorStore on purpose: the try-it wrapper and the routing stats never see
 * these rows. Synchronous; insert never throws.
 */
export interface SecurityStore {
  /**
   * Store one assessment. Fails open: a busy or foreign database (no v13 table, read-only)
   * returns undefined and the advice still shows. Waits at most `lockWaitMs` (default 0: try
   * once) for another connection's lock. About one insert in a hundred also prunes rows older
   * than 90 days.
   */
  insert(input: SecurityInput, o?: { lockWaitMs?: number }): number | undefined;
  get(id: number): SecurityRow | undefined;
  /** The row written beside a routing row (adjudications.id). */
  byAdjudication(adjudicationId: number): SecurityRow | undefined;
  /** Newest first; `total` counts every row matching the filter. */
  list(filter?: SecurityListFilter): { rows: SecurityRow[]; total: number };
  /** The task's latest assessment: its newest agent row, else its newest plan row. */
  forTask(runId: string, taskId: number): SecurityRow | undefined;
  /** The same per task of one run, one query, by task id. */
  forRun(runId: string): SecurityRow[];
  summary(since?: number): SecuritySummary;
  /** Delete rows with ts < before (epoch ms); returns rows deleted. */
  prune(before: number): number;
  /** Delete every row; returns how many. Zero when the table is missing. */
  purge(): number;
}
