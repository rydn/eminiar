import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput } from "../../src/hooks/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { hasColumn, migrations } from "../../src/storage/sqlite/schema.js";
import {
  ingestProject,
  ingestSession,
  ingestTranscript,
  transcriptDirFor,
  transcriptSlug,
  usageEnabled,
} from "../../src/usage/ingest.js";
import { costOfCall, resolvePrice } from "../../src/usage/pricing.js";
import { NON_TEXT_PART_CHARS, parseTranscriptLines } from "../../src/usage/transcript.js";

const FIXTURE = join(__dirname, "..", "fixtures", "transcripts", "sample.jsonl");

/** A minimal statusline snapshot row: everything null except what the test cares about. */
const snapRow = (session_id: string, ts: number, cost_usd: number) => ({
  session_id,
  ts,
  model_id: null,
  cost_usd,
  api_ms: null,
  duration_ms: null,
  ctx_input_tokens: null,
  ctx_output_tokens: null,
  ctx_size: null,
  ctx_used_pct: null,
  cache_warm: null,
  cache_ttl: null,
  five_hour_pct: null,
  five_hour_resets_at: null,
  seven_day_pct: null,
  seven_day_resets_at: null,
  lines_added: null,
  lines_removed: null,
});
const fixtureText = readFileSync(FIXTURE, "utf8");
const fixtureLines = fixtureText.split("\n");

let root: string;
let claudeDir: string;
let ctx: ProjectContext;
let db: StorageAdapter;

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "em-claude-"));
  process.env.EMINIAR_CLAUDE_DIR = claudeDir;
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx, { vectors: false });
});

afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_CLAUDE_DIR;
});

describe("parseTranscriptLines", () => {
  const parsed = parseTranscriptLines(fixtureLines, { sessionId: "fallback", path: FIXTURE });

  it("dedupes the per-block entries of one request and keeps the last usage", () => {
    const ids = parsed.calls.map((c) => `${c.request_id}/${c.message_id}`).sort();
    expect(ids).toEqual([
      "req_A/msg_A",
      "req_B/msg_B",
      "req_C/msg_C",
      "req_D/msg_D",
      "req_S/msg_S",
    ]);
    const a = parsed.calls.find((c) => c.request_id === "req_A")!;
    // the third entry carried the final output count
    expect(a.output_tokens).toBe(45);
    expect(a.stop_reason).toBe("tool_use");
    // the timestamp of the first entry of the response is kept
    expect(a.ts).toBe(Date.parse("2026-10-26T20:00:05.000Z"));
  });

  it("maps usage fields, including the cache_creation split and server tools", () => {
    const a = parsed.calls.find((c) => c.request_id === "req_A")!;
    expect(a).toMatchObject({
      session_id: "sess-main",
      agent_id: null,
      sidechain: 0,
      model: "claude-fable-5-1",
      input_tokens: 2,
      cache_create_5m: 200,
      cache_create_1h: 800,
      cache_read: 500,
      thinking_tokens: 5,
      web_searches: 1,
      web_fetches: 0,
      service_tier: "standard",
      speed: "standard",
      effort: "high",
      git_branch: "main",
      cwd: "/tmp/proj",
      version: "2.1.292",
      entrypoint: "cli",
      prompt_id: null,
    });
    const c = parsed.calls.find((c) => c.request_id === "req_C")!;
    expect(c).toMatchObject({ web_fetches: 2, speed: "fast", prompt_id: "p-1", effort: "medium" });
  });

  it("falls back to cache_creation_input_tokens when the split is absent, and tags sidechains", () => {
    const s = parsed.calls.find((c) => c.request_id === "req_S")!;
    expect(s).toMatchObject({
      sidechain: 1,
      agent_id: "agent1",
      session_id: "sess-main",
      model: "claude-haiku-4-5-20251001",
      cache_create_5m: 700,
      cache_create_1h: 0,
      thinking_tokens: 0,
      web_searches: 0,
    });
  });

  it("pairs tool_use blocks with their tool_result sizes and errors", () => {
    const byId = new Map(parsed.toolUses.map((t) => [t.tool_use_id, t]));
    expect([...byId.keys()].sort()).toEqual(["toolu_1", "toolu_2", "toolu_3", "toolu_s1"]);
    expect(byId.get("toolu_1")).toMatchObject({
      tool: "Bash",
      input_chars: JSON.stringify({ command: "ls -la" }).length,
      result_chars: "file1.ts\nfile2.ts\n".length,
      is_error: 0,
      request_id: "req_A",
      agent_id: null,
    });
    expect(byId.get("toolu_2")).toMatchObject({
      tool: "Read",
      result_chars: "File does not exist.".length,
      is_error: 1,
      request_id: "req_B",
    });
    expect(byId.get("toolu_s1")).toMatchObject({
      tool: "Grep",
      agent_id: "agent1",
      result_chars: 16,
    });
  });

  it("records compactions and /clear as context events and skips everything else", () => {
    expect(parsed.contextEvents).toEqual([
      {
        session_id: "sess-main",
        ts: Date.parse("2026-10-26T20:05:00.000Z"),
        kind: "compact",
        trigger: "auto",
        pre_tokens: 180000,
        post_tokens: 27029,
      },
      {
        session_id: "sess-main",
        ts: Date.parse("2026-10-26T20:06:00.000Z"),
        kind: "clear",
        trigger: "manual",
        pre_tokens: null,
        post_tokens: null,
      },
    ]);
    expect(parsed.lastTs).toBe(Date.parse("2026-10-26T20:06:05.000Z"));
  });

  it("survives malformed lines and uses the context session when an entry has none", () => {
    const out = parseTranscriptLines(
      [
        "{not json",
        "",
        JSON.stringify({
          type: "assistant",
          requestId: "r",
          timestamp: "2026-10-26T20:00:00Z",
          message: {
            id: "m",
            model: "claude-sonnet-4-5",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        JSON.stringify({ type: "assistant", message: { id: "nousage", model: "x" } }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          timestamp: "2026-10-26T20:00:01Z",
        }),
      ],
      { sessionId: "ctx-session", path: "x" },
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.session_id).toBe("ctx-session");
    expect(out.calls[0]!.cache_create_5m).toBe(0);
    expect(out.contextEvents[0]).toMatchObject({
      kind: "compact",
      trigger: null,
      pre_tokens: null,
    });
  });

  const result = (id: string, content: unknown, isError = true) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-26T20:00:00Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
      },
    });

  it("charges image / document parts a fixed estimate instead of their base64 length", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(200_000) },
    };
    const out = parseTranscriptLines(
      [
        result("t-img", [image, { type: "text", text: "ok" }], false),
        result("t-doc", [{ type: "document", source: { data: "B".repeat(50_000) } }], false),
        result("t-txt", [{ type: "text", text: "hello" }], false),
        result("t-str", "plain string", false),
      ],
      { sessionId: "s", path: "x" },
    );
    const chars = new Map(out.toolUses.map((t) => [t.tool_use_id, t.result_chars]));
    expect(chars.get("t-img")).toBe(NON_TEXT_PART_CHARS + 2);
    expect(chars.get("t-doc")).toBe(NON_TEXT_PART_CHARS);
    expect(chars.get("t-txt")).toBe(5);
    expect(chars.get("t-str")).toBe("plain string".length);
    expect(NON_TEXT_PART_CHARS).toBe(6400);
  });

  it("stores hook and permission denials as not-error and counts them", () => {
    const out = parseTranscriptLines(
      [
        result(
          "t-hook",
          "PreToolUse:Bash hook error: eminiar: this command is likely to print a lot; retry with em_execute.",
        ),
        result("t-hook2", [{ type: "text", text: "Stop hook error: something" }]),
        result("t-perm", "Permission to use Bash was denied by the user"),
        result("t-real", "Command failed with exit code 1: ENOENT"),
        result("t-real2", [{ type: "text", text: "File does not exist." }]),
      ],
      { sessionId: "s", path: "x" },
    );
    const err = new Map(out.toolUses.map((t) => [t.tool_use_id, t.is_error]));
    expect(err.get("t-hook")).toBe(0);
    expect(err.get("t-hook2")).toBe(0);
    expect(err.get("t-perm")).toBe(0);
    expect(err.get("t-real")).toBe(1);
    expect(err.get("t-real2")).toBe(1);
    expect(out.denied).toBe(3);
    expect(parsed.denied).toBe(0);
  });

  it("normalises timestamps: ISO, epoch seconds, epoch ms; garbage falls back and is never 0", () => {
    const entry = (req: string, timestamp: unknown) => {
      const e: Record<string, unknown> = {
        type: "assistant",
        requestId: req,
        message: {
          id: `msg_${req}`,
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      if (timestamp !== undefined) e.timestamp = timestamp;
      return JSON.stringify(e);
    };
    const lines = [
      entry("none", undefined),
      entry("secs", 1_761_508_800),
      entry("ms", 1_761_508_800_500),
      entry("garbage", "yesterday"),
      entry("iso", "2026-10-26T20:00:00.000Z"),
      entry("zero", 0),
    ];
    const out = parseTranscriptLines(lines, {
      sessionId: "s",
      path: "x",
      fallbackTs: 1_700_000_000_000,
    });
    const ts = new Map(out.calls.map((c) => [c.request_id, c.ts]));
    expect(ts.get("none")).toBe(1_700_000_000_000); // no earlier entry: the file mtime
    expect(ts.get("secs")).toBe(1_761_508_800_000);
    expect(ts.get("ms")).toBe(1_761_508_800_500);
    expect(ts.get("garbage")).toBe(1_761_508_800_500); // the previous entry's ts
    expect(ts.get("iso")).toBe(Date.parse("2026-10-26T20:00:00.000Z"));
    expect(ts.get("zero")).toBe(Date.parse("2026-10-26T20:00:00.000Z"));
    // lastTs reports only what the file said, not substituted values
    expect(out.lastTs).toBe(Date.parse("2026-10-26T20:00:00.000Z"));
    // without a fallback the parser uses the current time rather than 1970
    const before = Date.now();
    const noFallback = parseTranscriptLines([entry("none", undefined)], {
      sessionId: "s",
      path: "x",
    });
    expect(noFallback.calls[0]!.ts).toBeGreaterThanOrEqual(before);
    expect(noFallback.lastTs).toBeUndefined();
  });
});

describe("usage storage adapter", () => {
  const parsed = parseTranscriptLines(fixtureLines, { sessionId: "sess-main", path: FIXTURE });

  it("apiCallsUpsert ignores duplicates and reports the number inserted", () => {
    expect(db.apiCallsUpsert(parsed.calls)).toBe(5);
    expect(db.apiCallsUpsert(parsed.calls)).toBe(0);
    expect(db.apiCallsUpsert([])).toBe(0);
    expect(db.apiCalls()).toHaveLength(5);
    expect(db.apiCallsLatestTs()).toBe(Date.parse("2026-10-26T20:06:05.000Z"));
  });

  it("apiCalls filters by session, time window and sidechain, oldest first", () => {
    const all = db.apiCalls({ sessionId: "sess-main" });
    expect(all.map((c) => c.request_id)).toEqual(["req_A", "req_B", "req_C", "req_S", "req_D"]);
    expect(db.apiCalls({ sidechain: true }).map((c) => c.request_id)).toEqual(["req_S"]);
    expect(db.apiCalls({ sidechain: false })).toHaveLength(4);
    expect(
      db
        .apiCalls({
          since: Date.parse("2026-10-26T20:00:10.000Z"),
          until: Date.parse("2026-10-26T20:00:17.000Z"),
        })
        .map((c) => c.request_id),
    ).toEqual(["req_B", "req_C"]);
    expect(db.apiCalls({ limit: 2 }).map((c) => c.request_id)).toEqual(["req_A", "req_B"]);
    expect(db.apiCalls({ sessionId: "other" })).toEqual([]);
  });

  it("toolUsesUpsert lets the result row fill in what the tool_use row lacked", () => {
    const base = {
      session_id: "sess-tools",
      agent_id: null,
      ts: 1000,
      tool: "Bash",
      input_chars: 12,
      result_chars: null,
      is_error: 0,
      request_id: "req_t",
    };
    expect(db.toolUsesUpsert([{ tool_use_id: "t1", ...base }])).toBe(1);
    // result seen later: same id, no tool name, but a size and an error flag
    db.toolUsesUpsert([
      {
        tool_use_id: "t1",
        session_id: "sess-tools",
        agent_id: null,
        ts: 1500,
        tool: "",
        input_chars: 0,
        result_chars: 400,
        is_error: 1,
        request_id: null,
      },
    ]);
    const [row] = db.toolUses({ sessionId: "sess-tools" });
    expect(row).toMatchObject({
      tool: "Bash",
      input_chars: 12,
      result_chars: 400,
      is_error: 1,
      request_id: "req_t",
      ts: 1000,
    });
    // a later row without a result does not erase the stored one
    db.toolUsesUpsert([{ tool_use_id: "t1", ...base }]);
    expect(db.toolUses({ sessionId: "sess-tools" })[0]!.result_chars).toBe(400);
    db.toolUsesUpsert(parsed.toolUses);
    expect(db.toolUses({ sessionId: "sess-main", sidechain: true }).map((t) => t.tool)).toEqual([
      "Grep",
    ]);
    expect(db.toolUses({ sessionId: "sess-main", sidechain: false })).toHaveLength(3);
  });

  it("context events and statusline snapshots round-trip; statuslineLatest picks the newest", () => {
    for (const e of parsed.contextEvents) db.contextEventInsert(e);
    expect(db.contextEvents({ sessionId: "sess-main" }).map((e) => e.kind)).toEqual([
      "compact",
      "clear",
    ]);
    const snap = {
      session_id: "sess-main",
      model_id: "claude-fable-5-1",
      cost_usd: 1.5,
      api_ms: 1000,
      duration_ms: 5000,
      ctx_input_tokens: 10,
      ctx_output_tokens: 5,
      ctx_size: 200000,
      ctx_used_pct: 12.5,
      cache_warm: 1,
      cache_ttl: "5m",
      five_hour_pct: 20,
      five_hour_resets_at: 2000,
      seven_day_pct: 3,
      seven_day_resets_at: 3000,
      lines_added: 4,
      lines_removed: 1,
    };
    db.statuslineSnapshotInsert({ ...snap, ts: 100 });
    db.statuslineSnapshotInsert({ ...snap, ts: 300, cost_usd: 2.5 });
    db.statuslineSnapshotInsert({ ...snap, ts: 200, session_id: "sess-other" });
    expect(db.statuslineLatest()?.cost_usd).toBe(2.5);
    expect(db.statuslineLatest("sess-other")?.ts).toBe(200);
    expect(db.statuslineSnapshots({ sessionId: "sess-main" }).map((s) => s.ts)).toEqual([100, 300]);
    expect(db.statuslineSnapshots({ since: 150, until: 300 }).map((s) => s.ts)).toEqual([200]);
  });

  it("transcript_files upserts by path and purge(usage) clears the five tables", () => {
    db.transcriptFileSet({
      path: "/a.jsonl",
      session_id: null,
      offset: 10,
      size: 20,
      mtime: 1,
      ingested_at: 1,
    });
    db.transcriptFileSet({
      path: "/a.jsonl",
      session_id: "s",
      offset: 20,
      size: 20,
      mtime: 2,
      ingested_at: 2,
    });
    db.transcriptFileSet({
      path: "/a.jsonl",
      session_id: null,
      offset: 30,
      size: 40,
      mtime: 3,
      ingested_at: 3,
    });
    expect(db.transcriptFileGet("/a.jsonl")).toMatchObject({
      session_id: "s",
      offset: 30,
      size: 40,
    });
    expect(db.transcriptFiles()).toHaveLength(1);
    db.purge("usage");
    expect(db.apiCalls()).toEqual([]);
    expect(db.toolUses()).toEqual([]);
    expect(db.contextEvents()).toEqual([]);
    expect(db.transcriptFiles()).toEqual([]);
    expect(db.statuslineSnapshots()).toEqual([]);
    expect(db.apiCallsLatestTs()).toBeUndefined();
  });

  it("transcript_files keeps the head fingerprint", () => {
    db.transcriptFileSet({
      path: "/h.jsonl",
      session_id: "s",
      offset: 5,
      size: 5,
      mtime: 1,
      head_hash: "abc",
      ingested_at: 1,
    });
    expect(db.transcriptFileGet("/h.jsonl")?.head_hash).toBe("abc");
    db.transcriptFileSet({
      path: "/h.jsonl",
      session_id: "s",
      offset: 6,
      size: 6,
      mtime: 2,
      ingested_at: 2,
    });
    expect(db.transcriptFileGet("/h.jsonl")?.head_hash).toBeNull();
    db.purge("usage");
  });

  it("apiCallsUpsert replaces placeholder usage with the final counts and cost", () => {
    const first = parsed.calls.find((c) => c.request_id === "req_A")!;
    const placeholder = {
      ...first,
      request_id: "req_P",
      message_id: "msg_P",
      session_id: "sess-ph",
    };
    const p = resolvePrice(placeholder.model)!;
    const stub = {
      ...placeholder,
      output_tokens: 8,
      thinking_tokens: 0,
      stop_reason: null,
      cost_usd: 0.001,
      priced: 1,
    };
    expect(db.apiCallsUpsert([stub])).toBe(1);
    const final = {
      ...placeholder,
      output_tokens: 160,
      thinking_tokens: 14,
      stop_reason: "end_turn",
      cost_usd: costOfCall({ ...placeholder, output_tokens: 160 }, p).total,
      priced: 1,
    };
    // the second pass is an update, not a new row
    expect(db.apiCallsUpsert([final])).toBe(0);
    const row = db.apiCalls({ sessionId: "sess-ph" })[0]!;
    expect(row).toMatchObject({
      output_tokens: 160,
      thinking_tokens: 14,
      stop_reason: "end_turn",
      priced: 1,
    });
    expect(row.cost_usd).toBeCloseTo(final.cost_usd, 10);
    // a stale re-ingest of the placeholder cannot shrink the counts or the cost
    expect(db.apiCallsUpsert([stub])).toBe(0);
    const again = db.apiCalls({ sessionId: "sess-ph" })[0]!;
    expect(again.output_tokens).toBe(160);
    expect(again.thinking_tokens).toBe(14);
    expect(again.stop_reason).toBe("end_turn");
    expect(again.cost_usd).toBeCloseTo(final.cost_usd, 10);
    db.purge("usage");
  });

  it("statuslineSnapshotsPrune drops old rows and caps each session", () => {
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    const snap = (session_id: string, ts: number) =>
      db.statuslineSnapshotInsert(snapRow(session_id, ts, 1));
    snap("sess-p1", now - 40 * day);
    snap("sess-p1", now - 1 * day);
    for (let i = 0; i < 520; i++) snap("sess-p2", now - 520_000 + i * 1000);
    expect(db.statuslineSnapshotsPrune({ olderThan: now - 30 * day, keepPerSession: 500 })).toBe(
      21,
    );
    expect(db.statuslineSnapshots({ sessionId: "sess-p1" }).map((s) => s.ts)).toEqual([
      now - 1 * day,
    ]);
    const p2 = db.statuslineSnapshots({ sessionId: "sess-p2" });
    expect(p2).toHaveLength(500);
    expect(p2[0]!.ts).toBe(now - 520_000 + 20 * 1000); // the 20 oldest went
    expect(db.statuslineSnapshotsPrune({ olderThan: 0, keepPerSession: 500 })).toBe(0);
    db.purge("usage");
  });

  it("migration v5 indexes every usage table by ts", () => {
    const raw = (
      db as unknown as { db: { prepare: (sql: string) => { all: () => { name: string }[] } } }
    ).db;
    const names = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    for (const idx of [
      "api_calls_ts",
      "tool_uses_ts",
      "context_events_ts",
      "statusline_snapshots_ts",
      "tool_uses_session_ts",
      "context_events_session_ts",
      "statusline_snapshots_session_ts",
    ])
      expect(names).toContain(idx);
  });
});

describe("schema migration v6: transcript_files.head_hash", () => {
  const LATEST = migrations[migrations.length - 1]?.version;
  const headHashColumns = (a: SqliteAdapter) =>
    (a.db.pragma("table_info(transcript_files)") as { name: string }[]).filter(
      (c) => c.name === "head_hash",
    ).length;
  const versionOf = (a: SqliteAdapter) =>
    Number(
      (
        a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value,
    );
  /**
   * A database at meta.schema_version 5, built from the migrations as v5 first shipped
   * (no head_hash) or as v5 was later edited in place (column present). Both shapes exist
   * on real machines at version 5.
   */
  function v5Database(withColumn: boolean): string {
    const path = join(mkdtempSync(join(tmpdir(), "em-v5-")), "eminiar.db");
    const raw = new Database(path);
    for (const m of migrations) {
      if (m.version > 5) break;
      if (m.sql) raw.exec(m.sql);
    }
    expect(hasColumn(raw, "transcript_files", "head_hash")).toBe(false);
    if (withColumn) raw.exec("ALTER TABLE transcript_files ADD COLUMN head_hash TEXT");
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5')").run();
    raw.close();
    return path;
  }

  it.each([
    ["without the column", false],
    ["with the column", true],
  ])("a v5 database %s migrates to the latest version with one head_hash column", (_, has) => {
    const a = new SqliteAdapter(v5Database(has), { vectors: false });
    try {
      expect(versionOf(a)).toBe(LATEST);
      expect(headHashColumns(a)).toBe(1);
      // The INSERT that failed with "table transcript_files has no column named head_hash".
      const r = ingestTranscript(a, FIXTURE, { sessionId: "sess-v6" });
      expect(r.calls).toBeGreaterThan(0);
      expect(a.transcriptFileGet(FIXTURE)?.head_hash).toBeTruthy();
    } finally {
      a.close();
    }
  });

  it("a fresh database lands on the same version with one head_hash column", () => {
    const a = db as SqliteAdapter;
    expect(versionOf(a)).toBe(LATEST);
    expect(headHashColumns(a)).toBe(1);
  });

  it("reopening a migrated database is a no-op", () => {
    const path = v5Database(false);
    new SqliteAdapter(path, { vectors: false }).close();
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      expect(versionOf(again)).toBe(LATEST);
      expect(headHashColumns(again)).toBe(1);
    } finally {
      again.close();
    }
  });
});

describe("ingestTranscript rewrite detection", () => {
  let dir: string;
  const entry = (req: string, pad = "") =>
    JSON.stringify({
      type: "assistant",
      requestId: req,
      timestamp: "2026-10-26T20:07:00.000Z",
      sessionId: "sess-rw",
      message: {
        id: `msg_${req}`,
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      pad,
    });
  const ids = () => db.apiCalls({ sessionId: "sess-rw" }).map((c) => c.request_id);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-rewrite-"));
  });

  it("re-reads a file rewritten with different content but the same size", () => {
    const path = join(dir, "same-size.jsonl");
    writeFileSync(path, `${entry("req_R1")}\n`);
    expect(ingestTranscript(db, path).calls).toBe(1);
    const prev = db.transcriptFileGet(path)!;
    expect(prev.head_hash).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(path, `${entry("req_R2")}\n`);
    utimesSync(path, new Date(prev.mtime), new Date(prev.mtime)); // even with an unchanged mtime
    expect(statSync(path).size).toBe(prev.size);
    expect(ingestTranscript(db, path).calls).toBe(1);
    expect(ids()).toContain("req_R2");
    const next = db.transcriptFileGet(path)!;
    expect(next.offset).toBe(statSync(path).size);
    expect(next.head_hash).not.toBe(prev.head_hash);
  });

  it("restarts from 0 when a larger rewrite replaced the head", () => {
    const path = join(dir, "larger.jsonl");
    writeFileSync(path, `${entry("req_R3")}\n`);
    expect(ingestTranscript(db, path).calls).toBe(1);
    writeFileSync(path, `${entry("req_R4")}\n${entry("req_R5")}\n`);
    expect(ingestTranscript(db, path).calls).toBe(2);
    expect(ids()).toEqual(expect.arrayContaining(["req_R4", "req_R5"]));
    expect(db.transcriptFileGet(path)!.offset).toBe(statSync(path).size);
  });

  it("restarts when the file was touched and the old offset is no longer a line boundary", () => {
    const path = join(dir, "tail.jsonl");
    // a head longer than the fingerprint window that stays identical across the rewrite
    const head = JSON.stringify({ type: "mode", mode: "normal", pad: "m".repeat(700) });
    writeFileSync(path, `${head}\n${entry("req_R6")}\n`);
    expect(ingestTranscript(db, path).calls).toBe(1);
    const prev = db.transcriptFileGet(path)!;
    writeFileSync(path, `${head}\n${entry("req_R7", "x".repeat(40))}\n`);
    utimesSync(path, new Date(prev.mtime + 5000), new Date(prev.mtime + 5000));
    expect(statSync(path).size).toBeGreaterThan(prev.offset);
    expect(ingestTranscript(db, path).calls).toBe(1);
    expect(ids()).toContain("req_R7");
    expect(db.transcriptFileGet(path)!.offset).toBe(statSync(path).size);
  });

  it("still appends cheaply when the file only grew", () => {
    const path = join(dir, "grow.jsonl");
    writeFileSync(path, `${entry("req_R8")}\n`);
    expect(ingestTranscript(db, path).calls).toBe(1);
    const prev = db.transcriptFileGet(path)!;
    expect(prev.size).toBeLessThan(512);
    // growth past the fingerprint window (the old hash covered the whole short file) is
    // still an append: the check hashes min(512, old size) bytes, which did not change
    appendFileSync(path, `${entry("req_R9", "y".repeat(600))}\n`);
    expect(ingestTranscript(db, path).calls).toBe(1);
    expect(ids()).toEqual(expect.arrayContaining(["req_R8", "req_R9"]));
    expect(db.transcriptFileGet(path)!.head_hash).not.toBe(prev.head_hash);
    expect(ingestTranscript(db, path)).toEqual({ calls: 0, toolUses: 0, contextEvents: 0 });
  });

  it("refuses paths that are not .jsonl files", () => {
    const path = join(dir, "notes.txt");
    writeFileSync(path, `${entry("req_R10")}\n`);
    expect(ingestTranscript(db, path)).toEqual({ calls: 0, toolUses: 0, contextEvents: 0 });
    expect(db.transcriptFileGet(path)).toBeUndefined();
    db.purge("usage");
  });
});

describe("ingestTranscript", () => {
  let dir: string;
  let path: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-transcripts-"));
    path = join(dir, "sess-main.jsonl");
    copyFileSync(FIXTURE, path);
  });

  it("ingests the whole file, prices known models and leaves unknown ones unpriced", () => {
    const counts = ingestTranscript(db, path);
    expect(counts).toEqual({ calls: 5, toolUses: 4, contextEvents: 2 });
    const calls = db.apiCalls({ sessionId: "sess-main" });
    const a = calls.find((c) => c.request_id === "req_A")!;
    expect(a.priced).toBe(1);
    expect(a.cost_usd).toBeGreaterThan(0);
    const p = resolvePrice("claude-fable-5-1")!;
    const expected =
      (2 * p.input +
        45 * p.output +
        200 * p.cacheWrite5m +
        800 * p.cacheWrite1h +
        500 * p.cacheRead) /
        1_000_000 +
      (p.webSearch ?? 0) / 1000;
    expect(a.cost_usd).toBeCloseTo(expected, 8);
    const d = calls.find((c) => c.request_id === "req_D")!;
    expect(d.priced).toBe(0);
    expect(d.cost_usd).toBeNull();
    const file = db.transcriptFileGet(path)!;
    expect(file.offset).toBe(statSync(path).size);
    expect(file.session_id).toBe("sess-main");
  });

  it("is a no-op when nothing was appended", () => {
    expect(ingestTranscript(db, path)).toEqual({ calls: 0, toolUses: 0, contextEvents: 0 });
    expect(db.apiCalls({ sessionId: "sess-main" })).toHaveLength(5);
    expect(db.contextEvents({ sessionId: "sess-main" })).toHaveLength(2);
  });

  it("reads only the appended lines and leaves a trailing partial line for later", () => {
    const entry = (req: string, ts: string) =>
      JSON.stringify({
        type: "assistant",
        requestId: req,
        timestamp: ts,
        sessionId: "sess-main",
        message: {
          id: `msg_${req}`,
          model: "claude-fable-5-1",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
    const full = entry("req_E", "2026-10-26T20:07:00.000Z");
    const partial = entry("req_F", "2026-10-26T20:08:00.000Z");
    appendFileSync(path, `${full}\n${partial.slice(0, 40)}`);
    const before = statSync(path).size;
    expect(ingestTranscript(db, path)).toEqual({ calls: 1, toolUses: 0, contextEvents: 0 });
    const file = db.transcriptFileGet(path)!;
    expect(file.offset).toBe(before - 40); // the start of the incomplete line
    expect(file.size).toBe(before);
    // finishing the line makes it visible on the next pass
    appendFileSync(path, `${partial.slice(40)}\n`);
    expect(ingestTranscript(db, path)).toEqual({ calls: 1, toolUses: 0, contextEvents: 0 });
    expect(db.apiCalls({ sessionId: "sess-main" }).map((c) => c.request_id)).toContain("req_F");
    expect(db.transcriptFileGet(path)!.offset).toBe(statSync(path).size);
  });

  it("restarts from byte 0 when the file shrank, without duplicating rows", () => {
    const callsBefore = db.apiCalls({ sessionId: "sess-main" }).length;
    copyFileSync(FIXTURE, path); // rewritten shorter than the stored offset
    const counts = ingestTranscript(db, path);
    expect(counts).toEqual({ calls: 0, toolUses: 0, contextEvents: 0 });
    expect(db.apiCalls({ sessionId: "sess-main" })).toHaveLength(callsBefore);
    expect(db.contextEvents({ sessionId: "sess-main" })).toHaveLength(2);
    expect(db.transcriptFileGet(path)!.offset).toBe(statSync(path).size);
  });

  it("returns zeros for a missing file", () => {
    expect(ingestTranscript(db, join(dir, "nope.jsonl"))).toEqual({
      calls: 0,
      toolUses: 0,
      contextEvents: 0,
    });
  });
});

describe("ingestSession / ingestProject discovery", () => {
  let slugDir: string;
  beforeAll(() => {
    db.purge("usage");
    slugDir = transcriptDirFor(root);
    mkdirSync(join(slugDir, "sess-main", "subagents"), { recursive: true });
    copyFileSync(FIXTURE, join(slugDir, "sess-main.jsonl"));
    // a sidechain file under <session>/subagents, whose entries name the session
    const sub = fixtureLines.filter((l) => l.includes('"agentId":"agent1"'));
    writeFileSync(
      join(slugDir, "sess-main", "subagents", "agent-agent1.jsonl"),
      `${sub.join("\n")}\n`,
    );
    // a top-level agent-*.jsonl belonging to sess-main, and one belonging to another session
    writeFileSync(
      join(slugDir, "agent-top.jsonl"),
      `${sub.join("\n").replace(/req_S|msg_S/g, (m) => `${m}_top`)}\n`,
    );
    writeFileSync(
      join(slugDir, "agent-foreign.jsonl"),
      `${sub
        .join("\n")
        .replace(/sess-main/g, "sess-foreign")
        .replace(/req_S|msg_S/g, (m) => `${m}_foreign`)}\n`,
    );
    // a session whose transcript lives elsewhere, known only through the sessions table
    const elsewhere = join(mkdtempSync(join(tmpdir(), "em-elsewhere-")), "sess-else.jsonl");
    writeFileSync(
      elsewhere,
      `${fixtureLines
        .filter((l) => l.includes('"requestId":"req_B"'))
        .join("\n")
        .replace(/sess-main/g, "sess-else")
        .replace(/req_B|msg_B/g, (m) => `${m}_else`)}\n`,
    );
    db.sessionUpsert({ id: "sess-else", project_root: root, transcript_path: elsewhere });
  });

  it("transcriptDirFor follows the slug rule under EMINIAR_CLAUDE_DIR", () => {
    expect(transcriptSlug("/Users/me/Dev/x.y")).toBe("-Users-me-Dev-x-y");
    expect(transcriptDirFor(root)).toBe(join(claudeDir, "projects", transcriptSlug(root)));
    expect(usageEnabled(ctx)).toBe(true);
  });

  it("ingestSession takes the main transcript plus its sidechain files only", () => {
    const counts = ingestSession(db, root, "sess-main");
    // 5 from the main file (which, like a real transcript, already holds the sidechain
    // entries, so subagents/ adds nothing new), 1 from agent-top; agent-foreign is skipped
    expect(counts.calls).toBe(6);
    const subFile = join(slugDir, "sess-main", "subagents", "agent-agent1.jsonl");
    expect(db.transcriptFileGet(subFile)).toMatchObject({
      session_id: "sess-main",
      offset: statSync(subFile).size,
    });
    const ids = db.apiCalls({ sessionId: "sess-main" }).map((c) => c.request_id);
    expect(ids).toContain("req_S_top");
    expect(ids).not.toContain("req_S_foreign");
    expect(db.transcriptFileGet(join(slugDir, "agent-foreign.jsonl"))).toMatchObject({
      session_id: "sess-foreign",
      offset: 0,
    });
    // second pass: nothing new
    expect(ingestSession(db, root, "sess-main").calls).toBe(0);
  });

  it("ingestProject discovers the slug dir, subagent dirs and sessions-table paths, skipping unchanged files", () => {
    const first = ingestProject(db, root);
    // agent-foreign (1 call) and sess-else (1 call) were still pending
    expect(first.calls).toBe(2);
    expect(db.apiCalls({ sessionId: "sess-foreign" })).toHaveLength(1);
    expect(db.apiCalls({ sessionId: "sess-else" })).toHaveLength(1);
    const second = ingestProject(db, root);
    expect(second).toEqual({ calls: 0, toolUses: 0, contextEvents: 0, files: 0 });
  });

  it("ingestSession refuses session ids that would escape the transcript dir", () => {
    // a real transcript one directory up: a traversal id must not reach it
    const other = join(claudeDir, "projects", "other-project");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "victim.jsonl"),
      fixtureText.replace(/sess-main/g, "sess-victim").replace(/req_|msg_/g, (m) => `${m}v_`),
    );
    const filesBefore = db.transcriptFiles().length;
    for (const id of [
      "../other-project/victim",
      "../../../../etc/hosts",
      "sess-main/../../other-project/victim",
      "",
      "a".repeat(81),
      "sess main",
    ]) {
      expect(ingestSession(db, root, id)).toEqual({ calls: 0, toolUses: 0, contextEvents: 0 });
    }
    expect(db.apiCalls({ sessionId: "sess-victim" })).toEqual([]);
    expect(db.transcriptFiles()).toHaveLength(filesBefore);
    expect(db.transcriptFiles().some((f) => f.path.includes("other-project"))).toBe(false);
    // a trusted path from the hook payload still has to be a regular .jsonl file
    expect(ingestSession(db, root, "sess-main", slugDir)).toEqual({
      calls: 0,
      toolUses: 0,
      contextEvents: 0,
    });
    expect(ingestSession(db, root, "sess-main", join(root, "package.json"))).toEqual({
      calls: 0,
      toolUses: 0,
      contextEvents: 0,
    });
  });

  it("ingestSession and ingestProject prune stale statusline snapshots", () => {
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    db.statuslineSnapshotInsert(snapRow("sess-main", now - 45 * day, 1));
    db.statuslineSnapshotInsert(snapRow("sess-main", now - 1000, 2));
    ingestSession(db, root, "sess-main");
    expect(db.statuslineSnapshots({ sessionId: "sess-main" }).map((s) => s.cost_usd)).toEqual([2]);
    db.statuslineSnapshotInsert(snapRow("sess-main", now - 60 * day, 3));
    ingestProject(db, root);
    expect(db.statuslineSnapshots({ sessionId: "sess-main" }).map((s) => s.cost_usd)).toEqual([2]);
  });

  it("ingestProject copes with a project that has no transcript dir", () => {
    const bare = mkdtempSync(join(tmpdir(), "em-bare-"));
    writeFileSync(join(bare, "package.json"), "{}");
    const bctx = getContext(bare);
    const bdb = getStorage(bctx, { vectors: false });
    expect(ingestProject(bdb, bare)).toEqual({ calls: 0, toolUses: 0, contextEvents: 0, files: 0 });
  });
});

describe("hooks ingest the transcript", () => {
  const base = (over: Partial<HookInput>): HookInput => ({
    session_id: "sess-hook",
    cwd: root,
    hook_event_name: "x",
    ...over,
  });

  it("Stop with a transcript_path ingests the session's calls", async () => {
    db.purge("usage");
    const dir = mkdtempSync(join(tmpdir(), "em-hook-transcripts-"));
    const path = join(dir, "sess-hook.jsonl");
    writeFileSync(path, fixtureText.replace(/sess-main/g, "sess-hook"));
    await handlers.Stop!(
      base({ hook_event_name: "Stop", transcript_path: path, last_assistant_message: "done" }),
    );
    expect(db.apiCalls({ sessionId: "sess-hook" })).toHaveLength(5);
    expect(db.sessionGet("sess-hook")?.transcript_path).toBe(path);
    // SubagentStop may carry the agent's own transcript as well
    const agentPath = join(dir, "agent-x.jsonl");
    writeFileSync(
      agentPath,
      `${fixtureLines
        .filter((l) => l.includes('"agentId":"agent1"'))
        .join("\n")
        .replace(/sess-main/g, "sess-hook")
        .replace(/req_S|msg_S/g, (m) => `${m}_hook`)}\n`,
    );
    await handlers.SubagentStop!(
      base({
        hook_event_name: "SubagentStop",
        transcript_path: path,
        agent_transcript_path: agentPath,
        agent_id: "agent1",
        last_assistant_message: "",
      }),
    );
    expect(
      db.apiCalls({ sessionId: "sess-hook", sidechain: true }).map((c) => c.request_id),
    ).toEqual(["req_S", "req_S_hook"]);
    // SessionEnd and a resumed SessionStart are no-ops when nothing changed, and never throw
    await handlers.SessionEnd!(base({ hook_event_name: "SessionEnd", transcript_path: path }));
    await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "resume", transcript_path: path }),
    );
    await handlers.Stop!(
      base({ hook_event_name: "Stop", transcript_path: join(dir, "missing.jsonl") }),
    );
    expect(db.apiCalls({ sessionId: "sess-hook" })).toHaveLength(6);
  });

  it("skips ingest entirely when usage is disabled", async () => {
    const off = mkdtempSync(join(tmpdir(), "em-root-off-"));
    writeFileSync(join(off, "package.json"), "{}");
    writeFileSync(join(off, "eminiar.config.json"), JSON.stringify({ usage: { enabled: false } }));
    const octx = getContext(off);
    expect(usageEnabled(octx)).toBe(false);
    const odb = getStorage(octx, { vectors: false });
    const path = join(mkdtempSync(join(tmpdir(), "em-off-")), "sess-off.jsonl");
    writeFileSync(path, fixtureText.replace(/sess-main/g, "sess-off"));
    await handlers.Stop!({
      session_id: "sess-off",
      cwd: off,
      hook_event_name: "Stop",
      transcript_path: path,
    });
    expect(odb.apiCalls()).toEqual([]);
  });
});
