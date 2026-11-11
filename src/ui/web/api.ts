/** Fetch wrapper for the dashboard API: every call carries the selected project root. */
import type { DocCategory } from "../../docs/category.js";
import type {
  SwarmDoc,
  SwarmDocActiveRun,
  SwarmDocRename,
  SwarmDocSwarm,
  SwarmDocWarning,
} from "../../swarm/doc-types.js";
import type {
  NoteRow,
  RunRow,
  RunStatus,
  SwarmEventKind,
  SwarmEventRow,
  TaskRow,
  TaskStatus,
  Topology,
  WorkerStatus,
} from "../../swarm/types.js";

export type { DocCategory };

let root = new URLSearchParams(location.search).get("root") ?? "";

export const getRoot = (): string => root;
export function setRoot(r: string): void {
  root = r;
  const u = new URL(location.href);
  u.searchParams.set("root", r);
  // Keep history.state: the router stamps each entry's position there for the leave guard.
  history.replaceState(history.state, "", u.toString());
}

export type Params = Record<string, string | number | boolean | undefined | null>;

function url(path: string, params?: Params): string {
  const u = new URL(path, location.origin);
  if (root) u.searchParams.set("root", root);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed JSON error body (409 carries `current`, 400 `issues`, 422 `locked`). */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  const r = await fetch(url(path, params), init);
  const body = (await r.json().catch(() => ({ error: "bad response" }))) as T & { error?: string };
  if (r.status === 404 && body.error === "not found" && path.startsWith("/api/"))
    // The server routes to a generic 404 only for paths it does not know: the
    // dashboard bundle on disk is newer than the running server. Static assets are
    // read per request, so the UI updates while the server's own bundle stays frozen.
    throw new ApiError(
      `${path} is not available on the running server; restart \`eminiar ui\` to pick up the rebuilt bundle`,
      r.status,
    );
  if (!r.ok) throw new ApiError(body.error ?? `HTTP ${r.status}`, r.status, body);
  if (body && typeof body === "object" && "error" in body && body.error)
    throw new ApiError(String(body.error), r.status);
  return body;
}

export function post<T>(path: string, body: unknown, method = "POST", params?: Params): Promise<T> {
  return api<T>(path, params, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function del<T>(path: string, params?: Params): Promise<T> {
  return api<T>(path, params, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
}

// --- shared shapes ------------------------------------------------------------------

export interface VisNode {
  id: string;
  label: string;
  kind: string;
  path: string | null;
  line: number | null;
  root?: boolean;
  score?: number;
  exported?: boolean;
}
export interface VisEdge {
  src: string;
  dst: string;
  kind: string;
  weight: number;
  confidence?: number;
  count?: number;
  lines?: number[];
}
export interface GraphResult {
  root?: string;
  rootLabel?: string;
  truncated?: boolean;
  total?: number;
  nodes: VisNode[];
  edges: VisEdge[];
}
export interface Status {
  version: string;
  root: string;
  id: string;
  state: "fresh" | "stale" | "empty";
  freshness: {
    head?: string;
    indexedHead?: string;
    headMatches: boolean;
    queued: number;
    dirty: string[];
    lastRun: number | null;
  };
  files: {
    byStatus: Record<string, number>;
    reasons: Array<{ reason: string; n: number }>;
    lastIndexedAt: number | null;
  };
  graph: { nodes: number; edges: number; metrics: number; metricsAt: number | null };
  runs: IndexRun[];
}
export interface IndexRun {
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
export interface TreeFile {
  path: string;
  status: string;
  reason: string | null;
  language: string | null;
  symbols: number;
  size: number;
  score: number;
  fanIn: number;
  loc: number;
  cluster: number | null;
}
export interface FileSymbol {
  id: string;
  name: string;
  kind: string;
  start_line: number | null;
  end_line: number | null;
  exported: boolean;
}
export interface FileData {
  path: string;
  size?: number;
  language?: string | null;
  status?: string | null;
  reason?: string | null;
  lines?: number;
  content?: string;
  tooLarge?: boolean;
  symbols: FileSymbol[];
}
export interface Hit {
  id: string;
  label: string;
  kind: string;
  path: string | null;
  score: number;
  hops: number;
  reasons: string[];
}
export interface FileImpact {
  path: string;
  directDependents: number;
  affected: number;
  tests: number;
  coChanged: Array<{ path: string; reason: string }>;
  memories: string[];
  hits: Hit[];
  graph: GraphResult;
}
export interface EdgeWithNode extends VisEdge {
  node: VisNode;
}
export interface SymbolDetail {
  node: VisNode;
  meta: Record<string, unknown>;
  metrics: {
    fan_in: number;
    fan_out: number;
    loc: number;
    complexity: number;
    commits_90d: number;
    score: number;
    cluster: number | null;
  } | null;
  callers: EdgeWithNode[];
  callees: EdgeWithNode[];
  members: VisNode[];
  routes: VisNode[];
  memories: Array<{ name: string; kind: string }>;
  coChanged: Array<{ path: string; weight: number }>;
}
export interface Hotspot {
  id: string;
  path: string;
  kind: string;
  commits_90d: number;
  commits: number;
  last_touched: string;
  fan_in: number;
  fan_out: number;
  complexity: number;
  loc: number;
  score: number;
}
export interface RouteRow {
  id: string;
  method: string;
  path: string;
  framework: string;
  file: string;
  line: number | null;
  handlers: Array<{ id: string; name: string; path: string | null }>;
}
export interface ClusterSummary {
  id: number;
  size: number;
  label: string;
  files: string[];
  links: Record<string, number>;
}
export interface Architecture {
  project: { name?: string; version?: string; description?: string; root: string };
  overview: {
    files: number;
    symbols: number;
    edges: number;
    languages: Record<string, number>;
    coverage: Record<string, number>;
    indexedHead?: string;
    metricsAt?: number;
  };
  folders: Array<{
    path: string;
    files: number;
    loc: number;
    score: number;
    languages: Record<string, number>;
  }>;
  entryPoints: Array<{ kind: string; name: string; path: string }>;
  routes: RouteRow[];
  hotspots: Hotspot[];
  clusters: ClusterSummary[];
  cycles: string[][];
  decisions: Array<{ name: string; title: string; status: string; updated: number }>;
}
export interface MemoryRowUi {
  id: number;
  name: string;
  topic: string;
  kind: string;
  status: string | null;
  supersedes: string | null;
  content: string;
  tags: string[];
  related: string[];
  path: string | null;
  size: number | null;
  created_at: number;
  updated_at: number;
}
export interface MemoryList {
  dir: string;
  kinds: string[];
  statuses: string[];
  topics: string[];
  skipped: string[];
  gitignored: boolean;
  memories: MemoryRowUi[];
}
export interface DocsSyncState {
  at: number;
  pages: number;
  documents: number;
  chunks: number;
  errors: string[];
  skipped: number;
  ms: number;
}
export interface DocSourceUi {
  name: string;
  kind: "url" | "path";
  /** Derived server-side; see src/docs/category.ts. */
  category: DocCategory;
  urls?: string[];
  path?: string;
  glob?: string[];
  provider?: string;
  title?: string;
  crawl?: { depth?: number; maxPages?: number };
  ttlHours?: number;
  tags?: string[];
  notes?: string;
  addedAt: string;
  documents: number;
  chunks: number;
  latest: number | null;
  sync: DocsSyncState | null;
}
export interface DocsList {
  manifest: string;
  sources: DocSourceUi[];
  orphans: Array<{ source: string; documents: number; chunks: number }>;
  totals: { documents: number; chunks: number };
  catalog: number;
  config: { ttlHours: number; crawl: { depth: number; maxPages: number } };
}
export interface DocPage {
  id: number;
  title: string;
  uri: string | null;
  created_at: number;
  chunks: number;
}
export interface LocalCandidateUi {
  name: string;
  path: string;
  glob?: string[];
  files: number;
  bytes: number;
  why: string;
  project: string;
  registered: boolean;
}
export interface ProviderCandidateUi {
  name: string;
  provider: string;
  title: string;
  urls: string[];
  crawl?: { depth?: number; maxPages?: number };
  confidence: "catalog" | "registry" | "probe" | "unknown";
  tier?: "service" | "infra" | "library";
  usedBy: string[];
  evidence: string[];
  registered: boolean;
}
export interface DiscoveryUi {
  root: string;
  projects: string[];
  local: LocalCandidateUi[];
  providers: ProviderCandidateUi[];
}
export interface DocsSyncRow {
  name: string;
  kind: string;
  pages: number;
  indexed: number;
  unchanged: number;
  cached: number;
  chunks: number;
  skipped: number;
  errors: string[];
  ms: number;
}
export interface DocsAddResult {
  added: string[];
  updated: string[];
  failed: Array<{ name: string; reason: string }>;
  sync: DocsSyncRow[];
  text: string;
}
export interface SearchHitUi {
  title: string;
  source: string;
  uri: string | null;
  doc: number;
  chunk: number;
  lines: string | null;
  created: number;
  score: number;
  snippet: string;
}
export interface MemoryBody {
  name: string;
  kind: string;
  status?: string;
  supersedes?: string;
  tags: string[];
  related: string[];
  created: string;
  updated: string;
  body: string;
  path: string;
}

// --- history ---------------------------------------------------------------------------

export type Bucket = "feat" | "fix" | "refactor" | "perf" | "test" | "docs" | "other";
export interface CommitRowUi {
  sha: string;
  short: string;
  parents: string[];
  merge: boolean;
  onHead: boolean;
  author: string;
  at: number;
  subject: string;
  refs: string[];
  tags: string[];
  kind: string;
  bucket: Bucket;
  scope?: string;
  breaking: boolean;
  issues: string[];
  pr?: number;
  files: number;
  added: number;
  deleted: number;
  size: string;
  blamedBy: number;
  origins: number;
  reverted: boolean;
  risk: number;
  riskReasons: string[];
}
export interface FileHistoryUi {
  path: string;
  commits: number;
  fixes: number;
  feats: number;
  refactors: number;
  reverts: number;
  firstAt: number;
  lastAt: number;
  authors: Array<[string, number]>;
  added: number;
  deleted: number;
  bugOrigins: number;
  quickFixes: number;
  commits90d: number;
  months: number[];
  risk: number;
  reasons: string[];
  renamedFrom?: string;
}
export interface BranchUi {
  name: string;
  sha: string;
  at: number;
  remote: boolean;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  merged: boolean;
  isDefault: boolean;
  lastAuthor?: string;
  lastSubject?: string;
}
export interface WeekUi {
  week: string;
  at: number;
  total: number;
  byBucket: Record<Bucket, number>;
  added: number;
  deleted: number;
}
export interface AuthorUi {
  name: string;
  commits: number;
  fixes: number;
  files: number;
  firstAt: number;
  lastAt: number;
  added: number;
  deleted: number;
}
export interface HistoryOverview {
  git: boolean;
  error?: string;
  head: string;
  branch?: string;
  base?: string;
  builtAt: number;
  range: { from: number; to: number };
  stats: {
    commits: number;
    onHead: number;
    fixes: number;
    reverts: number;
    merges: number;
    authors: number;
    files: number;
    fixesTraced: number;
    linksTraced: number;
    tracePending: number;
    last30: number;
    prior30: number;
    branches: number;
    remoteBranches: number;
    unmerged: number;
    tags: number;
    workingTree: number;
  };
  kinds: Record<string, number>;
  buckets: Bucket[];
  weeks: WeekUi[];
  authors: AuthorUi[];
  tags: Array<{ name: string; sha: string; at: number }>;
  branches: BranchUi[];
  lessons: string[];
  risky: FileHistoryUi[];
  notable: CommitRowUi[];
}
export interface CommitLinkUi extends Partial<CommitRowUi> {
  sha: string;
  short: string;
  subject: string;
  paths: string[];
}
export interface CommitDetailUi {
  git: boolean;
  error?: string;
  commit: CommitRowUi & { body: string; email: string; revertOf?: string; revertedBy?: string };
  files: Array<{
    path: string;
    added: number;
    deleted: number;
    binary: boolean;
    renamedFrom?: string;
    symbols: Array<{ id: string; name: string; kind: string; line: number | null }>;
    stale: boolean;
    fileRisk: number;
    fileFixes: number;
  }>;
  blamedBy: CommitLinkUi[];
  origins: CommitLinkUi[];
  revertedBy: CommitLinkUi | null;
  branches: string[];
}
export interface FileHistoryDetailUi {
  git: boolean;
  path: string;
  file: FileHistoryUi | null;
  commits: CommitRowUi[];
  origins: Array<CommitRowUi & { fixes: Array<CommitRowUi & { daysLater: number }> }>;
}
export interface GraphCommitUi extends CommitRowUi {
  allParents: string[];
}
export interface HistoryGraphUi {
  git: boolean;
  base?: string;
  head: string;
  commits: GraphCommitUi[];
  branches: Array<{
    name: string;
    sha: string;
    remote: boolean;
    current: boolean;
    isDefault: boolean;
    merged: boolean;
  }>;
}
export interface BranchDetailUi {
  git: boolean;
  error?: string;
  branch: BranchUi;
  commits: CommitRowUi[];
  files: Array<{ path: string; commits: number; risk: number; fixes: number }>;
}
export interface RiskUi {
  git: boolean;
  source: string;
  files: Array<{
    path: string;
    file: FileHistoryUi | null;
    lastFix: string | null;
    origins: CommitRowUi[];
  }>;
}

/** `/api/knowledge` (src/ui/knowledge-api.ts): memories and docs and what they touch. */
export interface KnowledgeNodeUi extends VisNode {
  group: "memory" | "doc" | "hub" | "code";
  seed?: boolean;
  missing?: boolean;
  /** Memory kind or doc category id. */
  sub?: string;
  status?: string;
  tags?: string[];
  provider?: string;
  detail?: string;
}
export interface KnowledgeEdgeUi extends VisEdge {
  derived?: boolean;
}
export interface KnowledgeUi {
  scope: "memory" | "docs" | "all";
  focus: string | null;
  nodes: KnowledgeNodeUi[];
  edges: KnowledgeEdgeUi[];
  truncated: boolean;
  total: number;
  counts: { nodes: Record<string, number>; edges: Record<string, number> };
}

/** `/api/history/knowledge` (src/ui/history-graph-api.ts): branches → commits → files → knowledge. */
export interface HistoryGraphNodeUi extends VisNode {
  group: "branch" | "commit" | "file" | "memory" | "doc";
  seed?: boolean;
  missing?: boolean;
  sub?: string;
  bucket?: Bucket;
  status?: string;
  detail?: string;
  at?: number;
  author?: string;
  short?: string;
  risk?: number;
  fixes?: number;
  commits?: number;
  merged?: boolean;
  live?: boolean;
  isDefault?: boolean;
  prs?: number[];
}
export interface HistoryGraphBranchUi {
  name: string;
  commits: number;
  tipAt: number;
  merged: boolean;
  live: boolean;
  isDefault: boolean;
}
export interface HistoryKnowledgeUi {
  git: boolean;
  error?: string;
  focus: string | null;
  defaultBranch: string;
  nodes: HistoryGraphNodeUi[];
  edges: VisEdge[];
  truncated: boolean;
  total: number;
  branches: HistoryGraphBranchUi[];
}

// --- agent swarms (GET /api/swarm, /api/swarm/run, /api/swarm/events) -----------------

export type {
  RunStatus as SwarmRunStatus,
  SwarmEventKind,
  TaskStatus as SwarmTaskStatus,
  Topology as SwarmTopology,
  WorkerStatus as SwarmWorkerStatus,
};
export type SwarmTask = TaskRow & {
  /** In a run snapshot: `detail` / `result` were cut; GET /api/swarm/task has them whole. */
  clipped?: true;
};
export type SwarmNote = NoteRow;
export type SwarmEvent = SwarmEventRow;
export type SwarmIo = "read" | "write" | "exec" | "swarm" | "other";
/** Sync state of a role's agent file; `disabled`: swarms are off and no file exists. */
export type SwarmFileAction =
  | "create"
  | "update"
  | "unchanged"
  | "delete"
  | "conflict"
  | "disabled";

export interface SwarmIssue {
  path: string;
  message: string;
  line?: number;
}
export interface SwarmRoleUi {
  role: string;
  agentType: string;
  description: string;
  /** null: inherits the session's model. */
  model: string | null;
  /** null: a fixed pin; set, `model` is the fallback inside floor..ceiling. */
  range: { floor: string; ceiling: string } | null;
  count: number;
  /** null: every tool. */
  tools: string[] | null;
  disallowedTools: string[] | null;
  skills: string[];
  scope: string[];
  memoryTags: string[];
  isolation: string | null;
  hasHooks: boolean;
  file: { path: string; action: SwarmFileAction; reason?: string };
}
export interface SwarmDefUi {
  name: string;
  description: string;
  topology: Topology;
  maxAgents: number;
  stages: string[];
  instructions: string;
  roles: SwarmRoleUi[];
}
export interface SwarmRunCounts {
  tasks: Record<TaskStatus, number> & { total: number };
  workers: Record<WorkerStatus, number>;
}
export interface SwarmRunSummary {
  id: string;
  swarm: string;
  goal: string;
  status: RunStatus;
  topology: Topology;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  counts: SwarmRunCounts;
}
export interface SwarmOverview {
  state: "absent" | "invalid" | "ok";
  /** Swarms are active: the file exists, is valid and not `enabled: false`. */
  enabled: boolean;
  sync?: "auto" | "manual";
  /** Project-relative path of the swarm file (the default path when absent). */
  file: string;
  issues: SwarmIssue[];
  swarms: SwarmDefUi[];
  /** Generated agent files the swarm file no longer produces. */
  orphans: Array<{ path: string; agentType: string; reason: string | null }>;
  syncNeeded: boolean;
  /** Active runs first (always all of them), then the newest others up to `runsLimit`. */
  runs: SwarmRunSummary[];
  /** Older runs were left out (newer servers). */
  runsMore?: boolean;
  runsLimit?: number;
  /** The starter file, when there is no swarm file yet. */
  starter?: string;
  now: number;
}
export interface SwarmWorkerUi {
  run_id: string;
  agent_id: string;
  agent_type: string;
  role: string;
  status: WorkerStatus;
  task_id: number | null;
  prompt: string | null;
  session_id: string | null;
  spawned_at: number;
  last_ts: number;
  ended_at: number | null;
  tool_calls: number;
  errors: number;
  last_tool: string | null;
  summary: string | null;
}
export interface SwarmSegment {
  start: number;
  end: number;
  n: number;
  errors: number;
  io: Record<SwarmIo, number>;
  open?: boolean;
}
export type {
  DecisionFollow as SwarmDecisionFollow,
  SwarmDecision,
  SwarmDecisionAdvice,
  SwarmDecisionRan,
} from "../../adjudicator/swarm-decision-types.js";
export interface SwarmRunDetail {
  run: RunRow;
  /** The adjudicator's decision per task id (newer servers). */
  decisions?:
    | Record<number, import("../../adjudicator/swarm-decision-types.js").SwarmDecision>
    | undefined;
  /** Opaque hash of the decisions map; send it back as `decisionsHash` to skip an unchanged map. */
  decisionsHash?: string | undefined;
  /** `decisions` was left out because `decisionsHash` still matches the client's. */
  decisionsUnchanged?: boolean | undefined;
  /** Every task, or with `tasksPartial` only those updated since `tasksSince`. */
  tasks: SwarmTask[];
  /** How many tasks the run has (newer servers). */
  taskCount?: number;
  tasksPartial?: boolean;
  workers: SwarmWorkerUi[];
  notes: SwarmNote[];
  /** The latest events, oldest first (none when asked with `events=0`). */
  events: SwarmEvent[];
  counts: {
    tasks: Record<TaskStatus, number>;
    workers: Record<WorkerStatus, number>;
    toolCalls: number;
    errors: number;
    autoClosed: number;
    /** Active tasks held by a worker that went quiet or stopped (newer servers). */
    staleHeld?: number;
  };
  /** Roles of the swarm in config order, plus any the ledger names that the file lacks. */
  roles: string[];
  stages: string[];
  maxAgents: number | null;
  /** The run's swarm is still in the swarm file. */
  configured: boolean;
  timeline: {
    start: number;
    end: number;
    /** The timeline is drawn from the newest events only; the oldest were cut. */
    cut: boolean;
    /** With `cut`: the time of the oldest event drawn. */
    from?: number | null;
    workers: Array<{
      agent_id: string;
      role: string;
      status: WorkerStatus;
      spawned_at: number;
      ended_at: number | null;
      segments: SwarmSegment[];
    }>;
  };
  lastEventId: number;
  staleMs: number;
  now: number;
}
export interface SwarmEventsPage {
  run: { id: string; status: RunStatus; updated_at: number };
  events: SwarmEvent[];
  last: number;
  more: boolean;
  now: number;
}
export interface SwarmFinishResult {
  run: RunRow;
  /** The memory written for the run (with `remember`). */
  memory: string | null;
  /** The run closed but its memory could not be written (newer servers). */
  memoryError?: string | null;
}
export interface SwarmTaskFull {
  task: SwarmTask;
  decision?: import("../../adjudicator/swarm-decision-types.js").SwarmDecision;
}
export interface SwarmSyncResult {
  actions: Array<{ agentType: string; path: string; action: string; reason?: string }>;
  changed: number;
  conflicts: number;
}

// --- adjudicator (mirror src/ui/adjudicator-api.ts) ----------------------------------

type AdjRowFull = import("../../adjudicator/types.js").AdjudicationRow;
export type AdjFeatures = import("../../adjudicator/types.js").Features;
export type AdjProviderStatus = import("../../adjudicator/types.js").ProviderStatus;
export type AdjReason = import("../../adjudicator/types.js").Reason;
export type AdjScoreEntry = import("../../adjudicator/types.js").ScoreEntry;
export type AdjScoreTable = import("../../adjudicator/types.js").ScoreTable;
export type AdjSource = import("../../adjudicator/types.js").Source;
export interface AdjLatency {
  n: number;
  p50: number | null;
  p95: number | null;
}
export interface AdjProviderView {
  configured: string;
  effective: string;
  /** Why the configured provider is not the effective one (no_key, no_consent, ...). */
  degraded: string | null;
  detail: string | null;
  remote: boolean;
  configuredRemote: boolean;
  local: boolean;
  preset: string | null;
  model: string | null;
  baseUrl: string | null;
  price: { inPerM: number; outPerM: number } | null;
}
export interface AdjHealth {
  provider: string;
  configured: boolean;
  remote: boolean;
  /** closed | open | half_open | slow | any newer state; null = never called. */
  state: string | null;
  failures: number;
  retryAt: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastErrorClass: string | null;
  latency: AdjLatency;
  spendTodayUsd: number;
  dailyCapUsd: number | null;
}
/** Dispatches whose model the advice did not name (kept pin, FORCE, fork), by reason. */
export interface AdjKeptModel {
  pin?: number | undefined;
  force?: number | undefined;
  fork?: number | undefined;
}
export interface AdjSummary {
  since: number | null;
  total: number;
  keptModel?: AdjKeptModel;
  bySurface: Record<string, number>;
  bySource: Record<string, number>;
  byProviderStatus: Record<string, number>;
  byAction: Record<string, number>;
  byOutcome: Record<string, number>;
  latency: AdjLatency;
  providerLatency: AdjLatency;
  rates: {
    follow: number | null;
    apply: number | null;
    respect: number | null;
    /** effortFollowed / (effortFollowed + effortIgnored); absent from older servers. */
    effortFollow?: number | null;
  };
  costUsd: number;
  savingsUsd: number;
  netUsd: number;
  applyIneffective: number;
  applyChecked: number;
  /** Dispatches whose subagent ran at the advised effort (or the level passed). */
  effortFollowed?: number;
  /** Dispatches whose subagent ran at another effort than advised. */
  effortIgnored?: number;
  /** Dispatches whose set effort (applied by the hook, else passed) differs from the level that ran. */
  effortIneffective?: number;
  /** Dispatches with both a set and an actual effort (the m in "n of m"). */
  effortChecked?: number;
}
export interface AdjDayBucket {
  day: string;
  heuristic: number;
  blend: number;
  cache: number;
  fallback: number;
  total: number;
}
export type AdjReconcile =
  | { scanned: number; updated: number; finalized: number; linked: number; learned: number }
  | { error: string };
export interface AdjOverview {
  enabled: boolean;
  mode: "advise" | "apply";
  config: Record<string, unknown> & { provider?: string; mode?: string };
  provider: AdjProviderView;
  keySource: "env" | "file" | "none";
  keyFileRefused: boolean;
  consent: boolean;
  /** The remote origin consent applies to (scheme://host:port), null for local providers. */
  origin?: string | null;
  /** The warning line naming project-config adjudicator keys that were ignored, if any. */
  projectIgnored?: string | null;
  health: AdjHealth[];
  apply: { checked: number; ineffective: number; effective: number };
  summary: AdjSummary;
  fallbackRate: number | null;
  charts: { perDay: AdjDayBucket[]; complexity: number[] };
  chartsCut: boolean;
  filters: { surfaces: string[]; providers: string[]; outcomes: string[]; sources: string[] };
  reconcile: AdjReconcile;
  since: number | null;
  now: number;
}
/** A call-log row: the stored row without its scores JSON. */
export type AdjDecisionRow = Omit<AdjRowFull, "scores"> & { hasScores: boolean };
export interface AdjDecisionsPage {
  rows: AdjDecisionRow[];
  total: number;
  limit: number;
  offset: number;
  since: number | null;
  now: number;
}
/** The parsed scores JSON of one decision (engine.verdictColumns). */
export interface AdjScores {
  complexity: number;
  complexityReasons: AdjReason[];
  tool: AdjScoreTable;
  tier: AdjScoreTable;
  role: AdjScoreTable;
  effort: string;
  features?: AdjFeatures;
  alpha?: Partial<Record<"complexity" | "tier" | "role" | "tool", number>>;
  bias?: Record<string, number>;
}
export interface AdjDecisionDetail {
  row: Omit<AdjRowFull, "scores">;
  scores: AdjScores | null;
  now: number;
}
export interface AdjTierTokens {
  tasks: number;
  tokens: number;
  costUsd: number;
  tokensPerTask: number | null;
}
export interface AdjSavings {
  since: number | null;
  keptModel?: AdjKeptModel;
  usageAvailable: boolean;
  realisedUsd: number;
  redoPenaltyUsd: number;
  creditedRows: number;
  potentialUsd: number;
  potentialRows: number;
  spendUsd: number;
  netUsd: number;
  tokensPerSuccessByTier: Record<string, AdjTierTokens | undefined>;
  matrix: Array<{ suggested: string; actual: string; n: number }>;
  assumptions: string[];
  now: number;
}
export interface AdjEvalPayload {
  /** The last `eminiar adjudicator eval` report (shape owned by src/adjudicator/eval.ts), or null. */
  report: Record<string, unknown> | null;
  error?: string;
  now: number;
}
export type AdjTryItReason =
  | "used"
  | "disabled"
  | "not_requested"
  | "heuristic_configured"
  | "no_key"
  | "no_consent"
  | "hook_context"
  | "misconfigured";
export interface AdjTryIt {
  enabled: boolean;
  usedProvider: boolean;
  reason: AdjTryItReason | string;
  provider: AdjProviderView;
  verdict: AdjScores & {
    source: AdjSource;
    provider: string;
    providerStatus: AdjProviderStatus;
    latencyMs: number;
    providerLatencyMs?: number;
    usage?: { inTok: number; outTok: number; costUsd: number | null };
    version: string;
  };
  features: AdjFeatures;
  providerModel: string | null;
  advice: string;
  chars: number;
  persisted: false;
}

// --- Jev impact (mirror src/ui/adjudicator-api.ts jevPayload) ------------------------
// Types come type-only from the report module, which keeps its own imports web-safe; the
// api module of the node side pulls node code and cannot be imported here.

export type AdjJevReport = import("../../adjudicator/jev-impact.js").JevImpactReport;
export type AdjJevInactive = import("../../adjudicator/jev-impact.js").JevImpactInactive;
/** The provider block the route adds: the configured/effective pair, why it is degraded, health. */
export interface AdjJevProvider
  extends Omit<import("../../adjudicator/jev-impact.js").JevProviderSummary, "health"> {
  health: AdjHealth | null;
}
export type AdjJevImpact =
  import("../../adjudicator/jev-impact.js").JevImpactPayload<AdjJevProvider>;
/** What GET /api/adjudicator/jev answers: the report, or {active:false} when Jev is not on. */
export type AdjJevResponse = AdjJevImpact | AdjJevInactive;

/**
 * GET /api/adjudicator/jev. Call it only when Jev is configured and the adjudicator is on
 * (jevActive in views/jev-helpers.ts): the panel is not mounted otherwise, so no request is made.
 */
export const fetchJevImpact = (since: string): Promise<AdjJevResponse> =>
  api<AdjJevResponse>("/api/adjudicator/jev", { since });

// --- Jev request log (mirror src/ui/adjudicator-api.ts jevExchangesPayload / jevExchangePayload) ---

export type AdjExchangeSummary = import("../../adjudicator/types.js").ExchangeSummary;
export type AdjExchangeDetail = import("../../adjudicator/types.js").ExchangeDetail;
export type AdjExchangeBody = import("../../adjudicator/types.js").CapturedBody;

/** Capture is off: nothing was read; the panel explains how to turn it on. */
export interface AdjExchangesCaptureOff {
  active: true;
  capture: false;
  keep: number;
  now: number;
}

export interface AdjExchangesList {
  active: true;
  capture: true;
  keep: number;
  /** Stored rows for this filter. */
  total: number;
  rows: AdjExchangeSummary[];
  now: number;
}

export interface AdjExchangeOne {
  active: true;
  capture: true;
  exchange: AdjExchangeDetail;
  now: number;
}

/** What GET /api/adjudicator/jev/exchanges answers. */
export type AdjExchangesResponse = AdjJevInactive | AdjExchangesCaptureOff | AdjExchangesList;
/** What GET /api/adjudicator/jev/exchange answers (a missing id is a 404 error). */
export type AdjExchangeResponse = AdjJevInactive | AdjExchangesCaptureOff | AdjExchangeOne;

/**
 * GET /api/adjudicator/jev/exchanges: the newest stored Jev requests without bodies, optionally
 * only those that served decision `row`. Call it only when Jev is active (jevActive).
 */
export const fetchJevExchanges = (limit?: number, row?: number): Promise<AdjExchangesResponse> =>
  api<AdjExchangesResponse>("/api/adjudicator/jev/exchanges", { limit, row });

/** GET /api/adjudicator/jev/exchange: one stored request with its request and response bodies. */
export const fetchJevExchange = (id: number): Promise<AdjExchangeResponse> =>
  api<AdjExchangeResponse>("/api/adjudicator/jev/exchange", { id });

// --- swarm config studio (GET /api/swarm/config, POST /api/swarm/config/{validate,save}) ----

export type { SwarmDoc, SwarmDocActiveRun, SwarmDocRename, SwarmDocSwarm, SwarmDocWarning };
export interface SwarmConfigMeta {
  models: string[];
  tiers: string[];
  colors: string[];
  topologies: string[];
  efforts: string[];
  defaultContext: Record<string, unknown>;
  limits: Record<string, number | number[]>;
}
export interface SwarmConfigDoc {
  state: "absent" | "ok" | "invalid";
  file: string;
  text: string | null;
  hash: string | null;
  doc: SwarmDoc | null;
  issues: SwarmIssue[];
  warnings: SwarmDocWarning[];
  locked: string[];
  starter?: SwarmDoc;
  activeRuns: SwarmDocActiveRun[];
  meta: SwarmConfigMeta;
}
export interface SwarmConfigDraft {
  /** Exactly one of `doc` (structured) or `text` (raw YAML). */
  doc?: SwarmDoc;
  text?: string;
  renames?: SwarmDocRename[];
  /** Hash of the file the draft was based on; null creates the file. */
  baseHash: string | null;
  sync?: boolean;
}
export interface SwarmConfigValidation {
  ok: boolean;
  text: string;
  hash: string;
  issues: SwarmIssue[];
  warnings: SwarmDocWarning[];
  /** 1-based lines of `text` that differ from the file on disk. */
  changed: number[];
  removed: number;
  locked: string[];
}
export interface SwarmConfigSaved {
  saved: boolean;
  created: boolean;
  changed: number[];
  hash: string;
  text: string;
  warnings: SwarmDocWarning[];
  sync: SwarmSyncResult | null;
}
export interface SwarmTemplateUi {
  id: string;
  name: string;
  description: string;
  useWhen: string;
  topology: Topology;
  roles: Array<{ role: string; model: string; count: number }>;
  swarm: SwarmDocSwarm;
}

export const fetchSwarmConfig = (): Promise<SwarmConfigDoc> =>
  api<SwarmConfigDoc>("/api/swarm/config");
export const fetchSwarmTemplates = (): Promise<{ templates: SwarmTemplateUi[] }> =>
  api<{ templates: SwarmTemplateUi[] }>("/api/swarm/templates");
export const validateSwarmConfig = (draft: SwarmConfigDraft): Promise<SwarmConfigValidation> =>
  post<SwarmConfigValidation>("/api/swarm/config/validate", draft);
export const saveSwarmConfig = (draft: SwarmConfigDraft): Promise<SwarmConfigSaved> =>
  post<SwarmConfigSaved>("/api/swarm/config/save", draft);
