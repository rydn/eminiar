/**
 * The time a hook run may take. Claude Code kills a hook at the `timeout` in hooks/hooks.json
 * and throws its output away ("timed out after 5s — output discarded"), so a run that is going
 * to be late is better answered in time without the optional work. Budgets sit under those
 * timeouts and leave room for Node's start-up and for writing the answer.
 *
 * Two limits work together:
 *  - the lock wait: every statement waits for another process's write lock, and the waits add
 *    up over a handler's statements, so a hook opens its database with a short one;
 *  - the deadline: `dispatch` answers without the handler when this budget runs out, and
 *    handlers skip optional stages when little of it is left.
 * A synchronous SQLite wait cannot be interrupted, so the deadline only bounds what yields;
 * the short lock wait is what bounds the rest.
 */

import { handlerEvent } from "./cursor.js";

/** Per statement; a locked database is skipped, not waited for (the default is 2000). */
export const HOOK_BUSY_TIMEOUT_MS = 250;

/**
 * Events whose whole job is a write (a ledger row, a snapshot, a capture) wait longer for the
 * lock: they have seconds to spare, and losing the write leaves a worker holding its slot.
 * 1500 ms fits the 5 s hooks; the 8-12 s hooks take 2000.
 */
const WRITE_WAIT: Record<string, number> = {
  SessionStart: 2000,
  PostToolUse: 2000,
  SubagentStart: 2000,
  PreCompact: 2000,
  SubagentStop: 1500,
  SessionEnd: 1500,
  Stop: 1500,
};

/** The lock wait for one hook run: short where the answer comes from reads, longer for writes. */
export function busyTimeoutFor(event: string | undefined, tool?: string): number {
  if (event && WRITE_WAIT[event]) return WRITE_WAIT[event];
  // A spawn is reserved in the swarm ledger before it is allowed, and a failed Agent call
  // releases it: a lost release holds the worker's slot until the reservation expires.
  if (
    (event === "PreToolUse" || event === "PostToolUseFailure") &&
    (tool === "Agent" || tool === "Task")
  )
    return 1500;
  return HOOK_BUSY_TIMEOUT_MS;
}

/**
 * The lock wait for one hook process, from its raw stdin and argv: the event as the handlers
 * will see it (a Cursor `sessionStart` waits as `SessionStart`). Bad JSON gets the short wait;
 * `dispatch` reports it.
 */
export function lockWaitFor(raw: string, argv: string[]): number {
  let parsed: Record<string, unknown> = {};
  try {
    const p: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch {
    // dispatch reports the bad JSON
  }
  const { event, tool } = handlerEvent(parsed, argv);
  return busyTimeoutFor(event, tool);
}

/** The default run budget: hooks with a 5 s timeout. */
export const HOOK_BUDGET_MS = 3500;

/** Events whose hooks.json timeout is longer. */
const LONGER: Record<string, number> = {
  SessionStart: 8000,
  PostToolUse: 8000,
  SubagentStart: 8000,
  PreCompact: 12000,
};

export function budgetFor(event: string | undefined): number {
  return (event && LONGER[event]) || HOOK_BUDGET_MS;
}

/** Unset until a run starts: a handler called outside `dispatch` (a test, a tool) has no limit. */
let startedAt: number | undefined;
let budgetMs = HOOK_BUDGET_MS;

/**
 * Start the clock for one run (`dispatch` calls this once per payload). The clock is
 * `performance.now()`, whose 0 is the process start: `dispatch` passes 0 from a hook process, so
 * the budget counts Node's boot and the stdin read too, as Claude Code's timeout does.
 */
export function startBudget(ms: number = HOOK_BUDGET_MS, now: number = performance.now()): void {
  startedAt = now;
  budgetMs = ms;
}

/** Forget the run: no budget applies until the next `startBudget`. */
export function clearBudget(): void {
  startedAt = undefined;
}

/** Milliseconds left in this run's budget (never negative); unlimited without a run. */
export function budgetLeft(now: number = performance.now()): number {
  if (startedAt === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, budgetMs - (now - startedAt));
}

/** Is there at least `needMs` left for an optional stage? */
export function hasBudget(needMs: number, now: number = performance.now()): boolean {
  return budgetLeft(now) >= needMs;
}
