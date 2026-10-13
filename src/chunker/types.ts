import { createHash } from "node:crypto";
import type { ChunkInput, ContentType } from "../storage/types.js";

export interface ChunkerOptions {
  /** Soft maximum characters per chunk. */
  maxChars: number;
  /** Lines of overlap between consecutive windows for code/text. */
  overlapLines: number;
}

export const DEFAULT_CHUNKER: ChunkerOptions = { maxChars: 1800, overlapLines: 5 };

export interface RawChunk {
  title: string;
  body: string;
  startLine: number;
  endLine: number;
  /** Graph symbol this chunk belongs to (code cut at declaration boundaries). */
  symbolId?: string | undefined;
}

export function hashText(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function finalize(raw: RawChunk[], contentType: ContentType): ChunkInput[] {
  return raw
    .filter((r) => r.body.trim().length > 0)
    .map((r, ord) => ({
      ord,
      title: r.title,
      body: r.body,
      contentType,
      startLine: r.startLine,
      endLine: r.endLine,
      hash: hashText(r.body),
      symbolId: r.symbolId,
    }));
}

/**
 * Pack consecutive lines into windows of at most `maxChars`, preferring to break
 * at `isBoundary` lines, with `overlapLines` lines repeated at each window start.
 */
export function windowLines(
  lines: string[],
  opts: ChunkerOptions,
  isBoundary: (line: string, i: number) => boolean,
  titleFor: (start: number, end: number) => string,
  lineOffset = 0,
): RawChunk[] {
  const out: RawChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let size = 0;
    let end = start;
    let lastBoundary = -1;
    while (end < lines.length) {
      const len = (lines[end]?.length ?? 0) + 1;
      if (size + len > opts.maxChars && end > start) break;
      size += len;
      end++;
      if (end < lines.length && isBoundary(lines[end] ?? "", end)) lastBoundary = end;
    }
    // Prefer a boundary if it keeps the window at least half full.
    if (end < lines.length && lastBoundary > start && lastBoundary - start >= (end - start) / 2)
      end = lastBoundary;
    const body = lines.slice(start, end).join("\n");
    out.push({
      title: titleFor(start + lineOffset + 1, end + lineOffset),
      body,
      startLine: start + lineOffset + 1,
      endLine: end + lineOffset,
    });
    if (end >= lines.length) break;
    start = Math.max(end - opts.overlapLines, start + 1);
  }
  return out;
}
