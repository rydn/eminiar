import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexContent } from "../../src/index/indexer.js";
import { rrf } from "../../src/search/fusion.js";
import { search } from "../../src/search/pipeline.js";
import { buildMatch, parseQuery } from "../../src/search/query.js";
import { snippet } from "../../src/search/snippets.js";
import { correctTerms, editDistance } from "../../src/search/typo.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

describe("query parsing", () => {
  it("extracts phrases and identifiers", () => {
    const p = parseQuery('how to "connect pool" with db.pool_size and src/a.ts');
    expect(p.phrases).toEqual(["connect pool"]);
    expect(p.terms).toEqual(["db.pool_size", "src/a.ts"]);
    expect(buildMatch(p, "and")).toBe('"connect pool" "db.pool_size" "src/a.ts"');
    expect(buildMatch(p, "or", 3)).toContain(" OR ");
  });
});

describe("editDistance", () => {
  it("handles substitutions, deletions and transpositions", () => {
    expect(editDistance("database", "databse")).toBe(1);
    expect(editDistance("recieve", "receive")).toBe(1);
    expect(editDistance("abc", "xyz")).toBe(3);
    expect(editDistance("abc", "abcdefgh", 2)).toBe(3);
  });
});

describe("rrf", () => {
  it("rewards ids present in several lists", () => {
    const s = rrf([
      { ids: [1, 2, 3], weight: 1 },
      { ids: [3, 4], weight: 1 },
    ]);
    expect(s.get(3)!).toBeGreaterThan(s.get(1)!);
  });
});

describe("snippet", () => {
  it("cuts windows around hits and merges overlaps", () => {
    const body = `${"a ".repeat(200)}needle one ${"b ".repeat(5)}needle two ${"c ".repeat(200)}`;
    const s = snippet(body, ["needle"], { radius: 20, max: 3 });
    expect(s).toContain("needle one");
    expect(s).toContain("needle two");
    expect(s.split("⋯").length).toBe(1);
  });
});

describe("end-to-end search", () => {
  let db: SqliteAdapter;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "em-db-"));
    db = new SqliteAdapter(join(dir, "t.db"));
    indexContent(db, {
      source: "file",
      title: "README.md",
      uri: "file:///README.md",
      content: `# Eminiar
Local-first context for Claude Code.

## Database
Uses better-sqlite3 with FTS5 porter and trigram tokenizers. The database lives in ~/.eminiar.

## Sandbox
Runs shell and javascript in a child process with a timeout.
`,
    });
    indexContent(db, {
      source: "code",
      title: "src/sandbox/run.ts",
      uri: "file:///src/sandbox/run.ts",
      kind: "code",
      content: `export function runSandbox(cmd: string, timeoutMs: number) {\n  return spawnProcess(cmd, { timeoutMs });\n}\n`,
    });
    indexContent(db, {
      source: "exec",
      title: "git log",
      content: Array.from(
        { length: 300 },
        (_, i) => `commit ${i} fix flaky test in pipeline ${i}`,
      ).join("\n"),
    });
  });
  afterAll(() => db.close());

  it("finds by stemmed word and boosts titles", async () => {
    const r = await search(db, "databases");
    expect(r.hits[0]!.chunk.title).toBe("README.md > Eminiar > Database");
    expect(r.used).toContain("porter");
  });

  it("finds identifiers via trigram", async () => {
    const r = await search(db, "runSandbox");
    expect(r.hits[0]!.chunk.document.source).toBe("code");
    expect(r.hits[0]!.snippet).toContain("export function runSandbox");
  });

  it("corrects typos", async () => {
    const r = await search(db, "trigrm tokenizer");
    expect(r.corrections.map((c) => c.from)).toContain("trigrm");
    expect(r.hits[0]!.chunk.title).toContain("Database");
    const c = correctTerms(db, ["sandbox"]);
    expect(c.corrections).toHaveLength(0);
  });

  it("applies filters, sort and dedupes", async () => {
    const onlyCode = await search(db, "sandbox", { filters: { source: "code" } });
    expect(onlyCode.hits.every((h) => h.chunk.document.source === "code")).toBe(true);
    const timeline = await search(db, "pipeline flaky", { limit: 3, sort: "timeline" });
    expect(timeline.hits.length).toBeGreaterThan(0);
    const spans = timeline.hits.map((h) => [h.chunk.start_line, h.chunk.end_line]);
    expect(new Set(spans.map(String)).size).toBe(spans.length);
  });

  it("scans with a regular expression and rejects a bad one", async () => {
    const r = await search(db, "runSandbox\\(cmd: \\w+", {
      mode: "regex",
      filters: { source: "code" },
    });
    expect(r.used).toEqual(["regex"]);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.snippet).toContain("export function runSandbox");
    const none = await search(db, "^zzz$", { mode: "regex" });
    expect(none.hits).toHaveLength(0);
    await expect(search(db, "(", { mode: "regex" })).rejects.toThrow();
    await expect(search(db, "a".repeat(201), { mode: "regex" })).rejects.toThrow(/too long/);
  });

  it("replaces a document when its content changes", () => {
    const first = indexContent(db, {
      source: "file",
      title: "x.md",
      uri: "file:///x.md",
      content: "# one",
    });
    const same = indexContent(db, {
      source: "file",
      title: "x.md",
      uri: "file:///x.md",
      content: "# one",
    });
    const changed = indexContent(db, {
      source: "file",
      title: "x.md",
      uri: "file:///x.md",
      content: "# two",
    });
    expect(same.created).toBe(false);
    expect(same.documentId).toBe(first.documentId);
    const forced = indexContent(db, {
      source: "file",
      title: "x.md",
      uri: "file:///x.md",
      content: "# one",
      force: true,
    });
    expect(forced.created).toBe(true);
    expect(db.getDocument(first.documentId)).toBeUndefined();
    expect(changed.created).toBe(true);
    expect(changed.documentId).not.toBe(first.documentId);
    expect(db.getDocument(first.documentId)).toBeUndefined();
  });

  it("reports top terms and purges", () => {
    const ids = db.chunksOfDocument(1).map((c) => c.id);
    const terms = db.topTerms(ids, 5);
    expect(terms.length).toBeGreaterThan(0);
    db.purge("index");
    expect(db.countDocuments()).toBe(0);
    expect(db.termExists("database")).toBe(false);
  });
});
