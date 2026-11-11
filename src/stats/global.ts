import Database from "better-sqlite3";
import { ensureDirs, restrictDbFiles } from "../paths.js";
import type { StatDelta, StatRow } from "../storage/types.js";

/**
 * ~/.eminiar/global.db: lifetime stats across every project plus the URL fetch
 * cache. Deliberately tiny and schema-stable so hooks can open it cheaply.
 */
export class GlobalDb {
  readonly db: Database.Database;
  private readonly insStat: Database.Statement<unknown[], unknown>;
  private readonly insDaily: Database.Statement<unknown[], unknown>;

  constructor(path = ensureDirs().globalDb) {
    this.db = new Database(path, { timeout: 2000 });
    restrictDbFiles(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stats (
        session_id TEXT NOT NULL, tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, raw_chars INTEGER NOT NULL DEFAULT 0,
        returned_chars INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, tool)
      );
      CREATE TABLE IF NOT EXISTS daily (
        day TEXT NOT NULL, tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, saved_chars INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, tool)
      );
      CREATE TABLE IF NOT EXISTS fetch_cache (
        url TEXT PRIMARY KEY, etag TEXT, title TEXT, markdown TEXT NOT NULL,
        fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    // Every tool call records a stat; prepare the two statements once.
    this.insStat = this.db.prepare(
      `INSERT INTO stats (session_id, tool, calls, raw_chars, returned_chars, duration_ms)
       VALUES ('lifetime', ?, 1, ?, ?, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET calls = calls + 1,
         raw_chars = raw_chars + excluded.raw_chars,
         returned_chars = returned_chars + excluded.returned_chars,
         duration_ms = duration_ms + excluded.duration_ms`,
    );
    this.insDaily = this.db.prepare(
      `INSERT INTO daily (day, tool, calls, saved_chars) VALUES (?, ?, 1, ?)
       ON CONFLICT(day, tool) DO UPDATE SET calls = calls + 1, saved_chars = saved_chars + excluded.saved_chars`,
    );
  }

  record(tool: string, d: StatDelta): void {
    this.insStat.run(tool, d.rawChars, d.returnedChars, d.durationMs);
    const day = new Date().toISOString().slice(0, 10);
    this.insDaily.run(day, tool, Math.max(0, d.rawChars - d.returnedChars));
  }

  lifetime(): StatRow[] {
    return this.db
      .prepare("SELECT * FROM stats WHERE session_id = 'lifetime' ORDER BY tool")
      .all() as StatRow[];
  }

  daily(days: number): Array<{ day: string; calls: number; saved_chars: number }> {
    return this.db
      .prepare(
        `SELECT day, SUM(calls) calls, SUM(saved_chars) saved_chars FROM daily
         GROUP BY day ORDER BY day DESC LIMIT ?`,
      )
      .all(days) as Array<{ day: string; calls: number; saved_chars: number }>;
  }

  cacheGet(
    url: string,
  ): { title: string | null; markdown: string; fetched_at: number } | undefined {
    const row = this.db
      .prepare(
        "SELECT title, markdown, fetched_at FROM fetch_cache WHERE url = ? AND expires_at > ?",
      )
      .get(url, Date.now()) as
      | { title: string | null; markdown: string; fetched_at: number }
      | undefined;
    return row;
  }

  cacheSet(url: string, title: string | null, markdown: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO fetch_cache (url, etag, title, markdown, fetched_at, expires_at) VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET title = excluded.title, markdown = excluded.markdown,
           fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      )
      .run(url, title, markdown, now, now + ttlMs);
  }

  purgeCache(): void {
    this.db.exec("DELETE FROM fetch_cache");
  }

  close(): void {
    this.db.close();
  }
}

let shared: GlobalDb | undefined;
export function globalDb(): GlobalDb {
  if (!shared) shared = new GlobalDb();
  return shared;
}
