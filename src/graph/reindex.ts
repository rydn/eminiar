import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import fg from "fast-glob";
import micromatch from "micromatch";
import { hashText } from "../chunker/index.js";
import { chunkBySymbols, type SymbolSpan } from "../chunker/symbols.js";
import { getCodeBackend } from "../code/backend.js";
import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";
import { indexContent } from "../index/indexer.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { FileIndexStatus } from "../storage/types.js";
import { type GitSummary, gitHead, reindexGit } from "./git.js";
import { type LinkSummary, linkGraph } from "./link.js";
import { computeMetrics, type MetricsSummary } from "./metrics.js";

export interface CodeSummary {
  scanned: number;
  parsed: number;
  removed: number;
  unchanged: number;
  /** Files over the size limit or that the parser could not handle. */
  skipped: number;
  /** Files indexed with syntax errors the parser recovered from. */
  partial: number;
  /** Files matched by the include globs that no backend parses. */
  unsupported: number;
  errors: Array<{ path: string; error: string }>;
  link?: LinkSummary | undefined;
  metrics?: MetricsSummary | undefined;
  durationMs: number;
}

/** Largest file the parser is asked to handle (minified bundles are not worth a graph). */
export const MAX_CODE_BYTES = 1_500_000;

/**
 * Bumped when how code is parsed or chunked changes; a database built by an older
 * version gets one automatic full pass so every file carries symbol chunks and
 * reference edges without anyone remembering to run `em_reindex {full: true}`.
 */
const CODE_INDEX_VERSION = "3";

/** fast-glob's settings for the code index; codeFileFilter mirrors them for single paths. */
const CODE_GLOB = { onlyFiles: true, dot: false, followSymbolicLinks: false } as const;
const MATCH: micromatch.Options = { dot: false, posix: true, strictSlashes: false };

export function listCodeFiles(ctx: ProjectContext): string[] {
  return fg.sync(ctx.config.graph.include, {
    ...CODE_GLOB,
    cwd: ctx.root,
    ignore: ctx.config.graph.exclude,
  });
}

/**
 * Would listCodeFiles list this project-relative path? The same rules fast-glob applies, from
 * its own task patterns (braces expanded, `!` includes turned into ignores, a `!` on an ignore
 * dropped): a positive pattern matches (`**` does not cross a dot folder), no ignore pattern
 * matches (dot files included), and no folder on the way is one an ignore pattern prunes
 * (`dist`, `src/legacy`, `**\/generated/**`). The reindex queue holds what the hooks saw
 * edited, and a session's hooks record into its root's project: an edit made in a git worktree
 * under `.claude/worktrees/` must not put a second copy of the code into the graph.
 */
export function codeFileFilter(graph: Config["graph"]): (rel: string) => boolean {
  // Compiled once per config object: the server drains the queue on every request.
  const cached = FILTERS.get(graph);
  if (cached) return cached;
  const f = compileCodeFilter(graph);
  FILTERS.set(graph, f);
  return f;
}

const FILTERS = new WeakMap<Config["graph"], (rel: string) => boolean>();

function compileCodeFilter(graph: Config["graph"]): (rel: string) => boolean {
  const tasks = fg.generateTasks(graph.include, { ignore: graph.exclude });
  const re = (patterns: string[], opts: micromatch.Options) =>
    patterns.map((p) => micromatch.makeRe(p, opts));
  const any = (res: RegExp[], s: string) => res.some((r) => r.test(s));
  const positive = re(
    tasks.flatMap((t) => t.positive),
    MATCH,
  );
  const ignore = tasks[0]?.negative ?? [];
  const ignored = re(ignore, { ...MATCH, dot: true });
  const pruned = re(
    ignore.filter((p) => p.endsWith("/**") || !fg.isDynamicPattern(basename(p))),
    MATCH,
  );
  return (rel) => {
    if (isAbsolute(rel) || rel.startsWith("../") || !any(positive, rel) || any(ignored, rel))
      return false;
    const dirs = rel.split("/").slice(0, -1);
    return !dirs.some((_, i) => any(pruned, dirs.slice(0, i + 1).join("/")));
  };
}

type FileResult = "parsed" | "unchanged" | "skipped" | "partial";

/**
 * Parse one file into the graph and the code search index. Search chunks are cut at
 * the declarations the parser found, so each carries its symbol id. Every outcome
 * leaves a file_index row with a status, so coverage can be reported later.
 */
async function indexOne(
  ctx: ProjectContext,
  db: StorageAdapter,
  rel: string,
  force: boolean,
): Promise<FileResult> {
  const abs = join(ctx.root, rel);
  const st = statSync(abs);
  const backend = getCodeBackend(ctx);
  const language = backend.languageOf(rel) ?? null;
  if (st.size > MAX_CODE_BYTES) {
    const prev = db.fileIndexGet(rel);
    if (prev?.status !== "skipped" || prev.size !== st.size) {
      db.fileIndexSet({
        path: rel,
        hash: "",
        mtime: st.mtimeMs,
        size: st.size,
        language,
        document_id: prev?.document_id ?? null,
        status: "skipped",
        reason: `over ${Math.round((MAX_CODE_BYTES / 1_000_000) * 10) / 10} MB`,
      });
    }
    return "skipped";
  }
  const code = readFileSync(abs, "utf8");
  const hash = hashText(code);
  const prev = db.fileIndexGet(rel);
  if (!force && prev?.hash === hash && prev.status !== "skipped") return "unchanged";
  const parsed = await backend.parse(ctx.root, rel, code);
  const spans: SymbolSpan[] = parsed.nodes
    .filter(
      (n) => n.path === rel && n.kind !== "file" && n.kind !== "package" && n.kind !== "route",
    )
    .map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      startLine: n.startLine ?? 0,
      endLine: n.endLine ?? 0,
    }));
  const doc = indexContent(db, {
    source: "code",
    title: rel,
    uri: `file://${abs}`,
    content: code,
    kind: "code",
    chunks: spans.length ? chunkBySymbols(code, rel, spans) : undefined,
    force,
  });
  const status: FileIndexStatus = parsed.errors ? "partial" : "indexed";
  db.transaction(() => {
    // keep the file node so git-derived meta (hotspots) survives a re-parse
    db.graphDeleteForPath("tree-sitter", rel, { keepFile: true });
    db.graphUpsertNodes(parsed.nodes);
    db.graphUpsertEdges(parsed.edges);
    db.fileIndexSet({
      path: rel,
      hash,
      mtime: st.mtimeMs,
      size: st.size,
      language,
      document_id: doc.documentId,
      status,
      reason: parsed.errors
        ? `${parsed.errors} syntax error${parsed.errors === 1 ? "" : "s"} recovered`
        : null,
      symbols: spans.length,
    });
  });
  return status === "partial" ? "partial" : "parsed";
}

function removeOne(db: StorageAdapter, rel: string): void {
  const prev = db.fileIndexGet(rel);
  db.transaction(() => {
    db.graphDeleteForPath("tree-sitter", rel);
    if (prev?.document_id) db.deleteDocument(prev.document_id);
    db.fileIndexDelete(rel);
  });
}

/** Link pass + metrics; run after anything changed the graph. */
export function finalizeGraph(db: StorageAdapter): { link: LinkSummary; metrics: MetricsSummary } {
  const link = linkGraph(db);
  const metrics = computeMetrics(db);
  return { link, metrics };
}

/** Full or partial code reindex. With `paths`, only those files are (re)parsed. */
export async function reindexCode(
  ctx: ProjectContext,
  db: StorageAdapter,
  opts: { paths?: string[] | undefined; full?: boolean | undefined } = {},
): Promise<CodeSummary> {
  const started = Date.now();
  const summary: CodeSummary = {
    scanned: 0,
    parsed: 0,
    removed: 0,
    unchanged: 0,
    skipped: 0,
    partial: 0,
    unsupported: 0,
    errors: [],
    durationMs: 0,
  };
  const backend = getCodeBackend(ctx);
  const stale = db.metaGet("code_index_version") !== CODE_INDEX_VERSION;
  const full = (opts.full ?? false) || (stale && !opts.paths?.length);
  const partialRun = !!opts.paths?.length;
  const all = partialRun ? (opts.paths ?? []) : listCodeFiles(ctx);
  const targets = all.filter((p) => backend.supports(p));
  const run = partialRun ? undefined : db.indexRunStart("code", gitHead(ctx.root));
  summary.scanned = all.length;
  // Files the globs include but no parser handles: recorded once so coverage can show them.
  for (const rel of all) {
    if (backend.supports(rel)) continue;
    summary.unsupported++;
    if (db.fileIndexGet(rel)?.status === "unsupported") continue;
    try {
      const st = statSync(join(ctx.root, rel));
      db.fileIndexSet({
        path: rel,
        hash: "",
        mtime: st.mtimeMs,
        size: st.size,
        language: null,
        document_id: null,
        status: "unsupported",
        reason: `no parser for ${rel.slice(rel.lastIndexOf("."))}`,
      });
    } catch {
      // vanished between glob and stat
    }
  }
  for (const rel of targets) {
    try {
      if (!statSafe(join(ctx.root, rel))) {
        if (db.fileIndexGet(rel)) {
          removeOne(db, rel);
          summary.removed++;
        }
        continue;
      }
      summary[await indexOne(ctx, db, rel, full)]++;
    } catch (err) {
      const error = (err as Error).message;
      summary.errors.push({ path: rel, error });
      // hash "" makes the next run retry the file
      try {
        const st = statSync(join(ctx.root, rel));
        db.fileIndexSet({
          path: rel,
          hash: "",
          mtime: st.mtimeMs,
          size: st.size,
          language: backend.languageOf(rel) ?? null,
          document_id: db.fileIndexGet(rel)?.document_id ?? null,
          status: "skipped",
          reason: "parser error",
          errors: error.slice(0, 500),
        });
      } catch {
        // ignore
      }
    }
  }
  if (!partialRun) {
    // files that disappeared since the last full scan
    const live = new Set(all);
    for (const row of db.fileIndexAll()) {
      if (!live.has(row.path) && (backend.supports(row.path) || row.status === "unsupported")) {
        removeOne(db, row.path);
        summary.removed++;
      }
    }
    if (full) db.metaSet("code_index_version", CODE_INDEX_VERSION);
  }
  const changed = summary.parsed + summary.partial + summary.removed > 0;
  if (changed || (db.graphCounts().nodes > 0 && db.metricsCount() === 0)) {
    const f = finalizeGraph(db);
    summary.link = f.link;
    summary.metrics = f.metrics;
  }
  summary.durationMs = Date.now() - started;
  if (!partialRun) {
    db.metaSet(
      "coverage_summary",
      JSON.stringify({
        at: Date.now(),
        scanned: summary.scanned,
        unsupported: summary.unsupported,
        skipped: summary.skipped,
        partial: summary.partial,
        durationMs: summary.durationMs,
        include: ctx.config.graph.include,
        exclude: ctx.config.graph.exclude,
      }),
    );
  }
  if (run !== undefined) {
    db.indexRunFinish(run, {
      scanned: summary.scanned,
      indexed: summary.parsed + summary.partial,
      unchanged: summary.unchanged,
      skipped: summary.skipped + summary.unsupported,
      removed: summary.removed,
      errors: summary.errors.length,
      detail: summary.errors.length
        ? summary.errors
            .slice(0, 5)
            .map((e) => `${e.path}: ${e.error}`)
            .join("\n")
        : null,
    });
  }
  return summary;
}

function statSafe(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

let draining = false;

/** Parse files queued by the PostToolUse hook (Edit/Write). Cheap when the queue is empty. */
export async function drainReindexQueue(ctx: ProjectContext, db: StorageAdapter): Promise<number> {
  if (draining) return 0;
  const paths = db.reindexQueueDrain().filter(codeFileFilter(ctx.config.graph));
  if (!paths.length) return 0;
  draining = true;
  try {
    const s = await reindexCode(ctx, db, { paths });
    return s.parsed + s.partial + s.removed;
  } finally {
    draining = false;
  }
}

export function reindexGitSignals(
  ctx: ProjectContext,
  db: StorageAdapter,
  full = false,
): GitSummary {
  const run = db.indexRunStart("git", gitHead(ctx.root));
  try {
    const g = reindexGit(db, ctx.root, { maxCommits: ctx.config.git.maxCommits, full });
    if (g.commits && db.graphCounts().nodes) computeMetrics(db);
    db.indexRunFinish(run, {
      scanned: g.commits,
      indexed: g.files,
      detail: g.commits ? `${g.coChangeEdges} co-change pairs` : "unchanged",
    });
    return g;
  } catch (err) {
    db.indexRunFinish(run, { errors: 1, detail: (err as Error).message });
    throw err;
  }
}

/** How stale the index is relative to the working tree and git HEAD. */
export function indexFreshness(
  ctx: ProjectContext,
  db: StorageAdapter,
): {
  head: string | undefined;
  indexedHead: string | undefined;
  headMatches: boolean;
  queued: number;
  /** Indexed files whose content hash no longer matches the file on disk (sampled, max 400). */
  dirty: string[];
  lastRun: number | null;
} {
  const head = gitHead(ctx.root);
  const indexedHead = db.metaGet("last_git_sha");
  const rows = db.fileIndexAll().filter((r) => r.status === "indexed" || r.status === "partial");
  const dirty: string[] = [];
  for (const r of rows.slice(0, 400)) {
    try {
      const abs = join(ctx.root, r.path);
      const st = statSync(abs);
      if (r.mtime !== null && Math.abs(st.mtimeMs - r.mtime) < 1 && st.size === r.size) continue;
      if (hashText(readFileSync(abs, "utf8")) !== r.hash) dirty.push(r.path);
    } catch {
      dirty.push(r.path);
    }
  }
  return {
    head,
    indexedHead,
    headMatches: !!head && head === indexedHead,
    queued: db.reindexQueueSize(),
    dirty,
    lastRun: db.indexRunsRecent(1)[0]?.finished_at ?? null,
  };
}
