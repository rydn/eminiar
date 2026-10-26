/**
 * 5-hour billing blocks (ccusage semantics): a block starts at the floor-to-UTC-
 * hour of the first call after the previous block closed; a call later than
 * block start + `hours` opens a new block. Gaps between blocks are reported.
 */

import type { ApiCallRow } from "../storage/types.js";

export interface Block {
  /** ISO timestamp of `start`. */
  id: string;
  /** Epoch ms, floored to the UTC hour of the first call. */
  start: number;
  /** Epoch ms, `start + hours`. */
  end: number;
  firstCall: number;
  lastCall: number;
  calls: number;
  tokens: { input: number; output: number; cacheCreate: number; cacheRead: number };
  costUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
  models: string[];
  active: boolean;
  /** Ms between the previous block's last call and this block's first call. */
  gapBefore?: number;
}

const HOUR = 3_600_000;

function floorToHour(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

function newBlock(call: ApiCallRow, hours: number): Block {
  const start = floorToHour(call.ts);
  return {
    id: new Date(start).toISOString(),
    start,
    end: start + hours * HOUR,
    firstCall: call.ts,
    lastCall: call.ts,
    calls: 0,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    costUsd: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    models: [],
    active: false,
  };
}

function addCall(block: Block, call: ApiCallRow): void {
  block.calls += 1;
  block.lastCall = Math.max(block.lastCall, call.ts);
  block.tokens.input += call.input_tokens || 0;
  block.tokens.output += call.output_tokens || 0;
  block.tokens.cacheCreate += (call.cache_create_5m || 0) + (call.cache_create_1h || 0);
  block.tokens.cacheRead += call.cache_read || 0;
  if (call.priced && call.cost_usd != null && Number.isFinite(call.cost_usd)) {
    block.costUsd += call.cost_usd;
    block.pricedCalls += 1;
  } else {
    block.unpricedCalls += 1;
  }
  if (call.model && !block.models.includes(call.model)) block.models.push(call.model);
}

export function billingBlocks(calls: ApiCallRow[], now = Date.now(), hours = 5): Block[] {
  // `<synthetic>` rows are Claude Code's own interruption messages, not billed calls.
  const sorted = calls
    .filter((c) => Number.isFinite(c.ts) && c.model !== "<synthetic>")
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const call of sorted) {
    if (!current || call.ts >= current.end) {
      const next = newBlock(call, hours);
      if (current) next.gapBefore = Math.max(0, call.ts - current.lastCall);
      blocks.push(next);
      current = next;
    }
    addCall(current, call);
  }
  for (const b of blocks) {
    b.models.sort();
    b.active = now >= b.start && now < b.end;
  }
  return blocks;
}

/** The block whose window contains `now`, if any. */
export function activeBlock(blocks: Block[], now = Date.now()): Block | undefined {
  return blocks.find((b) => now >= b.start && now < b.end);
}
