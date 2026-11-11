import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Config, ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { codeFileFilter, listCodeFiles } from "../../src/graph/reindex.js";

// The reindex queue's filter must say yes exactly where a full scan (fast-glob) lists the file,
// for the default globs and for the custom ones a project may set.
const FILES = [
  "src/a.ts",
  "src/B.TS",
  "src/.hidden/b.ts",
  "src/.c.ts",
  ".claude/worktrees/w1/src/a.ts",
  ".storybook/main.ts",
  ".storybook/x.stories.ts",
  "node_modules/p/i.js",
  "pkg/node_modules/q/i.js",
  "dist/o.js",
  "build/b.js",
  "generated/g.ts",
  "src/generated/g.ts",
  "legacy/l.ts",
  "src/legacy/l.ts",
  "types/t.d.ts",
  "lib/x.min.js",
  "src/sp ace.ts",
  "src/x.test.ts",
  "src/(paren)/p.ts",
  "src/[id]/page.tsx",
  "app/main.py",
  "README.md",
];

const DEFAULTS = ConfigSchema.parse({}).graph;
const CONFIGS: Record<string, Partial<Config["graph"]>> = {
  defaults: {},
  "bare folder excludes": { exclude: ["node_modules", "generated", "legacy"] },
  "folder path excludes": { exclude: ["src/legacy", "dist/"] },
  "brace exclude": { exclude: ["{dist,build}/**"] },
  "dot folder include": {
    include: [...DEFAULTS.include, ".storybook/**/*.ts"],
    exclude: ["**/*.stories.ts"],
  },
  "./ include": { include: ["./src/**/*.ts"], exclude: [] },
  "narrow include": { include: ["src/**/*.ts"], exclude: [] },
  "! in include": { include: ["**/*.ts", "!**/*.test.ts"], exclude: [] },
  "! in exclude": { exclude: ["**/generated/**", "!src/generated/**"] },
  "basename exclude": { exclude: ["*.test.ts"] },
};

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "em-globs-"));
  for (const f of FILES) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), "");
  }
});

describe("codeFileFilter", () => {
  it.each(Object.entries(CONFIGS))("agrees with a full scan: %s", (_, over) => {
    const graph = { ...DEFAULTS, ...over };
    const ctx = { root, config: { graph } } as unknown as ProjectContext;
    // fast-glob keeps a pattern's leading "./" on what it lists; the queue's paths have none.
    const listed = new Set(listCodeFiles(ctx).map((f) => f.replace(/^\.\//, "")));
    const keep = codeFileFilter(graph);
    expect(FILES.filter((f) => keep(f) !== listed.has(f))).toEqual([]);
  });

  it("never keeps a path outside the project", () => {
    const keep = codeFileFilter(DEFAULTS);
    expect(keep("../other/a.ts")).toBe(false);
    expect(keep(join(root, "src/a.ts"))).toBe(false);
  });
});
