import { describe, expect, it } from "vitest";
import {
  costOfCall,
  estTokensFromChars,
  formatUsd,
  PRICING_VERSION,
  resolvePrice,
} from "../../src/usage/pricing.js";

const zeroCall = {
  input_tokens: 0,
  output_tokens: 0,
  cache_create_5m: 0,
  cache_create_1h: 0,
  cache_read: 0,
  web_searches: 0,
  web_fetches: 0,
};

describe("resolvePrice", () => {
  it("exports a pricing version", () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches exact families, most specific first", () => {
    expect(resolvePrice("claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(resolvePrice("claude-opus-5")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    expect(resolvePrice("claude-fable-5-1")).toMatchObject({
      input: 10,
      output: 50,
      cacheRead: 0.25,
    });
    expect(resolvePrice("claude-fable-5")).toMatchObject({ input: 10, cacheRead: 1 });
    expect(resolvePrice("claude-sonnet-5-5")).toMatchObject({
      input: 2,
      output: 10,
      cacheRead: 0.1,
    });
    expect(resolvePrice("claude-sonnet-5")).toMatchObject({ input: 2, cacheRead: 0.2 });
    expect(resolvePrice("claude-haiku-4-5")).toMatchObject({ input: 1, output: 5, cacheRead: 0.1 });
    expect(resolvePrice("claude-opus-4-1-20250805")).toMatchObject({ input: 15, output: 75 });
    expect(resolvePrice("claude-opus-4-20250514")).toMatchObject({ input: 15, output: 75 });
    expect(resolvePrice("claude-opus-4-5-20251101")).toMatchObject({ input: 5, output: 25 });
    expect(resolvePrice("claude-sonnet-4-5-20250929[1m]")).toMatchObject({ input: 3, output: 15 });
    expect(resolvePrice("us.anthropic.claude-sonnet-4-6-v1:0")).toMatchObject({ input: 3 });
    expect(resolvePrice("claude-3-5-haiku-20241022")).toMatchObject({ input: 0.8, output: 4 });
  });

  it("derives cache write prices with the standard multipliers and carries web search", () => {
    const p = resolvePrice("claude-opus-5-5");
    expect(p?.cacheWrite5m).toBe(5);
    expect(p?.cacheWrite1h).toBe(8);
    expect(p?.webSearch).toBe(10);
  });

  it("falls back to bare aliases only when the id has no version", () => {
    expect(resolvePrice("opus")).toMatchObject({ input: 4 });
    expect(resolvePrice("Sonnet")).toMatchObject({ input: 2, cacheRead: 0.1 });
    expect(resolvePrice("haiku")).toMatchObject({ input: 1 });
    expect(resolvePrice("claude-3-opus-20240229")).toBeUndefined();
  });

  it("returns undefined for unknown models", () => {
    expect(resolvePrice("gpt-4o")).toBeUndefined();
    expect(resolvePrice("")).toBeUndefined();
    expect(resolvePrice("<synthetic>")).toBeUndefined();
  });

  it("applies overrides over the bundled price, first match wins, partial merge", () => {
    const p = resolvePrice("claude-opus-5-5", {
      "opus-5-5": { output: 30 },
      opus: { output: 99 },
    });
    expect(p).toMatchObject({
      input: 4,
      output: 30,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
    });
  });

  it("overrides beat aliases and can price unknown models", () => {
    expect(resolvePrice("sonnet", { sonnet: { input: 1 } })).toMatchObject({
      input: 1,
      output: 10,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      cacheRead: 0.1,
    });
    const custom = resolvePrice("my-local-model", { "local-model": { input: 2, output: 4 } });
    expect(custom).toMatchObject({
      input: 2,
      output: 4,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
      cacheRead: 0.2,
    });
    expect(resolvePrice("my-local-model", { "local-model": { input: 2 } })).toBeUndefined();
  });
});

describe("costOfCall", () => {
  it("prices every token kind and web searches", () => {
    const price = resolvePrice("claude-opus-5-5")!;
    const cost = costOfCall(
      {
        input_tokens: 1000, // 1000 × $4 / 1M = 0.004
        output_tokens: 500, // 500 × $20 / 1M = 0.01
        cache_create_5m: 2000, // 2000 × $5 / 1M = 0.01
        cache_create_1h: 1000, // 1000 × $8 / 1M = 0.008
        cache_read: 10_000, // 10000 × $0.20 / 1M = 0.002
        web_searches: 3, // 3 × $10 / 1000 = 0.03
        web_fetches: 7, // free
      },
      price,
    );
    expect(cost.input).toBeCloseTo(0.004, 9);
    expect(cost.output).toBeCloseTo(0.01, 9);
    expect(cost.cacheWrite).toBeCloseTo(0.018, 9);
    expect(cost.cacheRead).toBeCloseTo(0.002, 9);
    expect(cost.tools).toBeCloseTo(0.03, 9);
    expect(cost.total).toBeCloseTo(0.064, 9);
  });

  it("does not double count thinking tokens and tolerates bad numbers", () => {
    const price = resolvePrice("claude-sonnet-5-5")!;
    const cost = costOfCall(
      { ...zeroCall, output_tokens: 1000, input_tokens: Number.NaN as number },
      price,
    );
    expect(cost.total).toBeCloseTo(0.01, 9);
  });

  it("applies the long-context tier to the whole request on Haiku 5.5", () => {
    const price = resolvePrice("claude-haiku-5-5")!;
    expect(price.longContext).toEqual({ threshold: 100_000, input: 0.5, output: 2.5 });
    const small = costOfCall({ ...zeroCall, input_tokens: 50_000, output_tokens: 1000 }, price);
    expect(small.input).toBeCloseTo(0.005, 9); // 50000 × $0.10 / 1M
    expect(small.output).toBeCloseTo(0.0005, 9); // 1000 × $0.50 / 1M
    const big = costOfCall(
      { ...zeroCall, input_tokens: 60_000, cache_read: 50_000, output_tokens: 1000 },
      price,
    );
    expect(big.input).toBeCloseTo(0.03, 9); // 60000 × $0.50 / 1M
    expect(big.cacheRead).toBeCloseTo(0.0025, 9); // 50000 × $0.05 / 1M (0.01 × 5)
    expect(big.output).toBeCloseTo(0.0025, 9); // 1000 × $2.50 / 1M
  });

  it("has no long-context tier on 1M-context models", () => {
    const price = resolvePrice("claude-opus-5-5")!;
    expect(price.longContext).toBeUndefined();
    const cost = costOfCall({ ...zeroCall, input_tokens: 900_000 }, price);
    expect(cost.input).toBeCloseTo(3.6, 9);
  });
});

describe("helpers", () => {
  it("formats USD", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(4.56)).toBe("$4.56");
    expect(formatUsd(1234.4)).toBe("$1,234");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-2.5)).toBe("-$2.50");
  });

  it("estimates tokens at 4 chars per token", () => {
    expect(estTokensFromChars(0)).toBe(0);
    expect(estTokensFromChars(1)).toBe(1);
    expect(estTokensFromChars(4000)).toBe(1000);
    expect(estTokensFromChars(4001)).toBe(1001);
  });
});
