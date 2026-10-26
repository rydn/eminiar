/**
 * Price eminiar's own savings: the stats table records, per session and em_*
 * tool, how many characters the tool looked at (raw_chars) versus what went
 * back to the model (returned_chars). Every token kept out of context is a
 * token not written to cache on that turn and not re-read on every later turn.
 */

import type { ApiCallRow, StatRow } from "../storage/types.js";
import {
  estTokensFromChars,
  type ModelPrice,
  type PricingOverrides,
  resolvePrice,
} from "./pricing.js";

export const FALLBACK_MODEL = "claude-sonnet-5-5";

export interface PricedSavings {
  /** Tokens kept out of context across all stat rows. */
  savedTokens: number;
  /** savedTokens priced at the 5-minute cache-write rate (first entry into context). */
  directUsd: number;
  /** savedTokens re-read at the cache-read rate on every later call of the session. */
  compoundingUsd: number;
  /** Average number of later calls credited per stat row's session. */
  laterCallsPerSession: number;
  /** Dominant model across `calls` (by call count), or the fallback. */
  model: string;
  assumptions: string[];
}

function dominantModel(calls: ApiCallRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of calls) {
    if (!c.model) continue;
    counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

export interface SavingsOptions {
  /**
   * Epoch ms of the window the `calls` were filtered to. Stat rows carry no timestamp, so
   * with a window only the rows of sessions that have a call inside it are counted.
   */
  since?: number | undefined;
}

export function pricedSavings(
  stats: StatRow[],
  calls: ApiCallRow[],
  overrides?: PricingOverrides,
  opts: SavingsOptions = {},
): PricedSavings {
  const assumptions = [
    "Saved tokens = ceil(raw_chars / 4) - ceil(returned_chars / 4) per stat row, floored at 0 (same estimate as em_stats).",
    "Direct savings price saved tokens at the 5-minute cache-write rate: a tool result enters context once and is written to cache on that turn.",
    "Compounding savings price saved tokens at the cache-read rate once per later API call in the same session; stat rows carry no timestamps, so half of the session's calls are taken as the expected number of later calls.",
    "Sessions with no recorded API calls earn no compounding savings.",
  ];

  const global = dominantModel(calls);
  let fallbackUsed = false;
  const priceFor = (model: string | undefined): { model: string; price: ModelPrice } => {
    const m = model ?? global;
    const p = m ? resolvePrice(m, overrides) : undefined;
    if (m && p) return { model: m, price: p };
    fallbackUsed = true;
    const fb = resolvePrice(FALLBACK_MODEL, overrides) ?? resolvePrice(FALLBACK_MODEL);
    return { model: FALLBACK_MODEL, price: fb as ModelPrice };
  };

  const bySession = new Map<string, ApiCallRow[]>();
  for (const c of calls) {
    const list = bySession.get(c.session_id);
    if (list) list.push(c);
    else bySession.set(c.session_id, [c]);
  }
  const sessionModel = new Map<string, string | undefined>();
  for (const [sid, rows] of bySession) sessionModel.set(sid, dominantModel(rows));

  const windowed = opts.since !== undefined;
  assumptions.push(
    windowed
      ? `Savings cover sessions active in the window (since ${new Date(opts.since as number).toISOString()}): stat rows carry no timestamps, so rows of sessions without an API call in the window are left out.`
      : "All-time: every stat row of the project is counted.",
  );

  let savedTokens = 0;
  let directUsd = 0;
  let compoundingUsd = 0;
  const laterBySession = new Map<string, number>();
  for (const row of stats) {
    if (windowed && !bySession.has(row.session_id)) continue;
    const saved = Math.max(
      0,
      estTokensFromChars(row.raw_chars) - estTokensFromChars(row.returned_chars),
    );
    if (saved === 0) continue;
    savedTokens += saved;
    const { price } = priceFor(sessionModel.get(row.session_id));
    directUsd += (saved * price.cacheWrite5m) / 1_000_000;
    const later = (bySession.get(row.session_id)?.length ?? 0) / 2;
    laterBySession.set(row.session_id, later);
    compoundingUsd += (saved * price.cacheRead * later) / 1_000_000;
  }

  const laterValues = [...laterBySession.values()];
  const laterCallsPerSession =
    laterValues.length > 0 ? laterValues.reduce((a, b) => a + b, 0) / laterValues.length : 0;

  const model = global ?? FALLBACK_MODEL;
  if (!global) assumptions.push(`No API calls recorded; priced at ${FALLBACK_MODEL} list prices.`);
  else
    assumptions.push(
      `Each session is priced at its own dominant model (by calls); ${model} overall.`,
    );
  if (fallbackUsed && global)
    assumptions.push(`Some sessions had no priceable model and were priced at ${FALLBACK_MODEL}.`);

  return { savedTokens, directUsd, compoundingUsd, laterCallsPerSession, model, assumptions };
}
