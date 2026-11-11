import { indexFreshness } from "../graph/reindex.js";
import { getStorage } from "../storage/index.js";
import { defineTool, READ_ONLY, text } from "./types.js";

export interface IndexStatus {
  freshness: ReturnType<typeof indexFreshness>;
  files: ReturnType<import("../storage/adapter.js").StorageAdapter["fileIndexSummary"]>;
  graph: { nodes: number; edges: number; metrics: number; metricsAt: number | null };
  runs: ReturnType<import("../storage/adapter.js").StorageAdapter["indexRunsRecent"]>;
  coverage: Record<string, unknown> | null;
}

export function indexStatus(
  ctx: Parameters<typeof getStorage>[0],
  db = getStorage(ctx),
): IndexStatus {
  const c = db.graphCounts();
  let coverage: Record<string, unknown> | null = null;
  try {
    coverage = JSON.parse(db.metaGet("coverage_summary") ?? "null") as Record<string, unknown>;
  } catch {
    coverage = null;
  }
  return {
    freshness: indexFreshness(ctx, db),
    files: db.fileIndexSummary(),
    graph: {
      nodes: c.nodes,
      edges: c.edges,
      metrics: db.metricsCount(),
      metricsAt: Number(db.metaGet("metrics_at") ?? 0) || null,
    },
    runs: db.indexRunsRecent(5),
    coverage,
  };
}

export function formatIndexStatus(s: IndexStatus): string {
  const f = s.freshness;
  const lines: string[] = [];
  const fresh =
    f.headMatches && !f.dirty.length && !f.queued
      ? "fresh"
      : f.dirty.length || f.queued
        ? "stale"
        : f.head
          ? "git signals behind HEAD"
          : "no git";
  lines.push(
    `index: ${fresh} · HEAD ${f.head?.slice(0, 7) ?? "n/a"}${f.indexedHead && f.indexedHead !== f.head ? ` (git signals at ${f.indexedHead.slice(0, 7)})` : ""} · ${f.dirty.length} file(s) changed since indexed · ${f.queued} queued${f.lastRun ? ` · last run ${new Date(f.lastRun).toISOString()}` : ""}`,
  );
  if (f.dirty.length)
    lines.push(
      `  changed: ${f.dirty.slice(0, 8).join(", ")}${f.dirty.length > 8 ? ` … +${f.dirty.length - 8}` : ""} (em_reindex {scope:"code"} to refresh)`,
    );
  const b = s.files.byStatus;
  lines.push(
    `files: ${b.indexed ?? 0} indexed, ${b.partial ?? 0} partial, ${b.skipped ?? 0} skipped, ${b.unsupported ?? 0} unsupported`,
  );
  if (s.files.reasons.length)
    lines.push(`  reasons: ${s.files.reasons.map((r) => `${r.reason} ×${r.n}`).join("; ")}`);
  lines.push(
    `graph: ${s.graph.nodes} nodes, ${s.graph.edges} edges, metrics for ${s.graph.metrics} node(s)${s.graph.metricsAt ? ` (${new Date(s.graph.metricsAt).toISOString()})` : " (not computed)"}`,
  );
  if (s.runs.length) {
    lines.push("recent runs:");
    for (const r of s.runs) {
      const dur = r.finished_at ? `${r.finished_at - r.started_at} ms` : "running";
      lines.push(
        `- ${new Date(r.started_at).toISOString()} ${r.scope}: ${r.scanned} scanned, ${r.indexed} indexed, ${r.unchanged} unchanged, ${r.skipped} skipped, ${r.removed} removed, ${r.errors} errors · ${dur}`,
      );
    }
  }
  return lines.join("\n");
}

export const emIndexStatus = defineTool({
  name: "em_index_status",
  annotations: READ_ONLY,
  description:
    "Is the code graph fresh? Reports HEAD vs indexed commit, files edited since they were indexed, the reindex queue, files by index status (indexed/partial/skipped/unsupported) with reasons, metrics age and recent index runs. Check before trusting absence claims (e.g. 'nothing calls X').",
  schema: {},
  handler: async (_args, ctx) => text(formatIndexStatus(indexStatus(ctx))),
});
