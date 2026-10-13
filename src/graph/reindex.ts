import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import { hashText } from "../chunker/index.js";
import { chunkBySymbols, type SymbolSpan } from "../chunker/symbols.js";
import { getCodeBackend } from "../code/backend.js";
import type { ProjectContext } from "../context.js";
import { indexContent } from "../index/indexer.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { reindexGit } from "./git.js";
import { grammarFor } from "./treesitter.js";

export interface CodeSummary {
  scanned: number;
  parsed: number;
  removed: number;
  unchanged: number;
  /** Files over the size limit. */
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

/** Largest file the parser is asked to handle (minified bundles are not worth a graph). */
export const MAX_CODE_BYTES = 1_500_000;

/**
 * Bumped when how code is parsed or chunked changes; a database built by an older
 * version gets one automatic full pass so every file carries symbol chunks and
 * reference edges without anyone remembering to run `em_reindex {full: true}`.
 */
const CODE_INDEX_VERSION = "2";

function listCodeFiles(ctx: ProjectContext): string[] {
  return fg.sync(ctx.config.graph.include, {
    cwd: ctx.root,
    ignore: ctx.config.graph.exclude,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });
}

/**
 * Parse one file into the graph and the code search index. Search chunks are cut at
 * the declarations the parser found, so each carries its symbol id.
 */
async function indexOne(
  ctx: ProjectContext,
  db: StorageAdapter,
  rel: string,
  force: boolean,
): Promise<"parsed" | "unchanged" | "skipped"> {
  const abs = join(ctx.root, rel);
  const st = statSync(abs);
  if (st.size > MAX_CODE_BYTES) return "skipped";
  const code = readFileSync(abs, "utf8");
  const hash = hashText(code);
  const prev = db.fileIndexGet(rel);
  if (!force && prev?.hash === hash) return "unchanged";
  const parsed = await getCodeBackend(ctx).parse(ctx.root, rel, code);
  const spans: SymbolSpan[] = parsed.nodes
    .filter((n) => n.path === rel && n.kind !== "file" && n.kind !== "package")
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
      language: grammarFor(rel) ?? null,
      document_id: doc.documentId,
    });
  });
  return "parsed";
}

function removeOne(db: StorageAdapter, rel: string): void {
  const prev = db.fileIndexGet(rel);
  db.transaction(() => {
    db.graphDeleteForPath("tree-sitter", rel);
    if (prev?.document_id) db.deleteDocument(prev.document_id);
    db.fileIndexDelete(rel);
  });
}

/** Full or partial code reindex. With `paths`, only those files are (re)parsed. */
export async function reindexCode(
  ctx: ProjectContext,
  db: StorageAdapter,
  opts: { paths?: string[] | undefined; full?: boolean | undefined } = {},
): Promise<CodeSummary> {
  const summary: CodeSummary = {
    scanned: 0,
    parsed: 0,
    removed: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
  };
  const backend = getCodeBackend(ctx);
  const stale = db.metaGet("code_index_version") !== CODE_INDEX_VERSION;
  const full = (opts.full ?? false) || (stale && !opts.paths?.length);
  const targets = opts.paths?.length
    ? opts.paths.filter((p) => backend.supports(p))
    : listCodeFiles(ctx).filter((p) => backend.supports(p));
  summary.scanned = targets.length;
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
      summary.errors.push({ path: rel, error: (err as Error).message });
    }
  }
  if (!opts.paths?.length) {
    // files that disappeared since the last full scan
    const live = new Set(targets);
    for (const row of db.fileIndexAll()) {
      if (!live.has(row.path) && grammarFor(row.path)) {
        removeOne(db, row.path);
        summary.removed++;
      }
    }
    if (full) db.metaSet("code_index_version", CODE_INDEX_VERSION);
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
  const paths = db.reindexQueueDrain();
  if (!paths.length) return 0;
  draining = true;
  try {
    const s = await reindexCode(ctx, db, { paths });
    return s.parsed + s.removed;
  } finally {
    draining = false;
  }
}

export function reindexGitSignals(ctx: ProjectContext, db: StorageAdapter, full = false) {
  return reindexGit(db, ctx.root, { maxCommits: ctx.config.git.maxCommits, full });
}
