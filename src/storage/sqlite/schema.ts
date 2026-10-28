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
];

/** vec0 lives outside the migration list: it needs the extension loaded first and takes the dimension. */
export function vecTableSql(dims: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}])`;
}
