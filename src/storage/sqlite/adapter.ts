import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { SessionPatch, StorageAdapter } from "../adapter.js";
import { topTermsOf } from "../terms.js";
import type {
  ChunkInput,
  ChunkWithDoc,
  DocumentInput,
  DocumentRow,
  DocumentSummaryRow,
  EventInput,
  EventRow,
  FileIndexInput,
  FileIndexRow,
  FtsHit,
  GraphEdge,
  GraphEdgeRow,
  GraphMetricInput,
  GraphMetricRow,
  GraphNode,
  GraphNodeRow,
  GraphSource,
  IndexRunRow,
  IndexRunSummary,
  MemoryInput,
  MemoryRow,
  PurgeScope,
  SearchFilters,
  SessionRow,
  SnapshotRow,
  SourceStatRow,
  StatDelta,
  StatRow,
  VecHit,
  VocabTerm,
} from "../types.js";
import { migrations, vecTableSql } from "./schema.js";

export interface SqliteOptions {
  /** Embedding dimension for the vec0 table. */
  dims?: number;
  /** Skip loading sqlite-vec (hooks don't need it and it saves startup time). */
  vectors?: boolean;
}

type Row = Record<string, unknown>;

/** Builds the WHERE fragment and params for search filters; `c`/`d` are the chunk/document aliases. */
function filterSql(f: SearchFilters | undefined): { where: string; params: unknown[] } {
  if (!f) return { where: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.source) {
    const sources = Array.isArray(f.source) ? f.source : [f.source];
    clauses.push(`d.source IN (${sources.map(() => "?").join(",")})`);
    params.push(...sources);
  }
  if (f.sourcePrefix) {
    clauses.push("d.source LIKE ? ESCAPE '\\'");
    params.push(`${f.sourcePrefix.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (f.contentType) {
    clauses.push("c.content_type = ?");
    params.push(f.contentType);
  }
  if (f.since) {
    clauses.push("d.created_at >= ?");
    params.push(f.since);
  }
  if (f.sessionId) {
    clauses.push("d.session_id = ?");
    params.push(f.sessionId);
  }
  if (f.documentIds?.length) {
    clauses.push(`d.id IN (${f.documentIds.map(() => "?").join(",")})`);
    params.push(...f.documentIds);
  }
  return { where: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

export class SqliteAdapter implements StorageAdapter {
  readonly db: Database.Database;
  readonly vectors: boolean;
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();

  /**
   * Prepared-statement cache. better-sqlite3 compiles the SQL on every prepare(), so
   * hot paths (every tool call records stats, every indexed output inserts chunks)
   * were paying for a parse each time. SQLite re-prepares cached statements itself
   * after a schema change, so entries never go stale.
   */
  private prep(sql: string): Database.Statement<unknown[], unknown> {
    let s = this.stmts.get(sql);
    if (!s) {
      if (this.stmts.size >= 512) this.stmts.clear();
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  constructor(
    readonly path: string,
    opts: SqliteOptions = {},
  ) {
    this.db = new Database(path, { timeout: 2000 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    // em_regexp(pattern, flags, text) backs chunkRegexSearch; compiled patterns are cached.
    const compiled = new Map<string, RegExp>();
    this.db.function("em_regexp", { deterministic: true }, (pattern, flags, text) => {
      const key = `${String(flags ?? "")}/${String(pattern)}`;
      let re = compiled.get(key);
      if (!re) {
        try {
          re = new RegExp(String(pattern), String(flags ?? ""));
        } catch {
          return 0;
        }
        if (compiled.size > 64) compiled.clear();
        compiled.set(key, re);
      }
      return re.test(String(text ?? "")) ? 1 : 0;
    });
    this.vectors = opts.vectors ?? true;
    if (this.vectors) sqliteVec.load(this.db);
    this.migrate(opts.dims ?? 384);
  }

  private migrate(dims: number): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const current = Number(this.metaGet("schema_version") ?? 0);
    const pending = migrations.filter((m) => m.version > current);
    if (pending.length) {
      this.transaction(() => {
        for (const m of pending) {
          this.db.exec(m.sql);
          this.metaSet("schema_version", String(m.version));
        }
      });
    }
    if (this.vectors) {
      const prevDims = this.metaGet("vec_dims");
      if (prevDims && Number(prevDims) !== dims) {
        // Dimension change invalidates every stored vector.
        this.db.exec("DROP TABLE IF EXISTS chunk_vec");
        this.db.exec("UPDATE chunks SET embedded = 0");
      }
      this.db.exec(vecTableSql(dims));
      this.metaSet("vec_dims", String(dims));
    }
  }

  // --- documents & chunks -------------------------------------------------

  upsertDocument(doc: DocumentInput, chunks: ChunkInput[]): { id: number; created: boolean } {
    return this.transaction(() => {
      if (doc.uri) {
        const existing = this.prep("SELECT id, content_hash FROM documents WHERE uri = ?").all(
          doc.uri,
        ) as Array<{ id: number; content_hash: string }>;
        const same = existing.find((e) => e.content_hash === doc.contentHash);
        if (same) return { id: same.id, created: false };
        for (const e of existing) this.deleteDocument(e.id);
      }
      const info = this.prep(
        `INSERT INTO documents (source, title, uri, content_type, content_hash, session_id, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        doc.source,
        doc.title,
        doc.uri ?? null,
        doc.contentType,
        doc.contentHash,
        doc.sessionId ?? null,
        doc.meta ? JSON.stringify(doc.meta) : null,
        Date.now(),
      );
      const id = Number(info.lastInsertRowid);
      const ins = this.prep(
        `INSERT INTO chunks (document_id, ord, title, body, content_type, start_line, end_line, hash, symbol_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of chunks) {
        ins.run(
          id,
          c.ord,
          c.title,
          c.body,
          c.contentType,
          c.startLine ?? null,
          c.endLine ?? null,
          c.hash,
          c.symbolId ?? null,
        );
      }
      return { id, created: true };
    });
  }

  getDocument(id: number): DocumentRow | undefined {
    return this.prep("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
  }

  findDocumentByUri(uri: string): DocumentRow | undefined {
    return this.prep("SELECT * FROM documents WHERE uri = ? ORDER BY created_at DESC LIMIT 1").get(
      uri,
    ) as DocumentRow | undefined;
  }

  deleteDocument(id: number): void {
    this.transaction(() => {
      if (this.vectors) {
        this.prep(
          "DELETE FROM chunk_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
        ).run(id);
      }
      // chunks cascade; FTS rows go via the chunks_ad trigger
      this.prep("DELETE FROM chunks WHERE document_id = ?").run(id);
      this.prep("DELETE FROM documents WHERE id = ?").run(id);
    });
  }

  deleteDocumentsBySource(source: string): number {
    const ids = this.db.prepare("SELECT id FROM documents WHERE source = ?").all(source) as Array<{
      id: number;
    }>;
    this.transaction(() => {
      for (const { id } of ids) this.deleteDocument(id);
    });
    return ids.length;
  }

  countDocuments(source?: string): number {
    const row = source
      ? (this.db.prepare("SELECT COUNT(*) n FROM documents WHERE source = ?").get(source) as {
          n: number;
        })
      : (this.db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number });
    return row.n;
  }

  documentsBySource(source: string, limit = 200): DocumentSummaryRow[] {
    return this.db
      .prepare(
        `SELECT d.id, d.source, d.title, d.uri, d.created_at,
                (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) chunks
         FROM documents d WHERE d.source = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
      )
      .all(source, limit) as DocumentSummaryRow[];
  }

  documentSourceStats(prefix: string): SourceStatRow[] {
    return this.db
      .prepare(
        `SELECT d.source source, COUNT(DISTINCT d.id) documents, COUNT(c.id) chunks, MAX(d.created_at) latest
         FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
         WHERE d.source LIKE ? ESCAPE '\\' GROUP BY d.source ORDER BY d.source`,
      )
      .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`) as SourceStatRow[];
  }

  private hydrate(rows: Row[]): ChunkWithDoc[] {
    return rows.map((r) => {
      const document: DocumentRow = {
        id: r.d_id as number,
        source: r.d_source as string,
        title: r.d_title as string,
        uri: r.d_uri as string | null,
        content_type: r.d_content_type as DocumentRow["content_type"],
        content_hash: r.d_content_hash as string,
        session_id: r.d_session_id as string | null,
        meta: r.d_meta as string | null,
        created_at: r.d_created_at as number,
      };
      return {
        id: r.id as number,
        document_id: r.document_id as number,
        ord: r.ord as number,
        title: r.title as string,
        body: r.body as string,
        content_type: r.content_type as ChunkWithDoc["content_type"],
        start_line: r.start_line as number | null,
        end_line: r.end_line as number | null,
        hash: r.hash as string,
        embedded: r.embedded as number,
        symbol_id: (r.symbol_id as string | null) ?? null,
        document,
      };
    });
  }

  private static readonly CHUNK_SELECT = `
    SELECT c.*, d.id d_id, d.source d_source, d.title d_title, d.uri d_uri, d.content_type d_content_type,
           d.content_hash d_content_hash, d.session_id d_session_id, d.meta d_meta, d.created_at d_created_at
    FROM chunks c JOIN documents d ON d.id = c.document_id`;

  getChunks(ids: number[]): ChunkWithDoc[] {
    if (!ids.length) return [];
    const rows = this.prep(
      `${SqliteAdapter.CHUNK_SELECT} WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    ).all(...ids) as Row[];
    const byId = new Map(this.hydrate(rows).map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id)).filter((c): c is ChunkWithDoc => !!c);
  }

  chunksOfDocument(documentId: number): ChunkWithDoc[] {
    const rows = this.prep(
      `${SqliteAdapter.CHUNK_SELECT} WHERE c.document_id = ? ORDER BY c.ord`,
    ).all(documentId) as Row[];
    return this.hydrate(rows);
  }

  chunksForSymbol(symbolId: string): ChunkWithDoc[] {
    const rows = this.db
      .prepare(`${SqliteAdapter.CHUNK_SELECT} WHERE c.symbol_id = ? ORDER BY c.document_id, c.ord`)
      .all(symbolId) as Row[];
    return this.hydrate(rows);
  }

  chunkRegexSearch(
    pattern: string,
    flags: string,
    limit: number,
    filters?: SearchFilters,
  ): number[] {
    if (pattern.length > 200) throw new Error("regex pattern is too long (max 200 chars)");
    new RegExp(pattern, flags); // surfaces a syntax error before the scan
    const { where, params } = filterSql(filters);
    const rows = this.db
      .prepare(
        `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE em_regexp(?, ?, c.body) = 1${where}
         ORDER BY d.created_at DESC, c.ord LIMIT ?`,
      )
      .all(pattern, flags, ...params, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  // --- lexical search ----------------------------------------------------

  ftsSearch(
    kind: "porter" | "trigram",
    match: string,
    limit: number,
    filters?: SearchFilters,
  ): FtsHit[] {
    const table = kind === "porter" ? "chunks_fts_porter" : "chunks_fts_trigram";
    const { where, params } = filterSql(filters);
    try {
      const rows = this.prep(
        `SELECT f.rowid id, -bm25(${table}, 5.0, 1.0) score
           FROM ${table} f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id
           WHERE ${table} MATCH ?${where}
           ORDER BY score DESC LIMIT ?`,
      ).all(match, ...params, limit) as Array<{ id: number; score: number }>;
      return rows.map((r) => ({ chunkId: r.id, score: r.score }));
    } catch (err) {
      // A malformed MATCH expression must not take the whole search down.
      if (/fts5: syntax error|no such column/i.test((err as Error).message)) return [];
      throw err;
    }
  }

  termExists(term: string): boolean {
    try {
      const row = this.prep(
        "SELECT rowid FROM chunks_fts_porter WHERE chunks_fts_porter MATCH ? LIMIT 1",
      ).get(`"${term.replace(/"/g, '""')}"`);
      return !!row;
    } catch {
      return false;
    }
  }

  vocabCandidates(prefix: string, limit: number): VocabTerm[] {
    const rows = this.prep(
      "SELECT term, doc df FROM chunks_vocab WHERE term >= ? AND term < ? ORDER BY doc DESC LIMIT ?",
    ).all(prefix, `${prefix}￿`, limit) as Array<{ term: string; df: number }>;
    return rows;
  }

  topTerms(chunkIds: number[], limit: number): VocabTerm[] {
    if (!chunkIds.length) return [];
    // Tokenised in JS over just these chunks. The previous fts5vocab('instance') query
    // could not push `doc IN (...)` down, so it walked every term instance in the index:
    // ~400 ms per call on a 60k-chunk database, growing with every output indexed.
    const bodies: string[] = [];
    for (let i = 0; i < chunkIds.length; i += 500) {
      const slice = chunkIds.slice(i, i + 500);
      const rows = this.prep(
        `SELECT body FROM chunks WHERE id IN (${slice.map(() => "?").join(",")})`,
      ).all(...slice) as Array<{ body: string }>;
      for (const r of rows) bodies.push(r.body);
    }
    return topTermsOf(bodies, limit);
  }

  // --- vectors -----------------------------------------------------------

  vecUpsert(chunkId: number, embedding: Float32Array): void {
    if (!this.vectors) return;
    // vec0 insists on INTEGER keys; better-sqlite3 binds BigInt as INTEGER (plain numbers may bind as REAL).
    this.db.prepare("DELETE FROM chunk_vec WHERE chunk_id = ?").run(BigInt(chunkId));
    this.db
      .prepare("INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)")
      .run(BigInt(chunkId), embedding);
  }

  vecSearch(embedding: Float32Array, k: number, filters?: SearchFilters): VecHit[] {
    if (!this.vectors) return [];
    // vec0 KNN cannot join; over-fetch then apply filters.
    const raw = this.db
      .prepare(
        "SELECT chunk_id id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(embedding, BigInt(filters ? k * 4 : k)) as Array<{ id: number; distance: number }>;
    if (!filters || !raw.length) return raw.map((r) => ({ chunkId: r.id, distance: r.distance }));
    const { where, params } = filterSql(filters);
    const allowed = new Set(
      (
        this.db
          .prepare(
            `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
             WHERE c.id IN (${raw.map(() => "?").join(",")})${where}`,
          )
          .all(...raw.map((r) => r.id), ...params) as Array<{ id: number }>
      ).map((r) => r.id),
    );
    return raw
      .filter((r) => allowed.has(r.id))
      .slice(0, k)
      .map((r) => ({ chunkId: r.id, distance: r.distance }));
  }

  unembeddedChunkIds(limit: number): number[] {
    return (
      this.db
        .prepare("SELECT id FROM chunks WHERE embedded = 0 ORDER BY id LIMIT ?")
        .all(limit) as Array<{
        id: number;
      }>
    ).map((r) => r.id);
  }

  markEmbedded(chunkIds: number[]): void {
    if (!chunkIds.length) return;
    this.db
      .prepare(`UPDATE chunks SET embedded = 1 WHERE id IN (${chunkIds.map(() => "?").join(",")})`)
      .run(...chunkIds);
  }

  vecCount(): number {
    if (!this.vectors) return 0;
    return (this.db.prepare("SELECT COUNT(*) n FROM chunk_vec").get() as { n: number }).n;
  }

  // --- sessions, events, snapshots, stats --------------------------------

  sessionUpsert(row: SessionPatch): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_root, started_at, ended_at, source, last_prompt, transcript_path)
         VALUES (@id, @project_root, @started_at, @ended_at, @source, @last_prompt, @transcript_path)
         ON CONFLICT(id) DO UPDATE SET
           project_root = COALESCE(excluded.project_root, sessions.project_root),
           started_at = COALESCE(sessions.started_at, excluded.started_at),
           ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
           source = COALESCE(excluded.source, sessions.source),
           last_prompt = COALESCE(excluded.last_prompt, sessions.last_prompt),
           transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path)`,
      )
      .run({
        id: row.id,
        project_root: row.project_root ?? null,
        started_at: row.started_at ?? Date.now(),
        ended_at: row.ended_at ?? null,
        source: row.source ?? null,
        last_prompt: row.last_prompt ?? null,
        transcript_path: row.transcript_path ?? null,
      });
  }

  sessionGet(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  sessionLatest(): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1").get() as
      | SessionRow
      | undefined;
  }

  sessionsRecent(limit: number): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY COALESCE(started_at, 0) DESC LIMIT ?")
      .all(limit) as SessionRow[];
  }

  eventInsert(e: EventInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (session_id, ts, category, priority, tool, payload, document_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.sessionId,
        e.ts ?? Date.now(),
        e.category,
        e.priority,
        e.tool ?? null,
        JSON.stringify(e.payload),
        e.documentId ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  eventsBySession(
    sessionId: string,
    opts: { categories?: string[]; limit?: number } = {},
  ): EventRow[] {
    const params: unknown[] = [sessionId];
    let where = "session_id = ?";
    if (opts.categories?.length) {
      where += ` AND category IN (${opts.categories.map(() => "?").join(",")})`;
      params.push(...opts.categories);
    }
    params.push(opts.limit ?? 10_000);
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where} ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(...params) as EventRow[];
  }

  eventsRecent(limit: number, categories?: string[]): EventRow[] {
    const params: unknown[] = [];
    let where = "1=1";
    if (categories?.length) {
      where += ` AND category IN (${categories.map(() => "?").join(",")})`;
      params.push(...categories);
    }
    params.push(limit);
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...params) as EventRow[];
  }

  snapshotInsert(s: { sessionId: string; trigger: string; body: string }): number {
    const info = this.db
      .prepare(
        "INSERT INTO snapshots (session_id, trigger, body, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(s.sessionId, s.trigger, s.body, Buffer.byteLength(s.body), Date.now());
    return Number(info.lastInsertRowid);
  }

  snapshotLatestUnconsumed(sessionId?: string): SnapshotRow | undefined {
    if (sessionId) {
      const own = this.db
        .prepare(
          "SELECT * FROM snapshots WHERE session_id = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .get(sessionId) as SnapshotRow | undefined;
      if (own) return own;
    }
    return this.db
      .prepare("SELECT * FROM snapshots WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get() as SnapshotRow | undefined;
  }

  snapshotMarkConsumed(id: number): void {
    this.db.prepare("UPDATE snapshots SET consumed_at = ? WHERE id = ?").run(Date.now(), id);
  }

  statRecord(sessionId: string, tool: string, d: StatDelta): void {
    this.prep(
      `INSERT INTO stats (session_id, tool, calls, raw_chars, returned_chars, duration_ms)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(session_id, tool) DO UPDATE SET
           calls = calls + 1,
           raw_chars = raw_chars + excluded.raw_chars,
           returned_chars = returned_chars + excluded.returned_chars,
           duration_ms = duration_ms + excluded.duration_ms`,
    ).run(sessionId, tool, d.rawChars, d.returnedChars, d.durationMs);
  }

  statsBySession(sessionId: string): StatRow[] {
    return this.db
      .prepare("SELECT * FROM stats WHERE session_id = ? ORDER BY tool")
      .all(sessionId) as StatRow[];
  }

  statsAll(): StatRow[] {
    return this.db.prepare("SELECT * FROM stats ORDER BY session_id, tool").all() as StatRow[];
  }

  // --- graph -------------------------------------------------------------

  graphUpsertNodes(nodes: GraphNode[]): void {
    if (!nodes.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO graph_nodes (id, kind, name, path, start_line, end_line, source, confidence, meta, updated_at)
       VALUES (@id, @kind, @name, @path, @start_line, @end_line, @source, @confidence, @meta, @updated_at)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, path = excluded.path,
         start_line = excluded.start_line, end_line = excluded.end_line, source = excluded.source,
         confidence = excluded.confidence,
         meta = CASE WHEN graph_nodes.meta IS NULL THEN excluded.meta
                     WHEN excluded.meta IS NULL THEN graph_nodes.meta
                     ELSE json_patch(graph_nodes.meta, excluded.meta) END,
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    this.transaction(() => {
      for (const n of nodes) {
        stmt.run({
          id: n.id,
          kind: n.kind,
          name: n.name,
          path: n.path ?? null,
          start_line: n.startLine ?? null,
          end_line: n.endLine ?? null,
          source: n.source,
          confidence: n.confidence ?? 1,
          meta: n.meta ? JSON.stringify(n.meta) : null,
          updated_at: now,
        });
      }
    });
  }

  graphUpsertEdges(edges: GraphEdge[]): void {
    if (!edges.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO graph_edges (src, dst, kind, source, confidence, weight, meta, updated_at)
       VALUES (@src, @dst, @kind, @source, @confidence, @weight, @meta, @updated_at)
       ON CONFLICT(src, dst, kind, source) DO UPDATE SET confidence = excluded.confidence,
         weight = excluded.weight, meta = excluded.meta, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    this.transaction(() => {
      for (const e of edges) {
        stmt.run({
          src: e.src,
          dst: e.dst,
          kind: e.kind,
          source: e.source,
          confidence: e.confidence ?? 1,
          weight: e.weight ?? 1,
          meta: e.meta ? JSON.stringify(e.meta) : null,
          updated_at: now,
        });
      }
    });
  }

  graphMergeNodeMeta(
    id: string,
    kind: string,
    name: string,
    source: GraphSource,
    meta: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO graph_nodes (id, kind, name, path, source, confidence, meta, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           meta = CASE WHEN graph_nodes.meta IS NULL THEN excluded.meta ELSE json_patch(graph_nodes.meta, excluded.meta) END,
           updated_at = excluded.updated_at`,
      )
      .run(id, kind, name, kind === "file" ? name : null, source, JSON.stringify(meta), Date.now());
  }

  graphGetNode(id: string): GraphNodeRow | undefined {
    return this.db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as
      | GraphNodeRow
      | undefined;
  }

  graphGetNodes(ids: string[]): GraphNodeRow[] {
    if (!ids.length) return [];
    const out: GraphNodeRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      out.push(
        ...(this.db
          .prepare(`SELECT * FROM graph_nodes WHERE id IN (${slice.map(() => "?").join(",")})`)
          .all(...slice) as GraphNodeRow[]),
      );
    }
    return out;
  }

  graphFindNodes(opts: {
    query?: string | undefined;
    kind?: string | undefined;
    kinds?: string[] | undefined;
    path?: string | undefined;
    pathPrefix?: string | undefined;
    limit?: number | undefined;
  }): GraphNodeRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.query) {
      clauses.push("(name LIKE ? OR id LIKE ?)");
      params.push(`%${opts.query}%`, `%${opts.query}%`);
    }
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    } else if (opts.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.path) {
      clauses.push("path LIKE ?");
      params.push(`%${opts.path}%`);
    }
    if (opts.pathPrefix) {
      clauses.push("path LIKE ? ESCAPE '\\'");
      params.push(`${opts.pathPrefix.replace(/[%_\\]/g, "\\$&")}%`);
    }
    params.push(opts.limit ?? 20);
    return this.db
      .prepare(
        `SELECT * FROM graph_nodes ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, length(name), name LIMIT ?`,
      )
      .all(...params.slice(0, -1), opts.query ?? "", params[params.length - 1]) as GraphNodeRow[];
  }

  graphNodesByKind(kinds: string[]): GraphNodeRow[] {
    if (!kinds.length) return [];
    return this.db
      .prepare(
        `SELECT * FROM graph_nodes WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY path, start_line`,
      )
      .all(...kinds) as GraphNodeRow[];
  }

  graphNodesAtLines(path: string, startLine: number, endLine: number): GraphNodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM graph_nodes WHERE path = ? AND kind != 'file' AND start_line IS NOT NULL
           AND start_line <= ? AND end_line >= ?
         ORDER BY (end_line - start_line) ASC, start_line ASC`,
      )
      .all(path, endLine, startLine) as GraphNodeRow[];
  }

  graphEdgesAll(kinds?: string[]): GraphEdgeRow[] {
    if (kinds?.length) {
      return this.db
        .prepare(`SELECT * FROM graph_edges WHERE kind IN (${kinds.map(() => "?").join(",")})`)
        .all(...kinds) as GraphEdgeRow[];
    }
    return this.db.prepare("SELECT * FROM graph_edges").all() as GraphEdgeRow[];
  }

  graphDanglingEdges(prefix: string): GraphEdgeRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM graph_edges e LEFT JOIN graph_nodes n ON n.id = e.dst
         WHERE n.id IS NULL AND e.dst LIKE ? ESCAPE '\\'`,
      )
      .all(`${prefix.replace(/[%_\\]/g, "\\$&")}%`) as GraphEdgeRow[];
  }

  graphDeleteEdges(edges: Array<Pick<GraphEdge, "src" | "dst" | "kind" | "source">>): void {
    if (!edges.length) return;
    const stmt = this.db.prepare(
      "DELETE FROM graph_edges WHERE src = ? AND dst = ? AND kind = ? AND source = ?",
    );
    this.transaction(() => {
      for (const e of edges) stmt.run(e.src, e.dst, e.kind, e.source);
    });
  }

  graphDegrees(kinds: string[]): Map<string, { fanIn: number; fanOut: number }> {
    const out = new Map<string, { fanIn: number; fanOut: number }>();
    if (!kinds.length) return out;
    const ph = kinds.map(() => "?").join(",");
    const get = (id: string) => {
      let d = out.get(id);
      if (!d) {
        d = { fanIn: 0, fanOut: 0 };
        out.set(id, d);
      }
      return d;
    };
    for (const r of this.db
      .prepare(
        `SELECT dst id, COUNT(DISTINCT src) n FROM graph_edges WHERE kind IN (${ph}) GROUP BY dst`,
      )
      .all(...kinds) as Array<{ id: string; n: number }>) {
      get(r.id).fanIn = r.n;
    }
    for (const r of this.db
      .prepare(
        `SELECT src id, COUNT(DISTINCT dst) n FROM graph_edges WHERE kind IN (${ph}) GROUP BY src`,
      )
      .all(...kinds) as Array<{ id: string; n: number }>) {
      get(r.id).fanOut = r.n;
    }
    return out;
  }

  graphDependentFileCounts(paths: string[], kinds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!paths.length || !kinds.length) return out;
    const kph = kinds.map(() => "?").join(",");
    for (let i = 0; i < paths.length; i += 400) {
      const batch = paths.slice(i, i + 400);
      const pph = batch.map(() => "?").join(",");
      for (const r of this.db
        .prepare(
          `SELECT d.path p, COUNT(DISTINCT s.path) n
             FROM graph_nodes d
             JOIN graph_edges e ON e.dst = d.id AND e.kind IN (${kph})
             JOIN graph_nodes s ON s.id = e.src
            WHERE d.path IN (${pph}) AND s.path IS NOT NULL AND s.path <> d.path
            GROUP BY d.path`,
        )
        .all(...kinds, ...batch) as Array<{ p: string; n: number }>) {
        out.set(r.p, r.n);
      }
    }
    return out;
  }

  private edgesWhere(col: "src" | "dst", ids: string[], kinds?: string[]): GraphEdgeRow[] {
    if (!ids.length) return [];
    const out: GraphEdgeRow[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const slice = ids.slice(i, i + 400);
      const params: unknown[] = [...slice];
      let sql = `SELECT * FROM graph_edges WHERE ${col} IN (${slice.map(() => "?").join(",")})`;
      if (kinds?.length) {
        sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
        params.push(...kinds);
      }
      out.push(...(this.db.prepare(sql).all(...params) as GraphEdgeRow[]));
    }
    return out;
  }

  graphEdgesFrom(ids: string[], kinds?: string[]): GraphEdgeRow[] {
    return this.edgesWhere("src", ids, kinds);
  }

  graphEdgesTo(ids: string[], kinds?: string[]): GraphEdgeRow[] {
    return this.edgesWhere("dst", ids, kinds);
  }

  graphEdgesByKind(kind: string, limit: number): GraphEdgeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM graph_edges WHERE kind = ? ORDER BY weight DESC, confidence DESC LIMIT ?",
      )
      .all(kind, limit) as GraphEdgeRow[];
  }

  graphDeleteForPath(source: GraphSource, path: string, opts: { keepFile?: boolean } = {}): void {
    this.transaction(() => {
      const ids = (
        this.db
          .prepare("SELECT id FROM graph_nodes WHERE source = ? AND path = ?")
          .all(source, path) as Array<{ id: string }>
      ).map((r) => r.id);
      const fileId = `file:${path}`;
      const all = ids.includes(fileId) ? ids : [...ids, fileId];
      // Only edges that originate in this file are re-derived by a re-parse; edges
      // from other files pointing here must survive (they are owned by those files).
      for (let i = 0; i < all.length; i += 400) {
        const slice = all.slice(i, i + 400);
        const ph = slice.map(() => "?").join(",");
        this.db
          .prepare(`DELETE FROM graph_edges WHERE source = ? AND src IN (${ph})`)
          .run(source, ...slice);
      }
      // Every symbol of the file shares the `sym:<path>#` prefix, so this also drops
      // edges whose source node never existed or no longer does (e.g. from a parser bug).
      this.db
        .prepare("DELETE FROM graph_edges WHERE source = ? AND src LIKE ? ESCAPE '\\'")
        .run(source, `sym:${path.replace(/[%_\\]/g, "\\$&")}#%`);
      if (opts.keepFile) {
        this.db
          .prepare("DELETE FROM graph_nodes WHERE source = ? AND path = ? AND kind != 'file'")
          .run(source, path);
      } else {
        this.db.prepare("DELETE FROM graph_nodes WHERE source = ? AND path = ?").run(source, path);
        this.db.prepare("DELETE FROM graph_edges WHERE dst = ? AND source = ?").run(fileId, source);
      }
    });
  }

  graphDeleteBySource(source: GraphSource): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM graph_edges WHERE source = ?").run(source);
      this.db.prepare("DELETE FROM graph_nodes WHERE source = ?").run(source);
    });
  }

  graphCounts(): { nodes: number; edges: number; byKind: Record<string, number> } {
    const nodes = (this.db.prepare("SELECT COUNT(*) n FROM graph_nodes").get() as { n: number }).n;
    const edges = (this.db.prepare("SELECT COUNT(*) n FROM graph_edges").get() as { n: number }).n;
    const byKind: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT kind, COUNT(*) n FROM graph_edges GROUP BY kind")
      .all() as Array<{
      kind: string;
      n: number;
    }>) {
      byKind[r.kind] = r.n;
    }
    return { nodes, edges, byKind };
  }

  graphNodeCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT kind, COUNT(*) n FROM graph_nodes GROUP BY kind")
      .all() as Array<{ kind: string; n: number }>) {
      out[r.kind] = r.n;
    }
    return out;
  }

  graphFileNodes(): GraphNodeRow[] {
    return this.db
      .prepare("SELECT * FROM graph_nodes WHERE kind = 'file' ORDER BY path")
      .all() as GraphNodeRow[];
  }

  // --- graph metrics ------------------------------------------------------

  metricsReplace(rows: GraphMetricInput[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO graph_metrics (node_id, kind, path, fan_in, fan_out, loc, complexity, commits_90d, score, cluster, updated_at)
       VALUES (@node_id, @kind, @path, @fan_in, @fan_out, @loc, @complexity, @commits_90d, @score, @cluster, @updated_at)`,
    );
    const now = Date.now();
    this.transaction(() => {
      this.db.exec("DELETE FROM graph_metrics");
      for (const r of rows)
        stmt.run({ ...r, path: r.path ?? null, cluster: r.cluster ?? null, updated_at: now });
    });
  }

  metricsGet(ids: string[]): GraphMetricRow[] {
    if (!ids.length) return [];
    const out: GraphMetricRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      out.push(
        ...(this.db
          .prepare(
            `SELECT * FROM graph_metrics WHERE node_id IN (${slice.map(() => "?").join(",")})`,
          )
          .all(...slice) as GraphMetricRow[]),
      );
    }
    return out;
  }

  metricsTop(opts: {
    orderBy?: "score" | "fan_in" | "fan_out" | "complexity" | "loc" | "commits_90d" | undefined;
    kind?: string | undefined;
    kinds?: string[] | undefined;
    pathPrefix?: string | undefined;
    cluster?: number | undefined;
    limit?: number | undefined;
  }): GraphMetricRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    } else if (opts.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.pathPrefix) {
      clauses.push("path LIKE ? ESCAPE '\\'");
      params.push(`${opts.pathPrefix.replace(/[%_\\]/g, "\\$&")}%`);
    }
    if (opts.cluster !== undefined) {
      clauses.push("cluster = ?");
      params.push(opts.cluster);
    }
    const order = opts.orderBy ?? "score";
    params.push(opts.limit ?? 20);
    return this.db
      .prepare(
        `SELECT * FROM graph_metrics ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY ${order} DESC, fan_in DESC, node_id LIMIT ?`,
      )
      .all(...params) as GraphMetricRow[];
  }

  metricsCount(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM graph_metrics").get() as { n: number }).n;
  }

  // --- file index & reindex queue ---------------------------------------

  fileIndexGet(path: string): FileIndexRow | undefined {
    return this.db.prepare("SELECT * FROM file_index WHERE path = ?").get(path) as
      | FileIndexRow
      | undefined;
  }

  fileIndexAll(): FileIndexRow[] {
    return this.db.prepare("SELECT * FROM file_index ORDER BY path").all() as FileIndexRow[];
  }

  fileIndexSet(row: FileIndexInput): void {
    this.db
      .prepare(
        `INSERT INTO file_index (path, hash, mtime, size, language, indexed_at, document_id, status, reason, symbols, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime, size = excluded.size,
           language = excluded.language, indexed_at = excluded.indexed_at, document_id = excluded.document_id,
           status = excluded.status, reason = excluded.reason, symbols = excluded.symbols, errors = excluded.errors`,
      )
      .run(
        row.path,
        row.hash,
        row.mtime,
        row.size,
        row.language,
        Date.now(),
        row.document_id,
        row.status ?? "indexed",
        row.reason ?? null,
        row.symbols ?? null,
        row.errors ?? null,
      );
  }

  fileIndexDelete(path: string): void {
    this.db.prepare("DELETE FROM file_index WHERE path = ?").run(path);
  }

  fileIndexSummary(): {
    byStatus: Record<string, number>;
    reasons: Array<{ reason: string; n: number }>;
    lastIndexedAt: number | null;
  } {
    const byStatus: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT status, COUNT(*) n FROM file_index GROUP BY status")
      .all() as Array<{ status: string; n: number }>) {
      byStatus[r.status] = r.n;
    }
    const reasons = this.db
      .prepare(
        "SELECT reason, COUNT(*) n FROM file_index WHERE reason IS NOT NULL GROUP BY reason ORDER BY n DESC LIMIT 10",
      )
      .all() as Array<{ reason: string; n: number }>;
    const last = this.db.prepare("SELECT MAX(indexed_at) t FROM file_index").get() as {
      t: number | null;
    };
    return { byStatus, reasons, lastIndexedAt: last.t ?? null };
  }

  reindexQueueSize(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM reindex_queue").get() as { n: number }).n;
  }

  indexRunStart(scope: string, headSha?: string | null): number {
    const info = this.db
      .prepare("INSERT INTO index_runs (scope, started_at, head_sha) VALUES (?, ?, ?)")
      .run(scope, Date.now(), headSha ?? null);
    // keep the log short
    this.db
      .prepare(
        "DELETE FROM index_runs WHERE id NOT IN (SELECT id FROM index_runs ORDER BY id DESC LIMIT 50)",
      )
      .run();
    return Number(info.lastInsertRowid);
  }

  indexRunFinish(id: number, s: IndexRunSummary): void {
    this.db
      .prepare(
        `UPDATE index_runs SET finished_at = ?, scanned = ?, indexed = ?, unchanged = ?, skipped = ?,
           removed = ?, errors = ?, detail = ? WHERE id = ?`,
      )
      .run(
        Date.now(),
        s.scanned ?? 0,
        s.indexed ?? 0,
        s.unchanged ?? 0,
        s.skipped ?? 0,
        s.removed ?? 0,
        s.errors ?? 0,
        s.detail ?? null,
        id,
      );
  }

  indexRunsRecent(limit: number): IndexRunRow[] {
    return this.db
      .prepare("SELECT * FROM index_runs ORDER BY id DESC LIMIT ?")
      .all(limit) as IndexRunRow[];
  }

  reindexQueuePush(path: string, reason: string): void {
    this.db
      .prepare(
        "INSERT INTO reindex_queue (path, reason, queued_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET queued_at = excluded.queued_at",
      )
      .run(path, reason, Date.now());
  }

  reindexQueueDrain(): string[] {
    // Runs before almost every tool call, and the queue is usually empty: peek with a
    // plain read first so the common case never opens a write transaction.
    const rows = this.prep("SELECT path FROM reindex_queue").all() as Array<{ path: string }>;
    if (!rows.length) return [];
    const paths = rows.map((r) => r.path);
    this.transaction(() => {
      const del = this.prep("DELETE FROM reindex_queue WHERE path = ?");
      for (const p of paths) del.run(p);
    });
    return paths;
  }

  // --- memories ----------------------------------------------------------

  memoryInsert(m: MemoryInput): number {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO memories (kind, content, tags, node_ids, session_id, document_id, created_at,
                               name, path, file_hash, file_mtime, file_size, updated_at, status, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.kind,
        m.content,
        m.tags?.length ? JSON.stringify(m.tags) : null,
        m.nodeIds?.length ? JSON.stringify(m.nodeIds) : null,
        m.sessionId ?? null,
        m.documentId ?? null,
        m.createdAt ?? now,
        m.name ?? null,
        m.path ?? null,
        m.fileHash ?? null,
        m.fileMtime ?? null,
        m.fileSize ?? null,
        m.updatedAt ?? null,
        m.status ?? null,
        m.supersedes ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  memoryList(
    opts: {
      kind?: string | undefined;
      topic?: string | undefined;
      status?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): MemoryRow[] {
    const params: unknown[] = [];
    let where = "1=1";
    if (opts.kind) {
      where += " AND kind = ?";
      params.push(opts.kind);
    }
    if (opts.status) {
      where += " AND COALESCE(status, 'accepted') = ?";
      params.push(opts.status);
    }
    if (opts.topic) {
      where += " AND name LIKE ? ESCAPE '\\'";
      params.push(`${opts.topic.replace(/[%_\\]/g, "\\$&")}/%`);
    }
    params.push(opts.limit ?? 100);
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE ${where} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
      )
      .all(...params) as MemoryRow[];
  }

  memoryGet(id: number): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  }

  memoryGetByName(name: string): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE name = ?").get(name) as
      | MemoryRow
      | undefined;
  }

  memoryUpsertByName(m: MemoryInput & { name: string }): number {
    return this.transaction(() => {
      const existing = this.memoryGetByName(m.name);
      if (!existing) return this.memoryInsert(m);
      this.db
        .prepare(
          `UPDATE memories SET kind = ?, content = ?, tags = ?, node_ids = ?, session_id = COALESCE(?, session_id),
             document_id = ?, path = ?, file_hash = ?, file_mtime = ?, file_size = ?,
             created_at = ?, updated_at = ?, status = ?, supersedes = ?
           WHERE id = ?`,
        )
        .run(
          m.kind,
          m.content,
          m.tags?.length ? JSON.stringify(m.tags) : null,
          m.nodeIds?.length ? JSON.stringify(m.nodeIds) : null,
          m.sessionId ?? null,
          m.documentId ?? null,
          m.path ?? existing.path,
          m.fileHash ?? existing.file_hash,
          m.fileMtime ?? existing.file_mtime,
          m.fileSize ?? existing.file_size,
          m.createdAt ?? existing.created_at,
          m.updatedAt ?? Date.now(),
          m.status ?? null,
          m.supersedes ?? null,
          existing.id,
        );
      return existing.id;
    });
  }

  memoryDelete(id: number): void {
    const row = this.db.prepare("SELECT document_id FROM memories WHERE id = ?").get(id) as
      | { document_id: number | null }
      | undefined;
    this.transaction(() => {
      if (row?.document_id) this.deleteDocument(row.document_id);
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    });
  }

  memoryDeleteByName(name: string): void {
    const row = this.memoryGetByName(name);
    if (row) this.memoryDelete(row.id);
  }

  memoryLegacyRows(): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE name IS NULL ORDER BY created_at")
      .all() as MemoryRow[];
  }

  memoryCount(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM memories").get() as { n: number }).n;
  }

  // --- misc --------------------------------------------------------------

  metaGet(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  metaSet(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  purge(scope: PurgeScope): void {
    this.transaction(() => {
      if (scope === "index" || scope === "all") {
        if (this.vectors) this.db.exec("DELETE FROM chunk_vec");
        this.db.exec(
          "DELETE FROM chunks; DELETE FROM documents; DELETE FROM file_index; DELETE FROM reindex_queue; DELETE FROM fetch_cache;",
        );
        this.db.exec("INSERT INTO chunks_fts_porter(chunks_fts_porter) VALUES ('rebuild')");
        this.db.exec("INSERT INTO chunks_fts_trigram(chunks_fts_trigram) VALUES ('rebuild')");
      }
      if (scope === "sessions" || scope === "all") {
        this.db.exec(
          "DELETE FROM events; DELETE FROM snapshots; DELETE FROM sessions; DELETE FROM stats;",
        );
      }
      if (scope === "graph" || scope === "all") {
        this.db.exec(
          "DELETE FROM graph_edges; DELETE FROM graph_nodes; DELETE FROM graph_metrics;",
        );
      }
      if (scope === "memories" || scope === "all") {
        this.db.exec("DELETE FROM memories;");
        // The index and graph scopes clear their own tables; a memories-only purge must
        // still drop the mirrored documents and memory nodes. The files stay on disk.
        if (scope === "memories") {
          this.deleteDocumentsBySource("memory");
          this.db.exec(
            "DELETE FROM graph_edges WHERE src LIKE 'memory:%' OR dst LIKE 'memory:%'; DELETE FROM graph_nodes WHERE id LIKE 'memory:%';",
          );
        }
      }
    });
    this.db.exec("VACUUM");
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
