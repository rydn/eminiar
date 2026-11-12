import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunk, hashText } from "../../src/chunker/index.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { runDoctor } from "../../src/doctor.js";
import { clearBudget } from "../../src/hooks/budget.js";
import { dispatch } from "../../src/hooks/dispatch.js";
import {
  backfillRecallIndex,
  fillRecallIndexBriefly,
  recallIndexFilling,
} from "../../src/index/indexer.js";
import { write } from "../../src/memory/store.js";
import { explainPrompt } from "../../src/session/recall-explain.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

type Raw = {
  prepare(s: string): {
    all(...a: unknown[]): unknown[];
    get(...a: unknown[]): unknown;
    run(...a: unknown[]): unknown;
  };
  exec(s: string): void;
  pragma(s: string): unknown;
};

let dir: string;
let path: string;
let db: SqliteAdapter;

const raw = (a: SqliteAdapter = db) => (a as unknown as { db: Raw }).db;
const open = () => new SqliteAdapter(path, { vectors: false });

function add(source: string, title: string, body: string, a: SqliteAdapter = db): number[] {
  const { id } = a.upsertDocument(
    {
      source,
      title,
      contentType: "prose",
      contentHash: hashText(`${source}${title}${body}`),
    },
    chunk(body, title, undefined, undefined).chunks,
  );
  return (
    raw(a).prepare("SELECT id FROM chunks WHERE document_id = ? ORDER BY id").all(id) as Array<{
      id: number;
    }>
  ).map((r) => r.id);
}

const indexed = (a: SqliteAdapter = db) =>
  raw(a).prepare("SELECT rowid id, src FROM recall_fts ORDER BY rowid").all() as Array<{
    id: number;
    src: string;
  }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-recall-index-"));
  path = join(dir, "t.db");
  db = open();
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
});

const DROP_RECALL =
  "DROP TRIGGER chunks_recall_ai; DROP TRIGGER chunks_recall_ad; DROP TRIGGER chunks_recall_au; DROP TABLE recall_fts;";

const recallObjects = (a: SqliteAdapter = db) =>
  (
    raw(a)
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%recall%' ORDER BY name")
      .all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);

const secureDelete = (a: SqliteAdapter = db) =>
  (
    raw(a).prepare("SELECT v FROM recall_fts_config WHERE k = 'secure-delete'").get() as
      | { v: number }
      | undefined
  )?.v;

/** Run the backfill to the end in slices of `rows`; returns how many slices it took. */
function fill(rows = 2000, a: SqliteAdapter = db): number {
  for (let n = 1; n < 10_000; n++) if (a.recallBackfillStep(rows).done) return n;
  throw new Error("backfill did not finish");
}

/** A database with recall data, then put back to `version` without the recall index. */
function seedWithoutIndex(version: string) {
  const mem = add("memory", "decision/pool", "sqlite connection pool decision");
  const docs = add("docs:lib", "lib page", "library documentation about pooling");
  const err = add("session", "error", "pool exhausted error text");
  add("code", "src/pool.ts", "pool pool pool code");
  add("exec", "run", "pool output");
  add("session", "decision", "a session decision about the pool");
  raw().exec(DROP_RECALL);
  db.metaSet("schema_version", version);
  db.close();
  return [...mem, ...docs, ...err].sort((a, b) => a - b);
}

describe("recall_fts migration (v12)", () => {
  it("a fresh database has the table, the triggers, secure-delete and schema_version 12, and is ready", () => {
    expect(db.metaGet("schema_version")).toBe("12");
    expect(recallObjects()).toEqual(
      expect.arrayContaining([
        "recall_fts",
        "chunks_recall_ai",
        "chunks_recall_ad",
        "chunks_recall_au",
      ]),
    );
    expect(secureDelete()).toBe(1);
    expect(db.metaGet("recall_fts_backfill_after")).toBeUndefined();
    add("memory", "m", "alpha");
    expect(db.recallSearch("memory", "alpha", 5)).toHaveLength(1);
  });

  it("upgrading a version 9 database only creates the empty index; recall is [] until the backfill", () => {
    const want = seedWithoutIndex("9");
    db = open();
    expect(db.metaGet("schema_version")).toBe("12");
    expect(indexed()).toEqual([]);
    expect(db.metaGet("recall_fts_backfill_after")).toBe("0");
    // never a partial answer and never the whole chunk index while the backfill is pending
    expect(db.recallSearch("memory", "pool", 5)).toEqual([]);
    fill();
    expect(db.metaGet("recall_fts_backfill_after")).toBeUndefined();
    expect(indexed().map((r) => r.id)).toEqual(want);
    expect(db.recallSearch("memory", "pool", 5)).toHaveLength(1);
    expect(() =>
      raw().exec("INSERT INTO recall_fts(recall_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it("a database already at 10 from another build's numbering (no recall_fts) gets the index", () => {
    const want = seedWithoutIndex("10");
    // what the adjudicator development build's own v10 left behind
    const r = new Database(path);
    r.exec(
      "CREATE TABLE decision_calls (id INTEGER PRIMARY KEY); CREATE TABLE decision_cache (k TEXT)",
    );
    r.close();
    db = open();
    expect(db.metaGet("schema_version")).toBe("12");
    expect(recallObjects()).toEqual(
      expect.arrayContaining([
        "recall_fts",
        "chunks_recall_ai",
        "chunks_recall_ad",
        "chunks_recall_au",
      ]),
    );
    expect(db.recallSearch("memory", "pool", 5)).toEqual([]);
    fill();
    expect(indexed().map((r) => r.id)).toEqual(want);
    expect(db.recallSearch("memory", "pool", 5)).toHaveLength(1);
    // purge and the remask merge work on it (they threw 'no such table' before)
    expect(() => db.purge("sessions")).not.toThrow();
  });

  it("a database at 12 or later without the index is healed at open (repair, not migration)", () => {
    const want = seedWithoutIndex("13");
    db = open();
    expect(db.metaGet("schema_version")).toBe("13");
    expect(recallObjects()).toContain("recall_fts");
    expect(secureDelete()).toBe(1);
    expect(db.metaGet("recall_fts_backfill_after")).toBe("0");
    fill();
    expect(indexed().map((r) => r.id)).toEqual(want);
  });

  it("a populated index from the earlier v10 recall build is kept as it is, ready, with secure-delete on", () => {
    const want = [
      ...add("memory", "m", "alpha memory text"),
      ...add("docs:x", "d", "alpha docs text"),
    ];
    // the earlier build: same table, filled in its migration, no backfill mark, no secure-delete
    raw().exec("INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 0)");
    db.metaSet("schema_version", "10");
    db.close();
    db = open();
    expect(db.metaGet("schema_version")).toBe("12");
    expect(indexed().map((r) => r.id)).toEqual(want);
    expect(db.metaGet("recall_fts_backfill_after")).toBeUndefined();
    expect(secureDelete()).toBe(1);
    expect(db.recallSearch("memory", "alpha", 5)).toHaveLength(1);
    expect(() =>
      raw().exec("INSERT INTO recall_fts(recall_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it("an index left without one of its triggers is made again, empty, and backfilled", () => {
    const [m] = add("memory", "m", "alpha memory");
    raw().exec("DROP TRIGGER chunks_recall_ad");
    // out of step now: a delete the trigger did not see
    raw().prepare("DELETE FROM chunks WHERE id = ?").run(m);
    const [m2] = add("memory", "m2", "beta memory");
    db.close();
    db = open();
    expect(recallObjects()).toContain("chunks_recall_ad");
    expect(indexed()).toEqual([]);
    fill();
    expect(indexed()).toEqual([{ id: m2, src: "memory" }]);
  });

  it("opening the same file again changes nothing", () => {
    add("memory", "m", "alpha beta");
    const before = indexed();
    db.close();
    db = open();
    expect(indexed()).toEqual(before);
    expect(db.metaGet("schema_version")).toBe("12");
    expect(db.recallBackfillStep()).toEqual({ done: true, rows: 0 });
  });

  it("a heal that finds the database locked leaves it for later and does not throw", () => {
    seedWithoutIndex("12");
    const other = new Database(path);
    other.exec("BEGIN IMMEDIATE");
    try {
      db = new SqliteAdapter(path, { vectors: false, busyTimeoutMs: 2000 });
      expect(recallObjects()).not.toContain("recall_fts");
      expect(db.recallSearch("memory", "pool", 5)).toEqual([]);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    db.close();
    db = open();
    expect(recallObjects()).toContain("recall_fts");
  });
});

describe("recall_fts backfill", () => {
  it("resumes from its cursor in another process, in slices, and ends with exactly the recall chunks", () => {
    const want: number[] = [];
    for (let i = 0; i < 6; i++) want.push(...add("memory", `m${i}`, `memory number ${i}`));
    add("code", "c", "code text");
    raw().exec(DROP_RECALL);
    db.metaSet("schema_version", "9");
    db.close();
    db = open();
    expect(db.recallBackfillStep(1).done).toBe(false);
    const cursor = Number(db.metaGet("recall_fts_backfill_after"));
    expect(cursor).toBeGreaterThan(0);
    db.close();
    db = open();
    expect(Number(db.metaGet("recall_fts_backfill_after"))).toBe(cursor);
    expect(fill(1)).toBeGreaterThan(1);
    expect(indexed().map((r) => r.id)).toEqual(want.sort((a, b) => a - b));
  });

  it("stays exact when rows change between slices (the triggers keep them, no duplicates)", () => {
    const early = add("memory", "early", "early memory text");
    const middle = add("docs:x", "middle", "middle docs text");
    const late = add("memory", "late", "late memory oldword");
    const gone = add("session", "error", "an error that will be deleted");
    raw().exec(DROP_RECALL);
    db.metaSet("schema_version", "9");
    db.close();
    db = open();
    // first slice copies only the first document
    expect(db.recallBackfillStep(1).done).toBe(false);
    expect(indexed().map((r) => r.id)).toEqual(early);
    // meanwhile: a new memory, an edit and a delete ahead of the cursor, a delete behind it
    const fresh = add("memory", "fresh", "fresh memory text");
    raw().prepare("UPDATE chunks SET body = ? WHERE id = ?").run("late memory newword", late[0]);
    raw().prepare("DELETE FROM chunks WHERE id = ?").run(gone[0]);
    raw().prepare("DELETE FROM chunks WHERE id = ?").run(early[0]);
    fill(1);
    expect(indexed().map((r) => r.id)).toEqual(
      [...middle, ...late, ...fresh].sort((a, b) => a - b),
    );
    expect(db.recallSearch("memory", "newword", 5)).toHaveLength(1);
    expect(db.recallSearch("memory", "oldword", 5)).toEqual([]);
    expect(() =>
      raw().exec("INSERT INTO recall_fts(recall_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it("updating chunks in place among inserts and deletes leaves the index intact (secure-delete)", () => {
    // SQLite FTS5 corrupts a secure-delete index when a row is re-inserted under its rowid and
    // deleted later, if old and new text share tokens: the update trigger must work around it
    let rng = 7;
    const rand = (n: number) => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng % n;
    };
    const body = (i: number) =>
      Array.from(
        { length: 1 + (i % 4) },
        (_, k) => `para ${k} word${i} tok${i % 97} ${"lorem ipsum ".repeat(40 + (i % 30))}`,
      ).join("\n\n");
    const { id: doc } = db.upsertDocument(
      { source: "docs:bulk", title: "bulk", contentType: "prose", contentHash: "bulk" },
      chunk("seed", "bulk", undefined, undefined).chunks,
    );
    const insert = raw().prepare(
      "INSERT INTO chunks (document_id, ord, title, body, content_type, hash) VALUES (?, 1, '', ?, 'prose', ?)",
    );
    const addRow = (i: number): number =>
      Number((insert.run(doc, body(i), `h${i}`) as { lastInsertRowid: number }).lastInsertRowid);
    const live: number[] = [];
    for (let i = 0; i < 400; i++) live.push(addRow(i));
    for (let op = 0; op < 400; op++) {
      const at = rand(live.length);
      const id = live[at] as number;
      if (op % 2 === 0)
        raw().prepare("UPDATE chunks SET body = body || ' edited' || ? WHERE id = ?").run(op, id);
      else {
        raw().prepare("DELETE FROM chunks WHERE id = ?").run(id);
        live.splice(at, 1);
        live.push(addRow(op));
      }
      if (op % 20 === 19)
        expect(() =>
          raw().exec("INSERT INTO recall_fts(recall_fts) VALUES ('integrity-check')"),
        ).not.toThrow();
    }
    expect(indexed().length).toBeGreaterThan(300);
    expect(secureDelete()).toBe(1);
  });

  it("a v12 database whose update trigger lacks the secure-delete toggle gets it replaced on open, rows kept", () => {
    const [m] = add("memory", "m", "alpha memory");
    raw().exec(`DROP TRIGGER chunks_recall_au;
      CREATE TRIGGER chunks_recall_au AFTER UPDATE OF title, body ON chunks BEGIN
        DELETE FROM recall_fts WHERE rowid = old.id;
        INSERT INTO recall_fts(rowid, title, body, src) SELECT new.id, new.title, new.body, 'memory';
      END;`);
    db.close();
    db = open();
    const sql = (
      raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_recall_au'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("'secure-delete'");
    expect(indexed()).toEqual([{ id: m, src: "memory" }]);
    expect(db.metaGet("recall_fts_backfill_after")).toBeUndefined();
  });

  it("throws SQLITE_BUSY while another process holds the lock, then carries on", () => {
    add("memory", "m", "alpha");
    raw().exec(DROP_RECALL);
    db.metaSet("schema_version", "9");
    db.close();
    db = open();
    const other = new Database(path);
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(() => db.recallBackfillStep()).toThrow(/locked|busy/i);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    fill();
    expect(indexed()).toHaveLength(1);
  });

  it("backfillRecallIndex runs it to the end and returns the rows copied", async () => {
    add("memory", "m", "alpha");
    add("docs:x", "d", "beta");
    raw().exec(DROP_RECALL);
    db.metaSet("schema_version", "9");
    db.close();
    db = open();
    expect(await backfillRecallIndex(db)).toBe(2);
    expect(await backfillRecallIndex(db)).toBe(0);
    expect(db.recallSearch("docs", "beta", 5)).toHaveLength(1);
  });
});

describe("fillRecallIndexBriefly (the hooks' share of the fill)", () => {
  /** More recall documents than one slice reads (500), upgraded from v9 without the index. */
  function seedMany(n: number): number {
    for (let i = 0; i < n; i++) add("memory", `m${i}`, `memory number ${i} about pools`);
    add("code", "c", "code text");
    raw().exec(DROP_RECALL);
    db.metaSet("schema_version", "9");
    db.close();
    db = open();
    return n;
  }

  it("does nothing, and takes no lock, on a complete index", async () => {
    add("memory", "m", "alpha");
    const spy = vi.spyOn(db, "recallBackfillStep");
    expect(recallIndexFilling(db)).toBeUndefined();
    expect(await fillRecallIndexBriefly(db, { budgetMs: 300 })).toEqual({
      rows: 0,
      slices: 0,
      done: true,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs one slice when the budget leaves no room for a second, and resumes from its cursor", async () => {
    const n = seedMany(1200);
    expect(recallIndexFilling(db)).toEqual({ after: 0 });
    const first = await fillRecallIndexBriefly(db, { budgetMs: 0 });
    expect(first.slices).toBe(1);
    expect(first.done).toBe(false);
    expect(recallIndexFilling(db)?.after).toBeGreaterThan(0);
    expect(db.recallSearch("memory", "pools", 5)).toEqual([]);
    const rest = await fillRecallIndexBriefly(db, { budgetMs: 60_000 });
    expect(rest.done).toBe(true);
    expect(first.rows + rest.rows).toBe(n);
    expect(recallIndexFilling(db)).toBeUndefined();
    expect(db.recallSearch("memory", "pools", 5)).toHaveLength(5);
  });

  it("keeps to its time budget: no slice starts once the next one would not fit", async () => {
    seedMany(1200);
    const t0 = performance.now();
    const r = await fillRecallIndexBriefly(db, { budgetMs: 120 });
    // a slice is allowed only while elapsed + gap (40) + the longest slice (at least 50) fits
    expect(r.slices).toBeLessThanOrEqual(2);
    expect(performance.now() - t0).toBeLessThan(120 + 100);
  });

  it("stops before a slice when stop() says so", async () => {
    seedMany(3);
    expect(await fillRecallIndexBriefly(db, { budgetMs: 300, stop: () => true })).toEqual({
      rows: 0,
      slices: 0,
      done: false,
    });
    expect(recallIndexFilling(db)).toEqual({ after: 0 });
  });

  it("gives up at once, without throwing, while another process holds the lock", async () => {
    seedMany(3);
    const other = new Database(path);
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(await fillRecallIndexBriefly(db, { budgetMs: 300 })).toEqual({
        rows: 0,
        slices: 0,
        done: false,
      });
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect((await fillRecallIndexBriefly(db, { budgetMs: 300 })).done).toBe(true);
  });
});

describe("a hooks-only database upgraded without the index (no MCP server ever fills it)", () => {
  const PROMPT = "Change the sqlite connection pool to allow concurrent writers";
  let root: string;
  let home: string;
  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    dispatch(
      JSON.stringify({ session_id: "s-hooks-only", cwd: root, hook_event_name: event, ...extra }),
      [],
    );
  const pdb = () => getStorage(getContext(root), { vectors: false });
  const key = () => pdb().metaGet("recall_fts_backfill_after");

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    process.env.EMINIAR_HOME = home;
    root = mkdtempSync(join(tmpdir(), "em-recall-hooks-"));
    writeFileSync(join(root, "package.json"), "{}");
    resetContextCache();
    const ctx = getContext(root);
    write(ctx, pdb(), {
      name: "decision/sqlite-connection-pool",
      kind: "decision",
      content:
        "The SQLite connection pool is capped at one writer; WAL mode handles concurrent readers.",
    });
    // put the database back to version 9, before the recall index
    raw(pdb() as unknown as SqliteAdapter).exec(DROP_RECALL);
    pdb().metaSet("schema_version", "9");
    closeAllStorage();
  });
  afterAll(() => {
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  afterEach(() => clearBudget());

  it("explain names the pending fill instead of 'none share a term'", async () => {
    // a hook opens it: the index is made, empty, and marked for the fill
    expect(JSON.parse(await hook("UserPromptSubmit", { prompt: PROMPT }))).toEqual({});
    expect(key()).toBe("0");
    const out = await explainPrompt(getContext(root), PROMPT);
    expect(out).toContain("recall index still filling (after document 0)");
    expect(out).toContain("eminiar reindex");
    expect(out).not.toContain("none share a term");
    expect(out).toContain("result: stays quiet");
    const checks = runDoctor({ db: pdb(), config: getContext(root).config, root });
    expect(checks.find((c) => c.name === "recall index")?.detail).toMatch(/still filling/);
  });

  it("the prompt and tool hooks never fill it", async () => {
    const step = vi.spyOn(pdb(), "recallBackfillStep");
    try {
      await hook("UserPromptSubmit", { prompt: PROMPT });
      await hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "x" } });
      await hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "x" } });
      expect(step).not.toHaveBeenCalled();
      expect(key()).toBe("0");
    } finally {
      step.mockRestore();
    }
  });

  it("a Stop hook short on time leaves it for later", async () => {
    // 3500 ms budget, 3000 ms of it already gone: under the 1000 ms the fill needs
    expect(
      await dispatch(
        JSON.stringify({ session_id: "s-hooks-only", cwd: root, hook_event_name: "Stop" }),
        [],
        { startedAt: performance.now() - 3000 },
      ),
    ).toBe("{}");
    expect(key()).toBe("0");
  });

  it("a Stop hook fills it, and prompt recall works again without a server", async () => {
    expect(await hook("Stop", { last_assistant_message: "done" })).toBe("{}");
    expect(key()).toBeUndefined();
    const out = JSON.parse(await hook("UserPromptSubmit", { prompt: PROMPT })) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.additionalContext).toContain("decision/sqlite-connection-pool");
    const explained = await explainPrompt(getContext(root), PROMPT);
    expect(explained).not.toContain("still filling");
    expect(explained).toContain("decision/sqlite-connection-pool");
    const checks = runDoctor({ db: pdb(), config: getContext(root).config, root });
    expect(checks.find((c) => c.name === "recall index")?.detail).toBe("complete");
  });
});

describe("recall_fts secure-delete (persistent)", () => {
  const segments = (a: SqliteAdapter = db) =>
    Buffer.concat(
      (raw(a).prepare("SELECT block FROM recall_fts_data").all() as Array<{ block: Buffer }>).map(
        (r) => r.block ?? Buffer.alloc(0),
      ),
    ).toString("latin1");

  it("a delete by another connection (an older eminiar's trigger) leaves no token in the index", () => {
    const [id] = add("memory", "m", "zqsecretmarker");
    expect(segments()).toContain("zqsecretmark");
    const other = new Database(path);
    other.prepare("DELETE FROM chunks WHERE id = ?").run(id);
    other.close();
    expect(segments()).not.toContain("zqsecretmark");
  });

  it("control: with secure-delete off the same delete leaves the token behind", () => {
    raw().exec("INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 0)");
    const [id] = add("memory", "m", "zqsecretmarker");
    const other = new Database(path);
    other.prepare("DELETE FROM chunks WHERE id = ?").run(id);
    other.close();
    expect(segments()).toContain("zqsecretmark");
  });

  it("purge(sessions) and purge(memories) keep it on", () => {
    add("memory", "m", "alpha");
    add("session", "error", "beta");
    db.purge("sessions");
    expect(secureDelete()).toBe(1);
    db.purge("memories");
    expect(secureDelete()).toBe(1);
  });
});

describe("a database without recall_fts (heal not yet done)", () => {
  function withoutIndex() {
    add("memory", "m", "alpha memory");
    add("session", "error", "beta error");
    add("exec", "run", "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA output");
    raw().exec(DROP_RECALL);
  }

  it("purge of sessions, memories and index does not throw", () => {
    withoutIndex();
    expect(() => db.purge("sessions")).not.toThrow();
    expect(() => db.purge("memories")).not.toThrow();
    expect(() => db.purge("index")).not.toThrow();
    expect(db.countDocuments()).toBe(0);
  });

  it("the remask runs to the end, merge step included", () => {
    withoutIndex();
    let after = 0;
    for (let i = 0; i < 100; i++) {
      const r = db.remaskDocuments(
        ["exec", "session"],
        (t) => t.replace(/sk-ant-\S+/g, "[K]"),
        after,
        1000,
      );
      after = r.lastId;
      if (r.done) break;
    }
    expect(db.metaGet("remask_fts_optimize")).toBeUndefined();
  });
});

describe("recall_fts triggers", () => {
  it("indexes memory, docs and error chunks with the right src, and nothing else", () => {
    const [m] = add("memory", "m", "alpha memory text");
    const [d] = add("docs:x", "d", "alpha docs text");
    const [e] = add("session", "error", "alpha error text");
    add("code", "c", "alpha code text");
    add("exec", "x", "alpha exec text");
    add("session", "decision", "alpha decision text");
    expect(indexed()).toEqual([
      { id: m, src: "memory" },
      { id: d, src: "docs" },
      { id: e, src: "error" },
    ]);
  });

  it("deleting a docs document removes its rows; deleting other chunks leaves the index intact", () => {
    const code = db.upsertDocument(
      {
        source: "code",
        title: "c",
        contentType: "prose",
        contentHash: "h-code",
      },
      chunk("zeta code", "c", undefined, undefined).chunks,
    );
    const { id } = db.upsertDocument(
      {
        source: "docs:x",
        title: "d",
        contentType: "prose",
        contentHash: "h-docs",
      },
      chunk("alpha docs", "d", undefined, undefined).chunks,
    );
    add("memory", "m", "beta memory");
    expect(indexed()).toHaveLength(2);
    db.deleteDocument(code.id);
    db.deleteDocument(id);
    expect(indexed().map((r) => r.src)).toEqual(["memory"]);
    expect(() =>
      raw().exec("INSERT INTO recall_fts(recall_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it("an UPDATE of the body re-indexes; markEmbedded leaves the index alone", () => {
    const [id] = add("memory", "m", "oldtoken here");
    expect(db.recallSearch("memory", "oldtoken", 5)).toHaveLength(1);
    raw().prepare("UPDATE chunks SET body = ? WHERE id = ?").run("newtoken here", id);
    expect(db.recallSearch("memory", "oldtoken", 5)).toEqual([]);
    expect(db.recallSearch("memory", "newtoken", 5)).toHaveLength(1);
    const rowsBefore = raw().prepare("SELECT count(*) n FROM recall_fts_docsize").get();
    raw().prepare("UPDATE chunks SET embedded = 1 WHERE id = ?").run(id);
    expect(raw().prepare("SELECT count(*) n FROM recall_fts_docsize").get()).toEqual(rowsBefore);
    expect(db.recallSearch("memory", "newtoken", 5)).toHaveLength(1);
  });
});

describe("recallSearch", () => {
  it("supports AND and OR expressions", () => {
    add("memory", "a", "pool writers concurrent");
    add("memory", "b", "pool readers only");
    expect(db.recallSearch("memory", "pool AND writers", 10)).toHaveLength(1);
    expect(db.recallSearch("memory", "pool AND nothing", 10)).toEqual([]);
    expect(db.recallSearch("memory", "writers OR readers", 10)).toHaveLength(2);
  });

  it("isolates by source and never returns a code chunk", () => {
    const [m] = add("memory", "m", "shared term words");
    const [d] = add("docs:x", "d", "shared term words");
    const [e] = add("session", "error", "shared term words");
    add("code", "c", "shared term words");
    expect(db.recallSearch("memory", "shared AND term", 10).map((h) => h.chunkId)).toEqual([m]);
    expect(db.recallSearch("docs", "shared AND term", 10).map((h) => h.chunkId)).toEqual([d]);
    expect(db.recallSearch("error", "shared AND term", 10).map((h) => h.chunkId)).toEqual([e]);
  });

  it("scores higher-is-better and respects the limit", () => {
    for (let i = 0; i < 5; i++) add("memory", `m${i}`, `common word number${i}`);
    const hits = db.recallSearch("memory", "common", 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("returns [] for a malformed expression", () => {
    add("memory", "m", "alpha");
    expect(db.recallSearch("memory", "alpha AND (", 10)).toEqual([]);
    expect(db.recallSearch("memory", '"unterminated', 10)).toEqual([]);
  });

  it("returns [] when the index table is missing", () => {
    raw().exec(
      "DROP TRIGGER chunks_recall_ai; DROP TRIGGER chunks_recall_ad; DROP TRIGGER chunks_recall_au; DROP TABLE recall_fts;",
    );
    expect(db.recallSearch("memory", "alpha", 10)).toEqual([]);
  });

  it("the words docs, memory and error in a prompt do not match the src column", () => {
    add("memory", "m", "pool writers");
    add("docs:x", "d", "pool writers");
    expect(db.recallSearch("docs", "docs", 10)).toEqual([]);
    expect(db.recallSearch("memory", "memory", 10)).toEqual([]);
    expect(db.recallSearch("error", "error", 10)).toEqual([]);
  });
});
