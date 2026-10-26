import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type {
  ApiCallRow,
  ContextEventRow,
  EventRow,
  StatuslineSnapshotRow,
  ToolUseRow,
} from "../../src/storage/types.js";
import { groupBy, isRealCall, totals } from "../../src/usage/aggregate.js";
import {
  detectInsights,
  type Insight,
  type InsightInput,
  loadInsightInput,
} from "../../src/usage/insights.js";
import { parseTranscriptLines } from "../../src/usage/transcript.js";

let seq = 0;
const T = (h: number, m = 0) => Date.UTC(2026, 9, 26, h, m);

function call(over: Partial<ApiCallRow> = {}): ApiCallRow {
  seq += 1;
  return {
    request_id: `req_${seq}`,
    message_id: `msg_${seq}`,
    session_id: "s1",
    agent_id: null,
    sidechain: 0,
    ts: T(10, seq),
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
    cost_usd: 0.01,
    priced: 1,
    ...over,
  };
}

function toolUse(over: Partial<ToolUseRow> = {}): ToolUseRow {
  seq += 1;
  return {
    tool_use_id: `toolu_${seq}`,
    session_id: "s1",
    agent_id: null,
    ts: T(10, seq),
    tool: "Read",
    input_chars: 50,
    result_chars: 1000,
    is_error: 0,
    request_id: null,
    ...over,
  };
}

function compact(over: Partial<ContextEventRow> = {}): ContextEventRow {
  seq += 1;
  return {
    id: seq,
    session_id: "s1",
    ts: T(10, seq),
    kind: "compact",
    trigger: "auto",
    pre_tokens: 180_000,
    post_tokens: 20_000,
    ...over,
  };
}

function snapshot(over: Partial<StatuslineSnapshotRow> = {}): StatuslineSnapshotRow {
  seq += 1;
  return {
    id: seq,
    session_id: "s1",
    ts: T(10, seq),
    model_id: "claude-opus-5-5",
    cost_usd: 1,
    api_ms: null,
    duration_ms: null,
    ctx_input_tokens: null,
    ctx_output_tokens: null,
    ctx_size: 200_000,
    ctx_used_pct: 40,
    cache_warm: 1,
    cache_ttl: "5m",
    five_hour_pct: 10,
    five_hour_resets_at: null,
    seven_day_pct: 5,
    seven_day_resets_at: null,
    lines_added: null,
    lines_removed: null,
    ...over,
  };
}

function event(over: Partial<EventRow> = {}): EventRow {
  seq += 1;
  return {
    id: seq,
    session_id: "s1",
    ts: T(10, seq),
    category: "iteration_loop",
    priority: 2,
    tool: null,
    payload: "{}",
    document_id: null,
    ...over,
  };
}

function run(over: Partial<InsightInput>): { insights: Insight[]; byId: Map<string, Insight> } {
  const { insights } = detectInsights({
    calls: [],
    toolUses: [],
    contextEvents: [],
    stats: [],
    events: [],
    snapshots: [],
    now: T(12),
    ...over,
  });
  return { insights, byId: new Map(insights.map((i) => [i.id, i])) };
}

/** `n` calls one minute apart in one thread. */
function thread(n: number, over: Partial<ApiCallRow> = {}, startMinute = 0): ApiCallRow[] {
  return Array.from({ length: n }, (_, i) => call({ ts: T(10, startMinute + i), ...over }));
}

describe("aggregate: synthetic rows", () => {
  it("isRealCall drops <synthetic> entries from totals and groupBy", () => {
    const rows = [call(), call({ model: "<synthetic>", cost_usd: 9, output_tokens: 0 })];
    expect(isRealCall(rows[0]!)).toBe(true);
    expect(isRealCall(rows[1]!)).toBe(false);
    const t = totals(rows);
    expect(t.calls).toBe(1);
    expect(t.costUsd).toBe(0.01);
    expect(t.models["<synthetic>"]).toBeUndefined();
    expect(groupBy(rows, (c) => c.model).map((g) => g.key)).toEqual(["claude-opus-5-5"]);
  });
});

describe("detectors", () => {
  it("cache-thrash: ≥ 3 consecutive calls rewriting ≥ 20% of context", () => {
    // writes 5000 of 15100 context = 33% on five consecutive calls (first call exempt)
    const pos = run({ calls: thread(5, { cache_create_5m: 5000, cache_read: 10_000 }) });
    const i = pos.byId.get("cache-thrash")!;
    expect(i).toBeDefined();
    expect(i.evidence).toMatchObject({ runs: 1, longestRun: 4 });
    expect(i.reason).toMatch(/1 run of 3\+ consecutive calls/);
    expect(i.estimatedSavingsUsd).toBeGreaterThan(0);
    expect(i.scope).toBe("session");
    expect(i.sessionId).toBe("s1");
    // 200 of 10300 = 2%: fine
    expect(run({ calls: thread(5) }).byId.has("cache-thrash")).toBe(false);
    // a compaction inside the run breaks it: 2 + 2 heavy calls, neither run reaches 3
    const split = run({
      calls: thread(5, { cache_create_5m: 5000, cache_read: 10_000 }),
      contextEvents: [compact({ ts: T(10, 2) + 30_000 })],
    });
    expect(split.byId.has("cache-thrash")).toBe(false);
  });

  it("cache-cold: a gap over the TTL followed by a full cache write", () => {
    const warm = call({ ts: T(10, 0) });
    const cold = call({ ts: T(10, 30), cache_create_5m: 20_000, cache_read: 0 });
    const pos = run({ calls: [warm, cold] });
    const i = pos.byId.get("cache-cold")!;
    expect(i).toBeDefined();
    expect(i.severity).toBe("info");
    expect(i.evidence).toMatchObject({
      restarts: 1,
      tokensRewritten: 20_000,
      longestGapMinutes: 30,
    });
    expect(i.reason).toMatch(/30 min/);
    // opus-5-5: write 5.0 − read 0.2 = 4.8 $/MTok × 20k tokens
    expect(i.estimatedSavingsUsd).toBeCloseTo(0.096, 4);
    // same write 2 minutes later is inside the 5-minute TTL
    const neg = run({ calls: [warm, { ...cold, ts: T(10, 2) }] });
    expect(neg.byId.has("cache-cold")).toBe(false);
    // 1h writes dominate the thread → TTL is 60 min, a 30-minute pause is fine
    const oneHour = run({
      calls: [
        { ...warm, cache_create_5m: 0, cache_create_1h: 30_000 },
        { ...cold, cache_create_5m: 0, cache_create_1h: 20_000 },
      ],
    });
    expect(oneHour.byId.has("cache-cold")).toBe(false);
    // two restarts → warn
    const twice = run({
      calls: [warm, cold, { ...cold, request_id: "req_x", ts: T(11, 30) }],
    });
    expect(twice.byId.get("cache-cold")?.severity).toBe("warn");
  });

  it("context-bloat: Read/Bash/Grep/WebFetch results over 8k estimated tokens", () => {
    const calls = thread(4);
    const pos = run({
      calls,
      toolUses: [
        toolUse({ ts: T(10, 0) + 1000, tool: "Read", result_chars: 40_000 }),
        toolUse({ ts: T(10, 1) + 1000, tool: "Bash", result_chars: 60_000 }),
      ],
    });
    const i = pos.byId.get("context-bloat")!;
    expect(i).toBeDefined();
    expect(i.evidence).toMatchObject({ results: 2, estTokens: 25_000 });
    expect(i.reason).toMatch(/2 Read\/Bash results above 8k tokens/);
    expect(i.estimatedSavingsUsd).toBeGreaterThan(0);
    // priced as compounding: the 10k-token Read (3 later calls) alone is
    // 10k × 5.0 + 10k × 0.2 × 3 = 0.056 USD at opus-5-5
    const single = run({
      calls,
      toolUses: [toolUse({ ts: T(10, 0) + 1000, tool: "Read", result_chars: 40_000 })],
    });
    expect(single.byId.get("context-bloat")?.estimatedSavingsUsd).toBeCloseTo(0.056, 4);
    // small results and em_* results do not count
    const neg = run({
      calls,
      toolUses: [
        toolUse({ tool: "Read", result_chars: 10_000 }),
        toolUse({ tool: "mcp__plugin_eminiar_eminiar__em_execute", result_chars: 100_000 }),
      ],
    });
    expect(neg.byId.has("context-bloat")).toBe(false);
  });

  it("compaction-churn: 3 compactions in a session, or one below half the window", () => {
    const three = run({ calls: thread(2), contextEvents: [compact(), compact(), compact()] });
    expect(three.byId.get("compaction-churn")?.evidence).toMatchObject({ maxCompactions: 3 });
    const early = run({ calls: thread(2), contextEvents: [compact({ pre_tokens: 50_000 })] });
    expect(early.byId.get("compaction-churn")?.evidence).toMatchObject({ earlyCompactions: 1 });
    // the window comes from the snapshot when there is one: 50k of a 90k window is 55%
    const smallWindow = run({
      calls: thread(2),
      contextEvents: [compact({ pre_tokens: 50_000 })],
      snapshots: [snapshot({ ctx_size: 90_000 })],
    });
    expect(smallWindow.byId.has("compaction-churn")).toBe(false);
    const neg = run({ calls: thread(2), contextEvents: [compact(), compact()] });
    expect(neg.byId.has("compaction-churn")).toBe(false);
  });

  it("opus-for-trivial: premium calls under 100 output tokens with no tool use, > 30%", () => {
    const trivial = () => call({ output_tokens: 20, cost_usd: 0.05 });
    const pos = run({ calls: [trivial(), trivial(), trivial(), trivial(), call(), call()] });
    const i = pos.byId.get("opus-for-trivial")!;
    expect(i).toBeDefined();
    expect(i.evidence).toMatchObject({ trivialCalls: 4, premiumCalls: 6, share: 67 });
    expect(i.severity).toBe("warn");
    // 4 × $0.05 spent; at sonnet-5-5 each is 100×2 + 20×10 + 200×2.5 + 10000×0.1 = 1.9e-3
    expect(i.estimatedSavingsUsd).toBeCloseTo(0.2 - 4 * 0.0019, 4);
    expect(i.reason).toMatch(/4 of 6 premium-model calls \(67%\)/);
    const neg = run({ calls: [trivial(), call(), call(), call(), call(), call()] });
    expect(neg.byId.has("opus-for-trivial")).toBe(false);
    // a short answer that called a tool is not trivial
    const withTool = [trivial(), trivial(), trivial(), trivial(), call(), call()];
    const tooled = run({
      calls: withTool,
      toolUses: withTool.slice(0, 3).map((c) => toolUse({ request_id: c.request_id })),
    });
    expect(tooled.byId.has("opus-for-trivial")).toBe(false);
    // too few premium calls to judge
    expect(run({ calls: [trivial(), trivial()] }).byId.has("opus-for-trivial")).toBe(false);
    // Sonnet calls are never premium
    const sonnet = run({
      calls: Array.from({ length: 6 }, () =>
        call({ model: "claude-sonnet-5-5", output_tokens: 10 }),
      ),
    });
    expect(sonnet.byId.has("opus-for-trivial")).toBe(false);
  });

  it("fast-mode-share: fast calls over 25% of priced cost", () => {
    const pos = run({ calls: [call({ speed: "fast", cost_usd: 0.5 }), call({ cost_usd: 0.5 })] });
    expect(pos.byId.get("fast-mode-share")?.evidence).toMatchObject({ fastCalls: 1, share: 50 });
    expect(pos.byId.get("fast-mode-share")?.reason).toMatch(/\$0.500 of \$1.00 \(50%\)/);
    const neg = run({ calls: [call({ speed: "fast", cost_usd: 0.1 }), call({ cost_usd: 0.9 })] });
    expect(neg.byId.has("fast-mode-share")).toBe(false);
  });

  it("thinking-share: thinking over 40% of output tokens", () => {
    const pos = run({ calls: [call({ output_tokens: 2000, thinking_tokens: 1000 })] });
    expect(pos.byId.get("thinking-share")?.evidence).toMatchObject({ share: 50 });
    const neg = run({ calls: [call({ output_tokens: 2000, thinking_tokens: 100 })] });
    expect(neg.byId.has("thinking-share")).toBe(false);
    // not enough output to judge
    const tiny = run({ calls: [call({ output_tokens: 200, thinking_tokens: 150 })] });
    expect(tiny.byId.has("thinking-share")).toBe(false);
  });

  it("subagent-cost: subagents over 60% of cost", () => {
    const side = (cost: number) => call({ sidechain: 1, agent_id: "a1", cost_usd: cost });
    const pos = run({ calls: [call({ cost_usd: 0.1 }), side(0.9)] });
    expect(pos.byId.get("subagent-cost")?.evidence).toMatchObject({ subagents: 1, share: 90 });
    const neg = run({ calls: [call({ cost_usd: 0.5 }), side(0.5)] });
    expect(neg.byId.has("subagent-cost")).toBe(false);
  });

  it("expensive-turn: one call over budgets.turnUsd (default $1)", () => {
    const pos = run({ calls: [call({ cost_usd: 1.5, cache_read: 300_000 }), call()] });
    const i = pos.byId.get("expensive-turn")!;
    expect(i.severity).toBe("warn");
    expect(i.evidence).toMatchObject({ calls: 1, maxUsd: 1.5, limitUsd: 1 });
    expect(i.reason).toMatch(/\$1.50 on claude-opus-5-5/);
    expect(i.reason).toMatch(
      /driven by context \(context \$0\.060, output \$0\.010, cache writes \$0\.001\)/,
    );
    expect(i.evidence).toMatchObject({
      driver: "context",
      contextUsd: 0.0604,
      outputUsd: 0.01,
      cacheWriteUsd: 0.001,
    });
    expect(i.recommendation).toMatch(/Compact, start a fresh session/);
    const high = run({ calls: [call({ cost_usd: 4 })] });
    expect(high.byId.get("expensive-turn")?.severity).toBe("high");
    const raised = run({ calls: [call({ cost_usd: 1.5 })], budgets: { turnUsd: 2 } });
    expect(raised.byId.has("expensive-turn")).toBe(false);
    expect(run({ calls: [call({ cost_usd: 0.9 })] }).byId.has("expensive-turn")).toBe(false);
  });

  it("expensive-turn: blames output or cache writes when they drive the cost, not context", () => {
    // opus-5-5: output $20/MTok → 60k output tokens = $1.20 against $0.0024 of context
    const out = run({ calls: [call({ cost_usd: 1.5, output_tokens: 60_000 })] });
    const o = out.byId.get("expensive-turn")!;
    expect(o.evidence).toMatchObject({ driver: "output", outputUsd: 1.2 });
    expect(o.reason).toMatch(
      /driven by output \(context \$0\.002, output \$1\.20, cache writes \$0\.001\)/,
    );
    expect(o.recommendation).toMatch(/Lower the effort level or ask for a shorter answer/);
    // 1h cache writes at $8/MTok → 150k tokens = $1.20 (plus the $0.001 default 5m write)
    const wr = run({ calls: [call({ cost_usd: 1.5, cache_create_1h: 150_000 })] });
    const w = wr.byId.get("expensive-turn")!;
    expect(w.evidence).toMatchObject({ driver: "cache-write", cacheWriteUsd: 1.201 });
    expect(w.reason).toMatch(
      /driven by cache writes \(context \$0\.002, output \$0\.010, cache writes \$1\.20\)/,
    );
    expect(w.recommendation).toMatch(/Keep the prefix stable, or use the 1h cache deliberately/);
    // a 5m write of the same size is $5/MTok = $0.75: still the dominant term
    const w5 = run({ calls: [call({ cost_usd: 1.5, cache_create_5m: 150_000 })] });
    expect(w5.byId.get("expensive-turn")!.evidence).toMatchObject({
      driver: "cache-write",
      cacheWriteUsd: 0.75,
    });
  });

  it("error-loop: hook and permission denials parsed from a transcript are not failures", () => {
    const use = (id: string, ts: string) =>
      JSON.stringify({
        type: "assistant",
        requestId: `r_${id}`,
        timestamp: ts,
        sessionId: "s1",
        message: {
          id: `m_${id}`,
          model: "claude-opus-5-5",
          content: [{ type: "tool_use", id, name: "Bash", input: { command: "cat big.log" } }],
        },
      });
    const res = (id: string, ts: string, text: string) =>
      JSON.stringify({
        type: "user",
        timestamp: ts,
        sessionId: "s1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }],
        },
      });
    const lines = (text: (i: number) => string) =>
      [1, 2, 3].flatMap((i) => [
        use(`t${i}`, `2026-10-26T10:0${i}:00Z`),
        res(`t${i}`, `2026-10-26T10:0${i}:01Z`, text(i)),
      ]);
    const denials = parseTranscriptLines(
      lines(
        () =>
          "PreToolUse:Bash hook error: eminiar: this command is likely to print a lot; retry with em_execute.",
      ),
      { sessionId: "s1", path: "x" },
    );
    expect(denials.denied).toBe(3);
    expect(denials.toolUses.every((u) => u.is_error === 0)).toBe(true);
    expect(run({ calls: thread(1), toolUses: denials.toolUses }).byId.has("error-loop")).toBe(
      false,
    );
    const failures = parseTranscriptLines(
      lines((i) => `Command failed with exit code ${i}: no such file`),
      { sessionId: "s1", path: "x" },
    );
    expect(failures.denied).toBe(0);
    const loop = run({ calls: thread(1), toolUses: failures.toolUses }).byId.get("error-loop");
    expect(loop?.evidence).toMatchObject({ longestErrorRun: 3, tool: "Bash" });
  });

  it("error-loop: an iteration_loop event or 3 consecutive failures of one tool", () => {
    const viaEvent = run({ calls: thread(1), events: [event()] });
    expect(viaEvent.byId.get("error-loop")?.evidence).toMatchObject({ loops: 1 });
    const fail = () => toolUse({ tool: "Bash", is_error: 1 });
    const viaTools = run({ calls: thread(1), toolUses: [fail(), fail(), fail()] });
    expect(viaTools.byId.get("error-loop")?.evidence).toMatchObject({
      longestErrorRun: 3,
      tool: "Bash",
    });
    expect(viaTools.byId.get("error-loop")?.reason).toMatch(/3 consecutive Bash failures/);
    // two failures, a success, two failures: no run of three
    const neg = run({ calls: thread(1), toolUses: [fail(), fail(), toolUse(), fail(), fail()] });
    expect(neg.byId.has("error-loop")).toBe(false);
    // three failures of different tools are not a loop
    const mixed = run({
      calls: thread(1),
      toolUses: [fail(), toolUse({ tool: "Read", is_error: 1 }), fail()],
    });
    expect(mixed.byId.has("error-loop")).toBe(false);
  });

  it("budget: session and daily totals above the configured budgets", () => {
    const now = Date.now();
    const calls = [call({ ts: now, cost_usd: 0.4 }), call({ ts: now, cost_usd: 0.3 })];
    const pos = run({ calls, now, budgets: { sessionUsd: 0.5, dailyUsd: 0.6 } });
    const budgets = pos.insights.filter((i) => i.id === "budget");
    expect(budgets).toHaveLength(2);
    expect(budgets.every((b) => b.severity === "high")).toBe(true);
    expect(budgets.find((b) => b.scope === "session")?.sessionId).toBe("s1");
    expect(budgets.find((b) => b.scope === "project")?.reason).toMatch(/\$0.700, over the \$0.600/);
    const neg = run({ calls, now, budgets: { sessionUsd: 1, dailyUsd: 1 } });
    expect(neg.byId.has("budget")).toBe(false);
    expect(run({ calls, now }).byId.has("budget")).toBe(false);
  });

  it("unpriced-model: calls without a price", () => {
    const pos = run({
      calls: [call(), call({ model: "claude-mystery-9", cost_usd: null, priced: 0 })],
    });
    expect(pos.byId.get("unpriced-model")?.evidence).toMatchObject({
      calls: 1,
      models: "claude-mystery-9",
    });
    expect(pos.byId.get("unpriced-model")?.recommendation).toMatch(/config.usage.pricing/);
    expect(run({ calls: [call()] }).byId.has("unpriced-model")).toBe(false);
  });

  it("context-near-limit: latest snapshot at or above 85%", () => {
    const warn = run({
      snapshots: [snapshot({ ctx_used_pct: 90 }), snapshot({ ctx_used_pct: 40, ts: T(9) })],
    });
    const i = warn.byId.get("context-near-limit")!;
    expect(i.severity).toBe("warn");
    expect(i.reason).toMatch(/90% of the 200k-token window/);
    expect(i.sessionId).toBe("s1");
    expect(
      run({ snapshots: [snapshot({ ctx_used_pct: 97 })] }).byId.get("context-near-limit")?.severity,
    ).toBe("high");
    // the latest snapshot decides, not the worst one
    const recovered = run({
      snapshots: [snapshot({ ctx_used_pct: 90 }), snapshot({ ctx_used_pct: 20 })],
    });
    expect(recovered.byId.has("context-near-limit")).toBe(false);
    expect(
      run({ snapshots: [snapshot({ ctx_used_pct: 50 })] }).byId.has("context-near-limit"),
    ).toBe(false);
  });

  it("ignores <synthetic> rows and sorts by severity then savings", () => {
    const quiet = run({ calls: [call(), call({ model: "<synthetic>", cost_usd: 9 })] });
    expect(quiet.byId.has("expensive-turn")).toBe(false);
    const mixed = run({
      calls: [
        call({ ts: T(10, 0) }),
        call({ ts: T(10, 30), cache_create_5m: 20_000, cache_read: 0 }), // cache-cold (info)
        call({ ts: T(10, 31), cost_usd: 1.5 }), // expensive-turn (warn)
        call({ ts: T(10, 32), model: "claude-x", cost_usd: null, priced: 0 }), // unpriced (info)
      ],
      snapshots: [snapshot({ ctx_used_pct: 97 })], // high
    });
    const ids = mixed.insights.map((i) => i.id);
    expect(ids[0]).toBe("context-near-limit");
    expect(ids[1]).toBe("expensive-turn");
    expect(ids.indexOf("cache-cold")).toBeLessThan(ids.indexOf("unpriced-model"));
    // project scope when several sessions are involved
    const multi = run({ calls: [call({ cost_usd: 2 }), call({ cost_usd: 2, session_id: "s2" })] });
    expect(multi.byId.get("expensive-turn")).toMatchObject({ scope: "project" });
    expect(multi.byId.get("expensive-turn")?.sessionId).toBeUndefined();
  });
});

describe("scores", () => {
  const ids = ["context-health", "cost-efficiency", "cache-efficiency", "delegation"];

  it("always lists the four scores with reasons, even on empty input", () => {
    const { scores } = detectInsights({
      calls: [],
      toolUses: [],
      contextEvents: [],
      stats: [],
      events: [],
      snapshots: [],
    });
    expect(scores.map((s) => s.id)).toEqual(ids);
    for (const s of scores) {
      expect(s.value).toBeGreaterThanOrEqual(0);
      expect(s.value).toBeLessThanOrEqual(100);
      expect(s.reasons.length).toBeGreaterThan(0);
    }
    expect(scores[2]?.reasons[0]).toMatch(/no usage recorded/);
  });

  it("context-health subtracts documented penalties", () => {
    const { scores } = detectInsights({
      calls: thread(3),
      toolUses: [toolUse({ tool: "Read", result_chars: 40_000 })], // −5
      contextEvents: [compact(), compact(), compact()], // 2 beyond the first → −20
      stats: [],
      events: [event()], // −10
      snapshots: [snapshot({ ctx_used_pct: 90 })], // −20
    });
    const ch = scores.find((s) => s.id === "context-health")!;
    expect(ch.value).toBe(45);
    expect(ch.reasons).toHaveLength(4);
    expect(ch.reasons.join(" ")).toMatch(/1 oversized tool result in context \(−5\)/);
    expect(ch.reasons.join(" ")).toMatch(/2 compactions beyond the first per session \(−20\)/);
  });

  it("cost-efficiency and cache-efficiency explain their deductions", () => {
    const { scores } = detectInsights({
      calls: [
        call({ ts: T(10, 0), cost_usd: 1.5 }), // expensive turn −10
        call({ ts: T(10, 30), cache_create_5m: 20_000, cache_read: 0 }), // cold restart −5
        call({ ts: T(10, 31), model: "claude-x", cost_usd: null, priced: 0 }), // 1/3 unpriced −7
      ],
      toolUses: [],
      contextEvents: [],
      stats: [],
      events: [],
      snapshots: [],
      now: T(12),
    });
    const cost = scores.find((s) => s.id === "cost-efficiency")!;
    expect(cost.value).toBe(83);
    expect(cost.reasons).toEqual(["1 call over $1.00 (−10)", "33% of calls unpriced (−7)"]);
    const cache = scores.find((s) => s.id === "cache-efficiency")!;
    // hit rate = 20000 / (300 + 20400 + 20000) ≈ 49% → 49 − 5
    expect(cache.reasons[0]).toMatch(/cache hit rate 49% over 3 calls/);
    expect(cache.reasons[1]).toBe("1 cold restart (−5)");
    expect(cache.value).toBe(44);
  });

  it("delegation rewards a healthy share and explains the extremes", () => {
    const none = detectInsights({ ...emptyInput(), calls: thread(2) }).scores;
    expect(none.find((s) => s.id === "delegation")).toMatchObject({ value: 60 });
    const side = (cost: number, over: Partial<ApiCallRow> = {}) =>
      call({ sidechain: 1, agent_id: "a1", cost_usd: cost, ...over });
    const healthy = detectInsights({
      ...emptyInput(),
      calls: [call({ cost_usd: 0.6 }), side(0.4)],
    });
    expect(healthy.scores.find((s) => s.id === "delegation")).toMatchObject({ value: 100 });
    const heavy = detectInsights({ ...emptyInput(), calls: [call({ cost_usd: 0.1 }), side(0.9)] });
    const d = heavy.scores.find((s) => s.id === "delegation")!;
    // 100 − 150 × (0.9 − 0.6) = 55
    expect(d.value).toBe(55);
    expect(d.reasons[0]).toMatch(/subagents are 90% of cost, above 60% \(−45\)/);
    const coldSub = detectInsights({
      ...emptyInput(),
      calls: [call({ cost_usd: 0.6 }), side(0.4, { cache_read: 0, cache_create_5m: 5000 })],
    });
    const cs = coldSub.scores.find((s) => s.id === "delegation")!;
    expect(cs.value).toBe(85);
    expect(cs.reasons[1]).toMatch(/subagent cache hit rate 0% \(−15\)/);
  });
});

function emptyInput(): InsightInput {
  return {
    calls: [],
    toolUses: [],
    contextEvents: [],
    stats: [],
    events: [],
    snapshots: [],
    now: T(12),
  };
}

describe("loadInsightInput", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        usage: { budgets: { sessionUsd: 0.5 }, pricing: { "mystery-9": { input: 3, output: 15 } } },
      }),
    );
    resetContextCache();
    ctx = getContext(root);
    db = getStorage(ctx, { vectors: false });
  });

  afterAll(() => {
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
  });

  it("gathers the session's rows, config budgets and overrides, and feeds detectInsights", () => {
    const now = Date.now();
    db.apiCallsUpsert([
      call({ session_id: "db-1", ts: now - 3000, cost_usd: 0.4 }),
      call({ session_id: "db-1", ts: now - 2000, cost_usd: 0.3 }),
      call({ session_id: "db-2", ts: now - 1000, cost_usd: 0.1 }),
    ]);
    db.toolUsesUpsert([toolUse({ session_id: "db-1", ts: now - 2500, result_chars: 50_000 })]);
    db.contextEventInsert({
      session_id: "db-1",
      ts: now - 1500,
      kind: "compact",
      trigger: "auto",
      pre_tokens: 150_000,
      post_tokens: 10_000,
    });
    db.eventInsert({ sessionId: "db-1", category: "iteration_loop", priority: 2, payload: {} });

    const input = loadInsightInput(db, ctx, { sessionId: "db-1", now });
    expect(input.calls.map((c) => c.session_id)).toEqual(["db-1", "db-1"]);
    expect(input.toolUses).toHaveLength(1);
    expect(input.contextEvents).toHaveLength(1);
    expect(input.events.map((e) => e.category)).toEqual(["iteration_loop"]);
    expect(input.budgets).toEqual({ sessionUsd: 0.5 });
    expect(input.overrides).toEqual({ "mystery-9": { input: 3, output: 15 } });
    expect(input.now).toBe(now);

    const { insights, scores } = detectInsights(input);
    const ids = insights.map((i) => i.id);
    expect(ids).toContain("budget");
    expect(ids).toContain("context-bloat");
    expect(ids).toContain("error-loop");
    expect(insights.find((i) => i.id === "budget")).toMatchObject({
      scope: "session",
      sessionId: "db-1",
    });
    expect(scores).toHaveLength(4);

    // project scope: every session, recent events, project stats
    const all = loadInsightInput(db, ctx, { now });
    expect(all.calls).toHaveLength(3);
    expect(all.events.length).toBeGreaterThanOrEqual(1);
    const since = loadInsightInput(db, ctx, { since: now - 1200, now });
    expect(since.calls.map((c) => c.session_id)).toEqual(["db-2"]);
  });
});
