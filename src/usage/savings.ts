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

/**
 * Tools whose `raw_chars` is output that really was produced and then kept out of context
 * (sandbox stdout/stderr, fetched pages). Every other tool (search, docs, graph, symbols,
 * history) records a counterfactual: the bytes a native Read/Grep/git call might have
 * returned, such as every file a graph answer touches or every whole chunk a search hit.
 */
const MEASURED_TOOLS: ReadonlySet<string> = new Set([
  "em_execute",
  "em_execute_file",
  "em_batch_execute",
  "em_fetch_and_index",
]);

export type SavingsKind = "measured" | "counterfactual";

/** Whether a tool's savings are measured output or a counterfactual estimate. */
export function savingsKind(tool: string): SavingsKind {
  return MEASURED_TOOLS.has(tool) ? "measured" : "counterfactual";
}

export interface SavingsSplit {
  /** Estimated tokens of execution output that was produced and kept out of context. */
  measuredTokens: number;
  /** Estimated tokens a native call might have returned for knowledge-tool answers. */
  counterfactualTokens: number;
}

type SplitRow = Pick<StatRow, "tool" | "raw_chars" | "returned_chars">;

/**
 * The one netting rule behind every saved-token figure (em_stats, the statusline, the
 * dashboard, em_usage): ceil(raw / 4) - ceil(returned / 4) per stat row, floored at 0. A row
 * that returned more than it read (em_symbols and em_reindex record raw 0) adds nothing and
 * takes nothing away from the other rows. Session, project and dashboard totals net per
 * (session, tool) row; the lifetime figure nets per tool, because global.db keeps one
 * lifetime row per tool, so it can differ slightly from the project total (about 0.1 percent
 * on real data).
 */
export function rowSavedTokens(r: Pick<StatRow, "raw_chars" | "returned_chars">): number {
  return Math.max(0, estTokensFromChars(r.raw_chars) - estTokensFromChars(r.returned_chars));
}

/**
 * Split saved tokens into measured and counterfactual savings, from the stat rows already
 * recorded (no new data), with the same per-row rule as every total, so the two kinds add up
 * to the total shown next to them.
 */
export function splitSavings(rows: SplitRow[]): SavingsSplit {
  const saved = { measured: 0, counterfactual: 0 };
  for (const r of rows) saved[savingsKind(r.tool)] += rowSavedTokens(r);
  return { measuredTokens: saved.measured, counterfactualTokens: saved.counterfactual };
}

export interface PricedSavings {
  /** Tokens kept out of context across all stat rows (an estimate: chars / 4). */
  savedTokens: number;
  /** Part of savedTokens from execution output that was really produced and kept out. */
  measuredTokens: number;
  /** Part of savedTokens from knowledge tools, measured against a native-call counterfactual. */
  counterfactualTokens: number;
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
    "Measured savings come from execution tools (em_execute, em_execute_file, em_batch_execute, em_fetch_and_index): output that was produced and kept out of context. Counterfactual savings come from search, docs, graph, symbol and history tools: what a native Read, Grep or git call might have returned, such as every file a graph answer touches, so they can overstate.",
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
  let measuredTokens = 0;
  let directUsd = 0;
  let compoundingUsd = 0;
  const laterBySession = new Map<string, number>();
  for (const row of stats) {
    if (windowed && !bySession.has(row.session_id)) continue;
    const saved = rowSavedTokens(row);
    if (saved === 0) continue;
    savedTokens += saved;
    if (savingsKind(row.tool) === "measured") measuredTokens += saved;
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

  return {
    savedTokens,
    measuredTokens,
    counterfactualTokens: savedTokens - measuredTokens,
    directUsd,
    compoundingUsd,
    laterCallsPerSession,
    model,
    assumptions,
  };
}
