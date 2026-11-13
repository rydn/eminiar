import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";
import { redactSecrets } from "../adjudicator/redact.js";
import { chunk, hashText, type Kind, kindToContentType } from "../chunker/index.js";
import { finalize, type RawChunk } from "../chunker/types.js";
import { within } from "../docs/manifest.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { RECALL_BACKFILL_KEY } from "../storage/sqlite/schema.js";
import type { ContentType, Source } from "../storage/types.js";

export interface IndexInput {
  source: Source;
  title: string;
  content: string;
  uri?: string | undefined;
  kind?: Kind | undefined;
  contentType?: ContentType | undefined;
  sessionId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  /** Pre-cut chunks (e.g. symbol-aligned code); skips the generic chunker. */
  chunks?: RawChunk[] | undefined;
  /** Re-chunk even when the content is unchanged (the chunking itself changed). */
  force?: boolean | undefined;
}

export interface IndexResult {
  documentId: number;
  created: boolean;
  chunks: number;
  chars: number;
  kind: Kind;
  /** The chunker found nothing in non-empty content, so the whole content became one chunk. */
  fallback: boolean;
}

/**
 * Captured output: what em_execute, em_execute_file, em_batch_execute and em_fetch_and_index
 * store. Unlike a project file or a memory, the index holds the only copy, it outlives the session
 * and any later em_search reads it, so secrets are masked before it is chunked. What the tools
 * show inline (small outputs, the head/tail preview) is as printed; sections they return for an
 * intent or queries come from this masked copy.
 */
const CAPTURED = new Set<Source>(["exec", "batch", "url"]);

/** Bump when the masking rules change enough that stored output should be masked again. */
const CAPTURED_MASK_VERSION = "1";

/** A captured document as stored: title, content, pre-cut chunks and string meta masked. */
function maskCaptured(input: IndexInput): IndexInput {
  const meta = input.meta
    ? Object.fromEntries(
        Object.entries(input.meta).map(([k, v]) => [
          k,
          typeof v === "string" ? redactSecrets(v) : v,
        ]),
      )
    : undefined;
  return {
    ...input,
    title: redactSecrets(input.title),
    content: redactSecrets(input.content),
    meta,
    chunks: input.chunks?.map((c) => ({
      ...c,
      title: redactSecrets(c.title),
      body: redactSecrets(c.body),
    })),
  };
}

/** How long one slice of the re-mask may read and mask before it writes and yields to tool calls. */
const REMASK_SLICE_MS = 20;

/**
 * The pause after a slice that wrote. Another process waiting on the lock retries on its own
 * schedule (every 25-50 ms by then), so a lock taken again at once would starve it; this leaves
 * it a gap as long as the remask's longest hold.
 */
const REMASK_GAP_MS = 40;

/** A busy database: retry after 50 ms, doubling to 2 s, and give up after this many in a row. */
const REMASK_BUSY_TRIES = 40;
const REMASK_BUSY_FIRST_MS = 50;
const REMASK_BUSY_MAX_MS = 2000;

/** The lock wait of the remask's own progress write (the default is 2000 ms, which stalls tool calls). */
const REMASK_LOCK_WAIT_MS = 40;

const isBusy = (err: unknown): boolean =>
  /^SQLITE_(BUSY|LOCKED)/.test(String((err as { code?: unknown } | null)?.code ?? ""));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => (ms > 0 ? setTimeout(resolve, ms) : setImmediate(resolve)));

/** `fn`, retried with a growing pause while another process holds the database. */
async function whenFree<T>(fn: () => T): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || tries >= REMASK_BUSY_TRIES) throw err;
      await sleep(Math.min(REMASK_BUSY_MAX_MS, REMASK_BUSY_FIRST_MS * 2 ** (tries - 1)));
    }
  }
}

/**
 * `<CAPTURED_MASK_VERSION>:<id>`: every captured document up to that id is masked under these
 * rules. Document ids are AUTOINCREMENT, so they are never handed out again below it.
 */
const CAPTURED_MASK_KEY = "captured_mask_upto";

/**
 * Mask captured output stored before it was masked (or under older rules) in place. The server
 * runs it in its warm-up on every start: the first run goes over the whole database, and later
 * ones only over the documents stored since, which catches output that an older eminiar still
 * running on the same database stored unmasked meanwhile. It yields every REMASK_SLICE_MS so a
 * tool call is never queued behind it, pauses REMASK_GAP_MS after each write so hooks get the
 * lock, waits out a busy database (a second server starting with this one), and records where it
 * got to after each slice, so a server stopped halfway resumes there. Hooks never run it. Returns
 * the number of rows (chunks and document titles) that changed.
 */
export async function remaskCapturedOutput(db: StorageAdapter): Promise<number> {
  const saved = db.metaGet(CAPTURED_MASK_KEY);
  const [version, id] = (saved ?? "").split(":");
  let afterId = version === CAPTURED_MASK_VERSION ? Number(id) || 0 : 0;
  let pointer = saved;
  let changed = 0;
  const shortWait = <T>(fn: () => T): T =>
    db.adjudicator.withLockWait ? db.adjudicator.withLockWait(REMASK_LOCK_WAIT_MS, fn) : fn();
  for (;;) {
    const slice = await whenFree(() =>
      db.remaskDocuments([...CAPTURED], redactSecrets, afterId, REMASK_SLICE_MS),
    );
    changed += slice.changed;
    afterId = slice.lastId;
    // Written after the slice, not inside its transactions: a stop between the two only redoes
    // documents that are already masked, which changes nothing.
    const next = `${CAPTURED_MASK_VERSION}:${afterId}`;
    if (next !== pointer) {
      await whenFree(() => shortWait(() => db.metaSet(CAPTURED_MASK_KEY, next)));
      pointer = next;
    }
    if (slice.done) return changed;
    await sleep(slice.wrote ? REMASK_GAP_MS : 0);
  }
}

/**
 * Fill the recall index with the memories, docs pages and captured errors stored before it
 * existed (a database upgraded to it, or one whose index was made again). Opening the database
 * only creates the empty index and its triggers, which keep new rows in step from then on; until
 * this finishes, recall finds nothing. The server starts it in the background and `eminiar
 * reindex` runs it; hooks that do not hold up a prompt run a few slices of it with
 * fillRecallIndexBriefly. Short slices (up to 500 rows, a few tens of ms of the write lock each)
 * with REMASK_GAP_MS between them so hooks get the lock, waiting out a busy database; the cursor
 * is saved in each slice, so a process stopped halfway resumes there. Returns the rows copied.
 */
export async function backfillRecallIndex(db: StorageAdapter): Promise<number> {
  let rows = 0;
  for (;;) {
    const step = await whenFree(() => db.recallBackfillStep());
    rows += step.rows;
    if (step.done) return rows;
    await sleep(REMASK_GAP_MS);
  }
}

/**
 * Where the recall index fill stands: undefined when the index is complete (or the database
 * cannot say), else the id of the last document the fill has copied (0: not started). A read of
 * one meta row, no lock taken.
 */
export function recallIndexFilling(db: StorageAdapter): { after: number } | undefined {
  try {
    const v = db.metaGet(RECALL_BACKFILL_KEY);
    return v === undefined ? undefined : { after: Number(v) || 0 };
  } catch {
    return undefined;
  }
}

/** The time a hook's fill assumes for its next slice: the longest so far, at least this. */
const FILL_SLICE_FLOOR_MS = 50;

/**
 * A few slices of the recall index fill, for a hook that does not hold up the user's prompt
 * (Stop, SessionEnd, PreCompact, SubagentStop). Without it a database that no new-version MCP
 * server opens (hooks-only or Cursor use, or a session whose server is still the build from before
 * an in-place `eminiar upgrade`) would never recall again. Nothing to do (one meta read) once the
 * index is complete. Otherwise slices of backfillRecallIndex's kind, REMASK_GAP_MS apart, while
 * the next one still fits in `budgetMs` and `stop` says go on; a busy database ends it at once,
 * with no retry (the next hook carries on from the saved cursor). Other errors are thrown.
 */
export async function fillRecallIndexBriefly(
  db: StorageAdapter,
  opts: { budgetMs: number; stop?: () => boolean },
): Promise<{ rows: number; slices: number; done: boolean }> {
  if (!recallIndexFilling(db)) return { rows: 0, slices: 0, done: true };
  const started = performance.now();
  let rows = 0;
  let slices = 0;
  let longest = FILL_SLICE_FLOOR_MS;
  for (;;) {
    if (opts.stop?.()) return { rows, slices, done: false };
    const t0 = performance.now();
    let step: { done: boolean; rows: number };
    try {
      step = db.recallBackfillStep();
    } catch (err) {
      if (isBusy(err)) return { rows, slices, done: false };
      throw err;
    }
    const now = performance.now();
    longest = Math.max(longest, now - t0);
    rows += step.rows;
    slices++;
    if (step.done) return { rows, slices, done: true };
    if (now - started + REMASK_GAP_MS + longest > opts.budgetMs)
      return { rows, slices, done: false };
    await sleep(REMASK_GAP_MS);
  }
}

/** Chunk + store one piece of content. Unchanged uri+content is a no-op (created=false). */
export function indexContent(db: StorageAdapter, raw: IndexInput): IndexResult {
  const input = CAPTURED.has(raw.source) ? maskCaptured(raw) : raw;
  const kind =
    input.kind ??
    (input.contentType === "code" ? "code" : input.contentType === "json" ? "json" : undefined);
  const cut = input.chunks
    ? { chunks: finalize(input.chunks, input.contentType ?? "code"), kind: kind ?? "code" }
    : chunk(input.content, input.title, kind, input.uri);
  const k = cut.kind;
  // Nothing may index to nothing: content the chunker could not cut is stored whole.
  const fallback = cut.chunks.length === 0 && input.content.trim().length > 0;
  const chunks = fallback
    ? finalize(
        [
          {
            title: input.title,
            body: input.content,
            startLine: 1,
            endLine: input.content.split("\n").length,
          },
        ],
        kindToContentType(k),
      )
    : cut.chunks;
  const contentHash = hashText(input.content);
  const existing = input.uri ? db.findDocumentByUri(input.uri) : undefined;
  if (existing && existing.content_hash === contentHash) {
    if (!input.force) {
      return {
        documentId: existing.id,
        created: false,
        chunks: chunks.length,
        chars: input.content.length,
        kind: k,
        fallback,
      };
    }
    db.deleteDocument(existing.id);
  }
  const { id, created } = db.upsertDocument(
    {
      source: input.source,
      title: input.title,
      uri: input.uri,
      contentType: chunks[0]?.contentType ?? "prose",
      contentHash,
      sessionId: input.sessionId,
      meta: input.meta,
    },
    chunks,
  );
  return {
    documentId: id,
    created,
    chunks: chunks.length,
    chars: input.content.length,
    kind: k,
    fallback,
  };
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexPathSummary {
  files: number;
  indexed: number;
  unchanged: number;
  skipped: Array<{ path: string; reason: string }>;
  chunks: number;
  /** Files whose chunker found no sections and that were indexed as one chunk. */
  fallbacks: number;
}

/** Index a file or every file under a directory matching `globs` (relative to the directory). */
export interface IndexPathOptions {
  source?: Source | undefined;
  globs?: string[] | undefined;
  recursive?: boolean | undefined;
  ignore?: string[] | undefined;
  /** Rewrite a file before indexing (e.g. render an OpenAPI spec as markdown); undefined keeps it as is. */
  transform?:
    | ((
        content: string,
        rel: string,
      ) => { content: string; title?: string | undefined; kind?: Kind | undefined } | undefined)
    | undefined;
  /**
   * Why a file found under the target must not be read (a Read deny rule, a symlink out of the
   * project), or undefined. Refused files are reported in `skipped` and never opened; the
   * target itself is the caller's to check.
   */
  refuse?: ((file: string) => string | undefined) | undefined;
}

/**
 * An IndexPathOptions.refuse for paths that must stay inside `root` once symlinks are resolved
 * (fast-glob follows them), so a committed `docs/link -> ~` cannot index the home folder. A path
 * that cannot be resolved is left to the reader, which reports it.
 */
export function refuseOutside(root: string): (file: string) => string | undefined {
  const realRoot = realpathSync.native(root);
  return (file) => {
    let real: string;
    try {
      real = realpathSync.native(file);
    } catch {
      return undefined;
    }
    return within(real, realRoot) ? undefined : "refused, it resolves outside the project";
  };
}

/**
 * Drop every document indexed from `file` (any source), so a file a Read rule now denies, or
 * one that resolves outside the project, leaves the index instead of staying searchable.
 * Returns how many documents went.
 */
export function forgetFile(db: StorageAdapter, file: string): number {
  const uri = `file://${file}`;
  let n = 0;
  // One row per (uri, content hash); bounded so a corrupt table cannot spin.
  for (let doc = db.findDocumentByUri(uri); doc && n < 1000; doc = db.findDocumentByUri(uri)) {
    db.deleteDocument(doc.id);
    n++;
  }
  return n;
}

/**
 * Drop the documents of `source` indexed from files under `dir` that no longer exist, so a
 * deleted or renamed file stops answering searches. `seen` (files the walk just found) skips
 * the stat for the common case.
 */
function pruneMissing(db: StorageAdapter, source: Source, dir: string, seen: Set<string>): void {
  const prefix = `file://${dir.endsWith("/") ? dir : `${dir}/`}`;
  for (const doc of db.documentsBySource(source, 1_000_000)) {
    if (!doc.uri?.startsWith(prefix)) continue;
    const file = doc.uri.slice("file://".length);
    if (seen.has(file) || existsSync(file)) continue;
    db.deleteDocument(doc.id);
  }
}

export function indexPath(
  db: StorageAdapter,
  root: string,
  target: string,
  opts: IndexPathOptions = {},
): IndexPathSummary {
  const abs = resolve(root, target);
  const summary: IndexPathSummary = {
    files: 0,
    indexed: 0,
    unchanged: 0,
    skipped: [],
    chunks: 0,
    fallbacks: 0,
  };
  const st = statSync(abs);
  const files = st.isDirectory()
    ? fg.sync(opts.globs ?? ["**/*.md"], {
        cwd: abs,
        absolute: true,
        onlyFiles: true,
        deep: opts.recursive === false ? 1 : Number.POSITIVE_INFINITY,
        ignore: opts.ignore ?? ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
        dot: false,
      })
    : [abs];
  for (const file of files) {
    summary.files++;
    const rel = relative(root, file) || file;
    try {
      const refused = opts.refuse?.(file);
      if (refused) {
        // Indexed before the rule existed (or by an older version): it leaves the index too.
        forgetFile(db, file);
        summary.skipped.push({ path: rel, reason: refused });
        continue;
      }
      const size = statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        summary.skipped.push({ path: rel, reason: `too large (${size} bytes)` });
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (content.includes("\u0000")) {
        summary.skipped.push({ path: rel, reason: "binary" });
        continue;
      }
      const t = opts.transform?.(content, rel);
      const r = indexContent(db, {
        source: opts.source ?? "file",
        title: t?.title ? `${t.title} (${rel})` : rel,
        content: t?.content ?? content,
        kind: t?.kind,
        uri: `file://${file}`,
      });
      if (r.created) summary.indexed++;
      else summary.unchanged++;
      summary.chunks += r.chunks;
      if (r.fallback) summary.fallbacks++;
    } catch (err) {
      summary.skipped.push({ path: rel, reason: (err as Error).message });
    }
  }
  if (st.isDirectory()) pruneMissing(db, opts.source ?? "file", abs, new Set(files));
  return summary;
}
