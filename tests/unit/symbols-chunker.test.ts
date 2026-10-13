import { describe, expect, it } from "vitest";
import { chunkBySymbols, type SymbolSpan } from "../../src/chunker/symbols.js";

const code = [
  "import { x } from './x.js';", // 1
  "", // 2
  "/** Adds. */", // 3
  "export function add(a, b) {", // 4
  "  return a + b;", // 5
  "}", // 6
  "export const A = 1;", // 7
  "export const B = 2;", // 8
  "export const C = 3;", // 9
  "export class Big {", // 10
  "  // first", // 11
  "  m1() {", // 12
  "    return 1;", // 13
  "  }", // 14
  "  m2() {", // 15
  "    return 2;", // 16
  "  }", // 17
  "}", // 18
  "export function huge() {", // 19
  ...Array.from({ length: 100 }, () => "  x();"), // 20..119
  "}", // 120
].join("\n");

const sym = (name: string, startLine: number, endLine: number, kind = "function"): SymbolSpan => ({
  id: `sym:f.ts#${name}`,
  name,
  kind,
  startLine,
  endLine,
});
const spans = [
  sym("add", 4, 6),
  sym("A", 7, 7, "variable"),
  sym("B", 8, 8, "variable"),
  sym("C", 9, 9, "variable"),
  sym("Big", 10, 18, "class"),
  sym("Big.m1", 12, 14, "method"),
  sym("Big.m2", 15, 17, "method"),
  sym("huge", 19, 120),
  sym("ghost", 500, 600), // out of range: ignored
];

describe("chunkBySymbols", () => {
  const out = chunkBySymbols(code, "f.ts", spans, { maxChars: 60, overlapLines: 0 });
  const titled = (t: string) => out.filter((c) => c.title === t);

  it("keeps imports and other gaps as symbol-less chunks", () => {
    const gap = titled("f.ts (L1-2)")[0]!;
    expect(gap.body).toContain("import { x }");
    expect(gap.symbolId).toBeUndefined();
  });

  it("attaches the leading comment block to a declaration", () => {
    const add = titled("f.ts > add")[0]!;
    expect(add.startLine).toBe(3);
    expect(add.endLine).toBe(6);
    expect(add.symbolId).toBe("sym:f.ts#add");
    expect(add.body.startsWith("/** Adds. */")).toBe(true);
  });

  it("merges runs of tiny declarations into one symbol-less chunk", () => {
    const merged = titled("f.ts > A, B, C")[0]!;
    expect(merged.startLine).toBe(7);
    expect(merged.endLine).toBe(9);
    expect(merged.symbolId).toBeUndefined();
    expect(out.some((c) => c.title === "f.ts > A")).toBe(false);
  });

  it("splits an oversized class into header, members and trailer", () => {
    const header = titled("f.ts > Big");
    expect(header.map((c) => [c.startLine, c.endLine])).toEqual([
      [10, 10],
      [18, 18],
    ]);
    expect(header.every((c) => c.symbolId === "sym:f.ts#Big")).toBe(true);
    const m1 = titled("f.ts > Big.m1")[0]!;
    expect([m1.startLine, m1.endLine]).toEqual([11, 14]); // "// first" comes along
    expect(m1.symbolId).toBe("sym:f.ts#Big.m1");
    expect(titled("f.ts > Big.m2")[0]!.symbolId).toBe("sym:f.ts#Big.m2");
  });

  it("windows a huge function and keeps its symbol id on every window", () => {
    const windows = out.filter((c) => c.title.startsWith("f.ts > huge (L"));
    expect(windows.length).toBeGreaterThan(3);
    expect(windows.every((c) => c.symbolId === "sym:f.ts#huge")).toBe(true);
    expect(windows[0]!.startLine).toBe(19);
    expect(windows[windows.length - 1]!.endLine).toBe(120);
    for (const w of windows) expect(w.body.length).toBeLessThanOrEqual(80);
  });

  it("covers every line exactly once and ignores spans outside the file", () => {
    const covered = new Set<number>();
    for (const c of out) for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    expect(covered.size).toBe(120);
    expect(out.some((c) => c.title.includes("ghost"))).toBe(false);
  });

  it("keeps a whole file in one chunk per declaration when everything fits", () => {
    const small = chunkBySymbols(
      "export const a = 1;\n\nexport function f() {\n  return a;\n}\n",
      "s.ts",
      [sym("a", 1, 1, "variable"), sym("f", 3, 5)],
    );
    expect(small.map((c) => c.title)).toEqual(["s.ts > a", "s.ts > f"]);
  });
});
