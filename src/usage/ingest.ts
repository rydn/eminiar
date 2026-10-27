/**
 * Incremental transcript ingest: reads only the bytes appended since the last pass
 * (transcript_files remembers the offset), prices each call and upserts the rows.
 * Cheap enough to run from hooks; every entry point swallows I/O errors.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { ApiCallInput, ContextEventInput, TranscriptFileRow } from "../storage/types.js";
import { costOfCall, type PricingOverrides, resolvePrice } from "./pricing.js";
import { parseTranscriptLines } from "./transcript.js";

export type { PricingOverrides } from "./pricing.js";

export interface IngestOptions {
  /** Session the file belongs to when its entries do not say (sidechain files do). */
  sessionId?: string | undefined;
  /** config.usage.pricing: per-model-substring price overrides, USD per MTok. */
  overrides?: PricingOverrides | undefined;
}

export interface IngestCounts {
  calls: number;
  toolUses: number;
  contextEvents: number;
}

const ZERO: IngestCounts = { calls: 0, toolUses: 0, contextEvents: 0 };

/** Bytes hashed to fingerprint a file's head (see TranscriptFileRow.head_hash). */
const HEAD_BYTES = 512;
/** Statusline snapshots older than this, or beyond this many per session, are pruned on ingest. */
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const SNAPSHOT_KEEP_PER_SESSION = 500;

/** Claude Code session ids are UUIDs; anything else (path separators, dots) is refused. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** The Claude Code data dir; EMINIAR_CLAUDE_DIR overrides ~/.claude (tests, unusual installs). */
export function claudeDir(): string {
  return process.env.EMINIAR_CLAUDE_DIR || join(homedir(), ".claude");
}

/** True when `path` (resolved) is `dir` or lives below it. */
function insideDir(path: string, dir: string): boolean {
  const d = resolve(dir);
  const p = resolve(path);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * Paths handed to us by a hook payload or the sessions table are trusted sources, but
 * still have to name a transcript: a regular .jsonl file.
 */
function isTranscriptFile(path: string): boolean {
  if (!path.endsWith(".jsonl")) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Project cwd → transcript slug: every char outside [A-Za-z0-9] becomes "-". */
export function transcriptSlug(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, "-");
}

/** Directory holding the transcripts of the project at `root`. */
export function transcriptDirFor(root: string): string {
  return join(claudeDir(), "projects", transcriptSlug(root));
}

export function usageEnabled(ctx: ProjectContext): boolean {
  return ctx.config.usage.enabled !== false;
}

/** Fill cost_usd / priced from the pricing table; unknown models stay unpriced. */
export function priceCalls(calls: ApiCallInput[], overrides?: PricingOverrides): ApiCallInput[] {
  return calls.map((c) => {
    const price = resolvePrice(c.model, overrides);
    if (!price) return { ...c, cost_usd: null, priced: 0 };
    return { ...c, cost_usd: costOfCall(c, price).total, priced: 1 };
  });
}

/** Read bytes [offset, size) and return the complete lines plus the offset just past them. */
function readCompleteLines(
  path: string,
  offset: number,
  size: number,
): { lines: string[]; nextOffset: number } {
  const length = size - offset;
  if (length <= 0) return { lines: [], nextOffset: offset };
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a, read - 1);
  if (end < 0) return { lines: [], nextOffset: offset }; // one unfinished line: wait for it
  const text = buf.toString("utf8", 0, end + 1);
  return { lines: text.split("\n"), nextOffset: offset + end + 1 };
}

/** sha1 of the first `length` bytes of the file (the whole file when shorter). */
function headHash(path: string, length: number): string | null {
  if (length <= 0) return null;
  const buf = Buffer.alloc(length);
  let read = 0;
  const fd = openSync(path, "r");
  try {
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return createHash("sha1").update(buf.subarray(0, read)).digest("hex");
}

/** The byte at `pos`, or undefined past the end. */
function byteAt(path: string, pos: number): number | undefined {
  if (pos < 0) return undefined;
  const buf = Buffer.alloc(1);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, buf, 0, 1, pos) === 1 ? buf[0] : undefined;
  } finally {
    closeSync(fd);
  }
}

function sessionIdFromName(path: string): string | undefined {
  // <dir>/<sessionId>/subagents/agent-x.jsonl → <sessionId>; <dir>/<sessionId>.jsonl → <sessionId>
  const dir = dirname(path);
  if (basename(dir) === "subagents") return basename(dirname(dir));
  const name = basename(path, ".jsonl");
  return name.startsWith("agent-") ? undefined : name;
}

/** Context events are plain inserts; a restart from byte 0 must not duplicate them. */
function contextEventExists(db: StorageAdapter, e: ContextEventInput): boolean {
  return db
    .contextEvents({ sessionId: e.session_id, since: e.ts, until: e.ts + 1 })
    .some((x) => x.kind === e.kind);
}

/**
 * Where to resume reading `path`: the stored offset when the file only grew, else 0.
 * A restart is forced when the file shrank, when the head fingerprint changed (rewritten
 * with the same or a larger size) or when it was touched and the stored offset no longer
 * sits on a line boundary (the old tail was replaced). Rows from the old content stay:
 * they are keyed by request/message id and tool_use_id, so a re-read of unchanged
 * entries is idempotent, and stale rows only arise if Claude Code rewrote history,
 * which it does not do.
 */
function resumeOffset(
  path: string,
  prev: TranscriptFileRow | undefined,
  size: number,
  mtime: number,
): number {
  if (!prev || prev.offset <= 0) return 0;
  if (size < prev.offset) return 0;
  if (prev.head_hash) {
    const want = Math.min(HEAD_BYTES, prev.size);
    try {
      if (headHash(path, want) !== prev.head_hash) return 0;
    } catch {
      return 0;
    }
  }
  if (prev.mtime !== mtime) {
    try {
      if (byteAt(path, prev.offset - 1) !== 0x0a) return 0;
    } catch {
      return 0;
    }
  }
  return prev.offset;
}

/**
 * Ingest everything appended to one transcript since the last pass. A trailing partial
 * line is left for the next pass; a file that shrank or was rewritten restarts from 0,
 * which is safe because api_calls and tool_uses upserts are idempotent.
 */
export function ingestTranscript(
  db: StorageAdapter,
  path: string,
  opts: IngestOptions = {},
): IngestCounts {
  if (!path.endsWith(".jsonl")) return ZERO;
  let size: number;
  let mtime: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return ZERO;
    size = st.size;
    mtime = Math.floor(st.mtimeMs);
  } catch {
    return ZERO;
  }
  const prev = db.transcriptFileGet(path);
  const offset = resumeOffset(path, prev, size, mtime);
  const sessionHint = opts.sessionId ?? prev?.session_id ?? sessionIdFromName(path);
  if (offset === size) {
    if (!prev || prev.size !== size || prev.mtime !== mtime || (sessionHint && !prev.session_id))
      db.transcriptFileSet({
        path,
        session_id: sessionHint ?? null,
        offset,
        size,
        mtime,
        head_hash: prev?.size === size ? (prev.head_hash ?? null) : fingerprint(path, size),
        ingested_at: Date.now(),
      });
    return ZERO;
  }
  const { lines, nextOffset } = readCompleteLines(path, offset, size);
  const parsed = parseTranscriptLines(lines, {
    sessionId: sessionHint ?? "unknown",
    path,
    fallbackTs: mtime,
  });
  const calls = priceCalls(parsed.calls, opts.overrides);
  const counts: IngestCounts = { calls: 0, toolUses: 0, contextEvents: 0 };
  const sessionSeen = parsed.calls[0]?.session_id ?? parsed.toolUses[0]?.session_id;
  const head = fingerprint(path, size);
  db.transaction(() => {
    counts.calls = db.apiCallsUpsert(calls);
    counts.toolUses = db.toolUsesUpsert(parsed.toolUses);
    for (const e of parsed.contextEvents) {
      if (contextEventExists(db, e)) continue;
      db.contextEventInsert(e);
      counts.contextEvents++;
    }
    db.transcriptFileSet({
      path,
      session_id: sessionHint ?? sessionSeen ?? null,
      offset: nextOffset,
      size,
      mtime,
      head_hash: head,
      ingested_at: Date.now(),
    });
  });
  return counts;
}

function fingerprint(path: string, size: number): string | null {
  try {
    return headHash(path, Math.min(HEAD_BYTES, size));
  } catch {
    return null;
  }
}

/** Keep statusline_snapshots bounded; runs in the ingest write path, so it must stay cheap. */
function pruneSnapshots(db: StorageAdapter): void {
  try {
    db.statuslineSnapshotsPrune({
      olderThan: Date.now() - SNAPSHOT_MAX_AGE_MS,
      keepPerSession: SNAPSHOT_KEEP_PER_SESSION,
    });
  } catch {
    // bookkeeping only
  }
}

function add(a: IngestCounts, b: IngestCounts): IngestCounts {
  return {
    calls: a.calls + b.calls,
    toolUses: a.toolUses + b.toolUses,
    contextEvents: a.contextEvents + b.contextEvents,
  };
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** The sessionId written in a file's first entry, read with a bounded head (no full scan). */
function firstEntrySessionId(path: string): string | undefined {
  try {
    const { lines } = readCompleteLines(path, 0, Math.min(statSync(path).size, 64 * 1024));
    for (const line of lines) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { sessionId?: unknown };
      return typeof e.sessionId === "string" ? e.sessionId : undefined;
    }
  } catch {
    // unreadable or not yet a full line
  }
  return undefined;
}

/**
 * Sidechain transcripts that belong to `sessionId`, next to its main transcript. `dir` is
 * the directory of a trusted main transcript; every candidate must resolve inside it and
 * the id must be a plain token, so no name can escape the directory.
 */
function sidechainFilesFor(db: StorageAdapter, dir: string, sessionId: string): string[] {
  if (!isValidSessionId(sessionId)) return [];
  const inside = (p: string) => insideDir(p, dir) && p.endsWith(".jsonl");
  const out = listJsonl(join(dir, sessionId, "subagents")).filter(inside);
  for (const path of listJsonl(dir)) {
    if (!inside(path) || !basename(path).startsWith("agent-")) continue;
    const known = db.transcriptFileGet(path)?.session_id;
    let owner = known ?? undefined;
    if (!owner) {
      owner = firstEntrySessionId(path);
      if (owner) {
        // Remember the owner so later passes skip the head read; offset 0 keeps the file pending.
        db.transcriptFileSet({
          path,
          session_id: owner,
          offset: 0,
          size: 0,
          mtime: 0,
          ingested_at: Date.now(),
        });
      }
    }
    if (owner === sessionId) out.push(path);
  }
  return out;
}

/**
 * Ingest one session: its main transcript (the sessions table knows the path, or the
 * caller does, or it is <slug dir>/<sessionId>.jsonl) and its sidechain files.
 *
 * The session id comes from tool arguments as well as hook payloads, so it is validated
 * before it becomes part of a path, and a path built from it must stay under claudeDir().
 * An explicit `transcriptPath` (hook payload) or the sessions table's path is trusted
 * but must still name a regular .jsonl file.
 */
export function ingestSession(
  db: StorageAdapter,
  root: string,
  sessionId: string,
  transcriptPath?: string,
  opts: Omit<IngestOptions, "sessionId"> = {},
): IngestCounts {
  if (!isValidSessionId(sessionId)) return ZERO;
  let main: string | undefined;
  const trusted = transcriptPath ?? db.sessionGet(sessionId)?.transcript_path ?? undefined;
  if (trusted) {
    if (!isTranscriptFile(trusted)) return ZERO;
    main = resolve(trusted);
  } else {
    const built = resolve(transcriptDirFor(root), `${sessionId}.jsonl`);
    if (!insideDir(built, claudeDir())) return ZERO;
    main = built;
  }
  let total = ingestTranscript(db, main, { sessionId, overrides: opts.overrides });
  for (const path of sidechainFilesFor(db, dirname(main), sessionId)) {
    total = add(total, ingestTranscript(db, path, { sessionId, overrides: opts.overrides }));
  }
  pruneSnapshots(db);
  return total;
}

/**
 * Ingest every transcript of the project: the slug directory (main files and
 * <session>/subagents/*.jsonl) plus any transcript_path the sessions table knows.
 * Files whose size and mtime are unchanged are skipped without being opened.
 */
export function ingestProject(
  db: StorageAdapter,
  root: string,
  opts: Omit<IngestOptions, "sessionId"> = {},
): IngestCounts & { files: number } {
  const dir = transcriptDirFor(root);
  const files = new Set<string>(listJsonl(dir));
  if (existsSync(dir)) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory())
          for (const sub of listJsonl(join(dir, entry.name, "subagents"))) files.add(sub);
      }
    } catch {
      // listed what we could
    }
  }
  for (const s of db.sessionsRecent(1000)) if (s.transcript_path) files.add(s.transcript_path);

  let total: IngestCounts = ZERO;
  let touched = 0;
  for (const path of files) {
    let st: { size: number; mtime: number };
    try {
      const s = statSync(path);
      if (!s.isFile()) continue;
      st = { size: s.size, mtime: Math.floor(s.mtimeMs) };
    } catch {
      continue;
    }
    const prev = db.transcriptFileGet(path);
    if (prev && prev.size === st.size && prev.mtime === st.mtime && prev.offset === st.size)
      continue;
    touched++;
    const sessionId = prev?.session_id ?? sessionIdFromName(path);
    total = add(total, ingestTranscript(db, path, { sessionId, overrides: opts.overrides }));
  }
  pruneSnapshots(db);
  return { ...total, files: touched };
}
