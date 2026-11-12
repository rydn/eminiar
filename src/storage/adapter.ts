import type { SwarmStore } from "../swarm/types.js";
import type {
  AdjudicatorStore,
  ApiCallInput,
  ApiCallRow,
  ChunkInput,
  ChunkWithDoc,
  ContextEventInput,
  ContextEventRow,
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
  PlaybookStore,
  PurgeScope,
  RecallSource,
  SearchFilters,
  SessionRow,
  SnapshotRow,
  SourceStatRow,
  StatDelta,
  StatRow,
  StatuslineSnapshotInput,
  StatuslineSnapshotRow,
  ToolUseRow,
  TranscriptFileRow,
  UsageFilter,
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
  /** Agent swarm ledger (runs, tasks, workers, events, blackboard); see src/swarm. */
  readonly swarm: SwarmStore;
  /** Adjudicator decisions, verdict cache, provider breakers and learned bias; see src/adjudicator. */
  readonly adjudicator: AdjudicatorStore;
  /** Playbooks (stored recurring tasks), their runs and suggestions; see src/playbooks. */
  readonly playbooks: PlaybookStore;

  // --- documents & chunks -------------------------------------------------
  /** Insert a document with its chunks. Same uri+hash → returns the existing id with created=false. */
  upsertDocument(doc: DocumentInput, chunks: ChunkInput[]): { id: number; created: boolean };
  getDocument(id: number): DocumentRow | undefined;
  findDocumentByUri(uri: string): DocumentRow | undefined;
  deleteDocument(id: number): void;
  deleteDocumentsBySource(source: string): number;
  /**
   * Rewrite the title, string meta and chunk text of these sources' documents through `mask`, in
   * place (FTS follows; changed chunks are re-embedded), in id order from after `afterId` until
   * `budgetMs` has passed. A document's chunks are masked as the one text they were cut from, so
   * a secret that spans chunks is masked whole; a chunk left with nothing is deleted. Once no
   * document is left, the FTS segments are merged in bounded steps so the old text's tokens leave
   * the index (a run stopped before that leaves the merge to the next). Writes take short IMMEDIATE transactions and
   * throw SQLITE_BUSY when the lock stays taken; call again after a pause. `changed` counts the
   * rows rewritten, `lastId` is the last document done, `wrote` says this call took the write
   * lock (pause before the next), `done` when none are left.
   */
  remaskDocuments(
    sources: string[],
    mask: (text: string) => string,
    afterId: number,
    budgetMs: number,
  ): { changed: number; lastId: number; done: boolean; wrote?: boolean };
  countDocuments(source?: string): number;
  /** Documents of one source, newest first, with chunk counts. */
  documentsBySource(source: string, limit?: number): DocumentSummaryRow[];
  /** Document/chunk totals per source tag starting with `prefix` (`docs:` → every docs source). */
  documentSourceStats(prefix: string): SourceStatRow[];
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
  /**
   * Search the recall index (memories, docs pages or captured errors only). `match` is an FTS5
   * expression; [] on a malformed one, a missing index or one still being backfilled.
   */
  recallSearch(src: RecallSource, match: string, limit: number): FtsHit[];
  /**
   * One slice of the recall index backfill (the chunks stored before the index existed), in a
   * short IMMEDIATE transaction; throws SQLITE_BUSY when the lock stays taken. `done` once the
   * index is complete; from then on recallSearch answers. Hooks call it only through
   * fillRecallIndexBriefly (src/index/indexer.ts), and only those nobody waits on.
   */
  recallBackfillStep(maxRows?: number): { done: boolean; rows: number };
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
  /** Most recently started sessions first. */
  sessionsRecent(limit: number): SessionRow[];
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
    /** Several kinds at once (ignored when `kind` is set). */
    kinds?: string[] | undefined;
    /** Substring of the path. */
    path?: string | undefined;
    /** Exact prefix of the path (a folder). */
    pathPrefix?: string | undefined;
    limit?: number | undefined;
  }): GraphNodeRow[];
  /** All nodes of the given kinds (no limit; used by analysis passes). */
  graphNodesByKind(kinds: string[]): GraphNodeRow[];
  /** Nodes whose [start_line, end_line] overlaps the range, most specific first. */
  graphNodesAtLines(path: string, startLine: number, endLine: number): GraphNodeRow[];
  graphEdgesFrom(ids: string[], kinds?: string[]): GraphEdgeRow[];
  graphEdgesTo(ids: string[], kinds?: string[]): GraphEdgeRow[];
  graphEdgesByKind(kind: string, limit: number): GraphEdgeRow[];
  /** Every edge of the given kinds (used by whole-graph analyses). */
  graphEdgesAll(kinds?: string[]): GraphEdgeRow[];
  /** Edges whose `dst` starts with `prefix` but names no existing node. */
  graphDanglingEdges(prefix: string): GraphEdgeRow[];
  graphDeleteEdges(edges: Array<Pick<GraphEdge, "src" | "dst" | "kind" | "source">>): void;
  /** Distinct-neighbour counts over the given edge kinds: incoming (fan-in) and outgoing (fan-out). */
  graphDegrees(kinds: string[]): Map<string, { fanIn: number; fanOut: number }>;
  /**
   * Per path: how many *other* files depend on that file or a symbol in it over the given edge
   * kinds. Unlike a file's metrics fan-in, calls from inside the file do not count.
   */
  graphDependentFileCounts(paths: string[], kinds: string[]): Map<string, number>;
  /** Delete everything a source produced for one file path (nodes with that path + edges touching them). */
  graphDeleteForPath(source: GraphSource, path: string, opts?: { keepFile?: boolean }): void;
  graphDeleteBySource(source: GraphSource): void;
  graphCounts(): { nodes: number; edges: number; byKind: Record<string, number> };
  /** Node counts per kind. */
  graphNodeCounts(): Record<string, number>;
  graphFileNodes(): GraphNodeRow[];

  // --- graph metrics ------------------------------------------------------
  metricsReplace(rows: GraphMetricInput[]): void;
  metricsGet(ids: string[]): GraphMetricRow[];
  metricsTop(opts: {
    orderBy?: "score" | "fan_in" | "fan_out" | "complexity" | "loc" | "commits_90d" | undefined;
    kind?: string | undefined;
    kinds?: string[] | undefined;
    pathPrefix?: string | undefined;
    cluster?: number | undefined;
    limit?: number | undefined;
  }): GraphMetricRow[];
  metricsCount(): number;

  // --- file index & reindex queue ---------------------------------------
  fileIndexGet(path: string): FileIndexRow | undefined;
  fileIndexAll(): FileIndexRow[];
  fileIndexSet(row: FileIndexInput): void;
  fileIndexDelete(path: string): void;
  /** Row counts per status plus the most common reasons. */
  fileIndexSummary(): {
    byStatus: Record<string, number>;
    reasons: Array<{ reason: string; n: number }>;
    lastIndexedAt: number | null;
  };
  reindexQueuePush(path: string, reason: string): void;
  reindexQueueDrain(): string[];
  reindexQueueSize(): number;
  indexRunStart(scope: string, headSha?: string | null): number;
  indexRunFinish(id: number, summary: IndexRunSummary): void;
  indexRunsRecent(limit: number): IndexRunRow[];

  // --- memories ----------------------------------------------------------
  memoryInsert(m: MemoryInput): number;
  memoryList(opts?: {
    kind?: string | undefined;
    /** Only names under `topic/`. */
    topic?: string | undefined;
    /** Only this lifecycle status (a missing status counts as accepted). */
    status?: string | undefined;
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
  // --- usage: model calls, tool results, context events, statusline ------------
  /**
   * Insert rows; an existing (request_id, message_id) pair keeps the larger of every
   * token count (Claude Code writes a placeholder usage first and the final counts later)
   * and takes the incoming cost when its output count is at least the stored one.
   * Returns the number of rows newly inserted.
   */
  apiCallsUpsert(rows: ApiCallInput[]): number;
  /** Rows matching the filter, oldest first. */
  apiCalls(filter?: UsageFilter): ApiCallRow[];
  /** Newest call timestamp, or undefined when nothing has been ingested. */
  apiCallsLatestTs(): number | undefined;
  /** Insert or update by tool_use_id (a later row with result_chars fills in the result). */
  toolUsesUpsert(rows: ToolUseRow[]): number;
  toolUses(filter?: UsageFilter): ToolUseRow[];
  contextEventInsert(e: ContextEventInput): number;
  contextEvents(filter?: UsageFilter): ContextEventRow[];
  transcriptFileGet(path: string): TranscriptFileRow | undefined;
  transcriptFileSet(row: TranscriptFileRow): void;
  transcriptFiles(): TranscriptFileRow[];
  statuslineSnapshotInsert(s: StatuslineSnapshotInput): number;
  statuslineSnapshots(filter?: UsageFilter): StatuslineSnapshotRow[];
  statuslineLatest(sessionId?: string): StatuslineSnapshotRow | undefined;
  /**
   * Drop snapshots with ts < olderThan and, per session, all but the newest keepPerSession.
   * Returns the number of rows deleted.
   */
  statuslineSnapshotsPrune(opts: { olderThan: number; keepPerSession: number }): number;

  metaGet(key: string): string | undefined;
  metaSet(key: string, value: string): void;
  /** Remove a meta key; returns whether it existed. */
  metaDelete(key: string): boolean;
  purge(scope: PurgeScope): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}
