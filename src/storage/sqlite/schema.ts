import type Database from "better-sqlite3";

/**
 * Versioned migrations. Each entry runs once, in order, inside a transaction;
 * `meta.schema_version` records the last applied version. A migration is raw `sql`,
 * an `up` step for changes that must look at the live schema first (SQLite has no
 * ADD COLUMN IF NOT EXISTS), or both (sql runs first).
 *
 * Never edit a shipped migration in place: databases that already ran it will not see
 * the change. Add a new version instead.
 */
export interface Migration {
  version: number;
  sql?: string;
  up?: (db: Database.Database) => void;
}

/** True when `table` already has a column named `column`. */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT,
  content_type TEXT NOT NULL DEFAULT 'prose',
  content_hash TEXT NOT NULL,
  session_id TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_src_ts ON documents(source, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS documents_uri_hash ON documents(uri, content_hash);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  content_type TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  hash TEXT NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id, ord);
CREATE INDEX IF NOT EXISTS chunks_embedded ON chunks(embedded);

-- Two external-content FTS tables over the same rows: porter for stemmed word
-- matching, trigram for identifiers/substrings. bm25() weights title 5x.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_porter USING fts5(
  title, body, content='chunks', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_trigram USING fts5(
  title, body, content='chunks', content_rowid='id',
  tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vocab USING fts5vocab('chunks_fts_porter', 'row');
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vocab_instance USING fts5vocab('chunks_fts_porter', 'instance');

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts_porter(rowid, title, body) VALUES (new.id, new.title, new.body);
  INSERT INTO chunks_fts_trigram(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts_porter(chunks_fts_porter, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO chunks_fts_trigram(chunks_fts_trigram, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts_porter(chunks_fts_porter, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO chunks_fts_trigram(chunks_fts_trigram, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO chunks_fts_porter(rowid, title, body) VALUES (new.id, new.title, new.body);
  INSERT INTO chunks_fts_trigram(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_root TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  source TEXT,
  last_prompt TEXT,
  transcript_path TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL,
  priority INTEGER NOT NULL,
  tool TEXT,
  payload TEXT NOT NULL,
  document_id INTEGER
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_cat ON events(category, ts DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  trigger TEXT,
  body TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS stats (
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  raw_chars INTEGER NOT NULL DEFAULT 0,
  returned_chars INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool)
);

CREATE TABLE IF NOT EXISTS fetch_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  markdown TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  source TEXT NOT NULL CHECK (source IN ('tree-sitter', 'curated', 'git')),
  confidence REAL NOT NULL DEFAULT 1,
  meta TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_nodes_name ON graph_nodes(name);
CREATE INDEX IF NOT EXISTS graph_nodes_path ON graph_nodes(path);

CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  weight REAL NOT NULL DEFAULT 1,
  meta TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind, source)
);
CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges(dst, kind);

CREATE TABLE IF NOT EXISTS file_index (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime INTEGER,
  size INTEGER,
  language TEXT,
  indexed_at INTEGER NOT NULL,
  document_id INTEGER
);
CREATE TABLE IF NOT EXISTS reindex_queue (
  path TEXT PRIMARY KEY,
  reason TEXT,
  queued_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  node_ids TEXT,
  session_id TEXT,
  document_id INTEGER,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    // Memories became markdown files under <project>/.eminiar/memories; the row mirrors
    // one file (name = topic/slug) and remembers its hash/mtime/size so reconcile can
    // skip unchanged files. Rows with name NULL are legacy and get migrated to files.
    version: 2,
    sql: `
ALTER TABLE memories ADD COLUMN name TEXT;
ALTER TABLE memories ADD COLUMN path TEXT;
ALTER TABLE memories ADD COLUMN file_hash TEXT;
ALTER TABLE memories ADD COLUMN file_mtime INTEGER;
ALTER TABLE memories ADD COLUMN file_size INTEGER;
ALTER TABLE memories ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS memories_name ON memories(name) WHERE name IS NOT NULL;
`,
  },
  {
    // Code chunks are cut at declaration boundaries and remember the symbol they belong
    // to (sym:<rel>#<Qualified>), so search hits can name their symbol and tools can go
    // from a symbol to its body. Chunks are rebuilt on every reparse; the id is stable.
    version: 3,
    sql: `
ALTER TABLE chunks ADD COLUMN symbol_id TEXT;
CREATE INDEX IF NOT EXISTS chunks_symbol ON chunks(symbol_id);
`,
  },
  {
    // Graph depth: nodes may come from an "analysis" pass (routes, link fixes), so the
    // source CHECK goes; a kind index serves the explorer; graph_metrics holds per-node
    // fan-in/out, size, complexity, churn, hotspot score and cluster; file_index records
    // why a file was not (fully) indexed; index_runs is a short log of index passes.
    version: 4,
    sql: `
CREATE TABLE graph_nodes_v4 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  meta TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO graph_nodes_v4 (id, kind, name, path, start_line, end_line, source, confidence, meta, updated_at)
  SELECT id, kind, name, path, start_line, end_line, source, confidence, meta, updated_at FROM graph_nodes;
DROP TABLE graph_nodes;
ALTER TABLE graph_nodes_v4 RENAME TO graph_nodes;
CREATE INDEX IF NOT EXISTS graph_nodes_name ON graph_nodes(name);
CREATE INDEX IF NOT EXISTS graph_nodes_path ON graph_nodes(path);
CREATE INDEX IF NOT EXISTS graph_nodes_kind ON graph_nodes(kind);

CREATE TABLE IF NOT EXISTS graph_metrics (
  node_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT,
  fan_in INTEGER NOT NULL DEFAULT 0,
  fan_out INTEGER NOT NULL DEFAULT 0,
  loc INTEGER NOT NULL DEFAULT 0,
  complexity INTEGER NOT NULL DEFAULT 0,
  commits_90d INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  cluster INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_metrics_score ON graph_metrics(kind, score DESC);
CREATE INDEX IF NOT EXISTS graph_metrics_cluster ON graph_metrics(cluster);
CREATE INDEX IF NOT EXISTS graph_metrics_path ON graph_metrics(path);

ALTER TABLE memories ADD COLUMN status TEXT;
ALTER TABLE memories ADD COLUMN supersedes TEXT;

ALTER TABLE file_index ADD COLUMN status TEXT NOT NULL DEFAULT 'indexed';
ALTER TABLE file_index ADD COLUMN reason TEXT;
ALTER TABLE file_index ADD COLUMN symbols INTEGER;
ALTER TABLE file_index ADD COLUMN errors TEXT;

CREATE TABLE IF NOT EXISTS index_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  scanned INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,
  detail TEXT
);
`,
  },
  {
    // Usage insights: api_calls mirrors one API request per Claude Code transcript entry
    // (deduped on request_id + message_id; cost cached at ingest), tool_uses pairs each
    // tool_use block with its tool_result size, context_events records compactions,
    // transcript_files keeps the byte offset so ingest only reads new bytes, and
    // statusline_snapshots stores what `eminiar statusline` saw. Column names = row fields.
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS api_calls (
  request_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  sidechain INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_create_5m INTEGER NOT NULL DEFAULT 0,
  cache_create_1h INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  web_fetches INTEGER NOT NULL DEFAULT 0,
  service_tier TEXT,
  speed TEXT,
  stop_reason TEXT,
  prompt_id TEXT,
  git_branch TEXT,
  cwd TEXT,
  effort TEXT,
  version TEXT,
  entrypoint TEXT,
  cost_usd REAL,
  priced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, message_id)
);
CREATE INDEX IF NOT EXISTS api_calls_session_ts ON api_calls(session_id, ts);
CREATE INDEX IF NOT EXISTS api_calls_ts ON api_calls(ts);

CREATE TABLE IF NOT EXISTS tool_uses (
  tool_use_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  input_chars INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS tool_uses_session_ts ON tool_uses(session_id, ts);
CREATE INDEX IF NOT EXISTS tool_uses_ts ON tool_uses(ts);

CREATE TABLE IF NOT EXISTS context_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  trigger TEXT,
  pre_tokens INTEGER,
  post_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS context_events_session_ts ON context_events(session_id, ts);
CREATE INDEX IF NOT EXISTS context_events_ts ON context_events(ts);

CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT,
  offset INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  ingested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS statusline_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model_id TEXT,
  cost_usd REAL,
  api_ms INTEGER,
  duration_ms INTEGER,
  ctx_input_tokens INTEGER,
  ctx_output_tokens INTEGER,
  ctx_size INTEGER,
  ctx_used_pct REAL,
  cache_warm INTEGER,
  cache_ttl TEXT,
  five_hour_pct REAL,
  five_hour_resets_at INTEGER,
  seven_day_pct REAL,
  seven_day_resets_at INTEGER,
  lines_added INTEGER,
  lines_removed INTEGER
);
CREATE INDEX IF NOT EXISTS statusline_snapshots_session_ts ON statusline_snapshots(session_id, ts);
CREATE INDEX IF NOT EXISTS statusline_snapshots_ts ON statusline_snapshots(ts);
`,
  },
  {
    // transcript_files.head_hash (fingerprint of the file head, so a rewrite with the same
    // size is noticed) was first added to v5 after v5 had already run on real databases, so
    // version-5 databases exist both with and without the column. Add it only when missing.
    version: 6,
    up(db) {
      if (!hasColumn(db, "transcript_files", "head_hash"))
        db.exec("ALTER TABLE transcript_files ADD COLUMN head_hash TEXT");
    },
  },
  {
    // Agent swarms (src/swarm): the coordination ledger. Runs own everything else, so a
    // deleted run cascades to its tasks, workers, events, blackboard notes and spawns.
    version: 7,
    sql: `
CREATE TABLE IF NOT EXISTS swarm_runs (
  id TEXT PRIMARY KEY,
  swarm TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  topology TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS swarm_runs_status ON swarm_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS swarm_runs_swarm ON swarm_runs(swarm, status, created_at);
CREATE TABLE IF NOT EXISTS swarm_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  agent_id TEXT,
  deps TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  auto_closed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS swarm_tasks_run ON swarm_tasks(run_id, status);
CREATE TABLE IF NOT EXISTS swarm_agents (
  run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  task_id INTEGER,
  prompt TEXT,
  session_id TEXT,
  spawned_at INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  ended_at INTEGER,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  last_tool TEXT,
  summary TEXT,
  PRIMARY KEY (run_id, agent_id)
);
CREATE INDEX IF NOT EXISTS swarm_agents_agent ON swarm_agents(agent_id, spawned_at);
CREATE TABLE IF NOT EXISTS swarm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  agent_id TEXT,
  role TEXT,
  kind TEXT NOT NULL,
  task_id INTEGER,
  text TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS swarm_events_run ON swarm_events(run_id, id);
CREATE TABLE IF NOT EXISTS swarm_notes (
  run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  author TEXT,
  ts INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (run_id, key)
);
-- A spawn reservation exists from PreToolUse(Agent) until the worker starts or the Agent
-- call returns; it may precede any run (the run opens at SubagentStart).
CREATE TABLE IF NOT EXISTS swarm_spawns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm TEXT NOT NULL,
  run_id TEXT REFERENCES swarm_runs(id) ON DELETE CASCADE,
  session_id TEXT,
  agent_type TEXT NOT NULL,
  prompt TEXT,
  task_id INTEGER,
  tool_use_id TEXT,
  ts INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS swarm_spawns_type ON swarm_spawns(agent_type, consumed, ts);
CREATE INDEX IF NOT EXISTS swarm_spawns_swarm ON swarm_spawns(swarm, consumed, ts);
CREATE INDEX IF NOT EXISTS swarm_spawns_run ON swarm_spawns(run_id, consumed, ts);
CREATE INDEX IF NOT EXISTS swarm_spawns_tool ON swarm_spawns(tool_use_id);
CREATE INDEX IF NOT EXISTS swarm_agents_session ON swarm_agents(session_id, status);
`,
  },
  {
    // Adjudicator (src/adjudicator, docs/design/adjudicator.md §12): one row per decision,
    // the verdict cache, per-provider breaker state and the learned bias buckets. No text
    // beyond input_head (≤ 80 redacted chars), no keys, no raw provider responses.
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS adjudications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  surface TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT,
  tool_use_id TEXT,
  run_id TEXT,
  task_id INTEGER,
  parent_id INTEGER,
  input_hash TEXT NOT NULL,
  input_head TEXT,
  input_chars INTEGER,
  complexity REAL,
  tier TEXT,
  effort TEXT,
  tool TEXT,
  role TEXT,
  confidence REAL,
  scores TEXT,
  source TEXT,
  provider TEXT,
  provider_model TEXT,
  provider_status TEXT,
  latency_ms INTEGER,
  provider_latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  action TEXT,
  model_requested TEXT,
  model_final TEXT,
  baseline_model TEXT,
  actual_model TEXT,
  actual_tokens INTEGER,
  actual_cost_usd REAL,
  baseline_cost_usd REAL,
  savings_usd REAL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  outcome_source TEXT,
  outcome_ts INTEGER,
  final INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  feedback_note TEXT
);
CREATE INDEX IF NOT EXISTS adjudications_session ON adjudications(session_id, ts);
CREATE INDEX IF NOT EXISTS adjudications_task ON adjudications(run_id, task_id);
CREATE INDEX IF NOT EXISTS adjudications_hash ON adjudications(input_hash);
CREATE INDEX IF NOT EXISTS adjudications_ts ON adjudications(ts);
CREATE INDEX IF NOT EXISTS adjudications_final ON adjudications(final, ts);
CREATE INDEX IF NOT EXISTS adjudications_tool_use ON adjudications(tool_use_id);
CREATE TABLE IF NOT EXISTS adjudicator_cache (
  key TEXT PRIMARY KEY,
  verdict TEXT,
  provider TEXT,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS adjudicator_provider_state (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  last_ok_at INTEGER,
  last_error_at INTEGER,
  last_error_class TEXT,
  latencies TEXT,
  latency_budgets TEXT,
  spend_day TEXT,
  spend_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  auth_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS adjudicator_bias (
  dimension TEXT NOT NULL,
  bucket TEXT NOT NULL,
  option TEXT NOT NULL,
  n REAL NOT NULL DEFAULT 0,
  s REAL NOT NULL DEFAULT 0,
  f REAL NOT NULL DEFAULT 0,
  cost_median REAL,
  bias REAL NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (dimension, bucket, option)
);
`,
  },
  {
    // Jev exchange log (docs/design/adjudicator.md, task #172): the newest 100 requests sent to
    // Jev and its answers, kept only while the personal privacy.captureExchanges setting is on.
    // A new table, so no heal is needed and the v8 DDL stays untouched. Never stores a key, a
    // header or the internal request keys; the bodies are redacted before they get here.
    version: 9,
    sql: `
CREATE TABLE IF NOT EXISTS adjudicator_exchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  model TEXT,
  surface TEXT,
  context TEXT,
  method TEXT NOT NULL,
  target TEXT NOT NULL,
  row_ids TEXT NOT NULL DEFAULT '[]',
  items INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  wait_ms INTEGER,
  job_wait_ms INTEGER,
  ttfb_ms INTEGER,
  duration_ms INTEGER,
  retry_wait_ms INTEGER NOT NULL DEFAULT 0,
  deadline_ms INTEGER NOT NULL,
  budget_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  request_body TEXT NOT NULL,
  request_bytes INTEGER NOT NULL,
  request_truncated INTEGER NOT NULL DEFAULT 0,
  response_body TEXT,
  response_bytes INTEGER,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS adjudicator_exchanges_ts ON adjudicator_exchanges(ts);
`,
  },
  {
    // v12: the recall index (see RECALL_INDEX_SQL). Not v10: a development build of the
    // adjudicator line already took 10 (decision_calls, decision_cache) on real databases, and the
    // playbooks migration takes 11. The table and its triggers only: a hook may be the first to
    // open the database, so the migration must stay cheap, and the rows that predate the triggers
    // are copied in later, in short slices (backfillRecallIndex), by the MCP server, `eminiar
    // reindex`, or a hook that does not block the prompt (Stop, SessionEnd, PreCompact, SubagentStop).
    // Idempotent, and also run at every open as a heal (ensureRecallIndex), because a database
    // can claim this version or a later one without the table (another build's numbering).
    version: 12,
    up: (db) => {
      ensureRecallIndex(db);
    },
  },
];

/**
 * The documents whose chunks the recall index holds, as a condition on `d` (documents), and the
 * source marker each one gets. Built-in SQL only: an older eminiar on the same database fires the
 * triggers too, and a custom SQL function would break its inserts.
 */
const RECALL_DOC_WHERE =
  "(d.source = 'memory' OR d.source LIKE 'docs:%' OR (d.source = 'session' AND d.title = 'error'))";
const RECALL_SRC_SQL =
  "CASE WHEN d.source = 'memory' THEN 'memory' WHEN d.source = 'session' THEN 'error' ELSE 'docs' END";

/**
 * The recall index. Prompt recall (UserPromptSubmit, the subagent brief, error recall) only ever
 * surfaces memories, documentation pages and captured tool errors, but it used to search the
 * whole chunk index, which grows with every captured code, exec and session output: seconds cold
 * on a large database. recall_fts holds just those chunks, so a recall query costs in proportion
 * to memories + docs + errors. A regular (content-storing) FTS5 table, not external content: a
 * chunk delete cannot see its document's source (the parent row may be gone), and secure-delete
 * and rebuild need the stored content. `src` is the source marker the query filters on inside the
 * index. Every statement is IF NOT EXISTS, so it can run again on any database.
 */
const RECALL_INDEX_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(
  title, body, src,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_recall_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO recall_fts(rowid, title, body, src)
  SELECT new.id, new.title, new.body, ${RECALL_SRC_SQL}
    FROM documents d
   WHERE d.id = new.document_id AND ${RECALL_DOC_WHERE};
END;
CREATE TRIGGER IF NOT EXISTS chunks_recall_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM recall_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_recall_au AFTER UPDATE OF title, body ON chunks BEGIN
  INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 0);
  DELETE FROM recall_fts WHERE rowid = old.id;
  INSERT INTO recall_fts(rowid, title, body, src)
  SELECT new.id, new.title, new.body, ${RECALL_SRC_SQL}
    FROM documents d
   WHERE d.id = new.document_id AND ${RECALL_DOC_WHERE};
  INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 1);
END;
`;

/**
 * With persistent secure-delete on, a delete and re-insert of the same rowid in one transaction
 * (this trigger's UPDATE) leaves phantom rowids behind once the row is deleted later: an SQLite
 * FTS5 bug (checked on 3.51.0 and 3.53.4) that fails 'integrity-check' and turns bm25 into NaN.
 * The trigger therefore switches secure-delete off around its delete+insert and back on after;
 * the updated row's old tokens stay as tombstones until a merge. A trigger without that toggle
 * (a v12 install from before this) is replaced on open.
 */
const RECALL_TRIGGERS = ["chunks_recall_ai", "chunks_recall_ad", "chunks_recall_au"] as const;

/**
 * Meta key of a recall index still being filled: the id of the last document whose chunks the
 * backfill has copied in. Absent means the index is complete (ready); while it is present,
 * recall returns nothing rather than a partial answer or the slow whole-index query.
 */
export const RECALL_BACKFILL_KEY = "recall_fts_backfill_after";

/** True when recall_fts, its three triggers and its persistent secure-delete are all in place. */
export function recallIndexIntact(db: Database.Database): boolean {
  const names = recallIndexObjects(db);
  if (names.size !== RECALL_TRIGGERS.length + 1) return false;
  return recallSecureDelete(db) && recallUpdateTriggerCurrent(db);
}

function recallIndexObjects(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE name IN ('recall_fts', ${RECALL_TRIGGERS.map((t) => `'${t}'`).join(", ")})`,
    )
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function recallUpdateTriggerCurrent(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_recall_au'").get() as
    | { sql: string | null }
    | undefined;
  return (row?.sql ?? "").includes("'secure-delete'");
}

function recallSecureDelete(db: Database.Database): boolean {
  const row = db.prepare("SELECT v FROM recall_fts_config WHERE k = 'secure-delete'").get() as
    | { v: unknown }
    | undefined;
  return Number(row?.v) === 1;
}

/**
 * Create the recall index where it is missing or incomplete, whatever schema_version says. Cheap
 * and idempotent: no rows are copied here (a hook may be the caller). A table left without one of
 * its triggers may be out of step with chunks, so it is dropped and made again, empty. A new
 * table on a database that already has chunks is marked for the backfill (RECALL_BACKFILL_KEY);
 * on one with no chunks it is complete as it stands. FTS5 secure-delete is turned on for good
 * (it is stored in the table's config, so every process deleting from it, an older eminiar's
 * triggers included, removes the deleted rows' tokens from the index segments). Run it inside a
 * write transaction. Returns true when it changed anything.
 */
export function ensureRecallIndex(db: Database.Database): boolean {
  const names = recallIndexObjects(db);
  if (names.size === RECALL_TRIGGERS.length + 1) {
    let changed = false;
    if (!recallSecureDelete(db)) {
      db.exec("INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 1)");
      changed = true;
    }
    if (!recallUpdateTriggerCurrent(db)) {
      // only the trigger body is stale; the table is in step, so keep it and its rows
      db.exec("DROP TRIGGER chunks_recall_au");
      db.exec(RECALL_INDEX_SQL);
      changed = true;
    }
    return changed;
  }
  for (const t of RECALL_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  if (names.has("recall_fts")) db.exec("DROP TABLE recall_fts");
  db.exec(RECALL_INDEX_SQL);
  db.exec("INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 1)");
  if (db.prepare("SELECT 1 FROM chunks LIMIT 1").get())
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(RECALL_BACKFILL_KEY);
  else db.prepare("DELETE FROM meta WHERE key = ?").run(RECALL_BACKFILL_KEY);
  return true;
}

/** How many recall documents one backfill slice reads at most (it also stops at its row cap). */
const RECALL_BACKFILL_DOCS = 500;

/**
 * One slice of the recall backfill: copy the chunks of the next recall documents after the saved
 * cursor that are not in the index yet, until `maxRows` rows are copied or `holdMs` has passed
 * (at least one document), and move the cursor; the last slice removes the key, which makes the
 * index ready. Run it inside an IMMEDIATE transaction. Safe against rows that change between
 * slices: the triggers have kept every insert, update and delete in step since the table was
 * made, and a slice copies only chunks the index does not hold yet, so a row a trigger already
 * wrote is never written twice and a deleted chunk is simply not found.
 */
export function recallBackfillSlice(
  db: Database.Database,
  maxRows: number,
  holdMs: number,
): { done: boolean; rows: number } {
  const saved = db.prepare("SELECT value FROM meta WHERE key = ?").get(RECALL_BACKFILL_KEY) as
    | { value: string }
    | undefined;
  if (saved === undefined) return { done: true, rows: 0 };
  const started = performance.now();
  let after = Number(saved.value) || 0;
  const docs = db
    .prepare(
      `SELECT d.id FROM documents d WHERE d.id > ? AND ${RECALL_DOC_WHERE} ORDER BY d.id LIMIT ?`,
    )
    .all(after, RECALL_BACKFILL_DOCS) as Array<{ id: number }>;
  const missing = db.prepare(
    `SELECT c.id, c.title, c.body, ${RECALL_SRC_SQL} src
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.document_id = ? AND NOT EXISTS (SELECT 1 FROM recall_fts r WHERE r.rowid = c.id)`,
  );
  const insert = db.prepare("INSERT INTO recall_fts(rowid, title, body, src) VALUES (?, ?, ?, ?)");
  let rows = 0;
  let seen = 0;
  for (const { id } of docs) {
    // read in full before writing: the insert goes into the table the read looks at
    const add = missing.all(id) as Array<{ id: number; title: string; body: string; src: string }>;
    for (const r of add) insert.run(r.id, r.title, r.body, r.src);
    rows += add.length;
    after = id;
    seen++;
    if (rows >= maxRows || performance.now() - started >= holdMs) break;
  }
  const done = seen === docs.length && docs.length < RECALL_BACKFILL_DOCS;
  if (done) db.prepare("DELETE FROM meta WHERE key = ?").run(RECALL_BACKFILL_KEY);
  else
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(String(after), RECALL_BACKFILL_KEY);
  return { done, rows };
}

/**
 * Columns added to the v8 tables after v8 first ran on development databases (v8 was not yet
 * released, so the migration was edited in place). Those databases are already at version 8
 * and never rerun it; healAdjudicatorColumns adds what they lack. A released change to these
 * tables gets a new migration instead.
 */
export const ADJUDICATOR_LATE_COLUMNS: ReadonlyArray<
  readonly [table: string, column: string, ddl: string]
> = [
  ["adjudicator_provider_state", "calls", "INTEGER NOT NULL DEFAULT 0"],
  ["adjudicator_provider_state", "auth_fingerprint", "TEXT"],
  ["adjudications", "feedback_note", "TEXT"],
  ["adjudicator_provider_state", "latency_budgets", "TEXT"],
];

/** Indexes added to the v8 tables after v8 first ran (see ADJUDICATOR_LATE_COLUMNS). */
export const ADJUDICATOR_LATE_INDEXES: ReadonlyArray<
  readonly [table: string, index: string, columns: string]
> = [["adjudications", "adjudications_tool_use", "tool_use_id"]];

/**
 * Adds any ADJUDICATOR_LATE_COLUMNS and ADJUDICATOR_LATE_INDEXES a database lacks. Idempotent and
 * cheap (one table_info per table, one sqlite_master lookup per index); tables that do not exist
 * yet are left to the migration. Returns what it added: `table.column` and index names.
 */
export function healAdjudicatorColumns(db: Database.Database): string[] {
  const added: string[] = [];
  const present = new Map<string, Set<string> | null>();
  for (const [table, column, ddl] of ADJUDICATOR_LATE_COLUMNS) {
    let cols = present.get(table);
    if (cols === undefined) {
      const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      cols = info.length ? new Set(info.map((c) => c.name)) : null;
      present.set(table, cols);
    }
    if (!cols || cols.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    cols.add(column);
    added.push(`${table}.${column}`);
  }
  const indexExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?");
  for (const [table, index, columns] of ADJUDICATOR_LATE_INDEXES) {
    let cols = present.get(table);
    if (cols === undefined) {
      const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      cols = info.length ? new Set(info.map((c) => c.name)) : null;
      present.set(table, cols);
    }
    if (!cols || indexExists.get(index)) continue;
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${columns})`);
    added.push(index);
  }
  return added;
}

/** vec0 lives outside the migration list: it needs the extension loaded first and takes the dimension. */
export function vecTableSql(dims: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}])`;
}
