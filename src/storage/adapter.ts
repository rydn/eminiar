import type {
  ChunkInput,
  ChunkWithDoc,
  DocumentInput,
  DocumentRow,
  EventInput,
  EventRow,
  FileIndexRow,
  FtsHit,
  GraphEdge,
  GraphEdgeRow,
  GraphNode,
  GraphNodeRow,
  GraphSource,
  MemoryInput,
  MemoryRow,
  PurgeScope,
  SearchFilters,
  SessionRow,
  SnapshotRow,
  StatDelta,
  StatRow,
  VecHit,
  VocabTerm,
} from "./types.js";

/** Fields to upsert on a session; undefined leaves the stored value alone. */
export type SessionPatch = { id: string } & { [K in keyof SessionRow]?: SessionRow[K] | undefined };

/**
 * Everything the rest of eminiar needs from a database. Only `sqlite/adapter.ts`
 * contains SQL; a Postgres/pgvector or libSQL adapter would implement this same
 * surface for a team-shared backend.
 */
export interface StorageAdapter {
  // --- documents & chunks -------------------------------------------------
  /** Insert a document with its chunks. Same uri+hash → returns the existing id with created=false. */
  upsertDocument(doc: DocumentInput, chunks: ChunkInput[]): { id: number; created: boolean };
  getDocument(id: number): DocumentRow | undefined;
  findDocumentByUri(uri: string): DocumentRow | undefined;
  deleteDocument(id: number): void;
  deleteDocumentsBySource(source: string): number;
  countDocuments(source?: string): number;
  getChunks(ids: number[]): ChunkWithDoc[];
  chunksOfDocument(documentId: number): ChunkWithDoc[];
  /** Code chunks that make up a symbol's body, in order (empty when the file predates symbol chunks). */
  chunksForSymbol(symbolId: string): ChunkWithDoc[];
  /** Chunk ids whose body matches a JS regular expression, newest documents first. Throws on a bad pattern. */
  chunkRegexSearch(
    pattern: string,
    flags: string,
    limit: number,
    filters?: SearchFilters,
  ): number[];

  // --- lexical search ----------------------------------------------------
  ftsSearch(
    kind: "porter" | "trigram",
    match: string,
    limit: number,
    filters?: SearchFilters,
  ): FtsHit[];
  /** True when the (porter-stemmed) term occurs anywhere in the index. */
  termExists(term: string): boolean;
  /** Vocabulary terms starting with `prefix`, most frequent first. */
  vocabCandidates(prefix: string, limit: number): VocabTerm[];
  /** Top terms by document frequency among the given chunks (for "searchable terms"). */
  topTerms(chunkIds: number[], limit: number): VocabTerm[];

  // --- vectors -----------------------------------------------------------
  vecUpsert(chunkId: number, embedding: Float32Array): void;
  vecSearch(embedding: Float32Array, k: number, filters?: SearchFilters): VecHit[];
  unembeddedChunkIds(limit: number): number[];
  markEmbedded(chunkIds: number[]): void;
  vecCount(): number;

  // --- sessions, events, snapshots, stats --------------------------------
  sessionUpsert(row: SessionPatch): void;
  sessionGet(id: string): SessionRow | undefined;
  sessionLatest(): SessionRow | undefined;
  eventInsert(e: EventInput): number;
  eventsBySession(sessionId: string, opts?: { categories?: string[]; limit?: number }): EventRow[];
  eventsRecent(limit: number, categories?: string[]): EventRow[];
  snapshotInsert(s: { sessionId: string; trigger: string; body: string }): number;
  snapshotLatestUnconsumed(sessionId?: string): SnapshotRow | undefined;
  snapshotMarkConsumed(id: number): void;
  statRecord(sessionId: string, tool: string, d: StatDelta): void;
  statsBySession(sessionId: string): StatRow[];
  statsAll(): StatRow[];

  // --- graph -------------------------------------------------------------
  graphUpsertNodes(nodes: GraphNode[]): void;
  graphUpsertEdges(edges: GraphEdge[]): void;
  /** Merge keys into a node's meta without touching anything else (creates a stub if missing). */
  graphMergeNodeMeta(
    id: string,
    kind: string,
    name: string,
    source: GraphSource,
    meta: Record<string, unknown>,
  ): void;
  graphGetNode(id: string): GraphNodeRow | undefined;
  graphGetNodes(ids: string[]): GraphNodeRow[];
  graphFindNodes(opts: {
    query?: string | undefined;
    kind?: string | undefined;
    path?: string | undefined;
    limit?: number | undefined;
  }): GraphNodeRow[];
  graphEdgesFrom(ids: string[], kinds?: string[]): GraphEdgeRow[];
  graphEdgesTo(ids: string[], kinds?: string[]): GraphEdgeRow[];
  graphEdgesByKind(kind: string, limit: number): GraphEdgeRow[];
  /** Delete everything a source produced for one file path (nodes with that path + edges touching them). */
  graphDeleteForPath(source: GraphSource, path: string, opts?: { keepFile?: boolean }): void;
  graphDeleteBySource(source: GraphSource): void;
  graphCounts(): { nodes: number; edges: number; byKind: Record<string, number> };
  graphFileNodes(): GraphNodeRow[];

  // --- file index & reindex queue ---------------------------------------
  fileIndexGet(path: string): FileIndexRow | undefined;
  fileIndexAll(): FileIndexRow[];
  fileIndexSet(row: Omit<FileIndexRow, "indexed_at">): void;
  fileIndexDelete(path: string): void;
  reindexQueuePush(path: string, reason: string): void;
  reindexQueueDrain(): string[];

  // --- memories ----------------------------------------------------------
  memoryInsert(m: MemoryInput): number;
  memoryList(opts?: {
    kind?: string | undefined;
    /** Only names under `topic/`. */
    topic?: string | undefined;
    limit?: number | undefined;
  }): MemoryRow[];
  memoryGet(id: number): MemoryRow | undefined;
  memoryGetByName(name: string): MemoryRow | undefined;
  /** Insert or update the row mirroring a named memory file; returns its id. */
  memoryUpsertByName(m: MemoryInput & { name: string }): number;
  memoryDelete(id: number): void;
  /** Delete the row and its indexed document (the file is the caller's business). */
  memoryDeleteByName(name: string): void;
  /** Rows from before memories lived in files (name IS NULL), oldest first. */
  memoryLegacyRows(): MemoryRow[];
  memoryCount(): number;

  // --- misc --------------------------------------------------------------
  metaGet(key: string): string | undefined;
  metaSet(key: string, value: string): void;
  purge(scope: PurgeScope): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}
