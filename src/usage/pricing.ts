/**
 * Bundled list prices for Claude models, USD per million tokens, and the cost of
 * one API call.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (the "Model
 * pricing", "Long context pricing" and "Web search tool" sections), fetched
 * 2026-10-26 and cross-checked against the `claude-api` skill reference of the
 * same date. Anthropic first-party API rates; Bedrock / Vertex differ.
 *
 * Rules taken from that page:
 * - 5-minute cache write = 1.25x base input, 1-hour cache write = 2x base input.
 * - Cache read = 0.1x base input, except 0.025x on Fable 5.1 / Mythos 5.1 and
 *   0.05x on Opus 5.5 / Sonnet 5.5.
 * - Claude 4.6+ models include the full 1M context window at standard pricing
 *   (no long-context premium). Only Haiku 5.5 is priced by prompt length: a
 *   request whose input + cache tokens exceed 100,000 pays the higher tier for
 *   the whole request.
 * - Web search: $10 per 1,000 searches. Web fetch: no additional charge.
 * - Thinking tokens are billed as output tokens (already inside output_tokens).
 */

import type { ApiCallRow } from "../storage/types.js";

/** Bump when the bundled table changes so stored cost_usd rows can be re-priced. */
export const PRICING_VERSION = "2026-10-26";

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** USD per 1k web search requests. */
  webSearch?: number;
  /**
   * Higher tier applied to the whole request when input + cache tokens exceed
   * `threshold`. Cache prices scale by `input / base input` in that tier.
   */
  longContext?: { threshold: number; input: number; output: number };
}

/**
 * Config-shaped price overrides keyed by model-id substring. Fields may be
 * `undefined` (as zod produces them) so `config.usage.pricing` is assignable
 * directly; `Record<string, Partial<ModelPrice>>` is a subtype.
 */
export type PricingOverrides = Record<
  string,
  { [K in keyof ModelPrice]?: ModelPrice[K] | undefined }
>;

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  tools: number;
  total: number;
}

const WEB_SEARCH_PER_1K = 10;

function price(
  input: number,
  output: number,
  cacheRead: number,
  extra: Pick<ModelPrice, "longContext"> = {},
): ModelPrice {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead,
    webSearch: WEB_SEARCH_PER_1K,
    ...extra,
  };
}

const FABLE_5_1 = price(10, 50, 0.25);
const FABLE_5 = price(10, 50, 1);
const OPUS_5_5 = price(4, 20, 0.2);
const OPUS_5 = price(5, 25, 0.5);
const OPUS_4_LATE = price(5, 25, 0.5); // 4.5 / 4.6 / 4.7 / 4.8
const OPUS_4_EARLY = price(15, 75, 1.5); // 4 / 4.1
const SONNET_5_5 = price(2, 10, 0.1);
const SONNET_5 = price(2, 10, 0.2);
const SONNET_4 = price(3, 15, 0.3); // 4 / 4.5 / 4.6
const HAIKU_5_5 = price(0.1, 0.5, 0.01, {
  longContext: { threshold: 100_000, input: 0.5, output: 2.5 },
});
const HAIKU_4_5 = price(1, 5, 0.1);
const HAIKU_3_5 = price(0.8, 4, 0.08);

/**
 * Substring patterns over the lower-cased model id, most specific first. Works
 * for bare ids (`claude-opus-5-5`), dated ids (`claude-opus-4-5-20251101`),
 * Bedrock ids (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and the `[1m]`
 * suffix Claude Code appends.
 */
const FAMILIES: ReadonlyArray<readonly [pattern: string, price: ModelPrice]> = [
  ["fable-5-1", FABLE_5_1],
  ["mythos-5-1", FABLE_5_1],
  ["fable-5", FABLE_5],
  ["mythos-5", FABLE_5],
  ["opus-5-5", OPUS_5_5],
  ["opus-5", OPUS_5],
  ["opus-4-8", OPUS_4_LATE],
  ["opus-4-7", OPUS_4_LATE],
  ["opus-4-6", OPUS_4_LATE],
  ["opus-4-5", OPUS_4_LATE],
  ["opus-4-1", OPUS_4_EARLY],
  ["opus-4", OPUS_4_EARLY],
  ["sonnet-5-5", SONNET_5_5],
  ["sonnet-5", SONNET_5],
  ["sonnet-4-6", SONNET_4],
  ["sonnet-4-5", SONNET_4],
  ["sonnet-4", SONNET_4],
  ["haiku-5-5", HAIKU_5_5],
  ["haiku-4-5", HAIKU_4_5],
  ["3-5-haiku", HAIKU_3_5],
];

/** Last resort for ids that carry no version digits at all ("opus", "sonnet"). */
const ALIASES: ReadonlyArray<readonly [pattern: string, price: ModelPrice]> = [
  ["fable", FABLE_5_1],
  ["mythos", FABLE_5_1],
  ["opus", OPUS_5_5],
  ["sonnet", SONNET_5_5],
  ["haiku", HAIKU_4_5],
];

function bundledPrice(id: string): ModelPrice | undefined {
  for (const [pattern, p] of FAMILIES) if (id.includes(pattern)) return p;
  if (/\d/.test(id)) return undefined;
  for (const [pattern, p] of ALIASES) if (id.includes(pattern)) return p;
  return undefined;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Price for a model id. Overrides are matched by case-insensitive substring in
 * insertion order (first match wins) and merged field by field over the bundled
 * price. An override for an unknown model needs at least `input` and `output`;
 * missing cache fields are derived with the standard multipliers.
 */
export function resolvePrice(
  model: string,
  overrides?: PricingOverrides | Record<string, Partial<ModelPrice>>,
): ModelPrice | undefined {
  const id = String(model ?? "").toLowerCase();
  if (!id) return undefined;
  const base = bundledPrice(id);
  if (!overrides) return base;
  for (const [pattern, o] of Object.entries(overrides)) {
    if (!pattern || !id.includes(pattern.toLowerCase())) continue;
    const input = finite(o.input) ? o.input : base?.input;
    const output = finite(o.output) ? o.output : base?.output;
    if (input === undefined || output === undefined) return base;
    const merged: ModelPrice = {
      input,
      output,
      cacheWrite5m: finite(o.cacheWrite5m)
        ? o.cacheWrite5m
        : base && !finite(o.input)
          ? base.cacheWrite5m
          : input * 1.25,
      cacheWrite1h: finite(o.cacheWrite1h)
        ? o.cacheWrite1h
        : base && !finite(o.input)
          ? base.cacheWrite1h
          : input * 2,
      cacheRead: finite(o.cacheRead)
        ? o.cacheRead
        : base && !finite(o.input)
          ? base.cacheRead
          : input * 0.1,
      webSearch: finite(o.webSearch) ? o.webSearch : (base?.webSearch ?? WEB_SEARCH_PER_1K),
    };
    if (o.longContext) merged.longContext = o.longContext;
    else if (base?.longContext) merged.longContext = base.longContext;
    return merged;
  }
  return base;
}

type CallTokens = Pick<
  ApiCallRow,
  | "input_tokens"
  | "output_tokens"
  | "cache_create_5m"
  | "cache_create_1h"
  | "cache_read"
  | "web_searches"
  | "web_fetches"
>;

const tok = (n: number | null | undefined): number => (finite(n) ? n : 0);

/**
 * USD cost of one call. Thinking tokens are already counted in output_tokens.
 * Web fetches carry no per-request charge (standard token costs only).
 */
export function costOfCall(call: CallTokens, price: ModelPrice): CostBreakdown {
  const input = tok(call.input_tokens);
  const output = tok(call.output_tokens);
  const c5m = tok(call.cache_create_5m);
  const c1h = tok(call.cache_create_1h);
  const read = tok(call.cache_read);
  const searches = tok(call.web_searches);

  let p = price;
  const lc = price.longContext;
  if (lc && input + c5m + c1h + read > lc.threshold) {
    const ratio = price.input > 0 ? lc.input / price.input : 1;
    p = {
      ...price,
      input: lc.input,
      output: lc.output,
      cacheWrite5m: price.cacheWrite5m * ratio,
      cacheWrite1h: price.cacheWrite1h * ratio,
      cacheRead: price.cacheRead * ratio,
    };
  }

  const M = 1_000_000;
  const breakdown = {
    input: (input * p.input) / M,
    output: (output * p.output) / M,
    cacheWrite: (c5m * p.cacheWrite5m + c1h * p.cacheWrite1h) / M,
    cacheRead: (read * p.cacheRead) / M,
    tools: (searches / 1000) * (p.webSearch ?? 0),
  };
  return {
    ...breakdown,
    total:
      breakdown.input +
      breakdown.output +
      breakdown.cacheWrite +
      breakdown.cacheRead +
      breakdown.tools,
  };
}

/**
 * "$0.00" for zero, "<$0.0001" below a hundredth of a cent, four decimals trimmed to at
 * least two below $1 ("$0.0123", "$0.50"), two decimals below $1,000 ("$4.56"), and a
 * thousands separator with no decimals from $1,000 up ("$1,234"; 999.999 rounds there too).
 * The same function runs in the dashboard bundle, so keep it browser-safe.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v < 0.0001) return sign ? "-$0.0001" : "<$0.0001";
  if (v < 1) {
    const fixed = v.toFixed(4);
    if (fixed.startsWith("1")) return `${sign}$1.00`; // 0.99996 rounds up
    return `${sign}$${fixed.replace(/0+$/, "").replace(/\.(\d)$/, ".$10")}`;
  }
  const two = v.toFixed(2);
  if (Number(two) >= 1000) return `${sign}$${Math.round(v).toLocaleString("en-US")}`;
  return `${sign}$${two}`;
}

/** Same 4-chars-per-token estimate as src/stats/record.ts estTokens. */
export function estTokensFromChars(chars: number): number {
  return finite(chars) ? Math.ceil(chars / 4) : 0;
}
