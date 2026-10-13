import { type ChunkerOptions, DEFAULT_CHUNKER, type RawChunk, windowLines } from "./types.js";

/** A declaration the parser found: 1-based inclusive line range, `Outer.inner` names. */
export interface SymbolSpan {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/** Comment, JSDoc and decorator lines that belong to the declaration below them. */
const LEADING = /^\s*(\/\/|\/\*|\*|@[\w.$]+)/;

function depthOf(name: string): number {
  return name.split(".").length;
}

/**
 * Cut source code at declaration boundaries so every chunk is a symbol's body
 * (title `rel > Name`, `symbolId` set), with the leading comment block attached:
 *
 * - declarations larger than `maxChars` with members (classes, interfaces) become a
 *   header chunk plus one chunk per member;
 * - a huge declaration with no members is windowed, every window keeping its symbolId;
 * - the gaps between declarations (imports, top-level statements) become `rel (L a-b)`
 *   chunks with no symbol;
 * - runs of three or more one-or-two-line declarations merge into one chunk, which
 *   bounds the chunk (and embedding) count for files full of tiny constants.
 */
export function chunkBySymbols(
  code: string,
  rel: string,
  symbols: SymbolSpan[],
  opts: ChunkerOptions = DEFAULT_CHUNKER,
): RawChunk[] {
  const lines = code.split("\n");
  const total = lines.length;
  const slice = (a: number, b: number) => lines.slice(a - 1, b).join("\n");
  const out: RawChunk[] = [];

  /** Start line of a declaration once its leading comments are included (never above `floor`). */
  const extendUp = (start: number, floor: number): number => {
    let s = start;
    while (s - 1 > floor && LEADING.test(lines[s - 2] ?? "")) s--;
    return s;
  };

  const gap = (a: number, b: number): void => {
    if (a > b) return;
    const text = slice(a, b);
    if (!text.trim()) return;
    if (text.length <= opts.maxChars) {
      out.push({ title: `${rel} (L${a}-${b})`, body: text, startLine: a, endLine: b });
      return;
    }
    out.push(
      ...windowLines(
        lines.slice(a - 1, b),
        opts,
        (l) => l.trim() === "",
        (x, y) => `${rel} (L${x}-${y})`,
        a - 1,
      ),
    );
  };

  /** One chunk for [a, b] under `title`, or windows titled `title (L x-y)` when too big. */
  const emit = (sym: SymbolSpan, title: string, a: number, b: number): void => {
    if (a > b) return;
    const text = slice(a, b);
    if (!text.trim()) return;
    if (text.length <= opts.maxChars) {
      out.push({ title, body: text, startLine: a, endLine: b, symbolId: sym.id });
      return;
    }
    for (const w of windowLines(
      lines.slice(a - 1, b),
      { ...opts, overlapLines: 0 },
      (l) => l.trim() === "",
      (x, y) => `${title} (L${x}-${y})`,
      a - 1,
    ))
      out.push({ ...w, symbolId: sym.id });
  };

  const valid = symbols.filter(
    (s) => s.startLine >= 1 && s.endLine >= s.startLine && s.endLine <= total,
  );
  const top = valid
    .filter((s) => depthOf(s.name) === 1)
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  const membersOf = (parent: SymbolSpan): SymbolSpan[] =>
    valid
      .filter(
        (s) =>
          depthOf(s.name) === depthOf(parent.name) + 1 &&
          s.name.startsWith(`${parent.name}.`) &&
          s.startLine >= parent.startLine &&
          s.endLine <= parent.endLine,
      )
      .sort((a, b) => a.startLine - b.startLine);

  let cursor = 1;
  let tiny: Array<{ sym: SymbolSpan; a: number; b: number }> = [];
  const flushTiny = (): void => {
    if (!tiny.length) return;
    if (tiny.length >= 3) {
      const a = tiny[0]!.a;
      const b = tiny[tiny.length - 1]!.b;
      out.push({
        title: `${rel} > ${tiny.map((t) => t.sym.name).join(", ")}`,
        body: slice(a, b),
        startLine: a,
        endLine: b,
      });
    } else {
      for (const t of tiny)
        out.push({
          title: `${rel} > ${t.sym.name}`,
          body: slice(t.a, t.b),
          startLine: t.a,
          endLine: t.b,
          symbolId: t.sym.id,
        });
    }
    tiny = [];
  };

  for (const sym of top) {
    if (sym.startLine < cursor) continue; // nested in or overlapping the previous declaration
    const a = extendUp(sym.startLine, cursor - 1);
    const b = sym.endLine;
    if (a > cursor && slice(cursor, a - 1).trim()) {
      flushTiny();
      gap(cursor, a - 1);
    }
    cursor = b + 1;
    if (b - a + 1 <= 2) {
      tiny.push({ sym, a, b });
      continue;
    }
    flushTiny();
    if (slice(a, b).length <= opts.maxChars) {
      emit(sym, `${rel} > ${sym.name}`, a, b);
      continue;
    }
    const members = membersOf(sym);
    if (!members.length) {
      emit(sym, `${rel} > ${sym.name}`, a, b);
      continue;
    }
    let inner = a;
    for (const m of members) {
      if (m.startLine < inner) continue;
      const ma = extendUp(m.startLine, inner - 1);
      emit(sym, `${rel} > ${sym.name}`, inner, ma - 1); // class header, fields, gaps between members
      emit(m, `${rel} > ${m.name}`, ma, m.endLine);
      inner = m.endLine + 1;
    }
    emit(sym, `${rel} > ${sym.name}`, inner, b);
  }
  flushTiny();
  gap(cursor, total);
  return out;
}
