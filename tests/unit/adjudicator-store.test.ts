import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EFFORTS, type Verdict } from "../../src/adjudicator/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { EXCHANGE_KEEP } from "../../src/storage/sqlite/adjudicator.js";
import {
  ADJUDICATOR_LATE_COLUMNS,
  ADJUDICATOR_LATE_INDEXES,
  healAdjudicatorColumns,
  migrations,
} from "../../src/storage/sqlite/schema.js";
import type { AdjudicationInput, ExchangeInput } from "../../src/storage/types.js";
import { emPurge } from "../../src/tools/em_purge.js";

const TABLES = [
  "adjudications",
  "adjudicator_cache",
  "adjudicator_provider_state",
  "adjudicator_bias",
  "adjudicator_exchanges",
];

function tmpDb(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "eminiar.db");
}

function count(a: SqliteAdapter, table: string): number {
  return (a.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function row(over: Partial<AdjudicationInput> = {}): AdjudicationInput {
  return { surface: "agent", inputHash: "h", ...over };
}

const VERDICT = {
  key: "k1",
  source: "heuristic",
  provider: "heuristic",
  providerStatus: "n/a",
  complexity: 1.5,
  effort: "medium",
  version: "1",
} as unknown as Verdict;

describe("schema migration v8: adjudicator tables", () => {
  it("applies on top of a v7 database and is the latest version", () => {
    expect(migrations.find((m) => m.version === 8)).toBeTruthy();
    expect(migrations[migrations.length - 1]?.version).toBe(12);
    const path = tmpDb("em-v7-");
    const raw = new Database(path);
    for (const m of migrations) {
      if (m.version > 7) break;
      if (m.sql) raw.exec(m.sql);
      m.up?.(raw);
    }
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7')").run();
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'adjudications'").get(),
    ).toBeUndefined();
    raw.close();

    const a = new SqliteAdapter(path, { vectors: false });
    try {
      expect(a.metaGet("schema_version")).toBe("12");
      const names = (
        a.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      for (const t of [
        ...TABLES,
        "adjudications_session",
        "adjudications_task",
        "adjudications_hash",
        "adjudications_ts",
        "adjudications_final",
      ])
        expect(names).toContain(t);
      // The v7 swarm ledger is still there and usable.
      expect(names).toContain("swarm_runs");
      expect(a.adjudicator.insert(row())).toBeGreaterThan(0);
      // The provider state carries the daily call count and the rejected-key fingerprint.
      const cols = (
        a.db.prepare("PRAGMA table_info(adjudicator_provider_state)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(["calls", "auth_fingerprint"]));
    } finally {
      a.close();
    }
    // Reopening is a no-op.
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      expect(again.metaGet("schema_version")).toBe("12");
      expect(count(again, "adjudications")).toBe(1);
    } finally {
      again.close();
    }
  });
});

describe("pre-release v8 databases (task #26)", () => {
  const colsOf = (db: Database.Database, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const hasIndex = (db: Database.Database, name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);

  /** The v8 DDL as it first ran on development machines: without the late columns. */
  function oldV8Sql(): string {
    let sql = migrations.find((m) => m.version === 8)!.sql!;
    for (const [, col, ddl] of ADJUDICATOR_LATE_COLUMNS) {
      sql = sql.replace(`  ${col} ${ddl},\n`, "").replace(`,\n  ${col} ${ddl}\n)`, "\n)");
    }
    for (const [table, index, cols] of ADJUDICATOR_LATE_INDEXES) {
      const line = `CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${cols});\n`;
      expect(sql).toContain(line);
      sql = sql.replace(line, "");
    }
    return sql;
  }

  function oldV8Db(): string {
    const path = tmpDb("em-v8-old-");
    const raw = new Database(path);
    for (const m of migrations) {
      if (m.version > 7) break;
      if (m.sql) raw.exec(m.sql);
      m.up?.(raw);
    }
    raw.exec(oldV8Sql());
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '8')").run();
    for (const [table, col] of ADJUDICATOR_LATE_COLUMNS)
      expect(colsOf(raw, table)).not.toContain(col);
    for (const [, index] of ADJUDICATOR_LATE_INDEXES) expect(hasIndex(raw, index)).toBe(false);
    raw
      .prepare(
        "INSERT INTO adjudicator_provider_state (provider, state, failures, spend_usd) VALUES ('openai', 'open', 2, 0.5)",
      )
      .run();
    raw
      .prepare("INSERT INTO adjudications (ts, surface, input_hash) VALUES (1, 'agent', 'old')")
      .run();
    raw.close();
    return path;
  }

  it("adds the missing v8 columns on first use, keeps the rows, and saves state again", () => {
    const path = oldV8Db();
    const a = new SqliteAdapter(path, { vectors: false });
    try {
      expect(a.metaGet("schema_version")).toBe("12");
      // Opening alone leaves the tables alone (a disabled adjudicator never touches them).
      expect(colsOf(a.db, "adjudications")).not.toContain("feedback_note");
      expect(a.adjudicator.providerState("openai")).toMatchObject({
        state: "open",
        failures: 2,
        calls: 0,
        authFingerprint: null,
      });
      for (const [table, col] of ADJUDICATOR_LATE_COLUMNS)
        expect(colsOf(a.db, table)).toContain(col);
      for (const [, index] of ADJUDICATOR_LATE_INDEXES) expect(hasIndex(a.db, index)).toBe(true);
      const saved = a.adjudicator.saveProviderState("openai", { calls: 3, authFingerprint: "fp1" });
      expect(saved).toMatchObject({ calls: 3, authFingerprint: "fp1", failures: 2 });
      expect(a.adjudicator.providerState("openai")).toMatchObject({
        calls: 3,
        authFingerprint: "fp1",
      });
      const id = a.adjudicator.insert(row({ feedbackNote: "kept" }));
      expect(a.adjudicator.get(id)?.feedbackNote).toBe("kept");
      expect(a.adjudicator.list().total).toBe(2);
    } finally {
      a.close();
    }
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      expect(healAdjudicatorColumns(again.db)).toEqual([]);
      expect(again.adjudicator.providerState("openai")?.calls).toBe(3);
    } finally {
      again.close();
    }
  });

  it("heals idempotently and skips tables that do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(healAdjudicatorColumns(empty)).toEqual([]);
    empty.close();
    const raw = new Database(oldV8Db());
    expect(healAdjudicatorColumns(raw)).toEqual([
      "adjudicator_provider_state.calls",
      "adjudicator_provider_state.auth_fingerprint",
      "adjudications.feedback_note",
      "adjudicator_provider_state.latency_budgets",
      "adjudications_tool_use",
    ]);
    expect(healAdjudicatorColumns(raw)).toEqual([]);
    raw.close();
  });

  it("stores, clears and lists the feedback note on a fresh database", () => {
    const a = new SqliteAdapter(tmpDb("em-note-"), { vectors: false });
    try {
      const id = a.adjudicator.insert(row());
      expect(a.adjudicator.get(id)?.feedbackNote ?? null).toBeNull();
      expect(a.adjudicator.update(id, { feedbackNote: "needed opus" })).toBe(true);
      expect(a.adjudicator.get(id)?.feedbackNote).toBe("needed opus");
      expect(a.adjudicator.list().rows[0]?.feedbackNote).toBe("needed opus");
      a.adjudicator.update(id, { feedbackNote: null });
      expect(a.adjudicator.get(id)?.feedbackNote).toBeNull();
    } finally {
      a.close();
    }
  });
});

describe("SqliteAdjudicatorStore", () => {
  let a: SqliteAdapter;
  beforeEach(() => {
    a = new SqliteAdapter(tmpDb("em-adj-"), { vectors: false });
  });
  afterEach(() => a.close());

  it("insert defaults ts, outcome and final; get maps every column back", () => {
    const before = Date.now();
    const id = a.adjudicator.insert(
      row({
        sessionId: "s1",
        runId: "r1",
        taskId: 7,
        inputHead: "fix the bug",
        inputChars: 11,
        complexity: 1.25,
        tier: "haiku",
        effort: "low",
        tool: "Edit",
        role: "coder",
        confidence: 0.8,
        scores: '{"a":1}',
        source: "heuristic",
        provider: "heuristic",
        providerStatus: "n/a",
        latencyMs: 3,
        action: "advised",
        baselineModel: "opus",
      }),
    );
    const r = a.adjudicator.get(id)!;
    expect(r.id).toBe(id);
    expect(r.ts).toBeGreaterThanOrEqual(before);
    expect(r.outcome).toBe("pending");
    expect(r.final).toBe(false);
    expect(r).toMatchObject({
      surface: "agent",
      sessionId: "s1",
      runId: "r1",
      taskId: 7,
      inputHash: "h",
      inputHead: "fix the bug",
      complexity: 1.25,
      tier: "haiku",
      confidence: 0.8,
      scores: '{"a":1}',
      action: "advised",
      baselineModel: "opus",
      agentId: null,
      savingsUsd: null,
    });
    expect(a.adjudicator.get(id + 999)).toBeUndefined();
  });

  it("update patches only the given columns, null clears, unknown id is false", () => {
    const id = a.adjudicator.insert(row({ tier: "sonnet", role: "coder" }));
    expect(
      a.adjudicator.update(id, {
        outcome: "success",
        final: true,
        actualModel: "claude-sonnet-4-5",
        role: null,
        tier: undefined,
      }),
    ).toBe(true);
    const r = a.adjudicator.get(id)!;
    expect(r).toMatchObject({
      outcome: "success",
      final: true,
      actualModel: "claude-sonnet-4-5",
      role: null,
      tier: "sonnet",
    });
    expect(a.adjudicator.update(id, {})).toBe(true);
    expect(a.adjudicator.update(id + 1, { outcome: "failure" })).toBe(false);
  });

  it("list filters, orders newest first, pages and counts the total", () => {
    for (let i = 0; i < 6; i++)
      a.adjudicator.insert(
        row({
          ts: 1000 + i,
          surface: i % 2 ? "prompt" : "agent",
          provider: i < 3 ? "heuristic" : "typesafe",
          outcome: i === 5 ? "success" : "pending",
        }),
      );
    const all = a.adjudicator.list();
    expect(all.total).toBe(6);
    expect(all.rows.map((r) => r.ts)).toEqual([1005, 1004, 1003, 1002, 1001, 1000]);
    expect(a.adjudicator.list({ surface: "prompt" }).total).toBe(3);
    expect(a.adjudicator.list({ provider: "typesafe", surface: "agent" }).rows).toHaveLength(1);
    expect(a.adjudicator.list({ outcome: "success" }).rows[0]?.ts).toBe(1005);
    expect(a.adjudicator.list({ since: 1004 }).total).toBe(2);
    const page = a.adjudicator.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(6);
    expect(page.rows.map((r) => r.ts)).toEqual([1003, 1002]);
  });

  it("latestForSession, forTask and nonFinal", () => {
    a.adjudicator.insert(row({ ts: 10, sessionId: "s", surface: "prompt", inputHash: "a" }));
    a.adjudicator.insert(row({ ts: 20, sessionId: "s", surface: "prompt", inputHash: "b" }));
    a.adjudicator.insert(row({ ts: 30, sessionId: "s", surface: "agent", inputHash: "c" }));
    a.adjudicator.insert(row({ ts: 40, sessionId: "t", surface: "prompt", inputHash: "d" }));
    expect(a.adjudicator.latestForSession("s", "prompt")?.inputHash).toBe("b");
    expect(a.adjudicator.latestForSession("nope", "prompt")).toBeUndefined();

    a.adjudicator.insert(row({ ts: 60, runId: "r", taskId: 1, surface: "agent", inputHash: "y" }));
    a.adjudicator.insert(row({ ts: 50, runId: "r", taskId: 1, surface: "plan", inputHash: "x" }));
    a.adjudicator.insert(row({ ts: 55, runId: "r", taskId: 2, inputHash: "z", final: true }));
    expect(a.adjudicator.forTask("r", 1).map((r) => r.inputHash)).toEqual(["x", "y"]);
    expect(a.adjudicator.forTask("r", 3)).toEqual([]);
    // forRun: every task row of the run, oldest first; rows without a task id and other runs stay out
    a.adjudicator.insert(row({ ts: 70, runId: "other", taskId: 1, inputHash: "o", final: true }));
    expect(a.adjudicator.forRun("r").map((r) => r.inputHash)).toEqual(["x", "z", "y"]);
    expect(a.adjudicator.forRun("none")).toEqual([]);

    expect(a.adjudicator.nonFinal(100).map((r) => r.ts)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(a.adjudicator.nonFinal(2).map((r) => r.ts)).toEqual([10, 20]);
    expect(a.adjudicator.nonFinal(100, 40).map((r) => r.ts)).toEqual([10, 20, 30]);
  });

  it("byToolUseId: newest match, surface and since filters, served by the index (#48)", () => {
    a.adjudicator.insert(row({ ts: 10, surface: "agent", toolUseId: "tu1", inputHash: "a" }));
    a.adjudicator.insert(row({ ts: 20, surface: "agent", toolUseId: "tu1", inputHash: "b" }));
    a.adjudicator.insert(row({ ts: 30, surface: "prompt", toolUseId: "tu1", inputHash: "c" }));
    a.adjudicator.insert(row({ ts: 40, surface: "agent", toolUseId: "tu2", inputHash: "d" }));
    expect(a.adjudicator.byToolUseId("tu1")?.inputHash).toBe("c");
    expect(a.adjudicator.byToolUseId("tu1", { surface: "agent" })?.inputHash).toBe("b");
    expect(a.adjudicator.byToolUseId("tu1", { surface: "agent", since: 21 })).toBeUndefined();
    expect(a.adjudicator.byToolUseId("tu1", { since: 15 })?.inputHash).toBe("c");
    expect(a.adjudicator.byToolUseId("nope")).toBeUndefined();
    // Older than the newest 200 agent rows is still found: no scan window.
    for (let i = 0; i < 250; i++)
      a.adjudicator.insert(row({ ts: 100 + i, surface: "agent", inputHash: `n${i}` }));
    expect(a.adjudicator.byToolUseId("tu2", { surface: "agent" })?.inputHash).toBe("d");
    const plan = a.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM adjudications WHERE tool_use_id = ? AND (? IS NULL OR surface = ?) AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .all("tu1", "agent", "agent", 0) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("adjudications_tool_use");
  });

  it("cache: put, hit counting, pending marker, max age and prune", () => {
    const s = a.adjudicator;
    expect(s.cacheGet("k1", 1000)).toBeUndefined();
    s.cachePut("k1", VERDICT, "heuristic", 1000);
    const hit = s.cacheGet("k1", 1500)!;
    expect(hit.verdict).toEqual(VERDICT);
    expect(hit).toMatchObject({ provider: "heuristic", createdAt: 1000, hits: 1, lastHitAt: 1500 });
    expect(s.cacheGet("k1", 1600)?.hits).toBe(2);
    // Expired by maxAge: a miss that does not bump.
    expect(s.cacheGet("k1", 5000, 1000)).toBeUndefined();
    expect(s.cacheGet("k1", 1700, 1000)?.hits).toBe(3);

    // The pending marker has no verdict and is not counted as a hit.
    s.cachePut("k2", null, "typesafe", 2000);
    const pending = s.cacheGet("k2", 2001)!;
    expect(pending.verdict).toBeNull();
    expect(pending.hits).toBe(0);
    // Replacing the marker with a verdict resets created_at and hits.
    s.cachePut("k2", VERDICT, "typesafe", 2100);
    expect(s.cacheGet("k2", 2200)).toMatchObject({ createdAt: 2100, hits: 1 });

    // Prune: TTL first, then LRU down to maxEntries.
    s.cachePut("old", VERDICT, "heuristic", 10);
    s.cachePut("k3", VERDICT, "heuristic", 3000);
    expect(s.cachePrune(10, 2500, 3000)).toBe(1);
    expect(s.cacheGet("old", 3000)).toBeUndefined();
    // Remaining: k1 (last hit 1700), k2 (last hit 2200), k3 (created 3000). Keep the 2 most recent.
    expect(s.cachePrune(2, 1_000_000, 3000)).toBe(1);
    expect(s.cacheGet("k1", 3000)).toBeUndefined();
    expect(s.cacheGet("k2", 3000)).toBeTruthy();
    expect(s.cacheGet("k3", 3000)).toBeTruthy();
  });

  it("provider state: defaults, merge, latency ring capped at 50", () => {
    const s = a.adjudicator;
    expect(s.providerState("typesafe")).toBeUndefined();
    const first = s.saveProviderState("typesafe", { failures: 1, lastErrorClass: "timeout" });
    expect(first).toMatchObject({
      provider: "typesafe",
      state: "closed",
      failures: 1,
      lastErrorClass: "timeout",
      latencies: [],
      spendUsd: 0,
      spendDay: null,
      calls: 0,
      authFingerprint: null,
    });
    s.saveProviderState("typesafe", {
      state: "open",
      retryAt: 9999,
      latencies: Array.from({ length: 60 }, (_, i) => i),
      spendDay: "2026-11-04",
      spendUsd: 0.0125,
    });
    const st = s.providerState("typesafe")!;
    expect(st).toMatchObject({
      state: "open",
      failures: 1,
      retryAt: 9999,
      lastErrorClass: "timeout",
      spendDay: "2026-11-04",
      spendUsd: 0.0125,
    });
    expect(st.latencies).toHaveLength(50);
    expect(st.latencies[0]).toBe(10);
    expect(st.latencies[49]).toBe(59);
    // Per-sample budgets round-trip and are never longer than the ring (aligned at the end).
    const withBudgets = s.saveProviderState("typesafe", {
      latencies: [1, 2],
      latencyBudgets: [800, 800, 3000],
    });
    expect(withBudgets.latencyBudgets).toEqual([800, 3000]);
    expect(s.providerState("typesafe")?.latencyBudgets).toEqual([800, 3000]);
    s.saveProviderState("typesafe", { latencies: Array.from({ length: 60 }, (_, i) => i) });
    // Daily calls and the auth lockout round-trip.
    s.saveProviderState("typesafe", {
      state: "auth_failed",
      calls: 7,
      authFingerprint: "0123456789ab",
    });
    expect(s.providerState("typesafe")).toMatchObject({
      state: "auth_failed",
      calls: 7,
      authFingerprint: "0123456789ab",
      spendUsd: 0.0125,
    });
    expect(s.saveProviderState("typesafe", { authFingerprint: null }).authFingerprint).toBeNull();
    // null clears a field; other providers are independent.
    expect(s.saveProviderState("typesafe", { retryAt: null }).retryAt).toBeNull();
    expect(s.providerState("openai-compatible")).toBeUndefined();
  });

  it("bias: upsert replaces by (dimension, bucket, option); reset clears only bias", () => {
    const s = a.adjudicator;
    s.biasUpsert({
      dimension: "tier",
      bucket: "c1",
      option: "haiku",
      n: 3,
      s: 2,
      f: 1,
      costMedian: 0.01,
      bias: 0.1,
      updatedAt: 5,
    });
    s.biasUpsert({
      dimension: "tier",
      bucket: "c1",
      option: "haiku",
      n: 4,
      s: 3,
      f: 1,
      costMedian: null,
      bias: 0.2,
    });
    s.biasUpsert({
      dimension: "role",
      bucket: "debug",
      option: "coder",
      n: 1,
      s: 1,
      f: 0,
      costMedian: null,
      bias: 0,
    });
    const all = s.biasAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ dimension: "role", option: "coder" });
    expect(all[1]).toMatchObject({ dimension: "tier", n: 4, s: 3, costMedian: null, bias: 0.2 });
    expect(all[1]?.updatedAt).toBeGreaterThan(5);
    s.cachePut("k", VERDICT, "heuristic");
    expect(s.biasReset()).toBe(2);
    expect(s.biasAll()).toEqual([]);
    expect(count(a, "adjudicator_cache")).toBe(1);
  });

  it("summary: counts, p50/p95, rates, spend, savings and apply effectiveness", () => {
    const s = a.adjudicator;
    // 20 prompt rows with latency 1..20 ms; provider latency on the first 10 (100..1000).
    for (let i = 1; i <= 20; i++)
      s.insert(
        row({
          ts: 1000 + i,
          surface: "prompt",
          source: i <= 10 ? "blend" : "heuristic",
          providerStatus: i <= 10 ? "ok" : "n/a",
          latencyMs: i,
          providerLatencyMs: i <= 10 ? i * 100 : null,
          costUsd: i <= 10 ? 0.001 : null,
          action: "advised",
          outcome: "n/a",
        }),
      );
    // Advise-mode agent dispatches: 3 followed (2 with savings), 1 ignored.
    s.insert(row({ ts: 2001, action: "followed", savingsUsd: 0.5, source: "cache" }));
    s.insert(row({ ts: 2002, action: "followed", savingsUsd: 0.25 }));
    s.insert(row({ ts: 2003, action: "followed" }));
    s.insert(row({ ts: 2004, action: "ignored", providerStatus: "timeout", source: "fallback" }));
    // Apply-mode: 3 applied (one took effect, one did not, one not yet reconciled), 1 respected.
    s.insert(
      row({
        ts: 3001,
        action: "applied",
        modelFinal: "haiku",
        actualModel: "claude-haiku-4-5",
        savingsUsd: 1,
      }),
    );
    s.insert(
      row({ ts: 3002, action: "applied", modelFinal: "haiku", actualModel: "claude-opus-4-1" }),
    );
    s.insert(row({ ts: 3003, action: "applied", modelFinal: "sonnet" }));
    s.insert(row({ ts: 3004, action: "respected", modelRequested: "opus" }));

    const sum = s.summary();
    expect(sum.since).toBeNull();
    expect(sum.total).toBe(28);
    expect(sum.bySurface).toEqual({ prompt: 20, agent: 8 });
    expect(sum.bySource).toEqual({ blend: 10, heuristic: 10, cache: 1, fallback: 1, "(none)": 6 });
    expect(sum.byProviderStatus).toMatchObject({ ok: 10, "n/a": 10, timeout: 1 });
    expect(sum.byAction).toEqual({
      advised: 20,
      followed: 3,
      ignored: 1,
      applied: 3,
      respected: 1,
    });
    expect(sum.byOutcome).toEqual({ "n/a": 20, pending: 8 });
    expect(sum.latency).toEqual({ n: 20, p50: 10, p95: 19 });
    expect(sum.providerLatency).toEqual({ n: 10, p50: 500, p95: 1000 });
    // followed / advise-mode dispatches: 3 / (3 followed + 1 ignored). The 20 advised prompt rows
    // are main-session advice, not dispatches, so they stay out (the old 3 / 24 counted them; #81).
    expect(sum.rates.follow).toBeCloseTo(3 / 4);
    expect(sum.rates.apply).toBeCloseTo(3 / 4);
    expect(sum.rates.respect).toBeCloseTo(1 / 4);
    expect(sum.costUsd).toBeCloseTo(0.01);
    expect(sum.savingsUsd).toBeCloseTo(1.75);
    expect(sum.netUsd).toBeCloseTo(1.74);
    expect(sum.applyChecked).toBe(2);
    expect(sum.applyIneffective).toBe(1);

    const recent = s.summary(3000);
    expect(recent.since).toBe(3000);
    expect(recent.total).toBe(4);
    expect(recent.rates.follow).toBeNull();
    expect(recent.latency).toEqual({ n: 0, p50: null, p95: null });
    expect(recent.savingsUsd).toBeCloseTo(1);
  });

  it("summary: advised rows whose advice named no model leave the follow rate (#78)", () => {
    const s = a.adjudicator;
    const scores = (o: unknown) => JSON.stringify(o);
    const ran = "claude-sonnet-5-5";
    s.insert(row({ ts: 1, action: "followed" }));
    s.insert(row({ ts: 2, action: "advised" }));
    // Flagged rows that ran: counted in keptModel like the savings report (#81).
    s.insert(
      row({ ts: 3, action: "advised", actualModel: ran, scores: scores({ pinDeferred: true }) }),
    );
    s.insert(
      row({
        ts: 4,
        action: "advised",
        actualModel: ran,
        scores: scores({ pinDeferred: true, pin: { model: "sonnet" } }),
      }),
    );
    s.insert(row({ ts: 5, action: "advised", actualModel: ran, scores: scores({ forced: true }) }));
    // A fork not priced yet: nothing to follow, but not in keptModel until it has run.
    s.insert(row({ ts: 6, action: "advised", scores: scores({ fork: true }) }));
    // A kept pin that ran on another model is no kept pin (keptPin), yet still has nothing to follow.
    s.insert(
      row({
        ts: 7,
        action: "advised",
        actualModel: "claude-haiku-4-5",
        scores: scores({ pinDeferred: true, pin: { model: "opus" } }),
      }),
    );
    // malformed scores and a false flag are ordinary advised rows
    s.insert(row({ ts: 8, action: "advised", scores: "{not json" }));
    s.insert(row({ ts: 9, action: "advised", scores: scores({ forced: false }) }));
    // An apply-mode row under FORCE that ran counts as kept, as in the savings report.
    s.insert(
      row({ ts: 10, action: "respected", actualModel: ran, scores: scores({ forced: true }) }),
    );
    const sum = s.summary();
    expect(sum.keptModel).toEqual({ pin: 2, force: 2, fork: 0 });
    expect(sum.byAction).toMatchObject({ advised: 8, followed: 1, respected: 1 });
    // followed / unflagged advise-mode dispatches (ts 1, 2, 8, 9)
    expect(sum.rates.follow).toBeCloseTo(1 / 4);
  });

  it("summary: counts each dispatch once, so a fully followed swarm run follows 100% (#81)", () => {
    const s = a.adjudicator;
    // Three swarm tasks, each a plan row (advised) and an agent row the coordinator followed.
    for (const t of [1, 2, 3]) {
      s.insert(row({ ts: t, surface: "plan", runId: "R1", taskId: t, action: "advised" }));
      s.insert(row({ ts: 10 + t, runId: "R1", taskId: t, action: "followed" }));
    }
    // Main-session prompt advice is no dispatch.
    s.insert(row({ ts: 20, surface: "prompt", action: "advised" }));
    let sum = s.summary();
    expect(sum.byAction).toMatchObject({ advised: 4, followed: 3 });
    expect(sum.rates.follow).toBe(1);
    // A task only planned (no agent row) counts by its plan row; a non-swarm agent row by itself.
    s.insert(row({ ts: 30, surface: "plan", runId: "R1", taskId: 4, action: "advised" }));
    s.insert(row({ ts: 31, action: "ignored" }));
    sum = s.summary();
    expect(sum.rates.follow).toBeCloseTo(3 / 5);
    // Inside a window that starts after the plan rows, the agent rows still count once each.
    expect(s.summary(11).rates.follow).toBeCloseTo(3 / 5);
  });

  it("summary: effort follow rate and passed-but-not-run counts come from the scores (#170)", () => {
    const s = a.adjudicator;
    const sc = (o: unknown) => JSON.stringify(o);
    // followed, ran at the passed level
    s.insert(
      row({
        ts: 1,
        scores: sc({ effortFollow: "followed", passedEffort: "high", actualEffort: "high" }),
      }),
    );
    // ignored, nothing passed
    s.insert(row({ ts: 2, scores: sc({ effortFollow: "ignored", actualEffort: "medium" }) }));
    // followed because the advised level was passed, but a lower one ran: ineffective
    s.insert(
      row({
        ts: 3,
        scores: sc({ effortFollow: "followed", passedEffort: "max", actualEffort: "high" }),
      }),
    );
    // an agent row without effort data, and garbage scores: not counted
    s.insert(row({ ts: 4, scores: sc({ passedEffort: "high" }) }));
    s.insert(row({ ts: 5, scores: "{not json" }));
    // a plan row with an agent sibling is no dispatch: its effort keys are not counted
    s.insert(
      row({
        ts: 6,
        surface: "plan",
        runId: "R",
        taskId: 1,
        scores: sc({ actualEffort: "low", effortFollow: "ignored" }),
      }),
    );
    s.insert(
      row({
        ts: 7,
        runId: "R",
        taskId: 1,
        scores: sc({ effortFollow: "followed", actualEffort: "low" }),
      }),
    );
    // a prompt row is no dispatch either
    s.insert(row({ ts: 8, surface: "prompt", scores: sc({ effortFollow: "ignored" }) }));
    const sum = s.summary();
    expect(sum.effortFollowed).toBe(3);
    expect(sum.effortIgnored).toBe(1);
    expect(sum.rates.effortFollow).toBeCloseTo(3 / 4);
    expect(sum.effortChecked).toBe(2);
    expect(sum.effortIneffective).toBe(1);
  });

  it("summary: effortApplied is the set level and beats passedEffort (checked/ineffective)", () => {
    const s = a.adjudicator;
    const sc = (o: unknown) => JSON.stringify(o);
    // applied == actual, passed differs: effective (passed alone would count ineffective)
    s.insert(
      row({
        ts: 1,
        scores: sc({ effortApplied: "high", passedEffort: "low", actualEffort: "high" }),
      }),
    );
    // applied != actual, passed == actual: ineffective (passed alone would count effective)
    s.insert(
      row({
        ts: 2,
        scores: sc({ effortApplied: "max", passedEffort: "high", actualEffort: "high" }),
      }),
    );
    // applied only
    s.insert(row({ ts: 3, scores: sc({ effortApplied: "medium", actualEffort: "low" }) }));
    // passed only still counts (advise mode)
    s.insert(row({ ts: 4, scores: sc({ passedEffort: "high", actualEffort: "high" }) }));
    // an invalid applied falls back to passed
    s.insert(
      row({
        ts: 5,
        scores: sc({ effortApplied: "bogus", passedEffort: "low", actualEffort: "high" }),
      }),
    );
    // applied without actual, and actual without any set level: not checked
    s.insert(row({ ts: 6, scores: sc({ effortApplied: "high" }) }));
    s.insert(row({ ts: 7, scores: sc({ actualEffort: "high" }) }));
    const sum = s.summary();
    expect(sum.effortChecked).toBe(5);
    expect(sum.effortIneffective).toBe(3);
  });

  it("the store counts every level in EFFORTS (its private copy must not drift)", () => {
    // The store mirrors EFFORTS in a private list (it cannot import src/adjudicator at boot);
    // a level added to EFFORTS but not there would silently drop out of effortChecked.
    EFFORTS.forEach((level, i) => {
      a.adjudicator.insert(
        row({
          ts: i + 1,
          scores: JSON.stringify({ passedEffort: level, actualEffort: level }),
        }),
      );
    });
    const sum = a.adjudicator.summary();
    expect(sum.effortChecked).toBe(EFFORTS.length);
    expect(sum.effortIneffective).toBe(0);
  });

  it("the store counts every level in EFFORTS when read from effortApplied", () => {
    EFFORTS.forEach((level, i) => {
      a.adjudicator.insert(
        row({ ts: i + 1, scores: JSON.stringify({ effortApplied: level, actualEffort: level }) }),
      );
    });
    const sum = a.adjudicator.summary();
    expect(sum.effortChecked).toBe(EFFORTS.length);
    expect(sum.effortIneffective).toBe(0);
  });

  it("an empty table summarises to zeros and null rates", () => {
    const sum = a.adjudicator.summary();
    expect(sum.total).toBe(0);
    expect(sum.keptModel).toEqual({ pin: 0, force: 0, fork: 0 });
    expect(sum.rates).toEqual({
      follow: null,
      apply: null,
      respect: null,
      effortFollow: null,
    });
    expect(sum).toMatchObject({
      effortFollowed: 0,
      effortIgnored: 0,
      effortIneffective: 0,
      effortChecked: 0,
    });
    expect(sum.costUsd).toBe(0);
    expect(sum.applyIneffective).toBe(0);
  });
});

function xchg(over: Partial<ExchangeInput> = {}): ExchangeInput {
  return {
    ts: 1_000,
    callId: "c1",
    provider: "typesafe",
    method: "POST",
    target: "api.typesafe.ai/v1/x",
    items: 1,
    outcome: "ok",
    deadlineMs: 800,
    requestBody: "{}",
    requestBytes: 2,
    ...over,
  };
}

describe("exchange log (migration v9)", () => {
  let a: SqliteAdapter;
  beforeEach(() => {
    a = new SqliteAdapter(tmpDb("em-adj-xchg-"), { vectors: false });
  });
  afterEach(() => a.close());

  const ids = () =>
    (
      a.db.prepare("SELECT id FROM adjudicator_exchanges ORDER BY id").all() as { id: number }[]
    ).map((r) => r.id);

  it("keeps exactly the newest 100 across single and batched inserts", () => {
    expect(EXCHANGE_KEEP).toBe(100);
    for (let i = 0; i < 105; i++) a.adjudicator.exchangeInsert([xchg({ callId: `c${i}` })]);
    expect(a.adjudicator.exchangeCount()).toBe(100);
    const batch = a.adjudicator.exchangeInsert([xchg({ batch: 0 }), xchg({ batch: 1 })]);
    expect(batch).toHaveLength(2);
    const all = ids();
    expect(all).toHaveLength(100);
    expect(all[0]).toBe(Math.max(...all) - 99);
    expect(all.every((id, i) => i === 0 || id === (all[i - 1] as number) + 1)).toBe(true);
    expect(all).toContain(batch[0]);
    expect(all).toContain(batch[1]);
  });

  it("honours a smaller keep and deletes nothing below it", () => {
    a.adjudicator.exchangeInsert([xchg(), xchg()], 3);
    expect(a.adjudicator.exchangeCount()).toBe(2);
    a.adjudicator.exchangeInsert([xchg(), xchg()], 3);
    expect(a.adjudicator.exchangeCount()).toBe(3);
    expect(a.adjudicator.exchangeInsert([])).toEqual([]);
  });

  it("round-trips a row; the list leaves the bodies and error out", () => {
    const [id] = a.adjudicator.exchangeInsert([
      xchg({
        rowIds: [4, 5],
        model: "jev",
        surface: "agent",
        timedOut: true,
        httpStatus: 429,
        attempts: 2,
        retryWaitMs: 100,
        tokensIn: 7,
        costUsd: 0.01,
        requestTruncated: true,
        responseBody: '{"a":1}',
        responseBytes: 7,
        error: "boom",
      }),
    ]) as [number];
    const full = a.adjudicator.exchangeGet(id);
    expect(full).toMatchObject({
      id,
      rowIds: [4, 5],
      model: "jev",
      timedOut: true,
      httpStatus: 429,
      attempts: 2,
      retryWaitMs: 100,
      tokensIn: 7,
      tokensOut: null,
      costUsd: 0.01,
      requestBody: "{}",
      requestTruncated: true,
      responseBody: '{"a":1}',
      responseTruncated: false,
      error: "boom",
    });
    const { rows, total } = a.adjudicator.exchangeList();
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ id, rowIds: [4, 5], timedOut: true });
    expect(rows[0]).not.toHaveProperty("requestBody");
    expect(rows[0]).not.toHaveProperty("responseBody");
    expect(rows[0]).not.toHaveProperty("error");
    expect(a.adjudicator.exchangeGet(id + 99)).toBeUndefined();
  });

  it("lists newest first, clamps the limit and filters by decision id", () => {
    a.adjudicator.exchangeInsert([xchg({ rowIds: [1] }), xchg({ rowIds: [2, 3] }), xchg()]);
    const all = a.adjudicator.exchangeList();
    expect(all.rows.map((r) => r.id)).toEqual([...ids()].reverse());
    expect(a.adjudicator.exchangeList({ limit: 0 }).rows).toHaveLength(1);
    expect(a.adjudicator.exchangeList({ limit: 1000 }).rows).toHaveLength(3);
    const byRow = a.adjudicator.exchangeList({ rowId: 3 });
    expect(byRow.total).toBe(1);
    expect(byRow.rows[0]?.rowIds).toEqual([2, 3]);
    expect(a.adjudicator.exchangeList({ rowId: 9 })).toEqual({ rows: [], total: 0 });
  });

  it("exchangePurge deletes every row", () => {
    a.adjudicator.exchangeInsert([xchg(), xchg()]);
    expect(a.adjudicator.exchangePurge()).toBe(2);
    expect(a.adjudicator.exchangeCount()).toBe(0);
  });

  it("fails fast on a locked database and stores nothing", () => {
    const holder = new Database(a.db.name);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const t0 = Date.now();
      expect(() => a.adjudicator.exchangeInsert([xchg()])).toThrow(/locked|busy/i);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(a.adjudicator.exchangeCount()).toBe(0);
    a.adjudicator.exchangeInsert([xchg()]);
    expect(a.adjudicator.exchangeCount()).toBe(1);
  });
});

describe("deleted exchanges leave the disk (review-xchg R1, task #195)", () => {
  /** A request body large enough to spill into overflow pages, as real prompts do. */
  function body(sentinel: string): Partial<ExchangeInput> {
    const text = JSON.stringify({
      state: { items: [{ id: "i0", text: `${sentinel} `.repeat(2000) }] },
    });
    return { requestBody: text, requestBytes: text.length };
  }
  /** Occurrences of `s` in the raw bytes of the database file and its -wal. */
  function onDisk(path: string, s: string): { db: number; wal: number } {
    const hits = (p: string) =>
      existsSync(p) ? readFileSync(p).toString("latin1").split(s).length - 1 : 0;
    return { db: hits(path), wal: hits(`${path}-wal`) };
  }

  let path: string;
  let a: SqliteAdapter;
  /** The long-lived second connection (MCP server, dashboard) that keeps the -wal alive. */
  let server: SqliteAdapter;
  beforeEach(() => {
    path = tmpDb("em-adj-sd-");
    a = new SqliteAdapter(path, { vectors: false });
    server = new SqliteAdapter(path, { vectors: false });
    server.adjudicator.exchangeCount();
  });
  afterEach(() => {
    a.close();
    server.close();
  });

  it("exchangePurge erases the bodies from the database and the -wal, with a second connection open", () => {
    for (let i = 0; i < 5; i++) a.adjudicator.exchangeInsert([xchg(body("PURGESENTINEL"))]);
    expect(onDisk(path, "PURGESENTINEL").wal + onDisk(path, "PURGESENTINEL").db).toBeGreaterThan(0);
    expect(a.adjudicator.exchangePurge()).toBe(5);
    expect(onDisk(path, "PURGESENTINEL")).toEqual({ db: 0, wal: 0 });
    a.close();
    expect(onDisk(path, "PURGESENTINEL")).toEqual({ db: 0, wal: 0 });
    a = new SqliteAdapter(path, { vectors: false });
  });

  it("the newest-100 prune erases the pruned bodies, with a second connection open", () => {
    for (let i = 0; i < EXCHANGE_KEEP + 5; i++)
      a.adjudicator.exchangeInsert([xchg(body(i < 5 ? `OLDROW${i}X` : "NEWROWX"))]);
    expect(a.adjudicator.exchangeCount()).toBe(EXCHANGE_KEEP);
    for (let i = 0; i < 5; i++) expect(onDisk(path, `OLDROW${i}X`)).toEqual({ db: 0, wal: 0 });
    // the kept rows are untouched
    const kept = onDisk(path, "NEWROWX");
    expect(kept.db + kept.wal).toBeGreaterThan(0);
    server.close();
    a.close();
    for (let i = 0; i < 5; i++) expect(onDisk(path, `OLDROW${i}X`).db).toBe(0);
    a = new SqliteAdapter(path, { vectors: false });
    server = new SqliteAdapter(path, { vectors: false });
  });

  it("store purge() erases the exchange bodies when it runs outside a transaction", () => {
    for (let i = 0; i < 3; i++) a.adjudicator.exchangeInsert([xchg(body("STOREPURGEX"))]);
    a.adjudicator.purge();
    expect(onDisk(path, "STOREPURGEX")).toEqual({ db: 0, wal: 0 });
  });

  it.each(["adjudicator", "all"] as const)(
    "adapter purge('%s') erases the bodies from the database and the -wal, with a second connection open",
    (scope) => {
      for (let i = 0; i < 5; i++) a.adjudicator.exchangeInsert([xchg(body("ADAPTERPURGEX"))]);
      const before = onDisk(path, "ADAPTERPURGEX");
      expect(before.db + before.wal).toBeGreaterThan(0);
      a.purge(scope);
      expect(onDisk(path, "ADAPTERPURGEX")).toEqual({ db: 0, wal: 0 });
      expect(a.adjudicator.exchangeCount()).toBe(0);
    },
  );

  it("adapter purge fails open: an open reader neither blocks nor fails it", () => {
    a.adjudicator.exchangeInsert([xchg(), xchg()]);
    server.db.exec("BEGIN");
    server.db.prepare("SELECT COUNT(*) FROM adjudicator_exchanges").get();
    try {
      const t0 = Date.now();
      a.purge("adjudicator");
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      server.db.exec("COMMIT");
    }
    expect(a.adjudicator.exchangeCount()).toBe(0);
  });

  it("leaves secure_delete as it was for the other writes", () => {
    const before = a.db.pragma("secure_delete", { simple: true });
    a.adjudicator.exchangeInsert([xchg(), xchg()], 1);
    a.adjudicator.exchangePurge();
    a.adjudicator.insert(row());
    expect(a.db.pragma("secure_delete", { simple: true })).toBe(before);
  });

  it("the checkpoint fails open: an open reader neither blocks nor fails the purge", () => {
    a.adjudicator.exchangeInsert([xchg(), xchg()]);
    server.db.exec("BEGIN");
    server.db.prepare("SELECT COUNT(*) FROM adjudicator_exchanges").get();
    try {
      const t0 = Date.now();
      expect(a.adjudicator.exchangePurge()).toBe(2);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      server.db.exec("COMMIT");
    }
    expect(a.adjudicator.exchangeCount()).toBe(0);
  });

  it("the prune inside a caller's transaction defers the checkpoint and still prunes", () => {
    a.adjudicator.atomically(() => {
      a.adjudicator.exchangeInsert([xchg(), xchg(), xchg()], 2);
    });
    expect(a.adjudicator.exchangeCount()).toBe(2);
  });
});

describe("purge", () => {
  function seed(a: SqliteAdapter): void {
    a.adjudicator.insert(row());
    a.adjudicator.cachePut("k", VERDICT, "heuristic");
    a.adjudicator.saveProviderState("typesafe", { failures: 2 });
    a.adjudicator.biasUpsert({
      dimension: "tier",
      bucket: "c0",
      option: "haiku",
      n: 1,
      s: 1,
      f: 0,
      costMedian: null,
      bias: 0,
    });
    a.adjudicator.exchangeInsert([xchg()]);
    a.metaSet("adjudicator:eval:last", "{}");
  }

  it.each(["adjudicator", "all"] as const)("purge(%s) clears the adjudicator tables", (scope) => {
    const a = new SqliteAdapter(tmpDb("em-adj-purge-"), { vectors: false });
    try {
      seed(a);
      for (const t of TABLES) expect(count(a, t)).toBe(1);
      a.purge(scope);
      for (const t of TABLES) expect(count(a, t)).toBe(0);
    } finally {
      a.close();
    }
  });

  it("other scopes leave the adjudicator tables alone", () => {
    const a = new SqliteAdapter(tmpDb("em-adj-purge-"), { vectors: false });
    try {
      seed(a);
      for (const scope of ["index", "sessions", "graph", "memories", "usage"] as const)
        a.purge(scope);
      for (const t of TABLES) expect(count(a, t)).toBe(1);
    } finally {
      a.close();
    }
  });

  it("purge(adjudicator) survives a v9+ database without the exchanges table (review-xchg R9)", () => {
    const path = tmpDb("em-adj-purge-");
    new SqliteAdapter(path, { vectors: false }).close();
    const raw = new Database(path);
    raw.exec(
      "DROP TABLE adjudicator_exchanges; UPDATE meta SET value = '10' WHERE key = 'schema_version'",
    );
    raw.close();
    const a = new SqliteAdapter(path, { vectors: false });
    try {
      a.adjudicator.insert(row());
      a.adjudicator.cachePut("k", VERDICT, "heuristic");
      expect(() => a.purge("adjudicator")).not.toThrow();
      for (const t of TABLES.filter((t) => t !== "adjudicator_exchanges"))
        expect(count(a, t)).toBe(0);
      expect(a.adjudicator.exchangePurge()).toBe(0);
    } finally {
      a.close();
    }
  });

  it("em_purge accepts the adjudicator scope", () => {
    const schema = z.object(emPurge.schema);
    expect(schema.parse({ scope: "adjudicator", confirm: true }).scope).toBe("adjudicator");
    expect(() => schema.parse({ scope: "bogus", confirm: true })).toThrow();
  });
});

describe("bounded lock waits (task #51)", () => {
  /** A second connection holding the write lock, as the MCP server's reindex would. */
  function holdLock(path: string): Database.Database {
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO meta (key, value) VALUES ('lock-probe', '1')");
    return holder;
  }

  it("withLockWait caps the busy timeout for its body only and never raises it", () => {
    const a = new SqliteAdapter(tmpDb("em-adj-lw-"), { vectors: false });
    const s = a.adjudicator;
    const busy = () => Number(a.db.pragma("busy_timeout", { simple: true }));
    expect(busy()).toBe(2000);
    expect(s.withLockWait(30, busy)).toBe(30);
    expect(s.withLockWait(30, () => s.withLockWait(10_000, busy))).toBe(30);
    expect(() =>
      s.withLockWait(0, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(busy()).toBe(2000);
    a.close();
  });

  it("a held write lock: reads still answer, a bounded write fails fast, the timeout is restored", () => {
    const path = tmpDb("em-adj-lock-");
    const a = new SqliteAdapter(path, { vectors: false });
    const s = a.adjudicator;
    s.saveProviderState("p", { state: "open", retryAt: 123 });
    s.cachePut("k1", VERDICT, "typesafe", 1000);
    const holder = holdLock(path);
    try {
      expect(s.providerState("p")?.state).toBe("open");
      // The hit is served even though its counter cannot be bumped.
      const t0 = Date.now();
      const hit = s.withLockWait(0, () => s.cacheGet("k1", 1500));
      expect(hit?.verdict).toMatchObject({ key: "k1" });
      expect(hit?.hits).toBe(0);
      expect(() =>
        s.atomically(() => s.saveProviderState("p", { state: "closed" }), { lockWaitMs: 50 }),
      ).toThrow(/busy|locked/i);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(Number(a.db.pragma("busy_timeout", { simple: true }))).toBe(2000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(s.providerState("p")?.state).toBe("open");
    expect(s.cacheGet("k1", 1600)?.hits).toBe(1);
    a.close();
  });
});
