import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexContent } from "../../src/index/indexer.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { VecHit } from "../../src/storage/types.js";

/**
 * Filtered semantic search without the embedding model: deterministic 384-dim vectors, a
 * common source whose chunks all sit next to the query and a rare source whose chunks are
 * all far from it. Over-fetching k*4 nearest and post-filtering never reached the rare
 * source; the k nearest *allowed* chunks must come back instead.
 */
const DIMS = 384;
const COMMON = 270;
const RARE = 30;

const unit = (dim: number, scale = 1): Float32Array => {
  const v = new Float32Array(DIMS);
  v[dim] = scale;
  return v;
};
const dist = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
};

let db: SqliteAdapter;
const vectors = new Map<number, Float32Array>();
const source = new Map<number, string>();
const query = unit(0);

beforeAll(() => {
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-vec-")), "t.db"));
  const add = (src: string, i: number, vec: Float32Array) => {
    const { documentId } = indexContent(db, {
      source: src,
      title: `${src} ${i}`,
      uri: `https://${src.replace(":", ".")}.test/${i}`,
      content: `Page ${i} of ${src}: a short paragraph that becomes exactly one chunk.`,
      kind: "markdown",
    });
    for (const c of db.chunksOfDocument(documentId)) {
      db.vecUpsert(c.id, vec);
      vectors.set(c.id, vec);
      source.set(c.id, src);
    }
  };
  // common chunks: near the query, spread along dimension 1 so distances are distinct
  for (let i = 0; i < COMMON; i++) {
    const v = unit(0);
    v[1] = 0.001 * (i + 1);
    add("docs:common", i, v);
  }
  // rare chunks: orthogonal to the query (distance about sqrt 2), spread along dimension 2
  for (let i = 0; i < RARE; i++) {
    const v = unit(1);
    v[2] = 0.001 * (i + 1);
    add("docs:rare", i, v);
  }
  expect(db.vecCount()).toBe(COMMON + RARE);
});
afterAll(() => db.close());

/** Brute-force k nearest among the chunks that pass `keep`. */
function nearest(k: number, keep: (id: number) => boolean): number[] {
  return [...vectors]
    .filter(([id]) => keep(id))
    .map(([id, v]) => ({ id, d: dist(query, v) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((h) => h.id);
}
const ids = (hits: VecHit[]) => hits.map((h) => h.chunkId);
const ascending = (hits: VecHit[]) =>
  hits.every((h, i) => i === 0 || h.distance >= hits[i - 1]!.distance);

describe("vecSearch with filters", () => {
  it("unfiltered: the k nearest overall", () => {
    const hits = db.vecSearch(query, 5);
    expect(ids(hits)).toEqual(nearest(5, () => true));
    expect(ascending(hits)).toBe(true);
    expect(hits.every((h) => source.get(h.chunkId) === "docs:common")).toBe(true);
  });
  it("an exact source that never makes the unfiltered top k*4 still returns its k nearest", () => {
    const hits = db.vecSearch(query, 5, { source: "docs:rare" });
    expect(hits).toHaveLength(5);
    expect(ids(hits)).toEqual(nearest(5, (id) => source.get(id) === "docs:rare"));
    expect(ascending(hits)).toBe(true);
  });
  it("a source list and a prefix filter", () => {
    expect(ids(db.vecSearch(query, 5, { source: ["docs:rare", "docs:nope"] }))).toEqual(
      nearest(5, (id) => source.get(id) === "docs:rare"),
    );
    expect(ids(db.vecSearch(query, 5, { sourcePrefix: "docs:" }))).toEqual(nearest(5, () => true));
    expect(ids(db.vecSearch(query, 5, { sourcePrefix: "docs:ra" }))).toEqual(
      nearest(5, (id) => source.get(id) === "docs:rare"),
    );
  });
  it("k above the allowed set returns the whole set; a filter nothing passes returns nothing", () => {
    expect(db.vecSearch(query, 50, { source: "docs:rare" })).toHaveLength(RARE);
    expect(db.vecSearch(query, 5, { source: "docs:rare", contentType: "code" })).toEqual([]);
    expect(db.vecSearch(query, 5, { source: "docs:missing" })).toEqual([]);
  });
  it("empty filters take the unfiltered path", () => {
    expect(db.vecSearch(query, 5, {})).toEqual(db.vecSearch(query, 5));
  });
  it("the widening fallback agrees with the IN-constrained query", () => {
    const widening = (
      db as unknown as {
        vecSearchWidening: (e: Float32Array, k: number, w: string, p: unknown[]) => VecHit[];
      }
    ).vecSearchWidening.bind(db);
    expect(widening(query, 5, " AND d.source IN (?)", ["docs:rare"])).toEqual(
      db.vecSearch(query, 5, { source: "docs:rare" }),
    );
    expect(widening(query, 50, " AND d.source IN (?)", ["docs:rare"])).toHaveLength(RARE);
    expect(widening(query, 5, " AND d.source IN (?)", ["docs:missing"])).toEqual([]);
  });
});
