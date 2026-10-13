/**
 * Versioned migrations. Each entry runs once, in order, inside a transaction;
 * `meta.schema_version` records the last applied version.
 */
export interface Migration {
  version: number;
  sql: string;
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
];

/** vec0 lives outside the migration list: it needs the extension loaded first and takes the dimension. */
export function vecTableSql(dims: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}])`;
}
