import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../context.js";
import { readManifest } from "../docs/manifest.js";
import { readBriefSummary } from "../history/model.js";
import { parseMemoryFile } from "../memory/frontmatter.js";
import { memoriesDir } from "../memory/store.js";
import type { StorageAdapter } from "../storage/adapter.js";

/**
 * A short, budgeted "what you need to know" about the project for a fresh context:
 * the onboarding overview's first paragraph, accepted decisions, the hottest files
 * and whether the index is current. Everything comes from memories, metrics and the
 * file index, so it costs a few milliseconds and no file reads beyond one memory.
 */
export function renderProjectBrief(
  ctx: ProjectContext,
  db: StorageAdapter,
  budget = 1500,
  opts: { freshnessOnly?: boolean | undefined; memoryTool?: boolean | undefined } = {},
): string {
  const lines: string[] = [];
  const freshness = freshnessLine(db);
  if (opts.freshnessOnly) return freshness ?? "";

  const overview = overviewParagraph(ctx);
  if (overview) lines.push(`Project: ${overview}`);

  const decisions = db
    .memoryList({ kind: "decision", status: "accepted", limit: 8 })
    .filter((m) => m.name)
    .map((m) => `${m.name!.replace(/^decision\//, "")}: ${firstLine(m.content, 90)}`);
  if (decisions.length)
    lines.push(
      `Accepted decisions${opts.memoryTool === false ? "" : ' (em_memory {action:"read", name})'}: ${decisions.join(" · ")}`,
    );

  // Constraints and preferences are the "never do X" knowledge: they lead the brief's rules.
  const rules = (["constraint", "preference"] as const).flatMap((kind) =>
    db
      .memoryList({ kind, limit: 6 })
      .filter((m) => m.name && m.status !== "superseded" && m.status !== "deprecated")
      .map((m) => `${m.name}: ${firstLine(m.content, 90)}`),
  );
  if (rules.length) lines.push(`Constraints & preferences: ${rules.join(" · ")}`);

  const hot = db.metricsTop({ kind: "file", limit: 5 }).filter((r) => r.score > 0);
  if (hot.length) lines.push(`Hot files (fan-in × churn): ${hot.map((r) => r.path).join(", ")}`);

  try {
    const docs = readManifest(ctx).sources;
    if (docs.length)
      lines.push(
        `Docs indexed (em_docs {action:"lookup", query} before WebFetch/WebSearch): ${docs
          .slice(0, 12)
          .map((s) => s.name)
          .join(", ")}${docs.length > 12 ? ` +${docs.length - 12} more` : ""}`,
      );
  } catch {
    // the manifest is optional
  }

  const history = historyLine(db);
  if (history) lines.push(history);

  if (freshness) lines.push(freshness);
  return fitBudget(lines, budget);
}

/** One line from the last history build (written by em_history / the dashboard; never computed here). */
function historyLine(db: StorageAdapter): string | undefined {
  const h = readBriefSummary(db);
  if (!h) return undefined;
  const parts = [
    `History (em_history): ${h.commits} commits, ${h.commits90d} in 90d of which ${h.fixes90d} fixes`,
  ];
  if (h.risky.length) parts.push(`bug-prone: ${h.risky.join(", ")}`);
  if (h.lesson) parts.push(h.lesson.replace(/\.$/, ""));
  return `${parts.join("; ")}. em_history {action:"file", path} before editing, {action:"risk"} before committing.`;
}

function overviewParagraph(ctx: ProjectContext): string | undefined {
  const file = join(memoriesDir(ctx), "onboarding", "overview.md");
  if (!existsSync(file)) return undefined;
  try {
    const body = parseMemoryFile(readFileSync(file, "utf8")).body.trim();
    const para = body
      .split(/\n\s*\n/)
      .map((p) =>
        p
          .replace(/^#+\s.*$/m, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((p) => p.length > 20);
    return para ? (para.length > 400 ? `${para.slice(0, 399)}…` : para) : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(s: string, max: number): string {
  const line = s.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? s;
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One line on index state; cheap (mtime/size compare, hashing only for changed files). */
function freshnessLine(db: StorageAdapter): string | undefined {
  const indexed = db.fileIndexSummary();
  const total = Object.values(indexed.byStatus).reduce((a, b) => a + b, 0);
  if (!total) return "Code graph: not built yet (em_architecture or em_reindex builds it).";
  const queued = db.reindexQueueSize();
  const gaps = (indexed.byStatus.partial ?? 0) + (indexed.byStatus.skipped ?? 0);
  const parts = [`Code graph: ${indexed.byStatus.indexed ?? 0} files indexed`];
  if (gaps) parts.push(`${gaps} with gaps`);
  if (queued) parts.push(`${queued} edited since (re-parsed on the next em_* call)`);
  parts.push(
    "em_architecture for the map, em_symbols / em_graph_impact before reading files, em_index_status for coverage",
  );
  return `${parts.join("; ")}.`;
}

function fitBudget(lines: string[], budget: number): string {
  let out = lines.join("\n");
  while (out.length > budget && lines.length > 1) {
    // drop the least important line first: history, hot files, decisions, rules, the overview
    const order = [
      "History (",
      "Hot files",
      "Accepted decisions",
      "Constraints & preferences",
      "Project:",
    ];
    const prefix = order.find((p) => lines.some((l) => l.startsWith(p)));
    if (!prefix) break;
    const idx = lines.findIndex((l) => l.startsWith(prefix));
    lines.splice(idx, 1);
    out = lines.join("\n");
  }
  return out.length > budget ? `${out.slice(0, budget - 1)}…` : out;
}
