import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";
import { chunk, hashText, type Kind } from "../chunker/index.js";
import { finalize, type RawChunk } from "../chunker/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
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
}

/** Chunk + store one piece of content. Unchanged uri+content is a no-op (created=false). */
export function indexContent(db: StorageAdapter, input: IndexInput): IndexResult {
  const kind =
    input.kind ??
    (input.contentType === "code" ? "code" : input.contentType === "json" ? "json" : undefined);
  const { chunks, kind: k } = input.chunks
    ? { chunks: finalize(input.chunks, input.contentType ?? "code"), kind: kind ?? "code" }
    : chunk(input.content, input.title, kind, input.uri);
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
  return { documentId: id, created, chunks: chunks.length, chars: input.content.length, kind: k };
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexPathSummary {
  files: number;
  indexed: number;
  unchanged: number;
  skipped: Array<{ path: string; reason: string }>;
  chunks: number;
}

/** Index a file or every file under a directory matching `globs` (relative to the directory). */
export function indexPath(
  db: StorageAdapter,
  root: string,
  target: string,
  opts: { source?: Source; globs?: string[]; recursive?: boolean; ignore?: string[] } = {},
): IndexPathSummary {
  const abs = resolve(root, target);
  const summary: IndexPathSummary = { files: 0, indexed: 0, unchanged: 0, skipped: [], chunks: 0 };
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
      const r = indexContent(db, {
        source: opts.source ?? "file",
        title: rel,
        content,
        uri: `file://${file}`,
      });
      if (r.created) summary.indexed++;
      else summary.unchanged++;
      summary.chunks += r.chunks;
    } catch (err) {
      summary.skipped.push({ path: rel, reason: (err as Error).message });
    }
  }
  return summary;
}
