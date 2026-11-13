import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { chunk, hashText } from "../../src/chunker/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

// A purge deletes rows, but FTS5 keeps a deleted row's tokens in its index segments until they are
// merged. The trigram index holds every 3-character window of what was stored, so a token left in
// a segment survives the VACUUM as readable fragments of the file.

const TOKEN = "ghp_Zq7Xk2VwRt9Lm4Np8Bs3Hd6Jc1Fy5Gu0Ea2W";
const PEM_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7Vn3Xk2";

const trigrams = (s: string) =>
  new Set(Array.from({ length: s.length - 2 }, (_, i) => s.slice(i, i + 3).toLowerCase()));

/** Fill a database the way an indexed session event or captured output is stored. */
function store(db: SqliteAdapter, source: string): void {
  const content = `$ cat .env\nGH=${TOKEN}\n${PEM_LINE}\n`;
  const cut = chunk(content, "shell: cat .env", undefined, undefined);
  db.upsertDocument(
    { source, title: "shell: cat .env", contentType: "prose", contentHash: hashText(content) },
    cut.chunks,
  );
}

/** The bytes of the database file after the scope was purged and the connection closed. */
function purgedFile(scope: "sessions" | "index" | "all", withDocument: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "em-residue-"));
  const path = join(dir, "t.db");
  const db = new SqliteAdapter(path, { vectors: false });
  if (withDocument) {
    // a scope-specific copy so each scope's delete path runs on a document it owns
    store(db, scope === "sessions" ? "session" : "exec");
  }
  db.purge(scope);
  db.close();
  const raw = readFileSync(path).toString("latin1");
  rmSync(dir, { recursive: true, force: true });
  return raw;
}

describe("purge(sessions) beside documents that stay", () => {
  // The session copy is written in the same transaction as other documents, so its tokens sit in
  // index segments that also hold rows the purge keeps: only removing them from those segments
  // (FTS5 secure-delete) gets rid of them, not deleting whole segments.
  function purged(withSession: boolean): {
    raw: string;
    kept: number;
    recalled: number;
    docs: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), "em-residue-"));
    const path = join(dir, "t.db");
    const db = new SqliteAdapter(path, { vectors: false });
    db.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const body = `ordinary build output line ${i} kept alpha beta`;
        db.upsertDocument(
          { source: "exec", title: `run ${i}`, contentType: "prose", contentHash: hashText(body) },
          chunk(body, `run ${i}`, undefined, undefined).chunks,
        );
        if (i === 100 && withSession) store(db, "session");
      }
    });
    db.purge("sessions");
    const sql = (db as unknown as { db: { prepare(s: string): { get(): unknown } } }).db;
    const count = (q: string) => (sql.prepare(q).get() as { n: number }).n;
    const kept = count(
      "SELECT count(*) n FROM chunks_fts_trigram WHERE chunks_fts_trigram MATCH '\"kept alpha\"'",
    );
    const recalled = count(
      "SELECT count(*) n FROM chunks_fts_porter WHERE chunks_fts_porter MATCH 'cat'",
    );
    const docs = count("SELECT count(*) n FROM documents WHERE source = 'session'");
    // the toggle is for the purge only: later deletes stay the cheap kind
    const secure = (
      sql.prepare("SELECT v n FROM chunks_fts_trigram_config WHERE k = 'secure-delete'").get() as
        | { n: number }
        | undefined
    )?.n;
    expect(secure ?? 0).toBe(0);
    db.close();
    const raw = readFileSync(path).toString("latin1");
    rmSync(dir, { recursive: true, force: true });
    return { raw, kept, recalled, docs };
  }

  it("removes the session copy's tokens and keeps the other documents searchable", () => {
    const baseline = purged(false).raw;
    const { raw, kept, recalled, docs } = purged(true);
    expect(docs).toBe(0);
    expect(recalled).toBe(0);
    expect(kept).toBe(200);
    // windows the database holds without the session copy (hex digests) are not residue
    const probes = [...trigrams(TOKEN), ...trigrams(PEM_LINE)].filter((t) => !baseline.includes(t));
    expect(probes.length).toBeGreaterThan(40);
    expect(probes.filter((t) => raw.includes(t))).toEqual([]);
    expect(raw).not.toContain(TOKEN);
  });
});

describe.each(["sessions", "index", "all"] as const)("purge(%s) then VACUUM", (scope) => {
  it("leaves no fragment of a stored token in the database file", () => {
    const baseline = purgedFile(scope, false);
    const raw = purgedFile(scope, true);
    // Windows that a bare database already contains by chance are not evidence of residue.
    const probes = [...trigrams(TOKEN), ...trigrams(PEM_LINE)].filter((t) => !baseline.includes(t));
    expect(probes.length).toBeGreaterThan(40);
    const left = probes.filter((t) => raw.includes(t));
    expect(left).toEqual([]);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(PEM_LINE);
  });
});

describe("purge and the recall index", () => {
  function withRecall(scope: "sessions" | "index") {
    const dir = mkdtempSync(join(tmpdir(), "em-residue-"));
    const path = join(dir, "t.db");
    const db = new SqliteAdapter(path, { vectors: false });
    const content = `ZqErrorToken failure ${TOKEN}\n${PEM_LINE}\n`;
    const add = (source: string, title: string, text: string) =>
      db.upsertDocument(
        { source, title, contentType: "prose", contentHash: hashText(text) },
        chunk(text, title, undefined, undefined).chunks,
      );
    db.transaction(() => {
      for (let i = 0; i < 50; i++) add("memory", `m${i}`, `kept memory number ${i} alpha`);
      add("session", "error", content);
    });
    db.purge(scope);
    const sql = (db as unknown as { db: { prepare(s: string): { get(): unknown } } }).db;
    const count = (q: string) => (sql.prepare(q).get() as { n: number }).n;
    const out = {
      err: count("SELECT count(*) n FROM recall_fts WHERE recall_fts MATCH 'ZqErrorToken'"),
      all: count("SELECT count(*) n FROM recall_fts"),
      file: "",
    };
    db.close();
    out.file = readFileSync(path).toString("latin1");
    rmSync(dir, { recursive: true, force: true });
    return out;
  }

  it("purge(sessions) leaves no recall match or token for a purged error", () => {
    const r = withRecall("sessions");
    expect(r.err).toBe(0);
    expect(r.all).toBe(50);
    // the index stores the lowercased word pieces, so look for those, not the original casing
    expect(r.file.toLowerCase()).not.toContain("zqerrortoken");
    expect(r.file.toLowerCase()).not.toContain("zq7xk2vwrt9lm4np8bs3hd6jc1fy5gu0ea2w");
  });

  it("purge(index) leaves the recall index empty and free of the token", () => {
    const r = withRecall("index");
    expect(r.all).toBe(0);
    // the index stores the lowercased word pieces, so look for those, not the original casing
    expect(r.file.toLowerCase()).not.toContain("zqerrortoken");
    expect(r.file.toLowerCase()).not.toContain("zq7xk2vwrt9lm4np8bs3hd6jc1fy5gu0ea2w");
  });

  /**
   * An older eminiar (0.14.x) on a database this one migrated: its purge('sessions') knows
   * nothing of recall_fts, so only the trigger deletes the error rows from it, as a plain
   * DELETE FROM chunks, then VACUUMs. `recallSecureDelete: 0` turns the table's persistent
   * option off first (the control); otherwise it is left as this version set it.
   */
  function olderPurge(recallSecureDelete?: 0): string {
    const dir = mkdtempSync(join(tmpdir(), "em-residue-old-"));
    const path = join(dir, "t.db");
    const db = new SqliteAdapter(path, { vectors: false });
    const text = `ZqErrorToken failure ${TOKEN}\n`;
    db.transaction(() => {
      for (let i = 0; i < 50; i++) {
        const t = `kept memory number ${i} alpha`;
        db.upsertDocument(
          { source: "memory", title: `m${i}`, contentType: "prose", contentHash: hashText(t) },
          chunk(t, `m${i}`, undefined, undefined).chunks,
        );
      }
      db.upsertDocument(
        { source: "session", title: "error", contentType: "prose", contentHash: hashText(text) },
        chunk(text, "error", undefined, undefined).chunks,
      );
    });
    db.close();
    const old = new Database(path);
    if (recallSecureDelete === 0)
      old.exec("INSERT INTO recall_fts(recall_fts, rank) VALUES ('secure-delete', 0)");
    // what 0.14.x purgeDocumentsBySource does: secure-delete on its own two FTS tables only
    const fts = ["chunks_fts_porter", "chunks_fts_trigram"];
    for (const t of fts) old.exec(`INSERT INTO ${t}(${t}, rank) VALUES ('secure-delete', 1)`);
    old.exec(
      "DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE source = 'session')",
    );
    for (const t of fts) old.exec(`INSERT INTO ${t}(${t}, rank) VALUES ('secure-delete', 0)`);
    old.exec("DELETE FROM documents WHERE source = 'session'");
    old.exec("VACUUM");
    old.close();
    const file = readFileSync(path).toString("latin1").toLowerCase();
    rmSync(dir, { recursive: true, force: true });
    return file;
  }

  it("an older eminiar's purge through the trigger leaves no token: secure-delete is persistent", () => {
    // a fresh database has it on, so the older purge needs nothing from this version
    const file = olderPurge();
    // FTS5 prefix-compresses a term against the one before it ("zq7x…" then "errortoken"), so
    // look for the suffix as well as the whole long token
    expect(file).not.toContain("errortoken");
    expect(file).not.toContain("zq7xk2vwrt9lm4np8bs3hd6jc1fy5gu0ea2w");
  });

  it("control: without the persistent option the same older purge leaves the token behind", () => {
    const file = olderPurge(0);
    expect(file).toContain("zq7xk2vwrt9lm4np8bs3hd6jc1fy5gu0ea2w");
    expect(file).toContain("errortoken");
  });
});
