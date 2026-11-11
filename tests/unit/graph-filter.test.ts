import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, graphGlobProblem, loadConfig } from "../../src/config.js";
import { codeFileFilter } from "../../src/graph/reindex.js";

const BAD = [
  "**/" + "*a".repeat(12) + "*b.ts",
  `**/${"x".repeat(250)}.ts`,
  "{a,b}{c,d}{e,f}{g,h}{i,j}",
];

describe("graph include/exclude globs", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-gg-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
  });

  it("accepts the defaults and ordinary patterns", () => {
    const g = ConfigSchema.shape.graph.parse({});
    for (const p of [...g.include, ...g.exclude, "src/**/*.{ts,tsx}", "**/*.test.*", "!**/gen/**"])
      expect(graphGlobProblem(p), p).toBeUndefined();
  });

  it("refuses patterns that can backtrack for seconds", () => {
    for (const p of BAD) expect(graphGlobProblem(p), p).toBeTypeOf("string");
    expect(graphGlobProblem("a/*x*x*x*x/b")).toBeTypeOf("string");
    expect(graphGlobProblem("**/**/**/**/**/**/**/**/**/x")).toBeTypeOf("string");
  });

  it("falls back to the defaults when eminiar.config.json carries one", () => {
    const root = mkdtempSync(join(tmpdir(), "em-ggp-"));
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ graph: { include: [BAD[0]] } }),
    );
    const t = performance.now();
    const cfg = loadConfig(root);
    const keep = codeFileFilter(cfg.graph);
    expect(keep(`src/${"a".repeat(40)}.ts`)).toBe(true);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it("indexes mts, cts and pyi by default", () => {
    const keep = codeFileFilter(ConfigSchema.shape.graph.parse({}));
    for (const f of ["a.mts", "src/b.cts", "pkg/c.pyi"]) expect(keep(f), f).toBe(true);
    expect(keep("types/d.d.ts")).toBe(false);
  });

  it("compiles the filter once per config", () => {
    const graph = ConfigSchema.shape.graph.parse({});
    expect(codeFileFilter(graph)).toBe(codeFileFilter(graph));
  });
});
