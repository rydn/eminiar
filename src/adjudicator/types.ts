/**
 * Shared types and constants of the adjudicator (docs/design/adjudicator.md §4). Pure
 * declarations: no imports with side effects, so the hook bundle pays nothing while the
 * adjudicator is off.
 */

/** Bump when scoring changes so cached verdicts and stored rows from older scorers are told apart. */
export const SCORER_VERSION = "1";

/** Meta key of the last `eminiar adjudicator eval` report (written by eval.ts, read by the dashboard). */
export const EVAL_META_KEY = "adjudicator:eval:last";

export const SURFACES = ["prompt", "agent", "plan", "tool", "mcp", "test"] as const;
export type Surface = (typeof SURFACES)[number];

/** The only values Claude Code's Agent `model` parameter accepts. */
export const TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Claude Code's effort levels (sub-agents "Choose an effort level"). Advise mode: the
 * coordinator passes it as `effort` on the Agent call (Claude Code AGENT_EFFORT_SINCE or later,
 * non-fork subagents; CLAUDE_CODE_EFFORT_LEVEL outranks it). Apply mode: the PreToolUse(Agent)
 * hook sets it in `updatedInput` (see memory adjudicator/apply-sets-effort).
 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** The first Claude Code version whose Agent tool takes a per-call `effort`. */
export const AGENT_EFFORT_SINCE = "2.1.292";

export const PROVIDER_IDS = ["heuristic", "typesafe", "openai-compatible", "embedding"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const MODES = ["advise", "apply"] as const;
export type Mode = (typeof MODES)[number];

export type Source = "heuristic" | "blend" | "cache" | "fallback";

export type ProviderStatus =
  | "ok"
  | "timeout"
  | "http_error"
  | "rate_limited"
  | "invalid"
  | "breaker_open"
  | "slow_guard"
  | "over_budget"
  | "auth_failed"
  | "no_key"
  | "no_consent"
  | "skipped"
  | "n/a";

export const INTENTS = [
  "lookup",
  "impact",
  "history",
  "run",
  "bigfile",
  "docs",
  "recall",
  "plan",
  "edit_small",
  "implement",
  "refactor",
  "design",
  "review",
  "debug",
  "research",
  "test",
  "git",
  "ui",
  "chat",
] as const;
export type Intent = (typeof INTENTS)[number];

/** Options of the tool table (§7.4); intersected with the registered tools at runtime. */
export const TOOL_IDS = [
  "em_symbols",
  "em_search",
  "em_graph_impact",
  "em_history",
  "em_execute",
  "em_batch_execute",
  "em_execute_file",
  "em_docs",
  "em_fetch_and_index",
  "em_recall",
  "em_swarm",
  "Edit",
  "Bash",
  "Agent",
  "none",
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Options of the role table (§7.5) when no swarm run narrows them to its own roles. */
export const DEFAULT_ROLES = [
  "explorer",
  "researcher",
  "coder",
  "tester",
  "reviewer",
  "architect",
  "ui",
  "none",
] as const;

export interface Reason {
  feature: string;
  weight: number;
  note: string;
}

export interface ScoreEntry {
  option: string;
  /** 0..1; the entries of one table sum to 1. */
  score: number;
  reasons: Reason[];
}

export interface ScoreTable {
  dimension: "tool" | "tier" | "role";
  /** Sorted by score, descending. */
  entries: ScoreEntry[];
  choice: string;
  confidence: number;
}

export interface Features {
  words: number;
  chars: number;
  lines: number;
  paths: number;
  symbols: number;
  codeBlock: boolean;
  stackTrace: boolean;
  intents: Partial<Record<Intent, number>>;
  /** 0..1 */
  scope: number;
  /** 0..1 */
  risk: number;
  chat: boolean;
  slash: boolean;
  classify?: string;
  task?: { role?: string; files: number; deps: number };
}

export interface ScoreSet {
  /** 0..4, continuous. */
  complexity: number;
  complexityReasons: Reason[];
  tool: ScoreTable;
  tier: ScoreTable;
  role: ScoreTable;
  effort: Effort;
}

export interface AdjudicationRequest {
  key: string;
  surface: Surface;
  text: string;
  hints?: {
    role?: string;
    roles?: Array<{ name: string; description?: string }>;
    files?: number;
    deps?: number;
    /**
     * The project's indexed documentation names, lower case (the em_docs manifest; the hooks
     * pass them): a kebab-case name counts as a package only when listed (features.ts PKG rule).
     */
    libraries?: readonly string[];
  };
}

export interface Dist {
  probs: Record<string, number>;
  confidence: number;
  calibrated: boolean;
}

export interface ProviderAnswer {
  key: string;
  complexity?: { value: number; confidence: number };
  tier?: Dist;
  role?: Dist;
  tool?: Dist;
  risky?: number;
  needsPlan?: number;
}

export interface ProviderResult {
  answers: ProviderAnswer[];
  /** costUsd is null when the price is unknown (cerebras, custom without openai.price); 0 for local. */
  usage: { inTok: number; outTok: number; costUsd: number | null };
  latencyMs: number;
  model: string;
}

/** How one captured HTTP exchange ended; "pending" only while the call is still in flight. */
export type ExchangeOutcome =
  | "pending"
  | "ok"
  | "timeout"
  | "http_error"
  | "rate_limited"
  | "invalid"
  | "no_key";

/** A request or answer body as stored: scrubbed, capped, never a header or a key. */
export interface CapturedBody {
  text: string;
  /** text is JSON (structurally scrubbed); false for a raw text body. */
  json: boolean;
  /** Length of the scrubbed body before the cap. */
  bytes: number;
  truncated: boolean;
}

/**
 * One provider HTTP call, filled IN PLACE by http.ts while it runs (so a call the engine gives up
 * on is still readable as "pending"). Times are ms; sentAt is epoch ms.
 */
export interface HttpExchange {
  method: "GET" | "POST";
  /** Host and path only (no query string, no userinfo). */
  target: string;
  sentAt: number;
  deadlineMs: number;
  attempts: number;
  retryWaitMs: number;
  /** Final attempt: from its send to the response headers. */
  ttfbMs: number | null;
  /** From sentAt to the end, retries included. */
  durationMs: number | null;
  status: number | null;
  outcome: ExchangeOutcome;
  request: CapturedBody;
  response: CapturedBody | null;
  /** The scrubbed ProviderError message. */
  error: string | null;
}

/** An HttpExchange plus what the provider knows about the batch it carried. */
export interface ProviderExchange {
  http: HttpExchange;
  provider: ProviderId;
  model: string;
  /** Request index within the adjudicate() call (0 or 1). */
  batch: number;
  /** AdjudicationRequest.key per item, in request order. The engine maps them to row ids; never stored. */
  itemKeys: string[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/** A stored exchange without bodies or error text (GET /api/adjudicator/jev/exchanges). */
export interface ExchangeSummary {
  id: number;
  ts: number;
  callId: string;
  batch: number;
  surface: string | null;
  context: string | null;
  model: string | null;
  target: string;
  outcome: Exclude<ExchangeOutcome, "pending">;
  status: number | null;
  timedOut: boolean;
  attempts: number;
  waitMs: number | null;
  jobWaitMs: number | null;
  ttfbMs: number | null;
  durationMs: number | null;
  retryWaitMs: number;
  deadlineMs: number;
  budgetMs: number | null;
  items: number;
  /** adjudications.id of the decisions this request served. */
  rowIds: number[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  requestBytes: number;
  requestTruncated: boolean;
  responseBytes: number | null;
  responseTruncated: boolean;
}

/** One stored exchange with its bodies (GET /api/adjudicator/jev/exchange). */
export interface ExchangeDetail extends ExchangeSummary {
  request: CapturedBody;
  response: CapturedBody | null;
  error: string | null;
}

export interface AdjudicatorProvider {
  id: ProviderId;
  remote: boolean;
  dims: Array<"complexity" | "tier" | "role" | "tool">;
  adjudicate(
    reqs: AdjudicationRequest[],
    /** capture: a per-call sink; a provider that supports it pushes one entry per HTTP call. */
    o: { signal: AbortSignal; deadlineMs: number; capture?: ProviderExchange[] | undefined },
  ): Promise<ProviderResult>;
  probe(o: { signal: AbortSignal }): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}

export interface Verdict extends ScoreSet {
  id?: number;
  key: string;
  source: Source;
  provider: ProviderId;
  providerStatus: ProviderStatus;
  alpha: Partial<Record<"complexity" | "tier" | "role" | "tool", number>>;
  bias: Record<string, number>;
  latencyMs: number;
  providerLatencyMs?: number;
  usage?: ProviderResult["usage"];
  version: string;
  /**
   * The heuristic's complexity before any provider blend (set by the engine on every verdict it
   * returns). The learned-bias bucket is keyed by it both when bias is looked up (only the
   * heuristic is known then) and when it is taught (learn.bucketsOf reads it from the row's
   * scores JSON), so feedback lands in the bucket the same request reads.
   */
  heuristicComplexity?: number;
}

export type AdjudicationAction =
  | "advised"
  | "applied"
  | "followed"
  | "respected"
  | "ignored"
  | "none";

export type AdjudicationOutcome = "pending" | "success" | "failure" | "abandoned" | "n/a";

/** One row of the `adjudications` table (§12), camelCase. Nullable columns are optional. */
export interface AdjudicationRow {
  id: number;
  ts: number;
  surface: Surface;
  sessionId?: string | null;
  agentId?: string | null;
  toolUseId?: string | null;
  runId?: string | null;
  taskId?: number | null;
  parentId?: number | null;
  inputHash: string;
  /** At most 80 chars of redact()ed text (privacy.storeHead). */
  inputHead?: string | null;
  inputChars?: number | null;
  complexity?: number | null;
  tier?: string | null;
  effort?: string | null;
  tool?: string | null;
  role?: string | null;
  confidence?: number | null;
  /** JSON: ScoreSet + features + alpha + bias. */
  scores?: string | null;
  source?: Source | null;
  provider?: ProviderId | null;
  providerModel?: string | null;
  providerStatus?: ProviderStatus | null;
  latencyMs?: number | null;
  providerLatencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  action?: AdjudicationAction | null;
  modelRequested?: string | null;
  modelFinal?: string | null;
  baselineModel?: string | null;
  actualModel?: string | null;
  actualTokens?: number | null;
  actualCostUsd?: number | null;
  baselineCostUsd?: number | null;
  savingsUsd?: number | null;
  outcome: AdjudicationOutcome;
  outcomeSource?: string | null;
  outcomeTs?: number | null;
  final: boolean;
  version?: string | null;
  /** em_adjudicate feedback note: redact()ed, at most 500 chars. */
  feedbackNote?: string | null;
}
