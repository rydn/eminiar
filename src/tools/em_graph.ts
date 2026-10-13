import { z } from "zod";
import { formatEdges, formatHits, nodeLabel } from "../graph/format.js";
import { conceptId } from "../graph/ids.js";
import {
  coupled,
  dependencies,
  hotspots,
  impact,
  neighbors,
  orphans,
  path,
  resolveNode,
} from "../graph/query.js";
import { drainReindexQueue, reindexCode, reindexGitSignals } from "../graph/reindex.js";
import { recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, text } from "./types.js";

export async function ensureGraph(ctx: Parameters<typeof getStorage>[0]) {
  const db = getStorage(ctx);
  if (!db.graphCounts().nodes) {
    await reindexCode(ctx, db);
    try {
      reindexGitSignals(ctx, db);
    } catch {
      // not a git repo
    }
  } else {
    await drainReindexQueue(ctx, db);
  }
  return db;
}

export const emGraphQuery = defineTool({
  name: "em_graph_query",
  description:
    "Look up nodes in the project knowledge graph (files, functions, classes, packages, people, concepts, memories) by name/path, or run a preset: hotspots (most-changed files), coupled (files that change together), orphans (files nothing imports). The graph is built on first use from tree-sitter (TS/JS), git history, the memories under .eminiar/memories (memory:<name> nodes with `mentions` edges) and em_graph_add.",
  schema: {
    query: z.string().optional().describe("Substring of a name, path or id"),
    kind: z
      .string()
      .optional()
      .describe(
        "file | function | class | method | interface | type | package | person | concept | memory",
      ),
    path: z.string().optional().describe("Restrict to nodes whose path contains this"),
    preset: z.enum(["hotspots", "coupled", "orphans", "stats"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    const limit = args.limit ?? 20;
    let out: string;
    if (args.preset === "stats") {
      const c = db.graphCounts();
      out = `${c.nodes} nodes, ${c.edges} edges: ${Object.entries(c.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}`;
    } else if (args.preset === "hotspots") {
      out =
        hotspots(db, limit)
          .map(
            (h) =>
              `- ${h.path} · ${h.commits_90d} commits/90d · ${h.commits} total · last ${h.last_touched}`,
          )
          .join("\n") || "no git history indexed";
    } else if (args.preset === "coupled") {
      out =
        coupled(db, limit)
          .map((c) => `- ${c.a} ↔ ${c.b} · ${c.count}× · ${Math.round(c.weight * 100)}%`)
          .join("\n") || "no coupling found (need ≥3 shared commits)";
    } else if (args.preset === "orphans") {
      out =
        orphans(db, limit)
          .map((p) => `- ${p}`)
          .join("\n") || "none";
    } else {
      const nodes = db.graphFindNodes({
        query: args.query,
        kind: args.kind,
        path: args.path,
        limit,
      });
      out = nodes.length
        ? nodes
            .map((n) => `- ${n.id} · ${nodeLabel(n, n.id)}${n.meta ? ` · ${n.meta}` : ""}`)
            .join("\n")
        : "no matching nodes";
    }
    recordStat(ctx, "em_graph_query", {
      rawChars: 0,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});

export const emGraphImpact = defineTool({
  name: "em_graph_impact",
  description:
    "What depends on a file or symbol (impact of changing it), what it depends on, its neighbourhood, or the path between two nodes. Combines import/call/extends edges from tree-sitter with git co-change coupling, and explains each hit. Use before refactors and when a change breaks something far away.",
  schema: {
    node: z.string().describe("Node id, project-relative file path, or symbol name (path#Symbol)"),
    mode: z
      .enum(["impact", "dependents", "dependencies", "neighbors", "path"])
      .optional()
      .describe("default impact"),
    to: z.string().optional().describe("Target node for mode=path"),
    depth: z.number().int().min(1).max(4).optional(),
    edge_kinds: z.array(z.string()).optional(),
    include_git: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    const mode = args.mode ?? "impact";
    const limit = args.limit ?? 25;
    let out: string;
    if (mode === "path") {
      if (!args.to) return errorResult("mode=path needs `to`");
      const p = path(db, args.node, args.to);
      if (!p) out = `no path between ${args.node} and ${args.to} within 6 hops`;
      else {
        const nodes = new Map(
          db.graphGetNodes([...new Set(p.flatMap((e) => [e.src, e.dst]))]).map((n) => [n.id, n]),
        );
        out = formatEdges(p, nodes, 50);
      }
    } else if (mode === "neighbors") {
      const r = neighbors(db, args.node, args.depth ?? 1, args.edge_kinds);
      if (!r) return errorResult(`unknown node ${args.node}`);
      const nodes = new Map(r.nodes.map((n) => [n.id, n]));
      out = `${nodeLabel(r.root, r.root.id)} — ${r.edges.length} edges, ${r.nodes.length} nodes\n${formatEdges(r.edges, nodes, limit)}`;
    } else if (mode === "dependencies") {
      const r = dependencies(db, args.node, args.depth ?? 1);
      if (!r) return errorResult(`unknown node ${args.node}`);
      out = formatHits(`${nodeLabel(r.root, r.root.id)} depends on:`, r.hits, limit);
    } else {
      const r = impact(db, args.node, {
        depth: args.depth ?? 2,
        includeGit: mode === "impact" ? (args.include_git ?? true) : false,
        edgeKinds: args.edge_kinds,
      });
      if (!r) return errorResult(`unknown node ${args.node}; try em_graph_query to find it`);
      out = formatHits(
        `${mode === "impact" ? "changing" : "dependents of"} ${nodeLabel(r.root, r.root.id)} affects:`,
        r.hits,
        limit,
      );
    }
    recordStat(ctx, "em_graph_impact", {
      rawChars: 0,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});

export const emGraphAdd = defineTool({
  name: "em_graph_add",
  description:
    "Add curated knowledge to the graph: concept nodes (components, services, decisions) and relations between them or to files/symbols. Node ids: file:<path>, sym:<path>#<Name>, pkg:<name>, person:<name>, concept:<slug>. Bare names become concepts.",
  schema: {
    nodes: z
      .array(
        z.object({
          id: z.string().optional(),
          kind: z.string(),
          name: z.string(),
          meta: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    edges: z
      .array(
        z.object({
          src: z.string(),
          dst: z.string(),
          kind: z
            .string()
            .describe("relates_to | depends_on | owns | implements | decided_for | part_of …"),
          confidence: z.number().min(0).max(1).optional(),
          note: z.string().optional(),
        }),
      )
      .optional(),
  },
  handler: async (args, ctx) => {
    const db = getStorage(ctx);
    const norm = (ref: string) =>
      ref.includes(":") ? ref : (resolveNode(db, ref)?.id ?? conceptId(ref));
    const nodes = (args.nodes ?? []).map((n) => ({
      id:
        n.id ??
        (n.kind === "file"
          ? `file:${n.name}`
          : n.kind === "person"
            ? `person:${n.name}`
            : conceptId(n.name)),
      kind: n.kind,
      name: n.name,
      path: n.kind === "file" ? n.name : undefined,
      source: "curated" as const,
      meta: n.meta,
    }));
    const edges = (args.edges ?? []).map((e) => ({
      src: norm(e.src),
      dst: norm(e.dst),
      kind: e.kind,
      source: "curated" as const,
      confidence: e.confidence ?? 1,
      meta: e.note ? { note: e.note } : undefined,
    }));
    // Endpoints that do not exist yet become concept stubs so the graph stays connected.
    const known = new Set([
      ...nodes.map((n) => n.id),
      ...db.graphGetNodes(edges.flatMap((e) => [e.src, e.dst])).map((n) => n.id),
    ]);
    for (const id of edges.flatMap((e) => [e.src, e.dst])) {
      if (!known.has(id) && id.startsWith("concept:")) {
        nodes.push({
          id,
          kind: "concept",
          name: id.slice(8),
          path: undefined,
          source: "curated",
          meta: undefined,
        });
        known.add(id);
      }
    }
    db.graphUpsertNodes(nodes);
    db.graphUpsertEdges(edges);
    return text(`added ${nodes.length} node(s), ${edges.length} edge(s)`);
  },
});

export const emReindex = defineTool({
  name: "em_reindex",
  description:
    "Rebuild parts of the local index: code (tree-sitter graph + code search), git (co-change/hotspots), docs (markdown per eminiar.config.json index.docs), memories (re-import .eminiar/memories files edited by hand), embeddings (vectors for unembedded chunks), or all. Incremental unless full: true.",
  schema: {
    scope: z
      .enum(["code", "git", "docs", "memories", "embeddings", "all"])
      .optional()
      .describe("default all"),
    paths: z.array(z.string()).optional().describe("Only these files (code scope)"),
    full: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = getStorage(ctx);
    const scope = args.scope ?? "all";
    const lines: string[] = [];
    if (scope === "code" || scope === "all") {
      const s = await reindexCode(ctx, db, { paths: args.paths, full: args.full });
      lines.push(
        `code: ${s.scanned} scanned, ${s.parsed} parsed, ${s.unchanged} unchanged, ${s.removed} removed${s.skipped ? `, ${s.skipped} skipped (over 1.5 MB)` : ""}${s.errors.length ? `, ${s.errors.length} errors (${s.errors[0]!.path}: ${s.errors[0]!.error})` : ""}`,
      );
    }
    if (scope === "git" || scope === "all") {
      try {
        const g = reindexGitSignals(ctx, db, args.full ?? false);
        lines.push(
          `git: ${g.commits} commits, ${g.files} files, ${g.coChangeEdges} co-change pairs`,
        );
      } catch (err) {
        lines.push(`git: skipped (${(err as Error).message})`);
      }
    }
    if (scope === "docs" || scope === "all") {
      const { indexPath } = await import("../index/indexer.js");
      const s = indexPath(db, ctx.root, ".", { source: "file", globs: ctx.config.index.docs });
      lines.push(`docs: ${s.files} files, ${s.indexed} indexed, ${s.unchanged} unchanged`);
    }
    if (scope === "memories" || scope === "all") {
      const { reconcile } = await import("../memory/store.js");
      const s = reconcile(ctx, db);
      lines.push(
        `memories: ${s.files} files, ${s.synced} synced, ${s.removed} removed${s.migrated ? `, ${s.migrated} migrated from the database into files` : ""}${s.skipped.length ? `, ${s.skipped.length} skipped (invalid name, e.g. ${s.skipped[0]})` : ""}`,
      );
    }
    if (scope === "embeddings" || scope === "all") {
      const { getProvider } = await import("../embeddings/provider.js");
      const { embedPending } = await import("../embeddings/queue.js");
      const provider = await getProvider(ctx.config);
      if (!provider) lines.push("embeddings: disabled or unavailable");
      else {
        const n = await embedPending(db, provider, { max: scope === "embeddings" ? 50_000 : 2000 });
        lines.push(`embeddings: ${n} chunks embedded, ${db.vecCount()} vectors total`);
      }
    }
    const c = db.graphCounts();
    lines.push(`graph: ${c.nodes} nodes, ${c.edges} edges`);
    recordStat(ctx, "em_reindex", {
      rawChars: 0,
      returnedChars: lines.join("\n").length,
      durationMs: Date.now() - started,
    });
    return text(lines.join("\n"));
  },
});
