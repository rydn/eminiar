import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { getContext, type ProjectContext } from "../context.js";
import {
  type AddInput,
  addDocSources,
  addPicked,
  formatAdd,
  type Pick,
  removeDocSource,
} from "../docs/add.js";
import { type CatalogEntry, catalogForProvider, mergedCatalog } from "../docs/catalog.js";
import { docCategory } from "../docs/category.js";
import { type DiscoverOptions, discoverDocs } from "../docs/discover.js";
import { DOCS_PREFIX, docsTag, manifestPath, readManifest, syncState } from "../docs/manifest.js";
import { resolveProvider } from "../docs/resolve.js";
import { formatSync, syncSources } from "../docs/sync.js";
import { embeddingStatus, kickEmbedding, vectorRanker } from "../embeddings/queue.js";
import { nodeLabel } from "../graph/format.js";
import { fileId, fileOf, parseId } from "../graph/ids.js";
import { coupled, dependencies, hotspots, impact, neighbors, orphans } from "../graph/query.js";
import { fullDoctor } from "../install/doctor.js";
import {
  gitignoreHint,
  isStatus,
  list,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  memoriesDir,
  read,
  reconcile,
  remove,
  rename,
  setMeta,
  write,
} from "../memory/store.js";
import { paths } from "../paths.js";
import { search } from "../search/pipeline.js";
import { getCurrentSession } from "../session/current.js";
import { globalDb } from "../stats/global.js";
import { summarize } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { SqliteAdapter } from "../storage/sqlite/adapter.js";
import type { GraphEdgeRow, GraphNodeRow, MemoryStatus, StatRow } from "../storage/types.js";
import { emIndex } from "../tools/em_index.js";
import { emPurge } from "../tools/em_purge.js";
import { sourceFilter } from "../tools/em_search.js";
import {
  LIMIT_DEFAULT,
  loadUsage,
  parseLimit,
  parseSince,
  recentlyIngested,
  sortInsights,
  USAGE_VIEWS,
  type UsageScope,
  type UsageView,
  usageView,
} from "../tools/em_usage.js";
import type { ToolResult } from "../tools/types.js";
import { contextTimeline, topToolConsumers, totals } from "../usage/aggregate.js";
import { usageEnabled } from "../usage/ingest.js";
import { detectInsights, loadInsightInput } from "../usage/insights.js";

/** Every project that has a database under ~/.eminiar/projects, with its root when known. */
export function listProjects(): Array<{ id: string; root: string | null }> {
  const dir = paths().projects;
  const out: Array<{ id: string; root: string | null }> = [];
  for (const id of readdirSync(dir, { withFileTypes: true })) {
    if (!id.isDirectory()) continue;
    const db = join(dir, id.name, "eminiar.db");
    try {
      const a = new SqliteAdapter(db, { vectors: false });
      out.push({ id: id.name, root: a.sessionLatest()?.project_root ?? null });
      a.close();
    } catch {
      // skip unreadable
    }
  }
  return out;
}

export function ctxFor(root?: string): ProjectContext {
  return getContext(root);
}

// --- stats ---------------------------------------------------------------

function groupBySession(rows: StatRow[]): Map<string, StatRow[]> {
  const m = new Map<string, StatRow[]>();
  for (const r of rows) {
    const arr = m.get(r.session_id) ?? [];
    arr.push(r);
    m.set(r.session_id, arr);
  }
  return m;
}

export function statsPayload(ctx: ProjectContext) {
  const db = getStorage(ctx);
  const sessionId = getCurrentSession(ctx);
  const g = globalDb();
  const onboardingDir = join(memoriesDir(ctx), "onboarding");
  const onboarding = existsSync(onboardingDir)
    ? readdirSync(onboardingDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
    : [];
  return {
    project: ctx.root,
    projectId: ctx.id,
    dbPath: ctx.dbPath,
    session: {
      id: sessionId,
      ...summarize(db.statsBySession(sessionId)),
      tools: db.statsBySession(sessionId),
    },
    projectTotals: summarize(db.statsAll()),
    lifetime: { ...summarize(g.lifetime()), tools: g.lifetime() },
    daily: g.daily(30).reverse(),
    index: {
      documents: db.countDocuments(),
      bySource: {
        ...Object.fromEntries(
          ["exec", "batch", "file", "url", "code", "memory", "session", "inline"].map((s) => [
            s,
            db.countDocuments(s),
          ]),
        ),
        docs: db.documentSourceStats(DOCS_PREFIX).reduce((n, s) => n + s.documents, 0),
      },
      vectors: db.vecCount(),
      pendingEmbeddings: db.unembeddedChunkIds(1).length > 0,
      embeddings: embeddingStatus(ctx, db),
      memories: db.memoryCount(),
      graph: db.graphCounts(),
    },
    memoriesDir: ctx.config.memories.dir,
    onboarding,
    routing: ctx.config.routing.mode,
    sessions: sessionsPayload(ctx, 8),
  };
}

export function sessionsPayload(ctx: ProjectContext, limit: number) {
  const db = getStorage(ctx);
  const byId = groupBySession(db.statsAll());
  const current = getCurrentSession(ctx);
  return db.sessionsRecent(limit).map((s) => ({
    id: s.id,
    current: s.id === current,
    started_at: s.started_at,
    ended_at: s.ended_at,
    source: s.source,
    last_prompt: s.last_prompt,
    ...summarize(byId.get(s.id) ?? []),
  }));
}

// --- search --------------------------------------------------------------

export async function searchPayload(
  ctx: ProjectContext,
  q: string,
  mode: "hybrid" | "lexical" | "semantic" | "regex",
  limit: number,
  source?: string,
) {
  const db = getStorage(ctx);
  const vectorSearch =
    mode === "lexical" || mode === "regex" ? undefined : await vectorRanker(ctx, db);
  const r = await search(db, q, {
    limit,
    mode,
    vectorSearch,
    ...(source ? { filters: sourceFilter(source) } : {}),
  });
  return {
    query: r.query,
    used: r.used,
    corrections: r.corrections,
    hits: r.hits.map((h) => ({
      title: h.chunk.title,
      source: h.chunk.document.source,
      uri: h.chunk.document.uri,
      doc: h.chunk.document_id,
      chunk: h.chunk.ord,
      lines: h.chunk.start_line ? `${h.chunk.start_line}-${h.chunk.end_line}` : null,
      symbol: h.chunk.symbol_id,
      created: h.chunk.document.created_at,
      score: h.score,
      snippet: h.snippet,
    })),
  };
}

// --- memories ------------------------------------------------------------

export const memoryKinds = [...MEMORY_KINDS];

export function memoriesPayload(
  ctx: ProjectContext,
  opts: { kind?: string | undefined; topic?: string | undefined; status?: string | undefined } = {},
) {
  const db = getStorage(ctx);
  const summary = reconcile(ctx, db);
  const rows = list(ctx, db, {
    kind: opts.kind,
    topic: opts.topic,
    status: opts.status,
    limit: 1000,
  }).map((r) => ({
    id: r.id,
    name: r.name,
    topic: r.name?.includes("/") ? r.name.split("/")[0] : "",
    kind: r.kind,
    status: r.status,
    supersedes: r.supersedes,
    content: r.content,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    related: r.node_ids ? (JSON.parse(r.node_ids) as string[]) : [],
    path: r.path,
    size: r.file_size,
    created_at: r.created_at,
    updated_at: r.updated_at ?? r.created_at,
  }));
  const topics = [...new Set(rows.map((r) => r.topic).filter(Boolean))].sort();
  return {
    dir: ctx.config.memories.dir,
    kinds: memoryKinds,
    statuses: [...MEMORY_STATUSES],
    topics,
    skipped: summary.skipped,
    gitignored: !!gitignoreHint(ctx),
    memories: rows,
  };
}

export function setMemoryStatus(ctx: ProjectContext, name: string, status: string) {
  if (!isStatus(status)) throw new Error(`invalid status "${status}"`);
  const db = getStorage(ctx);
  if (!setMeta(ctx, db, name, { status })) throw new Error(`memory "${name}" does not exist`);
  return { name, status };
}

export function memoryBody(ctx: ProjectContext, name: string) {
  const m = read(ctx, getStorage(ctx), name);
  return m ? { ...m, row: undefined } : undefined;
}

export interface MemoryWrite {
  kind?: string | undefined;
  content: string;
  name?: string | undefined;
  tags?: string[] | undefined;
  related?: string[] | undefined;
  status?: string | undefined;
  supersedes?: string | undefined;
}

function statusOf(s: string | undefined): MemoryStatus | undefined {
  if (s === undefined || s === "") return undefined;
  if (!isStatus(s)) throw new Error(`invalid status "${s}"`);
  return s;
}

export function addMemory(ctx: ProjectContext, input: MemoryWrite) {
  const db = getStorage(ctx);
  reconcile(ctx, db);
  const r = write(ctx, db, {
    kind: input.kind ?? "fact",
    content: input.content,
    name: input.name,
    tags: input.tags,
    related: input.related,
    sessionId: "dashboard",
    status: statusOf(input.status),
    supersedes: input.supersedes,
  });
  kickEmbedding(ctx, db);
  return { id: r.row.id, name: r.name, path: r.path, created: r.created, superseded: r.superseded };
}

/** Replace the whole memory (body, kind, tags, related, status); the created date is kept. */
export function updateMemory(ctx: ProjectContext, name: string, input: MemoryWrite) {
  const db = getStorage(ctx);
  const prev = read(ctx, db, name);
  if (!prev) throw new Error(`memory "${name}" does not exist`);
  const r = write(ctx, db, {
    name,
    kind: input.kind ?? prev.kind,
    content: input.content,
    tags: input.tags ?? prev.tags,
    related: input.related ?? prev.related,
    replace: true,
    sessionId: "dashboard",
    status:
      statusOf(input.status) ?? (prev.status && isStatus(prev.status) ? prev.status : undefined),
    supersedes: input.supersedes ?? prev.supersedes,
  });
  kickEmbedding(ctx, db);
  return { id: r.row.id, name: r.name, path: r.path, superseded: r.superseded };
}

export function renameMemory(ctx: ProjectContext, from: string, to: string) {
  const db = getStorage(ctx);
  const r = rename(ctx, db, from, to);
  return { name: to, ...r };
}

/** By row id (old UI) or by name; file-backed memories lose their file too. */
export function deleteMemory(ctx: ProjectContext, ref: number | string) {
  const db = getStorage(ctx);
  if (typeof ref === "string") return remove(ctx, db, ref);
  const row = db.memoryGet(ref);
  if (row?.name) return remove(ctx, db, row.name);
  db.memoryDelete(ref);
  return !!row;
}

// --- documentation -------------------------------------------------------

export function docsPayload(ctx: ProjectContext) {
  const db = getStorage(ctx);
  const m = readManifest(ctx);
  const stats = new Map(db.documentSourceStats(DOCS_PREFIX).map((s) => [s.source, s]));
  const catalog = mergedCatalog(ctx.config.docs.catalog as CatalogEntry[]);
  const sources = m.sources.map((s) => {
    const st = stats.get(docsTag(s.name));
    return {
      ...s,
      category: docCategory(s, s.provider ? catalogForProvider(s.provider, catalog) : undefined),
      documents: st?.documents ?? 0,
      chunks: st?.chunks ?? 0,
      latest: st?.latest ?? null,
      sync: syncState(db, s.name) ?? null,
    };
  });
  const known = new Set(m.sources.map((s) => docsTag(s.name)));
  const orphans = [...stats.values()]
    .filter((s) => !known.has(s.source))
    .map((s) => ({ source: s.source, documents: s.documents, chunks: s.chunks }));
  return {
    manifest: relative(ctx.root, manifestPath(ctx)),
    sources,
    orphans,
    totals: {
      documents: sources.reduce((n, s) => n + s.documents, 0),
      chunks: sources.reduce((n, s) => n + s.chunks, 0),
    },
    catalog: catalog.length,
    config: { ttlHours: ctx.config.docs.ttlHours, crawl: ctx.config.docs.crawl },
  };
}

export function docsPagesPayload(ctx: ProjectContext, name: string, limit = 200) {
  return getStorage(ctx).documentsBySource(docsTag(name), limit);
}

export function docsDiscoverPayload(ctx: ProjectContext, opts: DiscoverOptions) {
  return discoverDocs(ctx, opts);
}

export interface DocsAddBody {
  sources?: AddInput[] | undefined;
  pick?: Pick | undefined;
  names?: string[] | undefined;
  includeDev?: boolean | undefined;
  sync?: boolean | undefined;
  force?: boolean | undefined;
}

export async function docsAddPayload(ctx: ProjectContext, body: DocsAddBody) {
  const db = getStorage(ctx);
  const o = body.pick
    ? await addPicked(ctx, db, body.pick, {
        names: body.names,
        includeDev: body.includeDev,
        sync: body.sync,
        force: body.force,
      })
    : await addDocSources(ctx, db, body.sources ?? [], { sync: body.sync, force: body.force });
  return { ...o, text: formatAdd(o) };
}

export async function docsSyncPayload(
  ctx: ProjectContext,
  names: string[] | undefined,
  force: boolean,
) {
  const results = await syncSources(ctx, getStorage(ctx), names?.length ? names : undefined, {
    force,
  });
  return { results, text: formatSync(results) };
}

export function docsRemovePayload(ctx: ProjectContext, name: string) {
  return removeDocSource(ctx, getStorage(ctx), name);
}

export function docsResolvePayload(ctx: ProjectContext, provider: string) {
  return resolveProvider(provider, {
    catalog: mergedCatalog(ctx.config.docs.catalog as CatalogEntry[]),
  });
}

// --- graph ---------------------------------------------------------------

export interface VisNode {
  id: string;
  label: string;
  kind: string;
  path: string | null;
  root?: boolean | undefined;
  /** Only for file nodes with git signals. */
  commits?: number | undefined;
}
export interface VisEdge {
  src: string;
  dst: string;
  kind: string;
  weight: number;
}

function visNode(n: GraphNodeRow | undefined, id: string, root = false): VisNode {
  const meta = n?.meta ? (JSON.parse(n.meta) as { commits?: number }) : {};
  return {
    id,
    label: n ? (n.kind === "file" ? n.name : n.name) : id,
    kind: n?.kind ?? id.split(":")[0] ?? "?",
    path: n?.path ?? null,
    root,
    commits: meta.commits,
  };
}

function visEdges(edges: GraphEdgeRow[]): VisEdge[] {
  return edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, weight: e.weight }));
}

/** Upper bound on edges read per kind for the project map. */
const MAP_EDGES_PER_KIND = 50_000;

/**
 * The file-level map of the project: every tree-sitter file node and the edges of
 * `kinds` between them (default `imports` + `co_changes`). Symbol-level edges
 * (`calls`, `references`, `extends`, …) are lifted to the files that hold their
 * endpoints, so the map answers "which files call which"; edges that collapse onto
 * one file (`defines`, intra-file calls) drop out. Packages are folded away so the
 * picture stays about the repo; other endpoints (memories, routes) are kept as
 * extra nodes. Capped at `limit` files by degree.
 */
export function graphMap(
  ctx: ProjectContext,
  opts: {
    limit?: number | undefined;
    kinds?: string[] | undefined;
    coChanges?: boolean | undefined;
    pathFilter?: string | undefined;
  } = {},
) {
  const db = getStorage(ctx);
  const limit = opts.limit ?? 150;
  let files = db.graphFileNodes();
  if (opts.pathFilter)
    files = files.filter((f) => (f.path ?? f.name).includes(opts.pathFilter as string));
  const fileSet = new Set(files.map((f) => f.id));
  const kinds = opts.kinds ?? (opts.coChanges === false ? ["imports"] : ["imports", "co_changes"]);

  // A file or symbol becomes its file; a package is folded away; anything else
  // (memory, route, concept) stays as its own node.
  const lift = (id: string): string | undefined => {
    const kind = parseId(id).kind;
    if (kind === "file" || kind === "sym") {
      const rel = fileOf(id);
      const f = rel === undefined ? undefined : fileId(rel);
      return f && fileSet.has(f) ? f : undefined;
    }
    return kind === "pkg" ? undefined : id;
  };

  const merged = new Map<string, VisEdge>();
  for (const kind of kinds) {
    for (const e of db.graphEdgesByKind(kind, MAP_EDGES_PER_KIND)) {
      if (kind === "co_changes" && e.weight < 0.3) continue;
      const src = lift(e.src);
      const dst = lift(e.dst);
      if (!src || !dst || src === dst) continue;
      if (!fileSet.has(src) && !fileSet.has(dst)) continue;
      const key =
        kind === "co_changes" ? `${[src, dst].sort().join("|")}|co` : `${src}|${dst}|${kind}`;
      const prev = merged.get(key);
      // co_changes keeps its strength (it drives line width); lifted edges count occurrences.
      if (prev)
        prev.weight = kind === "co_changes" ? Math.max(prev.weight, e.weight) : prev.weight + 1;
      else merged.set(key, { src, dst, kind, weight: kind === "co_changes" ? e.weight : 1 });
    }
  }

  const degree = new Map<string, number>();
  for (const e of merged.values()) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  const keep = new Set(
    [...files]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, limit)
      .map((f) => f.id),
  );
  const edges: VisEdge[] = [];
  const extra = new Set<string>();
  for (const e of merged.values()) {
    const srcOk = keep.has(e.src) || (!fileSet.has(e.src) && keep.has(e.dst));
    const dstOk = keep.has(e.dst) || (!fileSet.has(e.dst) && keep.has(e.src));
    if (!srcOk || !dstOk) continue;
    if (!keep.has(e.src)) extra.add(e.src);
    if (!keep.has(e.dst)) extra.add(e.dst);
    edges.push(e);
  }
  const extraRows = new Map(db.graphGetNodes([...extra]).map((n) => [n.id, n]));
  return {
    mode: "map",
    total: files.length,
    nodes: [
      ...files.filter((f) => keep.has(f.id)).map((f) => visNode(f, f.id)),
      ...[...extra].map((id) => visNode(extraRows.get(id), id)),
    ],
    edges,
  };
}

/** Undirected neighbourhood around a node as nodes + edges, for the force layout. */
export function graphSubgraph(
  ctx: ProjectContext,
  ref: string,
  opts: {
    depth?: number | undefined;
    limit?: number | undefined;
    kinds?: string[] | undefined;
  } = {},
) {
  const db = getStorage(ctx);
  const r = neighbors(db, ref, opts.depth ?? 1, opts.kinds);
  if (!r) return { error: "unknown node" };
  const limit = opts.limit ?? 120;
  const nodeMap = new Map(r.nodes.map((n) => [n.id, n]));
  // keep the root plus the highest-weight edges
  const edges = [...r.edges].sort((a, b) => b.weight * b.confidence - a.weight * a.confidence);
  const keep = new Set<string>([r.root.id]);
  const out: GraphEdgeRow[] = [];
  for (const e of edges) {
    const grows = Number(!keep.has(e.src)) + Number(!keep.has(e.dst));
    if (keep.size + grows > limit) continue;
    keep.add(e.src);
    keep.add(e.dst);
    out.push(e);
  }
  return {
    mode: "subgraph",
    root: r.root.id,
    rootLabel: nodeLabel(r.root, r.root.id),
    truncated: r.nodes.length > keep.size,
    nodes: [...keep].map((id) => visNode(nodeMap.get(id), id, id === r.root.id)),
    edges: visEdges(out),
  };
}

export function graphPayload(ctx: ProjectContext, node: string, mode: string, limit: number) {
  const db = getStorage(ctx);
  if (mode === "hotspots") return { preset: mode, rows: hotspots(db, limit) };
  if (mode === "coupled") return { preset: mode, rows: coupled(db, limit) };
  if (mode === "orphans") return { preset: mode, rows: orphans(db, limit) };
  if (mode === "find")
    return {
      preset: mode,
      rows: db
        .graphFindNodes({ query: node, limit })
        .map((n) => ({ id: n.id, label: nodeLabel(n, n.id), kind: n.kind, path: n.path })),
    };
  if (mode === "dependencies") {
    const r = dependencies(db, node);
    return r
      ? {
          root: r.root.id,
          rootLabel: nodeLabel(r.root, r.root.id),
          hits: r.hits.slice(0, limit).map((h) => ({
            id: h.id,
            label: nodeLabel(h.node, h.id),
            kind: h.node?.kind ?? "?",
            score: h.score,
            reasons: h.reasons,
          })),
        }
      : { error: "unknown node" };
  }
  if (mode === "neighbors") {
    const r = neighbors(db, node);
    if (!r) return { error: "unknown node" };
    const nodes = new Map(r.nodes.map((n) => [n.id, n]));
    return {
      root: r.root.id,
      rootLabel: nodeLabel(r.root, r.root.id),
      edges: r.edges.slice(0, limit).map((e) => ({
        src: nodeLabel(nodes.get(e.src), e.src),
        kind: e.kind,
        dst: nodeLabel(nodes.get(e.dst), e.dst),
        weight: e.weight,
      })),
    };
  }
  const r = impact(db, node);
  return r
    ? {
        root: r.root.id,
        rootLabel: nodeLabel(r.root, r.root.id),
        hits: r.hits.slice(0, limit).map((h) => ({
          id: h.id,
          label: nodeLabel(h.node, h.id),
          kind: h.node?.kind ?? "?",
          score: h.score,
          reasons: h.reasons,
        })),
      }
    : { error: "unknown node" };
}

// --- sessions & events ---------------------------------------------------

export function eventsPayload(
  ctx: ProjectContext,
  opts: { limit: number; session?: string | undefined; categories?: string[] | undefined },
) {
  const db = getStorage(ctx);
  const rows = opts.session
    ? db.eventsBySession(opts.session, {
        limit: opts.limit,
        ...(opts.categories ? { categories: opts.categories } : {}),
      })
    : db.eventsRecent(opts.limit, opts.categories);
  return rows.map((e) => ({
    id: e.id,
    ts: e.ts,
    session: e.session_id,
    category: e.category,
    priority: e.priority,
    tool: e.tool,
    document: e.document_id,
    payload: JSON.parse(e.payload) as unknown,
  }));
}

// --- usage ---------------------------------------------------------------

export const usageViews: readonly string[] = USAGE_VIEWS;

/** Session ids as Claude Code writes them (UUIDs) or as tests seed them; no path tricks. */
const SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/;
export const isUsageSessionId = (s: string): boolean => SESSION_ID.test(s) && !s.includes("..");

/**
 * One em_usage view as JSON (`/api/usage`). `since` is an ISO date or a relative value
 * (`30d`); an unknown view, scope, session id, `since` or `limit` throws so the route can
 * answer 400. The transcript ingest runs at most once per request, and not at all when the
 * same project was ingested within the last few seconds (the dashboard fires several
 * requests per range change).
 */
export function usagePayload(
  ctx: ProjectContext,
  opts: {
    view?: string | undefined;
    scope?: string | undefined;
    session?: string | undefined;
    since?: string | undefined;
    limit?: number | string | undefined;
  },
) {
  const view = (opts.view ?? "summary") as UsageView;
  if (!USAGE_VIEWS.includes(view)) throw new Error(`unknown view "${opts.view}"`);
  if (opts.scope !== undefined && opts.scope !== "session" && opts.scope !== "project")
    throw new Error(`unknown scope "${opts.scope}": use session or project`);
  if (opts.session !== undefined && !isUsageSessionId(opts.session))
    throw new Error("invalid session id");
  const limit = parseLimit(opts.limit);
  if (typeof limit === "string") throw new Error(limit);
  const scope: UsageScope = opts.scope === "session" || opts.session ? "session" : "project";
  const since = parseSince(opts.since);
  const data = loadUsage(ctx, { scope, sessionId: opts.session, since });
  return {
    view,
    scope,
    enabled: usageEnabled(ctx),
    sessionId: data.sessionId,
    since: since ?? null,
    ...usageView(ctx, view, data, limit ?? LIMIT_DEFAULT),
  };
}

/**
 * `/api/usage/session?id=`: the context timeline, tool consumers and insights of one
 * session. The per-call rows are large and the dashboard never reads them, so they are only
 * included with `calls: true` (`?calls=1`). The ingest is skipped when the project (or this
 * session) was ingested within the guard window, which is the case right after `/api/usage`.
 */
export function usageSessionPayload(
  ctx: ProjectContext,
  id: string,
  opts: { calls?: boolean | undefined; ingest?: boolean | undefined } = {},
) {
  if (!isUsageSessionId(id)) throw new Error("invalid session id");
  const ingest = opts.ingest ?? !recentlyIngested(ctx.root, id);
  const data = loadUsage(ctx, { scope: "session", sessionId: id, ingest });
  const db = getStorage(ctx);
  const timeline = contextTimeline(data.calls, data.contextEvents);
  const r = detectInsights(loadInsightInput(db, ctx, { sessionId: id, now: data.now }));
  return {
    session: id,
    totals: totals(data.calls),
    timeline,
    ...(opts.calls
      ? {
          calls: data.calls.map((c) => ({
            ts: c.ts,
            requestId: c.request_id,
            model: c.model,
            agentId: c.agent_id,
            sidechain: !!c.sidechain,
            input: c.input_tokens,
            output: c.output_tokens,
            cacheRead: c.cache_read,
            cacheWrite: c.cache_create_5m + c.cache_create_1h,
            thinking: c.thinking_tokens,
            costUsd: c.cost_usd,
            priced: !!c.priced,
            speed: c.speed,
            effort: c.effort,
            stopReason: c.stop_reason,
          })),
        }
      : {}),
    contextEvents: data.contextEvents,
    toolUses: topToolConsumers(data.toolUses, 20),
    insights: sortInsights(r.insights),
    scores: r.scores,
    snapshot: data.snapshot ?? null,
  };
}

// --- doctor & actions ----------------------------------------------------

export async function doctorPayload(fix = false) {
  return fullDoctor({ fix });
}

export type ActionName =
  | "reindex"
  | "index"
  | "purge"
  | "doctor"
  | "embed"
  | "reconcile"
  | "purge-fetch-cache";

export interface ActionInput {
  action: ActionName;
  scope?: string | undefined;
  full?: boolean | undefined;
  /** reindex: only these files (code scope). */
  paths?: string[] | undefined;
  path?: string | undefined;
  glob?: string[] | undefined;
  source?: string | undefined;
  confirm?: boolean | undefined;
  fix?: boolean | undefined;
}

function toolText(r: ToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}

/**
 * Mutating operations the dashboard exposes. Each returns a plain-text report the
 * page shows in its action log. Purge needs `confirm` exactly like em_purge.
 */
export async function runAction(
  ctx: ProjectContext,
  input: ActionInput,
): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = Date.now();
  const done = (ok: boolean, output: string) => ({ ok, output, ms: Date.now() - started });
  switch (input.action) {
    case "reindex": {
      const { emReindex } = await import("../tools/em_graph.js");
      const scope = (input.scope ?? "all") as "all";
      const paths = input.paths?.length ? input.paths.map(String).filter(Boolean) : undefined;
      const r = await emReindex.handler({ scope, full: !!input.full, paths }, ctx);
      return done(!r.isError, toolText(r));
    }
    case "embed": {
      const { emReindex } = await import("../tools/em_graph.js");
      const r = await emReindex.handler({ scope: "embeddings" }, ctx);
      return done(!r.isError, toolText(r));
    }
    case "index": {
      if (!input.path?.trim()) return done(false, "path required");
      const r = await emIndex.handler(
        {
          path: input.path.trim(),
          glob: input.glob?.length ? input.glob : undefined,
          source: input.source || undefined,
        },
        ctx,
      );
      return done(!r.isError, toolText(r));
    }
    case "reconcile": {
      const s = reconcile(ctx, getStorage(ctx));
      return done(
        true,
        `memories: ${s.files} files, ${s.synced} synced, ${s.removed} removed, ${s.migrated} migrated${s.skipped.length ? `, skipped: ${s.skipped.join(", ")}` : ""}`,
      );
    }
    case "purge": {
      if (!input.confirm) return done(false, "refusing to purge without confirm");
      const scope = input.scope as "index" | "sessions" | "graph" | "memories" | "all" | undefined;
      if (!scope) return done(false, "scope required");
      const r = await emPurge.handler({ scope, confirm: true }, ctx);
      return done(!r.isError, toolText(r));
    }
    case "purge-fetch-cache": {
      globalDb().purgeCache();
      return done(true, "fetch cache emptied");
    }
    case "doctor": {
      const checks = await fullDoctor({ fix: !!input.fix });
      const bad = checks.filter((c) => !c.ok);
      return done(
        bad.length === 0,
        checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n"),
      );
    }
    default:
      return done(false, `unknown action ${String(input.action)}`);
  }
}
