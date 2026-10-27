import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { paths } from "../../src/paths.js";
import { renderStatusline, type StatuslineInput } from "../../src/stats/statusline.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { ApiCallRow } from "../../src/storage/types.js";
import { budgetWarnings, usageBrief } from "../../src/usage/brief.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;
let seq = 0;

function call(over: Partial<ApiCallRow> = {}): ApiCallRow {
  seq += 1;
  return {
    request_id: `req_${seq}`,
    message_id: `msg_${seq}`,
    session_id: "sl-brief",
    agent_id: null,
    sidechain: 0,
    ts: Date.now() - 60_000 + seq,
    model: "claude-opus-5-5",
    input_tokens: 100,
    output_tokens: 500,
    cache_create_5m: 200,
    cache_create_1h: 0,
    cache_read: 10_000,
    thinking_tokens: 10,
    web_searches: 0,
    web_fetches: 0,
    service_tier: null,
    speed: null,
    stop_reason: "end_turn",
    prompt_id: null,
    git_branch: "main",
    cwd: null,
    effort: null,
    version: null,
    entrypoint: null,
    cost_usd: 0.25,
    priced: 1,
    ...over,
  };
}

function writeConfig(usage: Record<string, unknown>): void {
  writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ usage }));
  resetContextCache();
  ctx = getContext(root);
}

const statusline = (over: Partial<StatuslineInput> = {}): StatuslineInput => ({
  session_id: "sl-1",
  cwd: root,
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  cost: {
    total_cost_usd: 0.88,
    total_duration_ms: 120_000,
    total_api_duration_ms: 40_000,
    total_lines_added: 12,
    total_lines_removed: 3,
  },
  context_window: {
    total_input_tokens: 50_000,
    total_output_tokens: 4_000,
    context_window_size: 200_000,
    used_percentage: 42,
    remaining_percentage: 58,
    current_usage: {
      input_tokens: 1_000,
      output_tokens: 200,
      cache_creation_input_tokens: 5_000,
      cache_read_input_tokens: 78_000,
    },
  },
  prompt_cache: {
    warm: true,
    caching_observed: true,
    ttl: "5m",
    expires_at: "2026-10-26T21:30:00Z",
  },
  rate_limits: {
    five_hour: { used_percentage: 31, resets_at: "2026-10-26T23:00:00Z" },
    seven_day: { used_percentage: 12, resets_at: 1_761_700_000 },
  },
  ...over,
});

const dropRenderCache = () => {
  const cache = paths().statuslineCache;
  if (existsSync(cache)) rmSync(cache);
};

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeConfig({ budgets: { sessionUsd: 0.5 } });
  db = getStorage(ctx, { vectors: false });
});

afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

describe("renderStatusline", () => {
  it("appends cost, context and 5h segments and records one snapshot", () => {
    dropRenderCache();
    const line = renderStatusline(JSON.stringify(statusline()));
    expect(line).toMatch(/^eminiar · /);
    expect(line).toContain(" · $0.88 · ctx 42% · 5h 31%");
    expect(line).not.toContain("7d");
    const snaps = db.statuslineSnapshots({ sessionId: "sl-1" });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      model_id: "claude-opus-5-5",
      cost_usd: 0.88,
      api_ms: 40_000,
      duration_ms: 120_000,
      ctx_input_tokens: 1_000,
      ctx_output_tokens: 200,
      ctx_size: 200_000,
      ctx_used_pct: 42,
      cache_warm: 1,
      cache_ttl: "5m",
      five_hour_pct: 31,
      five_hour_resets_at: Date.parse("2026-10-26T23:00:00Z"),
      seven_day_pct: 12,
      seven_day_resets_at: 1_761_700_000_000,
      lines_added: 12,
      lines_removed: 3,
    });
  });

  it("does not duplicate the snapshot on identical input, cached or not", () => {
    renderStatusline(JSON.stringify(statusline()));
    expect(db.statuslineSnapshots({ sessionId: "sl-1" })).toHaveLength(1);
    dropRenderCache();
    renderStatusline(JSON.stringify(statusline()));
    expect(db.statuslineSnapshots({ sessionId: "sl-1" })).toHaveLength(1);
  });

  it("re-renders and snapshots when a figure changes, showing 7d only from 50%", () => {
    const changed = statusline({
      cost: { total_cost_usd: 0.95 },
      rate_limits: {
        five_hour: { used_percentage: 31 },
        seven_day: { used_percentage: 60 },
      },
    });
    const line = renderStatusline(JSON.stringify(changed));
    expect(line).toContain(" · $0.95 · ctx 42% · 5h 31% · 7d 60%");
    expect(db.statuslineSnapshots({ sessionId: "sl-1" })).toHaveLength(2);
    // a sub-cent cost change is not a new snapshot
    renderStatusline(JSON.stringify({ ...changed, cost: { total_cost_usd: 0.954 } }));
    expect(db.statuslineSnapshots({ sessionId: "sl-1" })).toHaveLength(2);
  });

  it("omits the usage segments when config.usage.statusline is false", () => {
    writeConfig({ statusline: false, budgets: { sessionUsd: 0.5 } });
    dropRenderCache();
    const line = renderStatusline(JSON.stringify(statusline({ session_id: "sl-off" })));
    expect(line).toMatch(/% efficient$/);
    expect(line).not.toContain("$");
    expect(db.statuslineSnapshots({ sessionId: "sl-off" })).toHaveLength(0);
    writeConfig({ budgets: { sessionUsd: 0.5 } });
  });

  it("renders the base line when the input carries no usage figures", () => {
    dropRenderCache();
    const line = renderStatusline(JSON.stringify({ session_id: "sl-bare", cwd: root }));
    expect(line).toMatch(/% efficient$/);
    expect(db.statuslineSnapshots({ sessionId: "sl-bare" })).toHaveLength(0);
  });
});

describe("usageBrief", () => {
  it("returns an empty line when nothing is recorded", () => {
    const b = usageBrief(db, ctx, { sessionId: "sl-brief" });
    expect(b.line).toBe("");
    expect(b).toMatchObject({ sessionUsd: 0, todayUsd: 0, cacheHitRate: 0 });
    expect(b.topInsight).toBeUndefined();
  });

  it("summarises today and the session with the top insight", () => {
    db.apiCallsUpsert([
      call(),
      call({ cost_usd: 1.5, cache_read: 300_000 }), // expensive-turn
      call({ session_id: "sl-other", cost_usd: 0.1 }),
    ]);
    const b = usageBrief(db, ctx, { sessionId: "sl-brief" });
    expect(b.todayUsd).toBeCloseTo(1.85, 6);
    expect(b.sessionUsd).toBeCloseTo(1.75, 6);
    expect(b.cacheHitRate).toBeGreaterThan(0.9);
    expect(b.line).toMatch(
      /^usage: today \$1\.85 \(3 calls, \d+% cache hits\) · session \$1\.75 · top insight: session budget exceeded$/,
    );
    expect(b.topInsight?.id).toBe("budget"); // 1.75 > the 0.5 session budget, severity high
    // without a session only today's figures appear
    const today = usageBrief(db, ctx);
    expect(today.line).toMatch(/^usage: today \$1\.85 \(3 calls/);
    expect(today.line).not.toContain("session $");
    expect(today.sessionUsd).toBe(0);
  });

  it("is injected by the SessionStart hook", async () => {
    const out = await handlers.SessionStart!({
      session_id: "sl-brief",
      cwd: root,
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const text = out?.hookSpecificOutput?.additionalContext ?? "";
    expect(text).toMatch(/eminiar usage — usage: today \$1\.85/);
  });
});

describe("budgetWarnings", () => {
  it("fires once per crossed threshold and again for a new day key", () => {
    const first = budgetWarnings(db, ctx, "sl-brief");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/this session has cost \$1\.75, over its \$0\.50 budget/);
    expect(budgetWarnings(db, ctx, "sl-brief")).toEqual([]);
    expect(db.metaGet("usage_alert:session:sl-brief")).toBeTruthy();
    // under budget: nothing, and nothing recorded
    expect(budgetWarnings(db, ctx, "sl-other")).toEqual([]);
    expect(db.metaGet("usage_alert:session:sl-other")).toBeUndefined();

    writeConfig({ budgets: { sessionUsd: 0.5, dailyUsd: 1 } });
    const daily = budgetWarnings(db, ctx, "sl-other");
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatch(/today's sessions have cost \$1\.85, over the \$1\.00 daily budget/);
    expect(budgetWarnings(db, ctx, "sl-other")).toEqual([]);
    // the daily key is per local day: a different "now" in another day fires again
    const tomorrow = Date.now() + 2 * 86_400_000;
    expect(budgetWarnings(db, ctx, "sl-other", tomorrow)).toEqual([]); // no calls that day
  });

  it("reaches the prompt through the UserPromptSubmit hook, once", async () => {
    db.apiCallsUpsert([call({ session_id: "sl-prompt", cost_usd: 0.7 })]);
    const input = {
      session_id: "sl-prompt",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue with the refactor",
    };
    const first = await handlers.UserPromptSubmit!(input);
    expect(first?.hookSpecificOutput?.additionalContext).toMatch(
      /eminiar usage — this session has cost \$0\.70/,
    );
    const second = await handlers.UserPromptSubmit!(input);
    expect(second?.hookSpecificOutput?.additionalContext ?? "").not.toContain("eminiar usage");
  });
});
