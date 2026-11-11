import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { overview as fileSymbols, isExported } from "../code/symbols.js";
import type { ProjectContext } from "../context.js";
import { within } from "../docs/manifest.js";
import { ASPECTS, type Aspect, architecture } from "../graph/architecture.js";
import { detectChanges } from "../graph/changes.js";
import { nodeLabel } from "../graph/format.js";
import { fileId } from "../graph/ids.js";
import { readClusters, readCycles } from "../graph/metrics.js";
import {
  path as graphPath,
  hotspots,
  impact,
  neighbors,
  pattern,
  resolveNode,
  routes,
} from "../graph/query.js";
import { indexFreshness, MAX_CODE_BYTES } from "../graph/reindex.js";
import { loadPermissionRules } from "../permissions/settings.js";
import { readRefusal } from "../sandbox/file.js";
import { getStorage } from "../storage/index.js";
import type { GraphEdgeRow, GraphNodeRow } from "../storage/types.js";
import { indexStatus } from "../tools/em_index_status.js";
import { version } from "../version.js";

/** Graph node as the frontend draws it. */
export interface VisNode {
  id: string;
  label: string;
  kind: string;
  path: string | null;
  line: number | null;
  root?: boolean | undefined;
  score?: number | undefined;
  exported?: boolean | undefined;
}
export interface VisEdge {
  src: string;
  dst: string;
  kind: string;
  weight: number;
  confidence: number;
  count?: number | undefined;
  lines?: number[] | undefined;
}

function metaOf(row: { meta: string | null } | undefined): Record<string, unknown> {
  if (!row?.meta) return {};
  try {
    return JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function vis(n: GraphNodeRow | undefined, id: string, root = false): VisNode {
  const m = metaOf(n);
  return {
    id,
    label: n?.name ?? id.replace(/^[a-z]+:/, ""),
    kind: n?.kind ?? (id.split(":")[0] || "?"),
    path: n?.path ?? null,
    line: n?.start_line ?? null,
    root,
    exported: m.exported === true,
  };
}

function visEdge(e: GraphEdgeRow): VisEdge {
  const m = metaOf(e) as { count?: number; lines?: number[] };
  return {
    src: e.src,
    dst: e.dst,
    kind: e.kind,
    weight: e.weight,
    confidence: e.confidence,
    count: m.count,
    lines: m.lines,
  };
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// --- status, tree, files --------------------------------------------------------

export function statusPayload(ctx: ProjectContext) {
  const db = getStorage(ctx);
  const s = indexStatus(ctx, db);
  const state = !s.graph.nodes
    ? "empty"
    : s.freshness.dirty.length || s.freshness.queued
      ? "stale"
      : "fresh";
  return { version: version(), root: ctx.root, id: ctx.id, state, ...s };
}

export function treePayload(ctx: ProjectContext) {
  const db = getStorage(ctx);
  const metrics = new Map(db.metricsTop({ kind: "file", limit: 100_000 }).map((m) => [m.path, m]));
  const files = db.fileIndexAll().map((r) => {
    const m = metrics.get(r.path);
    return {
      path: r.path,
      status: r.status,
      reason: r.reason,
      language: r.language,
      symbols: r.symbols ?? 0,
      size: r.size ?? 0,
      score: m?.score ?? 0,
      fanIn: m?.fan_in ?? 0,
      loc: m?.loc ?? 0,
      cluster: m?.cluster ?? null,
    };
  });
  return { root: ctx.root, files };
}

/**
 * Project file for the source viewer; refuses paths outside the root (including via symlinks)
 * and paths a Claude Code Read deny or ask rule matches, checked as em_execute_file does.
 */
export function filePayload(ctx: ProjectContext, rel: string) {
  const clean = rel.replace(/^\.\//, "");
  const abs = resolve(ctx.root, clean);
  // within(): `..` as a whole segment and an absolute relative path (another drive), not a
  // name that merely starts with `..` such as `..notes.md`.
  if (!within(abs, ctx.root)) throw new Error("path outside the project");
  const refused = readRefusal(loadPermissionRules(ctx.root), abs, clean);
  if (refused) throw new Error(refused);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    return { error: "not found", path: clean };
  }
  if (!within(real, realpathSync(ctx.root))) throw new Error("path outside the project");
  const st = statSync(real);
  if (!st.isFile()) return { error: "not a file", path: clean };
  const db = getStorage(ctx);
  const row = db.fileIndexGet(clean);
  const symbols = fileSymbols(db, clean).map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    start_line: n.start_line,
    end_line: n.end_line,
    exported: isExported(n),
  }));
  if (st.size > MAX_CODE_BYTES)
    return { path: clean, tooLarge: true, size: st.size, status: row?.status ?? null, symbols };
  const content = readFileSync(real, "utf8");
  return {
    path: clean,
    size: st.size,
    language: row?.language ?? null,
    status: row?.status ?? null,
    reason: row?.reason ?? null,
    lines: content.split("\n").length,
    content,
    symbols,
  };
}

// --- symbols and impact -----------------------------------------------------------

const USE_KINDS = [
  "calls",
  "references",
  "extends",
  "implements",
  "handles",
  "reexports",
  "imports",
];

export function symbolPayload(ctx: ProjectContext, ref: string) {
  const db = getStorage(ctx);
  const node = resolveNode(db, ref);
  if (!node) return { error: "unknown node" };
  const metrics = db.metricsGet([node.id])[0];
  const incoming = db.graphEdgesTo([node.id], [...USE_KINDS, "mentions", "co_changes"]);
  const outgoing = db.graphEdgesFrom([node.id], [...USE_KINDS, "defines", "exports", "co_changes"]);
  const ids = [...new Set([...incoming.map((e) => e.src), ...outgoing.map((e) => e.dst)])];
  const nodes = new Map(db.graphGetNodes(ids).map((n) => [n.id, n]));
  const row = (e: GraphEdgeRow, other: string) => ({
    ...visEdge(e),
    node: vis(nodes.get(other), other),
  });
  const callers = incoming.filter((e) => !e.src.startsWith("memory:") && e.kind !== "co_changes");
  const memories = incoming
    .filter((e) => e.src.startsWith("memory:"))
    .map((e) => ({ name: e.src.slice(7), kind: String(metaOf(nodes.get(e.src)).kind ?? "") }));
  const coChanged = [...incoming, ...outgoing]
    .filter((e) => e.kind === "co_changes")
    .map((e) => ({ path: (e.src === node.id ? e.dst : e.src).slice(5), weight: e.weight }));
  return {
    node: vis(node, node.id, true),
    meta: metaOf(node),
    metrics: metrics ?? null,
    callers: callers.map((e) => row(e, e.src)).sort((a, b) => (b.count ?? 1) - (a.count ?? 1)),
    callees: outgoing
      .filter((e) => e.kind !== "co_changes" && e.kind !== "defines")
      .map((e) => row(e, e.dst)),
    members:
      node.kind === "file"
        ? outgoing.filter((e) => e.kind === "defines").map((e) => vis(nodes.get(e.dst), e.dst))
        : [],
    routes: outgoing.filter((e) => e.kind === "handles").map((e) => vis(nodes.get(e.dst), e.dst)),
    memories,
    coChanged,
  };
}

/** What depends on a file, summarised for the Explore side panel, plus its direct file-level neighbourhood. */
export function fileImpactPayload(ctx: ProjectContext, rel: string) {
  const db = getStorage(ctx);
  const clean = rel.replace(/^\.\//, "");
  const r = impact(db, fileId(clean), { depth: 2, includeGit: true });
  if (!r) return { error: "not in the graph", path: clean };
  const direct = r.hits.filter(
    (h) =>
      h.hops === 1 &&
      h.id.startsWith("file:") &&
      !h.reasons.every((x) => /^co-changed|^memory/.test(x)),
  );
  const tests = r.hits.filter((h) => h.node?.path && TEST_PATH.test(h.node.path));
  const coChanged = r.hits.filter((h) => h.reasons.some((x) => x.startsWith("co-changed")));
  const memories = r.hits.filter((h) => h.id.startsWith("memory:"));
  const n = neighbors(db, fileId(clean), 1, ["imports", "reexports"]);
  const nodeMap = new Map((n?.nodes ?? []).map((x) => [x.id, x]));
  const edges = (n?.edges ?? []).slice(0, 80);
  const keep = new Set<string>([fileId(clean)]);
  for (const e of edges) {
    keep.add(e.src);
    keep.add(e.dst);
  }
  return {
    path: clean,
    directDependents: direct.length,
    affected: r.hits.filter((h) => h.id.startsWith("file:")).length,
    tests: tests.length,
    coChanged: coChanged.map((h) => ({ path: h.id.slice(5), reason: h.reasons[0] ?? "" })),
    memories: memories.map((h) => h.id.slice(7)),
    hits: r.hits.slice(0, 40).map((h) => ({
      id: h.id,
      label: nodeLabel(h.node, h.id),
      kind: h.node?.kind ?? "?",
      path: h.node?.path ?? null,
      score: Number(h.score.toFixed(3)),
      hops: h.hops,
      reasons: h.reasons,
    })),
    graph: {
      nodes: [...keep].map((id) =>
        vis(nodeMap.get(id) ?? db.graphGetNode(id), id, id === fileId(clean)),
      ),
      edges: edges.map(visEdge),
    },
  };
}

export function nodeSearchPayload(
  ctx: ProjectContext,
  q: string,
  opts: { kind?: string | undefined; limit?: number | undefined } = {},
) {
  const db = getStorage(ctx);
  return db
    .graphFindNodes({ query: q, kind: opts.kind, limit: opts.limit ?? 15 })
    .map((n) => vis(n, n.id));
}

// --- galaxy ---------------------------------------------------------------------

/**
 * Nodes within `depth` hops of `node` along `kinds` in `direction`, with the edges
 * that reached them. Capped at `limit` nodes (nearest first) so a hub never floods
 * the canvas; `truncated` says when that happened.
 */
export function graphExpand(
  ctx: ProjectContext,
  opts: {
    node: string;
    direction?: "out" | "in" | "both" | undefined;
    kinds?: string[] | undefined;
    depth?: number | undefined;
    limit?: number | undefined;
  },
) {
  const db = getStorage(ctx);
  const root = resolveNode(db, opts.node);
  if (!root) return { error: "unknown node" };
  const limit = opts.limit ?? 150;
  const r = pattern(db, {
    from: { id: root.id },
    edge: { kinds: opts.kinds, direction: opts.direction ?? "both", depth: opts.depth ?? 1 },
    return: "edges",
    limit,
  });
  const keep = new Set<string>([root.id, ...r.nodes.map((m) => m.node.id)]);
  const nodeMap = new Map<string, GraphNodeRow>([[root.id, root]]);
  for (const m of r.nodes) nodeMap.set(m.node.id, m.node);
  // Also include edges among kept nodes so the picture is not a pure tree.
  const among = [...db.graphEdgesFrom([...keep], opts.kinds)].filter((e) => keep.has(e.dst));
  const uniq = new Map<string, GraphEdgeRow>();
  for (const e of [...r.edges, ...among]) uniq.set(`${e.src}|${e.dst}|${e.kind}|${e.source}`, e);
  return {
    root: root.id,
    rootLabel: nodeLabel(root, root.id),
    truncated: r.truncated,
    nodes: [...keep].map((id) => vis(nodeMap.get(id), id, id === root.id)),
    edges: [...uniq.values()].map(visEdge),
  };
}

export function graphPathPayload(ctx: ProjectContext, from: string, to: string) {
  const db = getStorage(ctx);
  const p = graphPath(db, from, to);
  if (!p) return { error: "no path within 6 hops" };
  const ids = [...new Set(p.flatMap((e) => [e.src, e.dst]))];
  const nodes = new Map(db.graphGetNodes(ids).map((n) => [n.id, n]));
  return { nodes: ids.map((id) => vis(nodes.get(id), id)), edges: p.map(visEdge) };
}

/** Direct callees of a symbol with the call sites, for the Behavior tree (one level per request). */
export function behaviorPayload(ctx: ProjectContext, ref: string) {
  const db = getStorage(ctx);
  const root = resolveNode(db, ref);
  if (!root) return { error: "unknown node" };
  const edges = db.graphEdgesFrom([root.id], ["calls", "handles", "references"]);
  const nodes = new Map(db.graphGetNodes(edges.map((e) => e.dst)).map((n) => [n.id, n]));
  const meta = metaOf(root) as { loc?: number; complexity?: number };
  return {
    root: {
      ...vis(root, root.id, true),
      endLine: root.end_line,
      loc: meta.loc,
      complexity: meta.complexity,
    },
    callees: edges
      .map((e) => ({ ...visEdge(e), node: vis(nodes.get(e.dst), e.dst) }))
      .sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0)),
  };
}

// --- architecture ---------------------------------------------------------------

export function architecturePayload(ctx: ProjectContext, aspects?: string[] | undefined) {
  const db = getStorage(ctx);
  const want = aspects?.length
    ? aspects.filter((a): a is Aspect => (ASPECTS as readonly string[]).includes(a))
    : ASPECTS;
  return architecture(ctx, db, want);
}

export function hotspotsPayload(
  ctx: ProjectContext,
  opts: {
    kind?: "file" | "symbol" | undefined;
    path?: string | undefined;
    limit?: number | undefined;
  },
) {
  const db = getStorage(ctx);
  return hotspots(db, opts.limit ?? 50, { kind: opts.kind, pathPrefix: opts.path });
}

export function routesPayload(ctx: ProjectContext) {
  return routes(getStorage(ctx));
}

export function clustersPayload(ctx: ProjectContext) {
  const db = getStorage(ctx);
  const members: Record<string, Array<{ path: string; score: number; fanIn: number }>> = {};
  for (const m of db.metricsTop({ kind: "file", limit: 5000 })) {
    if (m.cluster === null || !m.path) continue;
    const key = String(m.cluster);
    const list = members[key] ?? [];
    list.push({ path: m.path, score: m.score, fanIn: m.fan_in });
    members[key] = list;
  }
  return { clusters: readClusters(db), cycles: readCycles(db), members };
}

export function coveragePayload(ctx: ProjectContext) {
  const db = getStorage(ctx);
  let scan: Record<string, unknown> | null = null;
  try {
    scan = JSON.parse(db.metaGet("coverage_summary") ?? "null") as Record<string, unknown>;
  } catch {
    scan = null;
  }
  return {
    summary: db.fileIndexSummary(),
    freshness: indexFreshness(ctx, db),
    scan,
    files: db.fileIndexAll().map((r) => ({
      path: r.path,
      status: r.status,
      reason: r.reason,
      language: r.language,
      symbols: r.symbols,
      size: r.size,
      indexed_at: r.indexed_at,
      errors: r.errors,
    })),
  };
}

export function changesPayload(ctx: ProjectContext, ref?: string | undefined) {
  const db = getStorage(ctx);
  try {
    const c = detectChanges(db, ctx.root, { ref, limit: 60 });
    return {
      ...c,
      affected: c.affected.map((h) => ({
        id: h.id,
        label: nodeLabel(h.node, h.id),
        kind: h.node?.kind ?? "?",
        path: h.node?.path ?? null,
        score: Number(h.score.toFixed(3)),
        hops: h.hops,
        reasons: h.reasons,
      })),
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export function runsPayload(ctx: ProjectContext) {
  return getStorage(ctx).indexRunsRecent(50);
}
