import type Database from "better-sqlite3";
import { head, isSecretName, redactSecrets } from "../../adjudicator/redact.js";
import type { Level } from "../../adjudicator/security/types.js";
import type {
  SecurityInput,
  SecurityListFilter,
  SecurityRow,
  SecurityStore,
  SecuritySummary,
} from "../types.js";
import { SECURITY_SQL } from "./schema.js";

type Row = Record<string, unknown>;

/**
 * The accepted values, copied from src/adjudicator/security/types.ts on purpose: this file is
 * loaded by every hook through the storage adapter, and tests/unit/adjudicator-hooks-off.test.ts
 * forbids a runtime import of any adjudicator module but types.ts and redact.ts while the
 * adjudicator is off. tests/unit/adjudicator-security-store.test.ts pins these lists to the
 * originals, so a new level, surface or action cannot drift.
 */
export const STORED_LEVELS = ["low", "medium", "high", "critical"] as const;
export const STORED_ACTIONS = ["allow", "advise", "warn"] as const;
export const STORED_SURFACES = ["agent", "plan", "prompt", "mcp"] as const;
export const STORED_AUTONOMIES = ["manual", "default", "autonomous"] as const;
export const STORED_GRANT_STATUSES = ["known", "inherit", "unknown"] as const;
const LEVELS = STORED_LEVELS;

/** Rows older than this are pruned (about one insert in PRUNE_EVERY does it). */
export const SECURITY_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 100;
/** The most a row's `detail` may hold, in bytes of JSON. */
export const SECURITY_DETAIL_MAX = 8 * 1024;
const MAX_LIST = 500;
const MAX_RULES = 64;
const ID_CHARS = 128;
const STR_CHARS = 240;
const SHORT_STR_CHARS = 120;

/**
 * Keys that carry what the agent was asked to read or run. Nothing here is ever stored: the
 * detail holds ids, numbers, tags and reasons, never a tool's arguments or the text it matched.
 */
const ARGUMENT_KEYS = new Set([
  "args",
  "arg",
  "arguments",
  "toolinput",
  "tool_input",
  "input",
  "inputs",
  "command",
  "cmd",
  "prompt",
  "text",
  "content",
  "body",
  "env",
  "headers",
  "cwd",
  "path",
  "paths",
  "file",
  "files",
  "snippet",
  "match",
  "matched",
  "matches",
  "url",
  "urls",
]);

function rankSql(col: string): string {
  return `(CASE ${col} WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 WHEN 'critical' THEN 3 END)`;
}

function cut(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join("")}…`;
}

/** A string kept in a row: masked for secrets, cut. */
function safeString(s: string, n: number): string {
  return cut(redactSecrets(s), n);
}

function idOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? cut(v, ID_CHARS) : null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function oneOf<T extends string>(list: readonly T[], v: unknown, what: string): T {
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  throw new Error(`invalid security ${what}`);
}

function score(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`invalid security ${what}`);
  return Math.max(0, Math.min(100, Math.round(v)));
}

interface Limits {
  arr: number;
  str: number;
  keys: number;
  depth: number;
}

/**
 * Copy of `v` that is safe to keep: argument-like and secret-named keys dropped, strings masked
 * and cut, arrays and objects bounded. Anything that is not JSON data (functions, symbols,
 * bigints, non-finite numbers) becomes null.
 */
function sanitize(v: unknown, lim: Limits, depth = 0): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return safeString(v, lim.str);
  if (depth >= lim.depth) return null;
  if (Array.isArray(v)) return v.slice(0, lim.arr).map((x) => sanitize(x, lim, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (n >= lim.keys) break;
      if (x === undefined || typeof x === "function") continue;
      if (ARGUMENT_KEYS.has(k.toLowerCase()) || isSecretName(k)) continue;
      out[cut(k, 64)] = sanitize(x, lim, depth + 1);
      n++;
    }
    return out;
  }
  return null;
}

/** The detail JSON to store: sanitised, then tightened until it fits SECURITY_DETAIL_MAX. */
export function securityDetailJson(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const tries: Limits[] = [
    { arr: 32, str: STR_CHARS, keys: 48, depth: 6 },
    { arr: 12, str: SHORT_STR_CHARS, keys: 32, depth: 5 },
    { arr: 4, str: 60, keys: 16, depth: 4 },
  ];
  for (const lim of tries) {
    const json = JSON.stringify(sanitize(detail, lim));
    if (json !== undefined && Buffer.byteLength(json) <= SECURITY_DETAIL_MAX) return json;
  }
  return JSON.stringify({ truncated: true });
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseRules(raw: unknown): string[] {
  const v = parseJson(raw);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function toRow(r: Row): SecurityRow {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    surface: r.surface as SecurityRow["surface"],
    sessionId: strOrNull(r.session_id),
    toolUseId: strOrNull(r.tool_use_id),
    agentType: strOrNull(r.agent_type),
    runId: strOrNull(r.run_id),
    taskId: numOrNull(r.task_id),
    adjudicationId: numOrNull(r.adjudication_id),
    inputHash: strOrNull(r.input_hash),
    inputHead: strOrNull(r.input_head),
    level: r.level as Level,
    score: Number(r.score),
    action: r.action as SecurityRow["action"],
    heuristicLevel: r.heuristic_level as Level,
    heuristicScore: Number(r.heuristic_score),
    modelLevel: r.model_level == null ? null : (r.model_level as Level),
    modelScore: numOrNull(r.model_score),
    modelStatus: String(r.model_status),
    source: String(r.source),
    autonomy: strOrNull(r.autonomy),
    grantStatus: strOrNull(r.grant_status),
    rules: parseRules(r.rules),
    detail: parseJson(r.detail),
    noted: Number(r.noted) === 1,
    version: String(r.version),
  };
}

/** Validated, redacted, bounded: the values of one INSERT, in INSERT_COLUMNS order. */
function toValues(input: SecurityInput, now: number): unknown[] {
  const modelLevel =
    input.modelLevel == null ? null : oneOf(LEVELS, input.modelLevel, "modelLevel");
  const rules = (input.rules ?? [])
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, MAX_RULES)
    .map((x) => cut(x, 16));
  return [
    intOrNull(input.ts) ?? now,
    oneOf(STORED_SURFACES, input.surface, "surface"),
    idOrNull(input.sessionId),
    idOrNull(input.toolUseId),
    idOrNull(input.agentType),
    idOrNull(input.runId),
    intOrNull(input.taskId),
    intOrNull(input.adjudicationId),
    typeof input.inputHash === "string" && input.inputHash ? cut(input.inputHash, 64) : null,
    // head() is idempotent: a head that was already redacted comes out unchanged.
    typeof input.inputHead === "string" ? head(input.inputHead) : null,
    oneOf(LEVELS, input.level, "level"),
    score(input.score, "score"),
    oneOf(STORED_ACTIONS, input.action, "action"),
    oneOf(LEVELS, input.heuristicLevel, "heuristicLevel"),
    score(input.heuristicScore, "heuristicScore"),
    modelLevel,
    modelLevel === null || input.modelScore == null ? null : score(input.modelScore, "modelScore"),
    typeof input.modelStatus === "string" && input.modelStatus ? cut(input.modelStatus, 32) : "off",
    typeof input.source === "string" && input.source ? cut(input.source, 32) : "heuristic",
    input.autonomy == null ? null : oneOf(STORED_AUTONOMIES, input.autonomy, "autonomy"),
    input.grantStatus == null
      ? null
      : oneOf(STORED_GRANT_STATUSES, input.grantStatus, "grantStatus"),
    JSON.stringify(rules),
    securityDetailJson(input.detail),
    input.noted ? 1 : 0,
    typeof input.version === "string" && input.version ? cut(input.version, 16) : "1",
  ];
}

const INSERT_COLUMNS = [
  "ts",
  "surface",
  "session_id",
  "tool_use_id",
  "agent_type",
  "run_id",
  "task_id",
  "adjudication_id",
  "input_hash",
  "input_head",
  "level",
  "score",
  "action",
  "heuristic_level",
  "heuristic_score",
  "model_level",
  "model_score",
  "model_status",
  "source",
  "autonomy",
  "grant_status",
  "rules",
  "detail",
  "noted",
  "version",
] as const;

const INSERT_SQL = `INSERT INTO adjudicator_security (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`;

function levelCounts(): Record<Level, number> {
  return { low: 0, medium: 0, high: 0, critical: 0 };
}

function asLevel(v: unknown): Level | undefined {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v)
    ? (v as Level)
    : undefined;
}

/**
 * SQLite implementation of the security store; shares the adapter's connection. Nothing here
 * runs, and no table is touched, until a method is called: a build with security off never
 * reaches it.
 */
export class SqliteSecurityStore implements SecurityStore {
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();
  private ready = false;

  constructor(private readonly db: Database.Database) {}

  private prep(sql: string): Database.Statement<unknown[], unknown> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private hasTable(): boolean {
    try {
      return (
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adjudicator_security'",
          )
          .get() !== undefined
      );
    } catch {
      return true; // let the statement that needs the table report the real error
    }
  }

  /**
   * A database can claim schema_version 13 or later without the table (another build's
   * numbering, a restored file): create it on first use. One sqlite_master lookup when it exists.
   */
  private ensure(): void {
    if (this.ready) return;
    if (!this.hasTable()) {
      try {
        this.db.exec(SECURITY_SQL);
      } catch {
        return; // read-only or busy: the statement that needs the table reports the error
      }
    }
    this.ready = true;
  }

  private withLockWait<T>(ms: number, fn: () => T): T {
    const prev = Number(this.db.pragma("busy_timeout", { simple: true }));
    const next = Math.max(0, Math.min(Number.isFinite(prev) ? prev : 0, Math.floor(ms)));
    if (next === prev) return fn();
    this.db.pragma(`busy_timeout = ${next}`);
    try {
      return fn();
    } finally {
      this.db.pragma(`busy_timeout = ${prev}`);
    }
  }

  /** Run `fn` with PRAGMA secure_delete=ON so deleted rows are zeroed on disk; restores the old value. */
  private secureDelete<T>(fn: () => T): T {
    let prev: number | undefined;
    try {
      prev = Number(this.db.pragma("secure_delete", { simple: true }));
      if (prev !== 1) this.db.pragma("secure_delete = ON");
    } catch {
      prev = undefined;
    }
    try {
      return fn();
    } finally {
      if (prev !== undefined && prev !== 1) {
        try {
          this.db.pragma(`secure_delete = ${prev}`);
        } catch {
          // a connection left at ON is only slower, never wrong
        }
      }
    }
  }

  /** Best-effort WAL truncate so deleted rows do not linger in old log frames; never throws, never waits. */
  private checkpoint(): void {
    if (this.db.inTransaction) return;
    try {
      this.withLockWait(0, () => this.db.pragma("wal_checkpoint(TRUNCATE)"));
    } catch {
      // fail open
    }
  }

  insert(input: SecurityInput, o: { lockWaitMs?: number } = {}): number | undefined {
    try {
      const values = toValues(input, Date.now());
      this.ensure();
      const id = this.withLockWait(o.lockWaitMs ?? 0, () =>
        Number(this.prep(INSERT_SQL).run(...values).lastInsertRowid),
      );
      if (id % PRUNE_EVERY === 0) {
        try {
          this.prune(Date.now() - SECURITY_KEEP_MS);
        } catch {
          // pruning is housekeeping
        }
      }
      return id;
    } catch {
      return undefined;
    }
  }

  get(id: number): SecurityRow | undefined {
    this.ensure();
    const r = this.prep("SELECT * FROM adjudicator_security WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? toRow(r) : undefined;
  }

  byAdjudication(adjudicationId: number): SecurityRow | undefined {
    this.ensure();
    const r = this.prep(
      "SELECT * FROM adjudicator_security WHERE adjudication_id = ? ORDER BY ts DESC, id DESC LIMIT 1",
    ).get(adjudicationId) as Row | undefined;
    return r ? toRow(r) : undefined;
  }

  list(filter: SecurityListFilter = {}): { rows: SecurityRow[]; total: number } {
    this.ensure();
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    if (filter.level) {
      where.push("level = ?");
      params.push(filter.level);
    }
    if (filter.minLevel) {
      const from = LEVELS.indexOf(filter.minLevel);
      const levels = from < 0 ? [] : LEVELS.slice(from);
      where.push(`level IN (${levels.map(() => "?").join(", ") || "NULL"})`);
      params.push(...levels);
    }
    if (filter.surface) {
      where.push("surface = ?");
      params.push(filter.surface);
    }
    if (filter.runId !== undefined) {
      where.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.taskId !== undefined) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.prep(`SELECT COUNT(*) AS n FROM adjudicator_security ${clause}`).get(...params) as {
        n: number;
      }
    ).n;
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 50), MAX_LIST));
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    const rows = this.prep(
      `SELECT * FROM adjudicator_security ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Row[];
    return { rows: rows.map(toRow), total };
  }

  forTask(runId: string, taskId: number): SecurityRow | undefined {
    this.ensure();
    const r = this.prep(
      `SELECT * FROM adjudicator_security WHERE run_id = ? AND task_id = ?
       ORDER BY (surface = 'agent') DESC, ts DESC, id DESC LIMIT 1`,
    ).get(runId, taskId) as Row | undefined;
    return r ? toRow(r) : undefined;
  }

  forRun(runId: string): SecurityRow[] {
    this.ensure();
    const rows = this.prep(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY task_id ORDER BY (surface = 'agent') DESC, ts DESC, id DESC
         ) AS rn
         FROM adjudicator_security WHERE run_id = ? AND task_id IS NOT NULL
       ) WHERE rn = 1 ORDER BY task_id`,
    ).all(runId) as Row[];
    return rows.map(toRow);
  }

  summary(since?: number): SecuritySummary {
    this.ensure();
    const clause = since === undefined ? "" : "WHERE ts >= ?";
    const params: unknown[] = since === undefined ? [] : [since];
    const all = (sql: string): Row[] => this.prep(sql).all(...params) as Row[];

    const byLevel = levelCounts();
    let total = 0;
    for (const r of all(
      `SELECT level, COUNT(*) AS n FROM adjudicator_security ${clause} GROUP BY level`,
    )) {
      const lv = asLevel(r.level);
      if (!lv) continue;
      byLevel[lv] = Number(r.n);
      total += Number(r.n);
    }

    const bySurface: Record<string, number> = {};
    for (const r of all(
      `SELECT surface, COUNT(*) AS n FROM adjudicator_security ${clause} GROUP BY surface`,
    ))
      bySurface[String(r.surface)] = Number(r.n);

    const days = new Map<string, { day: string } & Record<Level, number>>();
    for (const r of all(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, level, COUNT(*) AS n
       FROM adjudicator_security ${clause} GROUP BY day, level ORDER BY day`,
    )) {
      const lv = asLevel(r.level);
      if (!lv || typeof r.day !== "string") continue;
      let d = days.get(r.day);
      if (!d) {
        d = { day: r.day, ...levelCounts() };
        days.set(r.day, d);
      }
      d[lv] = Number(r.n);
    }

    const rules = all(
      `SELECT j.value AS id, COUNT(*) AS n
       FROM adjudicator_security s, json_each(CASE WHEN json_valid(s.rules) THEN s.rules ELSE '[]' END) j
       ${clause.replace("WHERE ts", "WHERE s.ts")}
       GROUP BY j.value ORDER BY n DESC, j.value LIMIT 50`,
    ).map((r) => ({ id: String(r.id), n: Number(r.n) }));

    const matrix: Record<Level, Record<Level, number>> = {
      low: levelCounts(),
      medium: levelCounts(),
      high: levelCounts(),
      critical: levelCounts(),
    };
    for (const r of all(
      `SELECT heuristic_level AS h, level AS f, COUNT(*) AS n FROM adjudicator_security ${clause}
       GROUP BY heuristic_level, level`,
    )) {
      const h = asLevel(r.h);
      const f = asLevel(r.f);
      if (h && f) matrix[h][f] = Number(r.n);
    }

    const byStatus: Record<string, number> = {};
    for (const r of all(
      `SELECT model_status AS s, COUNT(*) AS n FROM adjudicator_security ${clause} GROUP BY model_status`,
    ))
      byStatus[String(r.s)] = Number(r.n);

    const cmp = (this.prep(
      `SELECT
         COALESCE(SUM(model_level IS NULL), 0) AS none,
         COALESCE(SUM(model_level IS NOT NULL AND ${rankSql("model_level")} > ${rankSql("heuristic_level")}), 0) AS raised,
         COALESCE(SUM(model_level IS NOT NULL AND ${rankSql("model_level")} < ${rankSql("heuristic_level")}), 0) AS lower,
         COALESCE(SUM(model_level IS NOT NULL AND ${rankSql("model_level")} = ${rankSql("heuristic_level")}), 0) AS agreed
       FROM adjudicator_security ${clause}`,
    ).get(...params) ?? {}) as Row;

    return {
      total,
      byLevel,
      bySurface,
      perDay: [...days.values()],
      rules,
      matrix,
      byStatus,
      modelRaised: Number(cmp.raised ?? 0),
      modelLower: Number(cmp.lower ?? 0),
      modelAgreed: Number(cmp.agreed ?? 0),
      heuristicOnly: Number(cmp.none ?? 0),
    };
  }

  prune(before: number): number {
    if (!this.hasTable()) return 0;
    const del = this.prep("DELETE FROM adjudicator_security WHERE ts < ?");
    return this.secureDelete(() => del.run(before).changes);
  }

  purge(): number {
    // A database from another build may lack the table: nothing to delete, nothing to create.
    if (!this.hasTable()) return 0;
    const del = this.prep("DELETE FROM adjudicator_security");
    const n = this.secureDelete(() => del.run().changes);
    // Inside the adapter's purge transaction this is skipped (the adapter VACUUMs after).
    this.checkpoint();
    return n;
  }
}
