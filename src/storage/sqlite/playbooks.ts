import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  PlaybookInput,
  PlaybookRow,
  PlaybookRunInput,
  PlaybookRunRow,
  PlaybookRunStatus,
  PlaybookStore,
  PlaybookSuggestionInput,
  PlaybookSuggestionRow,
  PlaybookSuggestionStatus,
} from "../types.js";

/** One suggestion per task, however it is phrased in whitespace and case. */
export function playbookFingerprint(prompt: string): string {
  const norm = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

const json = (v: unknown[] | undefined): string | null => (v?.length ? JSON.stringify(v) : null);

/** SQLite implementation of the playbook store; shares the adapter's connection. */
export class SqlitePlaybookStore implements PlaybookStore {
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();

  constructor(private readonly db: Database.Database) {}

  private prep(sql: string): Database.Statement<unknown[], unknown> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  upsert(p: PlaybookInput): number {
    const now = Date.now();
    const created = p.createdAt ?? now;
    this.prep(
      `INSERT INTO playbooks (name, title, prompt, params, schedule, tags, source, private, path,
         file_hash, file_mtime, file_size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET title = excluded.title, prompt = excluded.prompt,
         params = excluded.params, schedule = excluded.schedule, tags = excluded.tags,
         source = excluded.source, private = excluded.private, path = excluded.path,
         file_hash = excluded.file_hash, file_mtime = excluded.file_mtime,
         file_size = excluded.file_size, updated_at = excluded.updated_at`,
    ).run(
      p.name,
      p.title,
      p.prompt,
      json(p.params),
      p.schedule ?? null,
      json(p.tags),
      p.source ?? "manual",
      p.private ? 1 : 0,
      p.path ?? null,
      p.fileHash ?? null,
      p.fileMtime ?? null,
      p.fileSize ?? null,
      created,
      p.updatedAt ?? created,
    );
    return (this.prep("SELECT id FROM playbooks WHERE name = ?").get(p.name) as { id: number }).id;
  }

  get(name: string): PlaybookRow | undefined {
    return this.prep("SELECT * FROM playbooks WHERE name = ?").get(name) as PlaybookRow | undefined;
  }

  list(
    opts: {
      tag?: string | undefined;
      source?: string | undefined;
      includePrivate?: boolean | undefined;
      limit?: number | undefined;
    } = {},
  ): PlaybookRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.source) {
      where.push("source = ?");
      args.push(opts.source);
    }
    if (opts.includePrivate === false) where.push("private = 0");
    if (opts.tag) {
      // tags is a JSON array of strings: match the quoted element, with LIKE wildcards escaped
      where.push("tags LIKE ? ESCAPE '\\'");
      args.push(`%${JSON.stringify(opts.tag).replace(/[\\%_]/g, "\\$&")}%`);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 100_000));
    return this.prep(
      `SELECT * FROM playbooks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`,
    ).all(...args, limit) as PlaybookRow[];
  }

  delete(name: string): void {
    this.prep("DELETE FROM playbooks WHERE name = ?").run(name);
  }

  count(): number {
    return (this.prep("SELECT COUNT(*) AS n FROM playbooks").get() as { n: number }).n;
  }

  // --- runs ---------------------------------------------------------------------------

  runAdd(r: PlaybookRunInput): number {
    return Number(
      this.prep(
        "INSERT INTO playbook_runs (playbook, ts, trigger, session_id, status, note) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        r.playbook,
        r.ts ?? Date.now(),
        r.trigger,
        r.sessionId ?? null,
        r.status ?? "started",
        r.note ?? null,
      ).lastInsertRowid,
    );
  }

  runSetStatus(id: number, status: PlaybookRunStatus, note?: string | null | undefined): boolean {
    return (
      this.prep(
        "UPDATE playbook_runs SET status = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'started'",
      ).run(status, note ?? null, id).changes > 0
    );
  }

  getRun(id: number): PlaybookRunRow | undefined {
    return this.prep("SELECT * FROM playbook_runs WHERE id = ?").get(id) as
      | PlaybookRunRow
      | undefined;
  }

  runs(opts: { playbook?: string | undefined; limit?: number | undefined } = {}): PlaybookRunRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    return (
      opts.playbook
        ? this.prep(
            "SELECT * FROM playbook_runs WHERE playbook = ? ORDER BY ts DESC, id DESC LIMIT ?",
          ).all(opts.playbook, limit)
        : this.prep("SELECT * FROM playbook_runs ORDER BY ts DESC, id DESC LIMIT ?").all(limit)
    ) as PlaybookRunRow[];
  }

  runStats(): Map<string, { runs: number; lastTs: number }> {
    const rows = this.prep(
      "SELECT playbook, COUNT(*) AS runs, MAX(ts) AS lastTs FROM playbook_runs GROUP BY playbook",
    ).all() as Array<{ playbook: string; runs: number; lastTs: number }>;
    return new Map(rows.map((r) => [r.playbook, { runs: r.runs, lastTs: r.lastTs }]));
  }

  // --- suggestions --------------------------------------------------------------------

  suggestionAdd(s: PlaybookSuggestionInput): { id: number; created: boolean } {
    const fingerprint = playbookFingerprint(s.prompt);
    const r = this.prep(
      `INSERT INTO playbook_suggestions
         (ts, name, title, prompt, params, schedule, tags, evidence, session_id, status, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(fingerprint) DO NOTHING`,
    ).run(
      s.ts ?? Date.now(),
      s.name,
      s.title,
      s.prompt,
      json(s.params),
      s.schedule ?? null,
      json(s.tags),
      s.evidence ?? null,
      s.sessionId ?? null,
      fingerprint,
    );
    if (r.changes > 0) return { id: Number(r.lastInsertRowid), created: true };
    const row = this.prep("SELECT id FROM playbook_suggestions WHERE fingerprint = ?").get(
      fingerprint,
    ) as { id: number };
    return { id: row.id, created: false };
  }

  suggestionGet(id: number): PlaybookSuggestionRow | undefined {
    return this.prep("SELECT * FROM playbook_suggestions WHERE id = ?").get(id) as
      | PlaybookSuggestionRow
      | undefined;
  }

  suggestions(
    opts: { status?: PlaybookSuggestionStatus | undefined; limit?: number | undefined } = {},
  ): PlaybookSuggestionRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    return (
      opts.status
        ? this.prep(
            "SELECT * FROM playbook_suggestions WHERE status = ? ORDER BY ts DESC, id DESC LIMIT ?",
          ).all(opts.status, limit)
        : this.prep("SELECT * FROM playbook_suggestions ORDER BY ts DESC, id DESC LIMIT ?").all(
            limit,
          )
    ) as PlaybookSuggestionRow[];
  }

  suggestionSetStatus(
    id: number,
    status: PlaybookSuggestionStatus,
    playbook?: string | undefined,
  ): boolean {
    return (
      // only a pending suggestion changes: two processes cannot both accept (or accept and dismiss)
      this.prep(
        "UPDATE playbook_suggestions SET status = ?, playbook = ? WHERE id = ? AND status = 'pending'",
      ).run(status, playbook ?? null, id).changes > 0
    );
  }

  suggestionRelease(id: number, playbook: string): boolean {
    return (
      // only the claim this caller made (accepted under its name) goes back to pending
      this.prep(
        "UPDATE playbook_suggestions SET status = 'pending', playbook = NULL WHERE id = ? AND status = 'accepted' AND playbook = ?",
      ).run(id, playbook).changes > 0
    );
  }

  purgeMirror(): void {
    this.db.exec("DELETE FROM playbooks;");
  }

  purgeActivity(): void {
    this.db.exec("DELETE FROM playbook_runs; DELETE FROM playbook_suggestions;");
  }
}
