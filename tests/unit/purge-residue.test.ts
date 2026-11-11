import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
