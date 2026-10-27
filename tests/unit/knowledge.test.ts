import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { addDocSources, removeDocSource } from "../../src/docs/add.js";
import {
  ensureDocsGraph,
  packageCandidates,
  pathsIn,
  syncDocsGraph,
} from "../../src/docs/graph.js";
import { upsertSources } from "../../src/docs/manifest.js";
import { impact } from "../../src/graph/query.js";
import { reindexCode } from "../../src/graph/reindex.js";
import { indexContent } from "../../src/index/indexer.js";
import { write } from "../../src/memory/store.js";
import { search } from "../../src/search/pipeline.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emIndex } from "../../src/tools/em_index.js";
import { buildKnowledge } from "../../src/ui/knowledge-api.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

beforeAll(async () => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-know-"));
  writeFileSync(join(root, "package.json"), '{"name":"demo","dependencies":{"zod":"^4"}}');
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(
    join(root, "src/a.ts"),
    'import { z } from "zod";\nimport { b } from "./b.js";\nexport const a = () => z.string().parse(b());\n',
  );
  writeFileSync(join(root, "src/b.ts"), 'export function b() { return "b"; }\n');
  writeFileSync(
    join(root, "docs/guide.md"),
    "# Guide\n\nValidation lives in `src/a.ts`; see also [b](../src/b.ts) and src/missing.ts.\n",
  );
  writeFileSync(join(root, "docs/other.md"), "# Other\n\nNothing about code here.\n");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
  await reindexCode(ctx, db);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

describe("docs in the graph", () => {
  it("maps providers to package ids and finds code paths in a page", () => {
    expect(packageCandidates("npm:@scope/pkg")).toEqual(["pkg:@scope/pkg"]);
    expect(packageCandidates("pypi:Django-Rest")).toContain("pkg:django_rest");
    expect(packageCandidates("env:SUMSUB")).toEqual([]);
    expect(packageCandidates(undefined)).toEqual([]);
    const files = new Set(["src/a.ts", "src/b.ts"]);
    expect(pathsIn("see `src/a.ts`, ./src/b.ts.", undefined, files).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(pathsIn("[b](../src/b.ts)", "docs/guide.md", files)).toEqual(["src/b.ts"]);
    expect(pathsIn("src/other.ts", undefined, files)).toEqual([]);
  });

  it("writes doc nodes with documents edges to packages and the files pages name", async () => {
    upsertSources(ctx, [
      { name: "zod", kind: "url", urls: ["https://zod.dev/"], provider: "npm:zod" },
      { name: "left-pad", kind: "url", urls: ["https://x.test/"], provider: "npm:left-pad" },
    ]);
    const o = await addDocSources(ctx, db, [{ name: "docs", path: "docs" }]);
    expect(o.added).toEqual(["docs"]);
    const zod = db.graphGetNode("doc:zod");
    expect(zod?.kind).toBe("doc");
    expect(JSON.parse(zod!.meta!)).toMatchObject({ category: "library", provider: "npm:zod" });
    const out = (id: string) =>
      db
        .graphEdgesFrom([id], ["documents"])
        .map((e) => e.dst)
        .sort();
    expect(out("doc:zod")).toEqual(["pkg:zod"]);
    // nothing imports left-pad: the edge still names the canonical package
    expect(out("doc:left-pad")).toEqual(["pkg:left-pad"]);
    expect(out("doc:docs")).toEqual(["file:src/a.ts", "file:src/b.ts"]);
  });

  it("shows documentation in impact analysis", () => {
    const r = impact(db, "src/a.ts")!;
    const hit = r.hits.find((h) => h.id === "doc:docs");
    expect(hit?.reasons[0]).toMatch(/^doc documents/);
    const pkg = impact(db, "pkg:zod")!;
    expect(pkg.hits.some((h) => h.id === "doc:zod")).toBe(true);
  });

  it("rebuilds on removal and only when something changed", () => {
    expect(ensureDocsGraph(ctx, db)).toBe(false);
    removeDocSource(ctx, db, "left-pad");
    expect(db.graphGetNode("doc:left-pad")).toBeUndefined();
    expect(db.graphEdgesFrom(["doc:left-pad"])).toEqual([]);
    expect(db.graphGetNode("doc:zod")).toBeDefined();
    expect(syncDocsGraph(ctx, db).sources).toBe(2);
  });
});

describe("em_index", () => {
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => c.text ?? "").join("\n");

  it("makes a heading-only document searchable by the heading's words", async () => {
    const out = textOf(
      await emIndex.handler(
        { content: "# Quokka rollout checklist for the staging cluster", title: "quokka" },
        ctx,
      ),
    );
    expect(out).toMatch(/^indexed "quokka" as doc \d+: 1 chunks/);
    expect(out).not.toContain("no sections found");
    const hits = await search(db, "quokka rollout", { limit: 3, mode: "lexical" });
    expect(hits.hits.some((h) => h.chunk.body.includes("Quokka rollout checklist"))).toBe(true);
  });

  it("indexes content the chunker could not cut as one chunk and says so", () => {
    const r = indexContent(db, {
      source: "inline",
      title: "uncuttable",
      content: "nothing to cut here",
      chunks: [],
    });
    expect(r).toMatchObject({ chunks: 1, fallback: true });
    expect(db.chunksOfDocument(r.documentId).map((c) => c.body)).toEqual(["nothing to cut here"]);
    const normal = indexContent(db, { source: "inline", title: "n", content: "# A\nbody" });
    expect(normal.fallback).toBe(false);
  });
});

describe("knowledge galaxy payload", () => {
  beforeAll(() => {
    write(ctx, db, {
      name: "auth/old-way",
      kind: "decision",
      content: "Hand-written validators.",
      tags: ["validation"],
    });
    write(ctx, db, {
      name: "auth/validation",
      kind: "decision",
      content: "Validate with zod in src/a.ts; builds on mem:auth/old-way.",
      related: ["file:src/a.ts", "file:docs/guide.md", "mem:auth/old-way"],
      tags: ["validation"],
      supersedes: "auth/old-way",
    });
    write(ctx, db, { name: "loose-note", kind: "note", content: "Unrelated." });
  });

  it("seeds memories, expands one hop and adds tag and topic hubs", () => {
    const k = buildKnowledge(ctx, db, { scope: "memory" });
    const ids = new Set(k.nodes.map((n) => n.id));
    for (const id of [
      "memory:auth/validation",
      "memory:auth/old-way",
      "memory:loose-note",
      "file:src/a.ts",
      "tag:validation",
      "topic:auth",
    ])
      expect(ids.has(id)).toBe(true);
    expect(ids.has("doc:zod")).toBe(false);
    const kinds = (src: string) =>
      k.edges
        .filter((e) => e.src === src)
        .map((e) => `${e.kind} ${e.dst}`)
        .sort();
    expect(kinds("memory:auth/validation")).toEqual([
      "about doc:docs",
      "in_topic topic:auth",
      "links memory:auth/old-way",
      "mentions file:docs/guide.md",
      "mentions file:src/a.ts",
      "mentions memory:auth/old-way",
      "supersedes memory:auth/old-way",
      "tagged tag:validation",
    ]);
    const old = k.nodes.find((n) => n.id === "memory:auth/old-way")!;
    expect(old).toMatchObject({ group: "memory", sub: "decision", status: "superseded" });
    expect(k.nodes.find((n) => n.id === "topic:auth")?.group).toBe("hub");
    expect(k.counts.edges.tagged).toBe(2);
  });

  it("seeds doc sources for the docs scope with category hubs", () => {
    const k = buildKnowledge(ctx, db, { scope: "docs" });
    const ids = new Set(k.nodes.map((n) => n.id));
    expect(ids.has("doc:zod")).toBe(true);
    expect(ids.has("pkg:zod")).toBe(true);
    expect(ids.has("topic:docs/library")).toBe(true);
    // memories about a page of a local source come along
    expect(k.edges.some((e) => e.src === "memory:auth/validation" && e.dst === "doc:docs")).toBe(
      true,
    );
    expect(ids.has("memory:loose-note")).toBe(false);
    expect(k.nodes.find((n) => n.id === "doc:zod")).toMatchObject({
      group: "doc",
      sub: "library",
      provider: "npm:zod",
    });
  });

  it("centres on a focus and walks a second knowledge hop", () => {
    const k = buildKnowledge(ctx, db, { focus: "file:src/a.ts" });
    const ids = new Set(k.nodes.map((n) => n.id));
    expect(k.nodes.find((n) => n.root)?.id).toBe("file:src/a.ts");
    expect(ids.has("memory:auth/validation")).toBe(true);
    expect(ids.has("doc:docs")).toBe(true);
    // second hop: what the memory relates to
    expect(ids.has("memory:auth/old-way")).toBe(true);
    expect(ids.has("memory:loose-note")).toBe(false);
    const hub = buildKnowledge(ctx, db, { focus: "tag:validation" });
    expect(
      hub.nodes
        .filter((n) => n.group === "memory")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["memory:auth/old-way", "memory:auth/validation"]);
  });

  it("marks edge targets nothing defines and respects the limit", () => {
    write(ctx, db, {
      name: "dangling",
      kind: "fact",
      content: "Points at mem:gone-for-good.",
    });
    const k = buildKnowledge(ctx, db, { scope: "memory" });
    expect(k.nodes.find((n) => n.id === "memory:gone-for-good")).toMatchObject({
      missing: true,
      group: "memory",
    });
    const small = buildKnowledge(ctx, db, { scope: "all", limit: 10 });
    expect(small.nodes).toHaveLength(10);
    expect(small.truncated).toBe(true);
    expect(small.total).toBeGreaterThan(10);
    const kept = new Set(small.nodes.map((n) => n.id));
    expect(small.edges.every((e) => kept.has(e.src) && kept.has(e.dst))).toBe(true);
  });
});
