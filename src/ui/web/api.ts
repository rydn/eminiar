/** Fetch wrapper for the dashboard API: every call carries the selected project root. */
import type { DocCategory } from "../../docs/category.js";
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
  history.replaceState(null, "", u.toString());
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
  if (!r.ok) throw new ApiError(body.error ?? `HTTP ${r.status}`, r.status);
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
export type SwarmTask = TaskRow;
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
  runs: SwarmRunSummary[];
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
export interface SwarmRunDetail {
  run: RunRow;
  tasks: SwarmTask[];
  workers: SwarmWorkerUi[];
  notes: SwarmNote[];
  /** The latest events, oldest first. */
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
    cut: boolean;
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
export interface SwarmSyncResult {
  actions: Array<{ agentType: string; path: string; action: string; reason?: string }>;
  changed: number;
  conflicts: number;
}
