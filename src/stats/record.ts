import type { ProjectContext } from "../context.js";
import { getCurrentSession } from "../session/current.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type { StatRow } from "../storage/types.js";
import { rowSavedTokens } from "../usage/savings.js";
import { globalDb } from "./global.js";

export const estTokens = (chars: number): number => Math.ceil(chars / 4);

/**
 * Record one tool call: `raw` is what the tool had to look at (full output, page,
 * file), `returned` is what went back to the model. Both the project DB (per
 * session) and the global DB (lifetime) are updated.
 */
export function recordStat(
  ctx: ProjectContext,
  tool: string,
  d: { rawChars: number; returnedChars: number; durationMs: number },
): void {
  // Deferred past the current I/O phase: the handler's reply is serialised and
  // written to stdout before these two commits run, so they never add to latency.
  setImmediate(() => {
    try {
      getStorage(ctx).statRecord(getCurrentSession(ctx), tool, d);
      globalDb().record(tool, d);
    } catch {
      // stats must never break a tool call
    }
  });
}

/**
 * Bytes Claude would have read to learn the same thing by hand: the size of every
 * indexed file a graph answer points at. Lets graph/symbol tools report real savings.
 */
export function fileBytes(db: StorageAdapter, paths: Iterable<string | null | undefined>): number {
  let total = 0;
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    total += db.fileIndexGet(p)?.size ?? 0;
  }
  return total;
}

export interface StatSummary {
  calls: number;
  rawTokens: number;
  returnedTokens: number;
  savedTokens: number;
  efficiency: number;
  durationMs: number;
}

export function summarize(rows: StatRow[]): StatSummary {
  const calls = rows.reduce((a, r) => a + r.calls, 0);
  const raw = rows.reduce((a, r) => a + r.raw_chars, 0);
  const ret = rows.reduce((a, r) => a + r.returned_chars, 0);
  const rawTokens = estTokens(raw);
  const returnedTokens = estTokens(ret);
  // per row, like splitSavings and pricedSavings: one total everywhere
  const savedTokens = rows.reduce((a, r) => a + rowSavedTokens(r), 0);
  return {
    calls,
    rawTokens,
    returnedTokens,
    savedTokens,
    efficiency: rawTokens ? savedTokens / rawTokens : 0,
    durationMs: rows.reduce((a, r) => a + r.duration_ms, 0),
  };
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
