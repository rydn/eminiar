import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { ApiCallRow, ToolUseRow } from "../../src/storage/types.js";
import { emStats } from "../../src/tools/em_stats.js";
import {
  type BlocksPayload,
  CSV_VIEWS,
  emUsage,
  fmtGap,
  INGEST_GUARD_MS,
  type InsightsPayload,
  LIMIT_MAX,
  loadUsage,
  type ModelsPayload,
  type PeriodsPayload,
  parseLimit,
  parseSince,
  recentlyIngested,
  renderUsage,
  type SavingsPayload,
  type SessionsPayload,
  type SummaryPayload,
  shortModel,
  type ToolsPayload,
  type TurnsPayload,
  textTable,
  USAGE_VIEWS,
  type UsageData,
  usageCsv,
  usageView,
} from "../../src/tools/em_usage.js";
import { buildPalette, fillDays, modelColor } from "../../src/ui/web/views/usage-helpers.js";
import { transcriptDirFor } from "../../src/usage/ingest.js";
import { costOfCall, formatUsd, resolvePrice } from "../../src/usage/pricing.js";

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const UNKNOWN = "claude-unknown-9";
const HOUR = 36e5;
const DAY = 864e5;
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transcripts",
  "sample.jsonl",
);

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;
let now: number;
let n = 0;

function call(over: Partial<ApiCallRow> & { ts: number; model: string }): ApiCallRow {
  n += 1;
  const base: ApiCallRow = {
    request_id: `req-${n}`,
    message_id: `msg-${n}`,
    session_id: "sess-a",
    agent_id: null,
    sidechain: 0,
    input_tokens: 1_000,
    output_tokens: 500,
    cache_create_5m: 2_000,
    cache_create_1h: 0,
    cache_read: 20_000,
    thinking_tokens: 100,
    web_searches: 0,
    web_fetches: 0,
    service_tier: null,
    speed: null,
    stop_reason: "end_turn",
    prompt_id: null,
    git_branch: "feature/x",
    cwd: null,
    effort: null,
    version: null,
    entrypoint: null,
    cost_usd: null,
    priced: 0,
    ...over,
  };
  const price = resolvePrice(base.model);
  if (price) {
    base.cost_usd = costOfCall(base, price).total;
    base.priced = 1;
  }
  return base;
}

function toolUse(over: Partial<ToolUseRow> & { tool: string; ts: number }): ToolUseRow {
  n += 1;
  return {
    tool_use_id: `tu-${n}`,
    session_id: "sess-a",
    agent_id: null,
    input_chars: 50,
    result_chars: 1_000,
    is_error: 0,
    request_id: null,
    ...over,
  };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");
const SEEDED_CALLS = 8;
const SESSION_A_CALLS = 5;

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "em-claude-"));
  process.env.EMINIAR_SESSION_ID = "sess-a";
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx, { vectors: false });
  // Two days, two models, two sessions, one unpriced call. "yesterday" sits a full day
  // back so it never shares a local calendar day with the recent calls.
  now = Date.now();
  const y = now - DAY - 2 * HOUR;
  const t = now - 2 * HOUR;
  db.apiCallsUpsert([
    call({ ts: y, model: SONNET, cache_read: 0 }),
    call({ ts: y + 5 * 60e3, model: SONNET }),
    call({ ts: y + 10 * 60e3, model: SONNET }),
    call({ ts: y + 60e3, model: OPUS, session_id: "sess-b", cache_read: 0 }),
    call({ ts: y + 3 * 60e3, model: OPUS, session_id: "sess-b" }),
    call({ ts: t, model: OPUS, input_tokens: 5_000 }),
    call({ ts: t + 2 * 60e3, model: OPUS, cache_read: 40_000 }),
    call({ ts: t + 4 * 60e3, model: UNKNOWN, session_id: "sess-b" }),
  ]);
  db.contextEventInsert({
    session_id: "sess-a",
    ts: t + 60e3,
    kind: "compact",
    trigger: "auto",
    pre_tokens: 150_000,
    post_tokens: 20_000,
  });
  db.toolUsesUpsert([
    toolUse({ tool: "Bash", ts: y + 60e3, result_chars: 20_000 }),
    toolUse({ tool: "Bash", ts: t + 60e3, result_chars: 12_000, is_error: 1 }),
    toolUse({ tool: "Read", ts: y + 120e3, result_chars: 4_000 }),
    toolUse({ tool: "em_execute", ts: t + 90e3, result_chars: 500 }),
  ]);
  db.statRecord("sess-a", "em_execute", { rawChars: 40_000, returnedChars: 2_000, durationMs: 10 });
  db.sessionUpsert({ id: "sess-a", started_at: y, last_prompt: "fix the thing" });
});

afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_CLAUDE_DIR;
  delete process.env.EMINIAR_SESSION_ID;
});

const usdOf = (s: string): number => {
  const m = /\$([\d,.]+)/.exec(s);
  return m ? Number((m[1] as string).replace(/,/g, "")) : Number.NaN;
};
const cellsOf = (line: string): string[] => line.trim().split(/ {2,}/);

describe("parseSince", () => {
  const at = Date.UTC(2026, 9, 26, 12, 0, 0);
  it("accepts relative values and ISO dates", () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("")).toBeUndefined();
    expect(parseSince("30d", at)).toBe(at - 30 * DAY);
    expect(parseSince("12h", at)).toBe(at - 12 * HOUR);
    expect(parseSince("2w", at)).toBe(at - 14 * DAY);
    expect(parseSince("90m", at)).toBe(at - 90 * 60e3);
    expect(parseSince("45S", at)).toBe(at - 45e3);
    expect(parseSince("2026-10-01T00:00:00Z", at)).toBe(Date.UTC(2026, 9, 1));
    expect(parseSince("2026-10-01", at)).toBe(Date.parse("2026-10-01"));
  });
  it("rejects anything else, and dates outside 2000..tomorrow", () => {
    for (const bad of [
      "yesterday",
      "lately",
      "30",
      "1",
      "32",
      "1/1",
      "10-01",
      "99999999999999999999d",
      "1234567d", // seven digits
      "30 d",
      "2026-13-45",
      "1999-12-31",
      "2027-01-01", // after tomorrow (relative to `at`)
      "Infinity",
      "NaN",
    ])
      expect(() => parseSince(bad, at), bad).toThrow(/invalid since/);
    expect(() => parseSince("999999d", at)).toThrow(/invalid since/); // before 2000
  });
});

describe("parseLimit", () => {
  it("accepts whole numbers from 1 to the maximum and rejects the rest with a message", () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit(1)).toBe(1);
    expect(parseLimit("20")).toBe(20);
    expect(parseLimit(LIMIT_MAX)).toBe(LIMIT_MAX);
    for (const bad of [0, -1, Number.NaN, 1.5, LIMIT_MAX + 1, "0", "abc", "", "1e3", "true"])
      expect(parseLimit(bad), String(bad)).toMatch(/^limit must be a whole number/);
  });
});

describe("formatUsd", () => {
  it("renders tiny, sub-dollar, ordinary and large values", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-0)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsd(0.00009999)).toBe("<$0.0001");
    expect(formatUsd(-0.00004)).toBe("-$0.0001");
    expect(formatUsd(0.0001)).toBe("$0.0001");
    expect(formatUsd(0.00016)).toBe("$0.0002");
    expect(formatUsd(0.001)).toBe("$0.001");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0.123)).toBe("$0.123");
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.99996)).toBe("$1.00");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(4.56)).toBe("$4.56");
    expect(formatUsd(999.99)).toBe("$999.99");
    expect(formatUsd(999.999)).toBe("$1,000");
    expect(formatUsd(1000)).toBe("$1,000");
    expect(formatUsd(1234.4)).toBe("$1,234");
    expect(formatUsd(-2.5)).toBe("-$2.50");
    expect(formatUsd(-1234.5)).toBe("-$1,235");
  });
});

describe("labels", () => {
  it("shortModel strips the claude- prefix and date suffix, keeping [1m]", () => {
    expect(shortModel("claude-sonnet-4-5-20250929[1m]")).toBe("sonnet-4-5[1m]");
    expect(shortModel("claude-sonnet-4-5-20250929")).toBe("sonnet-4-5");
    expect(shortModel("claude-opus-4-1-20250805")).toBe("opus-4-1");
    expect(shortModel("claude-opus-5-5")).toBe("opus-5-5");
    expect(shortModel("claude-opus-5-5[1m]")).toBe("opus-5-5[1m]");
    expect(shortModel("<synthetic>")).toBe("<synthetic>");
  });
  it("fmtGap prints <1h or h:mm", () => {
    expect(fmtGap(0)).toBe("<1h");
    expect(fmtGap(59 * 60e3)).toBe("<1h");
    expect(fmtGap(HOUR)).toBe("1:00");
    expect(fmtGap(3.5 * HOUR)).toBe("3:30");
    expect(fmtGap(26 * HOUR + 5 * 60e3)).toBe("26:05");
    expect(fmtGap(Number.NaN)).toBe("<1h");
  });
});

describe("dashboard helpers", () => {
  it("gives every distinct model id its own colour, with the family setting the hue", () => {
    const ids = [
      "claude-sonnet-4-5",
      "claude-sonnet-4-5[1m]",
      "claude-opus-4-1",
      "claude-opus-5-5",
      "claude-haiku-4-5",
      "claude-mythos-5-1",
      "some-other-model",
    ];
    const p = buildPalette(ids);
    expect(p.size).toBe(ids.length);
    expect(new Set(p.values()).size).toBe(ids.length); // all distinct
    const hue = (c: string) => Number(/hsl\((\d+)/.exec(c)?.[1]);
    expect(hue(p.get("claude-sonnet-4-5") as string)).toBe(
      hue(p.get("claude-sonnet-4-5[1m]") as string),
    );
    expect(hue(p.get("claude-opus-4-1") as string)).toBe(hue(p.get("claude-opus-5-5") as string));
    expect(hue(p.get("claude-opus-5-5") as string)).not.toBe(
      hue(p.get("claude-sonnet-4-5") as string),
    );
    expect(hue(p.get("claude-mythos-5-1") as string)).toBe(hue(modelColor("claude-fable-5-1")));
    expect(p.get("claude-haiku-4-5")).toBe(modelColor("claude-haiku-4-5")); // alone in its family
    expect(buildPalette([]).size).toBe(0);
  });
  it("fills the selected range with empty days so the axis is contiguous", () => {
    const at = new Date(2026, 9, 26, 15, 0).getTime(); // local 2026-10-26
    const row = (key: string, calls: number) => ({
      key,
      totals: { calls, costUsd: calls, input: 0, output: 0 } as never,
      models: [],
    });
    const filled = fillDays([row("2026-10-20", 2), row("2026-10-25", 1)], 7, at);
    expect(filled.map((r) => r.key)).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
    expect(filled.map((r) => r.totals.calls)).toEqual([2, 0, 0, 0, 0, 1, 0]);
    // a row older than the range extends it backwards rather than being dropped
    const extended = fillDays([row("2026-10-15", 1)], 7, at);
    expect(extended[0]?.key).toBe("2026-10-15");
    expect(extended.length).toBe(12);
    expect(fillDays([], 3, at).map((r) => r.key)).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
  });
});

describe("em_usage views", () => {
  it("summary reports totals, costs, models, insights and savings at list price", async () => {
    const out = text(await emUsage.handler({}, ctx));
    const [head = ""] = out.split("\n");
    expect(head).toMatch(/^usage \(project, est\. at list price\): 8 calls · \$/);
    expect(head).toContain("1 unpriced");
    const json = JSON.parse(text(await emUsage.handler({ json: true }, ctx))) as SummaryPayload;
    expect(usdOf(head)).toBeCloseTo(json.totals.costUsd, 2);
    expect(out).toContain("cost: today");
    expect(out).toMatch(/cache: \d+% hit rate/);
    expect(out).toContain(`${json.cache.coldCalls} cold call(s)`);
    expect(out).toContain("sonnet-5-5 3 calls");
    expect(out).toContain("opus-5-5 4 calls");
    expect(out).toContain("unknown-9 1 calls");
    expect(out).toMatch(
      /active block: started \d{2}:\d{2}:\d{2} UTC · 3 calls · \$[\d.]+ · \$[\d.]+\/h/,
    );
    expect(out).toContain("insights:");
    expect(out).toContain("eminiar savings: 9.5k tokens");
    expect(out).toContain("without a bundled price");
  });

  it("scopes to the current session and accepts a relative since", async () => {
    const out = text(await emUsage.handler({ scope: "session" }, ctx));
    expect(out).toMatch(/^usage \(session sess-a, est\. at list price\): 5 calls/);
    const recent = text(await emUsage.handler({ scope: "session", since: "12h" }, ctx));
    expect(recent).toMatch(
      /^usage \(session sess-a since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, est\. at list price\): 2 calls/,
    );
  });

  it("returns an error result, not a throw, for a bad since or limit", async () => {
    for (const since of ["lately", "1", "32", "1/1", "99999999999999999999d"]) {
      const bad = await emUsage.handler({ since }, ctx);
      expect(bad.isError, since).toBe(true);
      expect(text(bad)).toMatch(/invalid since/);
    }
    for (const limit of [0, -1, Number.NaN, 1001, 2.5]) {
      const bad = await emUsage.handler({ view: "sessions", limit }, ctx);
      expect(bad.isError, String(limit)).toBe(true);
      expect(text(bad)).toMatch(/limit must be a whole number between 1 and 1000/);
    }
  });

  it("daily, weekly and monthly group by local period and add up to the total", async () => {
    const summary = JSON.parse(text(await emUsage.handler({ json: true }, ctx))) as SummaryPayload;
    const daily = text(await emUsage.handler({ view: "daily" }, ctx));
    const lines = daily.split("\n");
    expect(lines[0]).toMatch(/^daily: 8 calls/);
    expect(lines[1]).toMatch(/period\s+calls\s+cost/);
    expect(lines.length).toBe(5); // title, header, two days, footer
    expect(lines[4]).toBe("  periods are local calendar days; cost est. at list price");
    const rows = lines.slice(2, 4).map(cellsOf);
    expect(rows.map((r) => Number(r[1])).reduce((a, b) => a + b, 0)).toBe(SEEDED_CALLS);
    expect(rows.map((r) => usdOf(r[2] as string)).reduce((a, b) => a + b, 0)).toBeCloseTo(
      summary.totals.costUsd,
      1,
    );
    expect(rows[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((rows[0]?.[0] as string) < (rows[1]?.[0] as string)).toBe(true);
    expect(daily).toContain("(1 unpriced)");
    const weekly = text(await emUsage.handler({ view: "weekly" }, ctx));
    expect(weekly).toMatch(/^weekly \(Monday\): 8 calls/);
    const monthly = text(await emUsage.handler({ view: "monthly" }, ctx));
    expect(monthly).toMatch(/^monthly: 8 calls/);
    const mp = JSON.parse(
      text(await emUsage.handler({ view: "monthly", json: true }, ctx)),
    ) as PeriodsPayload;
    expect(mp.rows.reduce((s, r) => s + r.totals.calls, 0)).toBe(SEEDED_CALLS);
    expect(mp.rows.reduce((s, r) => s + r.totals.costUsd, 0)).toBeCloseTo(summary.totals.costUsd);
  });

  it("models shows calls, share of cost and marks unpriced models; rows sum to the total", async () => {
    const out = text(await emUsage.handler({ view: "models" }, ctx));
    const lines = out.split("\n");
    expect(lines[0]).toBe("models:");
    expect(lines[1]).toMatch(/^ {2}model\s+calls\s+cost\s+share/);
    const rows = lines.slice(2, 5).map(cellsOf);
    expect(rows.map((r) => r[0])).toEqual(["opus-5-5", "sonnet-5-5", "unknown-9 (unpriced)"]);
    expect(rows.map((r) => Number(r[1]))).toEqual([4, 3, 1]);
    const json = JSON.parse(
      text(await emUsage.handler({ view: "models", json: true }, ctx)),
    ) as ModelsPayload;
    const summary = JSON.parse(text(await emUsage.handler({ json: true }, ctx))) as SummaryPayload;
    expect(json.rows.reduce((s, m) => s + m.costUsd, 0)).toBeCloseTo(summary.totals.costUsd);
    expect(json.rows.reduce((s, m) => s + m.calls, 0)).toBe(SEEDED_CALLS);
    expect(json.rows.reduce((s, m) => s + m.share, 0)).toBeCloseTo(1);
    expect(rows[0]?.[3]).toBe(`${Math.round((json.rows[0] as { share: number }).share * 100)}%`);
    expect(rows[2]?.[2]).toBe("$0.00");
    expect(lines.at(-1)).toBe("  cost est. at list price");
  });

  it("sessions lists each session with its last prompt, times labelled UTC", async () => {
    const out = text(await emUsage.handler({ view: "sessions" }, ctx));
    const lines = out.split("\n");
    expect(lines[1]).toMatch(/^ {2}session\s+last call \(UTC\)\s+branch\s+calls\s+cost/);
    const rows = lines.slice(2).map(cellsOf);
    expect(rows.map((r) => r[0])).toEqual(["sess-b", "sess-a"]); // most recent last call first
    expect(rows.map((r) => Number(r[3]))).toEqual([3, 5]);
    expect(rows[1]).toContain("feature/x");
    expect(rows[1]?.at(-1)).toBe("fix the thing");
    const one = text(await emUsage.handler({ view: "sessions", limit: 1 }, ctx));
    expect(one.split("\n").length).toBe(3);
    const json = JSON.parse(
      text(await emUsage.handler({ view: "sessions", json: true }, ctx)),
    ) as SessionsPayload;
    expect(json.rows.map((r) => r.totals.calls)).toEqual([3, 5]);
  });

  it("blocks shows the 5-hour windows in UTC, the gap as h:mm and the burn rate", async () => {
    const out = text(await emUsage.handler({ view: "blocks" }, ctx));
    const lines = out.split("\n");
    expect(lines[0]).toBe("5-hour billing blocks (times in UTC, * = active):");
    expect(lines[1]).toMatch(/^ {2}block \(UTC\)\s+calls at \(UTC\)\s+calls\s+cost\s+tokens\s+gap/);
    const json = JSON.parse(
      text(await emUsage.handler({ view: "blocks", json: true }, ctx)),
    ) as BlocksPayload;
    expect(json.rows.length).toBe(2);
    expect(json.rows[0]?.active).toBe(true);
    expect(lines[2]).toMatch(
      /^ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} \*\s+\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}\s+3\b/,
    );
    // the gap between yesterday's block and today's is a day minus ten minutes: h:mm
    expect(json.rows[0]?.gapBefore).toBe(DAY - 10 * 60e3);
    expect(cellsOf(lines[2] as string)[5]).toBe("23:50");
    expect(json.rows[1]?.gapBefore).toBeUndefined(); // the first block has no gap
    expect(json.burn.reliable).toBe(true); // 3 calls, the first two hours ago
    expect(lines.at(-1)).toMatch(
      /^ {2}burn: \$[\d.,]+\/h · [\d.]+k? tok\/min over \d+ min · projected \$/,
    );
  });

  it("burn rate is n/a until the active block has enough calls and minutes", () => {
    const base = loadUsage(ctx, { ingest: false });
    const one = call({ ts: now - 60e3, model: OPUS, session_id: "sess-z" });
    const two = call({ ts: now - 2 * 60e3, model: OPUS, session_id: "sess-z" });
    const data: UsageData = { ...base, calls: [one, two], stats: [] };
    const blocks = usageView(ctx, "blocks", data) as BlocksPayload;
    expect(blocks.burn.reliable).toBe(false);
    expect(blocks.burn.projectedBlockUsd).toBeNull();
    expect(renderUsage("blocks", blocks)).toMatch(
      /\n {2}burn n\/a \(needs 2\+ calls over 5\+ min\)$/,
    );
    const summary = usageView(ctx, "summary", data) as SummaryPayload;
    expect(renderUsage("summary", summary)).toMatch(/active block: .* · burn n\/a/);
  });

  it("turns is the session's context timeline and says 'last N of M' when cut", async () => {
    const out = text(await emUsage.handler({ view: "turns", scope: "session" }, ctx));
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^turns \(session sess-a\): 5 calls · 1 compaction\(s\) · \$/);
    expect(lines[1]).toMatch(/^ {2}time \(UTC\)\s+model\s+context\s+output\s+cost/);
    expect(lines.length).toBe(2 + SESSION_A_CALLS);
    expect(lines.filter((l) => l.endsWith("compacted before this call")).length).toBe(1);
    const limited = text(await emUsage.handler({ view: "turns", limit: 2 }, ctx));
    expect(limited.split("\n").length).toBe(4);
    expect(limited).toMatch(/^turns \(session sess-a\): last 2 of 5 calls · 1 compaction/);
    const json = JSON.parse(
      text(await emUsage.handler({ view: "turns", limit: 2, json: true }, ctx)),
    ) as TurnsPayload;
    expect(json.timeline.length).toBe(2);
    expect(json.totals.calls).toBe(SESSION_A_CALLS);
    expect(json.timeline[0]?.compactBefore).toBeUndefined();
    expect(json.timeline[1]?.compactBefore).toBe(true);
  });

  it("tools ranks tool results by characters in context", async () => {
    const out = text(await emUsage.handler({ view: "tools" }, ctx));
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^tool results in context \(9\.1k est\. tokens total\)/);
    expect(lines[2]).toMatch(/^ {2}Bash\s+2\s+32\.0k\s+8\.0k\s+16\.0k\s+1$/);
    expect(lines[3]).toMatch(/^ {2}Read\s+1\s+4\.0k\s+1\.0k\s+4\.0k\s+0$/);
    expect(lines[4]).toMatch(/^ {2}em_execute\s+1\s+500\s+125\s+500\s+0$/);
    const json = JSON.parse(
      text(await emUsage.handler({ view: "tools", json: true }, ctx)),
    ) as ToolsPayload;
    expect(json.totalChars).toBe(36_500);
  });

  it("insights lists detections with severity and the four scores with reasons", async () => {
    const out = text(await emUsage.handler({ view: "insights" }, ctx));
    expect(out).toContain("unpriced");
    expect(out).toContain("scores (0–100, higher is better):");
    for (const id of ["context-health", "cost-efficiency", "cache-efficiency", "delegation"])
      expect(out).toMatch(new RegExp(`\\n {2}${id}\\s+\\d{1,3}(\\n|$)`));
    expect(out).toMatch(/\[(info|warn|high)\]/);
    const json = JSON.parse(
      text(await emUsage.handler({ view: "insights", json: true }, ctx)),
    ) as InsightsPayload;
    expect(json.scores.length).toBe(4);
    for (const s of json.scores) {
      expect(s.value).toBeGreaterThanOrEqual(0);
      expect(s.value).toBeLessThanOrEqual(100);
    }
    expect(json.insights.some((i) => i.id === "unpriced-model")).toBe(true);
  });

  it("savings prices eminiar's stat rows all-time, or only sessions active in the window", async () => {
    const out = text(await emUsage.handler({ view: "savings" }, ctx));
    expect(out).toMatch(/^eminiar savings: 9\.5k tokens kept out of context/);
    expect(out).toMatch(/\n {2}direct {6}\$[\d.]+ {2}\(never written to cache/);
    expect(out).toMatch(/\n {2}compounding \$[\d.]+ {2}\(never re-read/);
    expect(out).toContain("    - All-time: every stat row of the project is counted.");
    const all = JSON.parse(
      text(await emUsage.handler({ view: "savings", json: true }, ctx)),
    ) as SavingsPayload;
    expect(all.savedTokens).toBe(9_500);
    expect(all.directUsd).toBeGreaterThan(0);
    expect(all.compoundingUsd).toBeGreaterThan(0);
    // sess-a (the only session with stat rows) made calls in the last 12 h: still counted
    const recent = JSON.parse(
      text(await emUsage.handler({ view: "savings", since: "12h", json: true }, ctx)),
    ) as SavingsPayload;
    expect(recent.savedTokens).toBe(9_500);
    expect(
      recent.assumptions.some((a) => a.startsWith("Savings cover sessions active in the window")),
    ).toBe(true);
    expect(recent.assumptions.some((a) => a.startsWith("All-time"))).toBe(false);
    // a window with no sess-a calls counts nothing
    const none = JSON.parse(
      text(await emUsage.handler({ view: "savings", since: "1m", json: true }, ctx)),
    ) as SavingsPayload;
    expect(none.savedTokens).toBe(0);
    expect(none.directUsd).toBe(0);
    expect(
      none.assumptions.some((a) => a.startsWith("Savings cover sessions active in the window")),
    ).toBe(true);
  });

  it("json mode returns the aggregate object", async () => {
    const r = JSON.parse(text(await emUsage.handler({ json: true }, ctx))) as SummaryPayload & {
      view: string;
    };
    expect(r.view).toBe("summary");
    expect(r.scope).toBe("project");
    expect(r.totals.calls).toBe(8);
    expect(r.totals.unpricedCalls).toBe(1);
    expect(r.last7d.calls).toBe(8);
    expect(r.models.map((m) => m.model)).toEqual([OPUS, SONNET, UNKNOWN]);
    expect(r.models[0]?.share).toBeGreaterThan(0.5);
    expect(r.block?.active).toBe(true);
    expect(r.insights.length).toBeLessThanOrEqual(3);
    expect(r.scores.map((s) => s.id)).toContain("cache-efficiency");
    expect(r.savings.savedTokens).toBe(9_500);
    const daily = JSON.parse(
      text(await emUsage.handler({ view: "daily", json: true }, ctx)),
    ) as PeriodsPayload;
    expect(daily.rows.length).toBe(2);
    expect(daily.rows[1]?.models.map((m) => m.model).sort()).toEqual([OPUS, UNKNOWN]);
  });

  it("every view renders through the shared renderer with its own header", () => {
    const data = loadUsage(ctx, { ingest: false });
    const heads: Record<(typeof USAGE_VIEWS)[number], RegExp> = {
      summary: /^usage \(project, est\. at list price\): 8 calls/,
      daily: /^daily: 8 calls/,
      weekly: /^weekly \(Monday\): 8 calls/,
      monthly: /^monthly: 8 calls/,
      models: /^models:\n {2}model/,
      sessions: /^sessions:\n {2}session/,
      blocks: /^5-hour billing blocks \(times in UTC/,
      turns: /^turns \(session sess-a\): 5 calls/,
      tools: /^tool results in context \(9\.1k est\. tokens total\)/,
      insights: /^insights \(\d+\):\n {2}\[(info|warn|high)\]/,
      savings: /^eminiar savings: 9\.5k tokens/,
    };
    for (const view of USAGE_VIEWS)
      expect(renderUsage(view, usageView(ctx, view, data)), view).toMatch(heads[view]);
  });

  it("usageView clamps an out-of-range limit as the last line of defence", () => {
    const data = loadUsage(ctx, { ingest: false });
    expect((usageView(ctx, "sessions", data, 0) as SessionsPayload).rows.length).toBe(1);
    expect((usageView(ctx, "sessions", data, -5) as SessionsPayload).rows.length).toBe(1);
    expect((usageView(ctx, "sessions", data, Number.NaN) as SessionsPayload).rows.length).toBe(2);
    expect((usageView(ctx, "turns", data, 1.9) as TurnsPayload).timeline.length).toBe(1);
    expect((usageView(ctx, "turns", data, 1e9) as TurnsPayload).timeline.length).toBe(
      SESSION_A_CALLS,
    );
  });

  it("csv has a header row and one row per aggregate", () => {
    const data = loadUsage(ctx, { ingest: false });
    for (const view of CSV_VIEWS) {
      const csv = usageCsv(view, usageView(ctx, view, data, 1000));
      expect(csv).toBeDefined();
      const lines = (csv as string).split("\n");
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toMatch(/^[a-z0-9_]+(,[a-z0-9_]+)+$/);
    }
    const daily = usageCsv("daily", usageView(ctx, "daily", data)) as string;
    expect(daily.split("\n")[0]).toBe(
      "period,calls,cost_usd,unpriced,input,output,cache_read,cache_write_5m,cache_write_1h,thinking,cache_hit_rate,models",
    );
    expect(daily.split("\n").length).toBe(3);
    expect(usageCsv("summary", usageView(ctx, "summary", data))).toBeUndefined();
  });

  it("csv quotes a model id that carries a comma, a quote or a newline", () => {
    const base = loadUsage(ctx, { ingest: false });
    const weird = 'vendor,"custom" model';
    const data: UsageData = {
      ...base,
      calls: [call({ ts: now - 60e3, model: weird, session_id: "sess-q" })],
    };
    const models = usageCsv("models", usageView(ctx, "models", data)) as string;
    expect(models.split("\n")[1]?.startsWith('"vendor,""custom"" model",1,')).toBe(true);
    const daily = usageCsv("daily", usageView(ctx, "daily", data)) as string;
    expect(daily.split("\n")[1]?.endsWith(',"vendor,""custom"" model=0.000000"')).toBe(true);
    const blocks = usageCsv("blocks", usageView(ctx, "blocks", data)) as string;
    expect(blocks.split("\n")[1]?.endsWith(',"vendor,""custom"" model"')).toBe(true);
  });

  it("textTable pads columns and right-aligns numbers", () => {
    expect(
      textTable(
        ["a", "bb"],
        [
          ["x", "1"],
          ["yyy", "22"],
        ],
      ),
    ).toBe("  a    bb\n  x     1\n  yyy  22");
  });

  it("em_stats ends with a usage line that points at em_usage", async () => {
    const out = text(await emStats.handler({ scope: "session" }, ctx));
    expect(out).toMatch(/\nusage: today \$[\d.,]+ · session \$[\d.,]+ · see em_usage$/);
  });
});

describe("ingest guard", () => {
  // Last: it ingests the fixture transcript, which changes the counts above.
  it("ingests a project at most once per guard window", () => {
    // Earlier tests ingested at real time; start a window past all of them.
    const t0 = Date.now() + INGEST_GUARD_MS;
    loadUsage(ctx, { now: t0 });
    expect(recentlyIngested(ctx.root, undefined, t0 + INGEST_GUARD_MS - 1)).toBe(true);
    expect(recentlyIngested(ctx.root, "sess-a", t0 + INGEST_GUARD_MS - 1)).toBe(true);
    expect(recentlyIngested(ctx.root, undefined, t0 + INGEST_GUARD_MS)).toBe(false);
    expect(recentlyIngested(ctx.root, "sess-a", t0 + INGEST_GUARD_MS)).toBe(false);
    expect(recentlyIngested(`${ctx.root}-other`, undefined, t0)).toBe(false);

    const dir = transcriptDirFor(ctx.root); // ctx.root is the realpath; `root` may not be
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE, join(dir, "fixture-session.jsonl"));
    // within the window: the new transcript is not read
    expect(loadUsage(ctx, { now: t0 + 5_000 }).calls.length).toBe(SEEDED_CALLS);
    // past it: it is
    const after = loadUsage(ctx, { now: t0 + INGEST_GUARD_MS + 1 });
    expect(after.calls.length).toBeGreaterThan(SEEDED_CALLS);
    expect(recentlyIngested(ctx.root, undefined, t0 + INGEST_GUARD_MS + 2)).toBe(true);
    // ingest:false never touches the guard
    expect(recentlyIngested(ctx.root, undefined, t0 + 3 * INGEST_GUARD_MS)).toBe(false);
    loadUsage(ctx, { ingest: false, now: t0 + 3 * INGEST_GUARD_MS });
    expect(recentlyIngested(ctx.root, undefined, t0 + 3 * INGEST_GUARD_MS)).toBe(false);
  });
});
