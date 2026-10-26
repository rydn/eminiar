import { type ChunkerOptions, DEFAULT_CHUNKER, type RawChunk, windowLines } from "./types.js";

interface Section {
  path: string[];
  lines: string[];
  startLine: number;
}

/**
 * Split markdown by heading (any level), ignoring headings inside fenced code
 * blocks. Each section's title is its heading path ("Install > macOS"). Sections
 * longer than maxChars are windowed on paragraph boundaries; fences stay intact.
 *
 * A heading with no body of its own still yields a chunk, whose content is the heading
 * text, unless it has sub-headings: a structural parent's text already appears in every
 * descendant's title path, so emitting it would only duplicate what is searchable.
 */
export function chunkMarkdown(
  text: string,
  baseTitle: string,
  opts: ChunkerOptions = DEFAULT_CHUNKER,
): RawChunk[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: Section = { path: [], lines: [], startLine: 1 };
  let inFence = false;
  const stack: Array<{ level: number; text: string }> = [];

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      sections.push(current);
      const level = m[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: m[2]! });
      current = { path: stack.map((s) => s.text), lines: [], startLine: i + 1 };
      return;
    }
    current.lines.push(line);
  });
  sections.push(current);

  const out: RawChunk[] = [];
  sections.forEach((s, k) => {
    const title = s.path.length ? `${baseTitle} > ${s.path.join(" > ")}` : baseTitle;
    const body = s.lines.join("\n");
    if (!body.trim()) {
      // Bodiless: a heading-only section is searchable by its own text; a preamble
      // without a heading, or a parent of the next section, contributes nothing new.
      const next = sections[k + 1];
      const isParent =
        next !== undefined &&
        next.path.length > s.path.length &&
        s.path.every((p, j) => next.path[j] === p);
      if (s.path.length && !isParent) {
        const heading = s.path[s.path.length - 1]!;
        out.push({ title, body: heading, startLine: s.startLine, endLine: s.startLine });
      }
      return;
    }
    if (body.length <= opts.maxChars) {
      out.push({ title, body, startLine: s.startLine, endLine: s.startLine + s.lines.length - 1 });
      return;
    }
    // Window on blank lines, never inside a fence.
    let fence = false;
    const fenceState = s.lines.map((l) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      return fence;
    });
    out.push(
      ...windowLines(
        s.lines,
        { ...opts, overlapLines: 0 },
        (line, i) => line.trim() === "" && !fenceState[i],
        (a, b) => `${title} (L${a}-${b})`,
        s.startLine - 1,
      ),
    );
  });
  return out;
}
