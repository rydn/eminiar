import { z } from "zod";
import { refuseUnreadable } from "../docs/sync.js";
import { getProvider } from "../embeddings/provider.js";
import { embedPending } from "../embeddings/queue.js";
import { formatEdges, formatHits, nodeLabel } from "../graph/format.js";
import { conceptId } from "../graph/ids.js";
import { readClusters, readCycles } from "../graph/metrics.js";
import {
  coupled,
  deadCode,
  dependencies,
  hotspots,
  impact,
  neighbors,
  orphans,
  path,
  pattern,
  resolveNode,
  routes,
} from "../graph/query.js";
import {
  drainReindexQueue,
  finalizeGraph,
  reindexCode,
  reindexGitSignals,
} from "../graph/reindex.js";
import { indexPath } from "../index/indexer.js";
import { reconcile } from "../memory/store.js";
import { fileBytes, recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, LOCAL_WRITE, READ_ONLY, text } from "./types.js";

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

const NodeFilterSchema = z.object({
  id: z.string().optional().describe("exact node id, path or path#Symbol"),
  kind: z.union([z.string(), z.array(z.string())]).optional(),
  name: z.string().optional().describe("JS regex over the name (or a substring)"),
  path: z.string().optional().describe("substring of the path"),
  pathPrefix: z.string().optional().describe("folder prefix of the path"),
});

export const emGraphQuery = defineTool({
  name: "em_graph_query",
  annotations: READ_ONLY,
  description:
    'Look up nodes in the project knowledge graph (files, functions, classes, routes, packages, people, concepts, memories) by name/path, run a preset (hotspots, coupled, orphans, dead_code, routes, cycles, clusters, stats), or run a structured pattern: start at nodes matching `from`, walk `edge.kinds` in `edge.direction` for `edge.depth` hops, keep what matches `to` — e.g. {from:{kind:"route"}, edge:{kinds:["handles"], direction:"in"}} lists every route handler, {from:{name:"^parseFile$"}, edge:{kinds:["calls"], direction:"in", depth:2}} its callers two levels up. Built from tree-sitter (TS/JS, Python, Go, PHP), git history, memories and em_graph_add.',
  schema: {
    query: z.string().optional().describe("Substring of a name, path or id"),
    kind: z
      .string()
      .optional()
      .describe(
        "file | function | class | method | interface | type | route | package | person | concept | memory",
      ),
    path: z.string().optional().describe("Restrict to nodes whose path contains this"),
    preset: z
      .enum([
        "hotspots",
        "coupled",
        "orphans",
        "dead_code",
        "routes",
        "cycles",
        "clusters",
        "stats",
      ])
      .optional(),
    hotspot_kind: z
      .enum(["file", "symbol"])
      .optional()
      .describe("hotspots: rank files (default) or functions/classes/methods"),
    pattern: z
      .object({
        from: NodeFilterSchema.optional(),
        edge: z
          .object({
            kinds: z.array(z.string()).optional(),
            direction: z.enum(["out", "in", "both"]).optional().describe("default out"),
            depth: z.number().int().min(0).max(6).optional().describe("default 1"),
          })
          .optional(),
        to: NodeFilterSchema.optional(),
        return: z.enum(["nodes", "edges", "paths"]).optional().describe("default nodes"),
      })
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    const limit = args.limit ?? 20;
    let out: string;
    const touched: Array<string | null | undefined> = [];
    if (args.pattern) {
      const r = pattern(db, { ...args.pattern, limit });
      if (!r.starts.length) out = "no nodes match `from` (or `to` when `from` is absent)";
      else {
        const nodes = new Map<string, (typeof r.starts)[number]>();
        for (const n of r.starts) nodes.set(n.id, n);
        for (const m of r.nodes) nodes.set(m.node.id, m.node);
        for (const n of db.graphGetNodes(
          [...new Set(r.edges.flatMap((e) => [e.src, e.dst]))].filter((id) => !nodes.has(id)),
        ))
          nodes.set(n.id, n);
        const head = `${r.starts.length} start node(s) → ${r.nodes.length} match(es)${r.truncated ? " (truncated)" : ""}`;
        const want = args.pattern.return ?? "nodes";
        if (want === "edges") out = `${head}\n${formatEdges(r.edges, nodes, limit * 2)}`;
        else if (want === "paths")
          out = `${head}\n${r.paths
            .slice(0, limit)
            .map((p, i) =>
              p.length
                ? `${i + 1}. ${nodeLabel(nodes.get(p[0]!.src), p[0]!.src)} ${p.map((e) => `—${e.kind}→ ${nodeLabel(nodes.get(e.dst), e.dst)}`).join(" ")}`
                : `${i + 1}. ${nodeLabel(r.nodes[i]?.node, r.nodes[i]?.node.id ?? "")}`,
            )
            .join("\n")}`;
        else
          out = `${head}\n${r.nodes.map((m) => `- ${nodeLabel(m.node, m.node.id)}${m.hops ? ` · ${m.hops} hop${m.hops > 1 ? "s" : ""}` : ""}`).join("\n")}`;
        touched.push(...r.nodes.map((m) => m.node.path));
      }
    } else if (args.preset === "stats") {
      const c = db.graphCounts();
      const n = db.graphNodeCounts();
      out = `${c.nodes} nodes (${Object.entries(n)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}), ${c.edges} edges (${Object.entries(c.byKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")})`;
    } else if (args.preset === "hotspots") {
      const rows = hotspots(db, limit, { kind: args.hotspot_kind, pathPrefix: args.path });
      out = rows.length
        ? `${args.hotspot_kind === "symbol" ? "symbol" : "file"} · fan-in · commits/90d · complexity · loc → score (a signal, not a grade)\n${rows
            .map(
              (h) =>
                `- ${h.path} · ${h.fan_in} · ${h.commits_90d} · ${h.complexity} · ${h.loc} → ${h.score}${h.last_touched ? ` · last ${h.last_touched}` : ""}`,
            )
            .join("\n")}`
        : "no hotspot data yet (run em_reindex)";
      touched.push(...rows.map((h) => (h.kind === "file" ? h.path : h.path.split(" > ")[0])));
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
    } else if (args.preset === "dead_code") {
      const rows = deadCode(db, limit);
      out = rows.length
        ? `candidates (no indexed caller; check dynamic dispatch, framework conventions and coverage gaps before deleting):\n${rows.map((r) => `- ${nodeLabel(r.node, r.node.id)} · ${r.reason}`).join("\n")}`
        : "no dead-code candidates";
      touched.push(...rows.map((r) => r.node.path));
    } else if (args.preset === "routes") {
      const rows = routes(db, limit * 5).filter((r) => !args.path || r.file.includes(args.path));
      out = rows.length
        ? rows
            .slice(0, limit)
            .map(
              (r) =>
                `- ${r.method} ${r.path} · ${r.framework} · ${r.handlers.map((h) => `${h.path ?? ""} > ${h.name}`).join(", ") || r.file}${r.line ? ` (${r.file}:${r.line})` : ""}`,
            )
            .join("\n") + (rows.length > limit ? `\n… ${rows.length - limit} more` : "")
        : "no routes detected (express/fastify/hono/koa registrations and Next.js route files are recognised)";
      touched.push(...rows.map((r) => r.file));
    } else if (args.preset === "cycles") {
      const c = readCycles(db);
      out = c.length
        ? c
            .slice(0, limit)
            .map((cy, i) => `${i + 1}. ${cy.join(" → ")} → ${cy[0]}`)
            .join("\n")
        : "no import cycles";
    } else if (args.preset === "clusters") {
      const c = readClusters(db);
      out = c.length
        ? c
            .slice(0, limit)
            .map(
              (cl) =>
                `- #${cl.id} ${cl.label} · ${cl.size} files · ${cl.files.slice(0, 4).join(", ")}${
                  Object.keys(cl.links).length
                    ? ` · → ${Object.entries(cl.links)
                        .map(([k, v]) => `#${k}×${v}`)
                        .join(" ")}`
                    : ""
                }`,
            )
            .join("\n")
        : "no clusters yet (run em_reindex)";
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
      rawChars: fileBytes(db, touched),
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});

export const emGraphImpact = defineTool({
  name: "em_graph_impact",
  annotations: READ_ONLY,
  description:
    "What depends on a file or symbol (impact of changing it), what it depends on, its neighbourhood, or the path between two nodes. Combines import/call/extends/route edges from tree-sitter with git co-change coupling and memories, and explains each hit. Use before refactors and when a change breaks something far away.",
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
    const touched: Array<string | null | undefined> = [];
    if (mode === "path") {
      if (!args.to) return errorResult("mode=path needs `to`");
      const p = path(db, args.node, args.to);
      if (!p) out = `no path between ${args.node} and ${args.to} within 6 hops`;
      else {
        const nodes = new Map(
          db.graphGetNodes([...new Set(p.flatMap((e) => [e.src, e.dst]))]).map((n) => [n.id, n]),
        );
        out = formatEdges(p, nodes, 50);
        touched.push(...[...nodes.values()].map((n) => n.path));
      }
    } else if (mode === "neighbors") {
      const r = neighbors(db, args.node, args.depth ?? 1, args.edge_kinds);
      if (!r) return errorResult(`unknown node ${args.node}`);
      const nodes = new Map(r.nodes.map((n) => [n.id, n]));
      out = `${nodeLabel(r.root, r.root.id)} — ${r.edges.length} edges, ${r.nodes.length} nodes\n${formatEdges(r.edges, nodes, limit)}`;
      touched.push(...r.nodes.map((n) => n.path));
    } else if (mode === "dependencies") {
      const r = dependencies(db, args.node, args.depth ?? 1);
      if (!r) return errorResult(`unknown node ${args.node}`);
      out = formatHits(`${nodeLabel(r.root, r.root.id)} depends on:`, r.hits, limit);
      touched.push(...r.hits.slice(0, limit).map((h) => h.node?.path));
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
      touched.push(...r.hits.slice(0, limit).map((h) => h.node?.path));
    }
    recordStat(ctx, "em_graph_impact", {
      rawChars: fileBytes(db, touched),
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});

export const emGraphAdd = defineTool({
  name: "em_graph_add",
  // The upsert replaces an existing node's kind, name and location, as em_remember replaces a memory.
  annotations: { ...LOCAL_WRITE, destructiveHint: true },
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
  annotations: LOCAL_WRITE,
  description:
    "Rebuild parts of the local index: code (tree-sitter graph + code search, then the link pass and metrics), git (co-change/hotspots), metrics (fan-in, hotspot scores, clusters, cycles only), docs (markdown per eminiar.config.json index.docs), memories (re-import .eminiar/memories files edited by hand), embeddings (vectors for unembedded chunks), or all. Incremental unless full: true.",
  schema: {
    scope: z
      .enum(["code", "git", "metrics", "docs", "memories", "embeddings", "all"])
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
      const extras = [
        s.partial ? `${s.partial} partial (syntax errors recovered)` : "",
        s.skipped ? `${s.skipped} skipped (over 1.5 MB or parser error)` : "",
        s.unsupported ? `${s.unsupported} unsupported` : "",
        s.errors.length
          ? `${s.errors.length} errors (${s.errors[0]!.path}: ${s.errors[0]!.error})`
          : "",
      ].filter(Boolean);
      lines.push(
        `code: ${s.scanned} scanned, ${s.parsed} parsed, ${s.unchanged} unchanged, ${s.removed} removed${extras.length ? `, ${extras.join(", ")}` : ""} · ${s.durationMs} ms`,
      );
      if (s.link)
        lines.push(
          `link: ${s.link.resolved} resolved via barrels/defaults, ${s.link.demoted} demoted to file level, ${s.link.restored} restored, ${s.link.stubs} external file stubs`,
        );
      if (s.metrics)
        lines.push(
          `metrics: ${s.metrics.nodes} nodes scored, ${s.metrics.clusters} clusters, ${s.metrics.cycles} import cycles`,
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
    if (scope === "metrics") {
      const f = finalizeGraph(db);
      lines.push(
        `link: ${f.link.resolved} resolved, ${f.link.demoted} demoted, ${f.link.restored} restored, ${f.link.stubs} stubs`,
        `metrics: ${f.metrics.nodes} nodes scored, ${f.metrics.clusters} clusters, ${f.metrics.cycles} import cycles`,
      );
    }
    if (scope === "docs" || scope === "all") {
      const s = indexPath(db, ctx.root, ".", {
        source: "file",
        globs: ctx.config.index.docs,
        refuse: refuseUnreadable(ctx),
      });
      lines.push(
        `docs: ${s.files} files, ${s.indexed} indexed, ${s.unchanged} unchanged${s.skipped.length ? `, ${s.skipped.length} skipped` : ""}`,
      );
    }
    if (scope === "memories" || scope === "all") {
      const s = reconcile(ctx, db);
      lines.push(
        `memories: ${s.files} files, ${s.synced} synced, ${s.removed} removed${s.migrated ? `, ${s.migrated} migrated from the database into files` : ""}${s.skipped.length ? `, ${s.skipped.length} skipped (invalid name or outside the project, e.g. ${s.skipped[0]})` : ""}`,
      );
    }
    if (scope === "embeddings" || scope === "all") {
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
