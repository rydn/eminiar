import { describe, expect, it } from "vitest";
import type { ApiCallRow, ContextEventRow, StatRow, ToolUseRow } from "../../src/storage/types.js";
import {
  burnRate,
  byAgent,
  byDay,
  byMonth,
  bySpeed,
  byWeek,
  cacheStats,
  contextTimeline,
  expensiveCalls,
  topToolConsumers,
  totals,
} from "../../src/usage/aggregate.js";
import { activeBlock, billingBlocks } from "../../src/usage/blocks.js";
import { pricedSavings } from "../../src/usage/savings.js";

let seq = 0;
function call(over: Partial<ApiCallRow> = {}): ApiCallRow {
  seq += 1;
  return {
    request_id: `req_${seq}`,
    message_id: `msg_${seq}`,
    session_id: "s1",
    agent_id: null,
    sidechain: 0,
    ts: Date.UTC(2026, 9, 26, 10, 30),
    model: "claude-opus-5-5",
    input_tokens: 100,
    output_tokens: 50,
    cache_create_5m: 200,
    cache_create_1h: 0,
    cache_read: 700,
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

const T = (h: number, m = 0, d = 26) => Date.UTC(2026, 9, d, h, m);

describe("totals", () => {
  it("sums tokens, cost and models and computes the cache hit rate", () => {
    const t = totals([
      call(),
      call({ model: "claude-sonnet-5-5", cost_usd: null, priced: 0, cache_create_1h: 100 }),
    ]);
    expect(t.calls).toBe(2);
    expect(t.input).toBe(200);
    expect(t.output).toBe(100);
    expect(t.cacheCreate5m).toBe(400);
    expect(t.cacheCreate1h).toBe(100);
    expect(t.cacheRead).toBe(1400);
    expect(t.thinking).toBe(20);
    expect(t.costUsd).toBeCloseTo(0.01, 9);
    expect(t.unpricedCalls).toBe(1);
    // 1400 / (200 + 400 + 100 + 1400)
    expect(t.cacheHitRate).toBeCloseTo(1400 / 2100, 9);
    expect(t.models).toEqual({ "claude-opus-5-5": 1, "claude-sonnet-5-5": 1 });
  });

  it("reports a zero hit rate with no input", () => {
    expect(totals([]).cacheHitRate).toBe(0);
  });
});

describe("billingBlocks", () => {
  it("splits calls more than 5h apart into blocks starting at the floored hour", () => {
    const calls = [
      call({ ts: T(10, 30) }),
      call({ ts: T(10, 45), cost_usd: null, priced: 0 }),
      call({ ts: T(17, 0), model: "claude-sonnet-5-5" }),
    ];
    const now = T(17, 30);
    const blocks = billingBlocks(calls, now);
    expect(blocks).toHaveLength(2);
    const [a, b] = blocks as [(typeof blocks)[0], (typeof blocks)[0]];
    expect(a.start).toBe(T(10));
    expect(a.end).toBe(T(15));
    expect(a.id).toBe("2026-10-26T10:00:00.000Z");
    expect(a.calls).toBe(2);
    expect(a.pricedCalls).toBe(1);
    expect(a.unpricedCalls).toBe(1);
    expect(a.tokens).toEqual({ input: 200, output: 100, cacheCreate: 400, cacheRead: 1400 });
    expect(a.costUsd).toBeCloseTo(0.01, 9);
    expect(a.models).toEqual(["claude-opus-5-5"]);
    expect(a.active).toBe(false);
    expect(a.gapBefore).toBeUndefined();
    expect(b.start).toBe(T(17));
    expect(b.active).toBe(true);
    expect(b.gapBefore).toBe(T(17) - T(10, 45));
    expect(activeBlock(blocks, now)).toBe(b);
    expect(activeBlock(blocks, T(16))).toBeUndefined();
  });

  it("keeps a call exactly at block end in a new block", () => {
    const blocks = billingBlocks([call({ ts: T(10, 10) }), call({ ts: T(15, 0) })], T(15, 1));
    expect(blocks).toHaveLength(2);
  });
});

describe("time groupings", () => {
  const calls = [
    call({ ts: Date.UTC(2026, 9, 25, 23, 30) }), // Sun 2026-10-25
    call({ ts: Date.UTC(2026, 9, 26, 0, 30) }), // Mon 2026-10-26
    call({ ts: Date.UTC(2026, 10, 1, 12, 0) }), // Sun 2026-11-01
  ];
  it("byDay uses the calendar day in the given zone", () => {
    expect(byDay(calls, "UTC").map((g) => g.key)).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-11-01",
    ]);
    // the first two calls land on the same day in Los Angeles (16:30 and 17:30 on the 25th)
    expect(byDay(calls, "America/Los_Angeles").map((g) => [g.key, g.totals.calls])).toEqual([
      ["2026-10-25", 2],
      ["2026-11-01", 1],
    ]);
  });
  it("byWeek keys on the ISO week's Monday", () => {
    expect(byWeek(calls, "UTC").map((g) => [g.key, g.totals.calls])).toEqual([
      ["2026-10-19", 1],
      ["2026-10-26", 2],
    ]);
  });
  it("byMonth keys on YYYY-MM", () => {
    expect(byMonth(calls, "UTC").map((g) => [g.key, g.totals.calls])).toEqual([
      ["2026-10", 2],
      ["2026-11", 1],
    ]);
  });
  it("bySpeed separates fast mode", () => {
    expect(
      bySpeed([call(), call({ speed: "fast" }), call({ speed: "standard" })]).map((g) => [
        g.key,
        g.totals.calls,
      ]),
    ).toEqual([
      ["fast", 1],
      ["standard", 2],
    ]);
  });
});

describe("byAgent", () => {
  it("rolls sidechain calls up by agent and reports the delegation share", () => {
    const r = byAgent([
      call({ cost_usd: 0.06 }),
      call({ sidechain: 1, agent_id: "a1", cost_usd: 0.03 }),
      call({ sidechain: 1, agent_id: "a1", cost_usd: 0.03 }),
      call({ sidechain: 1, agent_id: "a2", cost_usd: 0.08 }),
    ]);
    expect(r.main.calls).toBe(1);
    expect(r.subagents.map((s) => [s.agentId, s.totals.calls])).toEqual([
      ["a2", 1],
      ["a1", 2],
    ]);
    expect(r.delegationShare).toBeCloseTo(0.14 / 0.2, 9);
  });
  it("is zero with nothing priced", () => {
    expect(byAgent([call({ cost_usd: null, priced: 0 })]).delegationShare).toBe(0);
  });
});

describe("cacheStats", () => {
  it("computes hit rate, write/read ratio, 1h share and cold calls", () => {
    const s = cacheStats([
      call({ ts: 1, cache_create_5m: 300, cache_create_1h: 100, cache_read: 0 }),
      call({ ts: 2, cache_create_5m: 0, cache_create_1h: 0, cache_read: 800 }),
      call({ ts: 3, cache_create_5m: 0, cache_create_1h: 0, cache_read: 0 }),
      call({ ts: 1, session_id: "s2", cache_create_5m: 0, cache_create_1h: 0, cache_read: 0 }),
    ]);
    expect(s.cacheWrites).toBe(400);
    expect(s.cacheReads).toBe(800);
    expect(s.writeReadRatio).toBeCloseTo(0.5, 9);
    expect(s.share1h).toBeCloseTo(0.25, 9);
    // 800 / (400 input + 400 writes + 800 reads)
    expect(s.hitRate).toBeCloseTo(0.5, 9);
    expect(s.coldCalls).toBe(1);
  });
  it("treats only the single earliest call per session as the first (ties by request_id)", () => {
    // Two calls share the session's first timestamp (parallel tool-result turns): only the
    // one with the lower request_id is the cold start; the other is a cold call.
    const s = cacheStats([
      call({ ts: 1, request_id: "r-b", cache_read: 0 }),
      call({ ts: 1, request_id: "r-a", cache_read: 0 }),
      call({ ts: 2, request_id: "r-c", cache_read: 500 }),
      call({ ts: 5, session_id: "s2", request_id: "r-d", cache_read: 0 }),
      call({ ts: 4, session_id: "s2", request_id: "r-e", cache_read: 0 }),
    ]);
    expect(s.coldCalls).toBe(2); // r-b in s1, r-d in s2 (r-e at ts 4 is s2's first)
    expect(cacheStats([call({ model: "<synthetic>", cache_read: 0 })]).coldCalls).toBe(0);
  });
});

describe("contextTimeline", () => {
  it("orders points by time and marks the first call after a compaction", () => {
    const calls = [
      call({
        ts: 3000,
        request_id: "r3",
        input_tokens: 10,
        cache_create_5m: 5,
        cache_create_1h: 0,
        cache_read: 0,
      }),
      call({ ts: 1000, request_id: "r1" }),
      call({ ts: 2000, request_id: "r2" }),
    ];
    const events: ContextEventRow[] = [
      {
        id: 1,
        session_id: "s1",
        ts: 2500,
        kind: "compact",
        trigger: "auto",
        pre_tokens: 1000,
        post_tokens: 100,
      },
      {
        id: 2,
        session_id: "s1",
        ts: 9000,
        kind: "clear",
        trigger: null,
        pre_tokens: null,
        post_tokens: null,
      },
    ];
    const points = contextTimeline(calls, events);
    expect(points.map((p) => p.requestId)).toEqual(["r1", "r2", "r3"]);
    expect(points.map((p) => p.contextTokens)).toEqual([1000, 1000, 15]);
    expect(points.map((p) => p.compactBefore ?? false)).toEqual([false, false, true]);
    expect(points[0]?.costUsd).toBe(0.01);
  });
});

describe("burnRate", () => {
  it("is unreliable (zeros, no projection) without an active block", () => {
    expect(burnRate([call({ ts: T(1) })], T(12))).toEqual({
      tokensPerMin: 0,
      usdPerHour: 0,
      projectedBlockUsd: null,
      windowMinutes: 0,
      reliable: false,
    });
  });
  it("rates tokens and dollars over the active block and projects to its end", () => {
    const calls = [call({ ts: T(10, 0), cost_usd: 0.5 }), call({ ts: T(10, 30), cost_usd: 0.5 })];
    const r = burnRate(calls, T(11, 0));
    expect(r.reliable).toBe(true);
    expect(r.windowMinutes).toBe(60);
    // two calls × (100 + 50 + 200 + 700) tokens over 60 minutes
    expect(r.tokensPerMin).toBeCloseTo(2100 / 60, 9);
    expect(r.usdPerHour).toBeCloseTo(1, 9);
    // $1 so far + $1/h × 4h remaining in the 10:00-15:00 block
    expect(r.projectedBlockUsd).toBeCloseTo(5, 9);
  });
  it("does not project from one call or from a window under five minutes", () => {
    // one call, an hour in: a single data point says nothing about the rate
    const one = burnRate([call({ ts: T(10, 0), cost_usd: 2 })], T(11, 0));
    expect(one.reliable).toBe(false);
    expect(one.projectedBlockUsd).toBeNull();
    expect(one.usdPerHour).toBe(0);
    expect(one.tokensPerMin).toBe(0);
    expect(one.windowMinutes).toBe(60);
    // two calls, but "now" is only three minutes after the first
    const quick = burnRate(
      [call({ ts: T(10, 0), cost_usd: 1 }), call({ ts: T(10, 2), cost_usd: 1 })],
      T(10, 3),
    );
    expect(quick.reliable).toBe(false);
    expect(quick.projectedBlockUsd).toBeNull();
    expect(quick.windowMinutes).toBe(3);
    // exactly at the thresholds it projects
    const edge = burnRate(
      [call({ ts: T(10, 0), cost_usd: 1 }), call({ ts: T(10, 2), cost_usd: 1 })],
      T(10, 5),
    );
    expect(edge.reliable).toBe(true);
    expect(edge.usdPerHour).toBeCloseTo(24, 9);
    expect(edge.projectedBlockUsd).toBeCloseTo(2 + 24 * (4 + 55 / 60), 9);
  });
});

describe("topToolConsumers", () => {
  it("ranks tools by result chars with token estimates and error counts", () => {
    const uses: ToolUseRow[] = [
      {
        tool_use_id: "t1",
        session_id: "s1",
        agent_id: null,
        ts: 1,
        tool: "Read",
        input_chars: 10,
        result_chars: 4000,
        is_error: 0,
        request_id: null,
      },
      {
        tool_use_id: "t2",
        session_id: "s1",
        agent_id: null,
        ts: 2,
        tool: "Read",
        input_chars: 10,
        result_chars: 2000,
        is_error: 1,
        request_id: null,
      },
      {
        tool_use_id: "t3",
        session_id: "s1",
        agent_id: null,
        ts: 3,
        tool: "Bash",
        input_chars: 10,
        result_chars: 9000,
        is_error: 0,
        request_id: null,
      },
      {
        tool_use_id: "t4",
        session_id: "s1",
        agent_id: null,
        ts: 4,
        tool: "Grep",
        input_chars: 10,
        result_chars: null,
        is_error: 0,
        request_id: null,
      },
    ];
    const top = topToolConsumers(uses, 2);
    expect(top).toEqual([
      { tool: "Bash", calls: 1, chars: 9000, estTokens: 2250, avgChars: 9000, errors: 0 },
      { tool: "Read", calls: 2, chars: 6000, estTokens: 1500, avgChars: 3000, errors: 1 },
    ]);
    expect(topToolConsumers(uses)).toHaveLength(3);
  });
});

describe("expensiveCalls", () => {
  it("returns priced calls at or above the threshold, most expensive first", () => {
    const r = expensiveCalls(
      [
        call({ cost_usd: 0.2 }),
        call({ cost_usd: 1.5 }),
        call({ cost_usd: null, priced: 0 }),
        call({ cost_usd: 0.5 }),
      ],
      0.5,
    );
    expect(r.map((c) => c.cost_usd)).toEqual([1.5, 0.5]);
  });
});

describe("pricedSavings", () => {
  const stats: StatRow[] = [
    // 40000 chars seen, 4000 returned → 10000 − 1000 = 9000 saved tokens
    {
      session_id: "s1",
      tool: "em_execute",
      calls: 3,
      raw_chars: 40_000,
      returned_chars: 4_000,
      duration_ms: 0,
    },
    // returned more than seen → 0
    {
      session_id: "s1",
      tool: "em_search",
      calls: 1,
      raw_chars: 100,
      returned_chars: 400,
      duration_ms: 0,
    },
    // session without calls: 4000 saved tokens, direct only
    {
      session_id: "s9",
      tool: "em_execute",
      calls: 1,
      raw_chars: 16_000,
      returned_chars: 0,
      duration_ms: 0,
    },
  ];
  it("prices direct savings at the cache-write rate and compounding at the cache-read rate", () => {
    const calls = [call(), call(), call(), call(), call({ model: "claude-sonnet-5-5" })]; // 5 calls, opus dominant
    const r = pricedSavings(stats, calls);
    expect(r.savedTokens).toBe(13_000);
    expect(r.model).toBe("claude-opus-5-5");
    // 13000 × $5 / 1M
    expect(r.directUsd).toBeCloseTo(0.065, 9);
    // s1: 9000 × $0.20 / 1M × (5 / 2 later calls); s9: no calls → 0
    expect(r.compoundingUsd).toBeCloseTo(0.0045, 9);
    expect(r.laterCallsPerSession).toBeCloseTo(1.25, 9); // mean of 2.5 (s1) and 0 (s9)
    expect(r.assumptions.some((a) => a.includes("claude-opus-5-5"))).toBe(true);
  });
  it("falls back to the sonnet price when no calls exist and says so", () => {
    const r = pricedSavings(stats, []);
    expect(r.model).toBe("claude-sonnet-5-5");
    // 13000 × $2.50 / 1M
    expect(r.directUsd).toBeCloseTo(0.0325, 9);
    expect(r.compoundingUsd).toBe(0);
    expect(r.assumptions.some((a) => a.includes("claude-sonnet-5-5"))).toBe(true);
  });
  it("honours pricing overrides", () => {
    const r = pricedSavings(stats, [call()], { "opus-5-5": { cacheWrite5m: 10 } });
    expect(r.directUsd).toBeCloseTo(0.13, 9);
  });
});
