/**
 * Thinking-effort facts of one dispatch: which level the advice named, which the call passed,
 * which the agent file sets, and which the subagent actually ran at (read from the api_calls
 * transcript rows), plus the follow verdict derived from them (#170).
 *
 * Everything lives in the row's scores JSON, so there is no schema change. Pure: the only runtime
 * import is ./types.js (a leaf), so storage, hooks, learn and swarm can all use it without
 * import cycles (learn.ts must not import swarm.ts, which already imports learn.ts).
 */

import type { ApiCallRow } from "../storage/types.js";
import { EFFORTS, type Effort } from "./types.js";

/** Scores-JSON key of an agent row: the `effort` the Agent call passed (a known level only). */
export const PASSED_EFFORT_FIELD = "passedEffort";
/** Scores-JSON key of an agent row: the effort the hook put on the call in apply mode (a known level only). */
export const EFFORT_APPLIED_FIELD = "effortApplied";
/** Scores-JSON key of an agent row: the CLAUDE_CODE_EFFORT_LEVEL in force (a known level only). */
export const EFFORT_ENV_FIELD = "effortEnv";
/** EFFORT_ENV_FIELD value when CLAUDE_CODE_EFFORT_LEVEL is set to something outside EFFORTS. */
export const EFFORT_ENV_OTHER = "other";
/** Scores-JSON key of an agent row: the agent file's frontmatter `effort` at dispatch (a known level only). */
export const AGENT_EFFORT_FIELD = "agentEffort";
/** Scores-JSON key of an agent or plan row: the effort the subagent ran at (dominant api_calls.effort). */
export const ACTUAL_EFFORT_FIELD = "actualEffort";
/** Scores-JSON key of an agent row: "followed" or "ignored"; absent means not counted. */
export const EFFORT_FOLLOW_FIELD = "effortFollow";

export type EffortFollow = "followed" | "ignored";

/** A known effort level (EFFORTS), lower-cased, or undefined: free text is never stored. */
export function effortLevel(v: unknown): Effort | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (EFFORTS as readonly string[]).includes(s) ? (s as Effort) : undefined;
}

/**
 * The effort most calls ran at: the mode of the known levels, skipping null and unknown values.
 * On a tie the level seen last wins (the later calls are the ones the subagent settled on).
 */
export function dominantEffort(calls: readonly Pick<ApiCallRow, "effort">[]): Effort | undefined {
  const seen = new Map<Effort, { n: number; last: number }>();
  calls.forEach((c, i) => {
    const e = effortLevel(c.effort);
    if (!e) return;
    const cur = seen.get(e);
    seen.set(e, { n: (cur?.n ?? 0) + 1, last: i });
  });
  let best: Effort | undefined;
  let bestN = 0;
  let bestLast = -1;
  for (const [e, s] of seen) {
    if (s.n > bestN || (s.n === bestN && s.last > bestLast)) {
      best = e;
      bestN = s.n;
      bestLast = s.last;
    }
  }
  return best;
}

export interface EffortFacts {
  /** The level the advice named (adjudication row's effort); a non-level counts as none. */
  advised?: string | null;
  /** The level the subagent ran at. */
  ran?: Effort;
  /** The level the Agent call passed. */
  passed?: Effort;
  /** The level the hook put on the call in apply mode; it overrides the call and the agent file. */
  applied?: Effort;
  /** The level the agent file's frontmatter sets; counts only when the call passed nothing. */
  agent?: Effort;
  /** CLAUDE_CODE_EFFORT_LEVEL was set (it outranks the call and the agent file). */
  env: boolean;
  /** A fork inherits the parent's effort; advice does not apply. */
  fork: boolean;
  /** The brief was saturated, so the advice was informational. */
  saturated: boolean;
}

/**
 * Did the subagent run at the advised effort? Not counted (undefined) when there was no advice,
 * the actual level is unknown, the dispatch was a fork, the env var overrode it, or the brief was
 * saturated. When the hook applied an effort (`applied`) it overrides the call and the agent file
 * and no model runs a different level than the one sent (a model without effort support records
 * no level, so `ran` is unknown), so the verdict is exact: followed iff it ran at the advised
 * level. Without `applied` (advise mode), followed when it ran at the advised level, or the effort
 * that was set for the call is the advised level (a model without that level runs the next one
 * down, so setting it is following): the passed level, or when nothing was passed, the agent
 * file's level (the hook tells the coordinator to pass nothing then). Passed wins when both
 * exist. Ignored otherwise.
 */
export function effortFollowOf(f: EffortFacts): EffortFollow | undefined {
  const advised = effortLevel(f.advised);
  if (!advised || !f.ran || f.fork || f.env || f.saturated) return undefined;
  if (f.applied) return f.ran === advised ? "followed" : "ignored";
  const set = f.passed ?? f.agent;
  return f.ran === advised || set === advised ? "followed" : "ignored";
}

export interface RowEffort {
  passed?: Effort;
  applied?: Effort;
  env?: Effort | typeof EFFORT_ENV_OTHER;
  agent?: Effort;
  actual?: Effort;
  follow?: EffortFollow;
}

function parseScores(
  scores: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (scores == null || scores === "") return {};
  let v: unknown = scores;
  if (typeof scores === "string") {
    try {
      v = JSON.parse(scores);
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Tolerant reader of the effort keys in a scores JSON: never throws, garbage reads as empty. */
export function rowEffort(scores: string | Record<string, unknown> | null | undefined): RowEffort {
  const o = parseScores(scores);
  if (!o) return {};
  const out: RowEffort = {};
  const passed = effortLevel(o[PASSED_EFFORT_FIELD]);
  if (passed) out.passed = passed;
  const applied = effortLevel(o[EFFORT_APPLIED_FIELD]);
  if (applied) out.applied = applied;
  const envRaw = o[EFFORT_ENV_FIELD];
  const env = effortLevel(envRaw);
  if (env) out.env = env;
  else if (envRaw === EFFORT_ENV_OTHER) out.env = EFFORT_ENV_OTHER;
  const agent = effortLevel(o[AGENT_EFFORT_FIELD]);
  if (agent) out.agent = agent;
  const actual = effortLevel(o[ACTUAL_EFFORT_FIELD]);
  if (actual) out.actual = actual;
  const follow = o[EFFORT_FOLLOW_FIELD];
  if (follow === "followed" || follow === "ignored") out.follow = follow;
  return out;
}

/**
 * Does the row record the dispatch facts effortFollowOf needs? A missing key reads as "absent"
 * (nothing passed, no env, no agent-file level), which is only true for a row the hook wrote after
 * those keys existed: a row reconciled before then has no keys and the verdict would be a guess
 * (a legacy dispatch under CLAUDE_CODE_EFFORT_LEVEL, or one that passed the advised level, would
 * read "ignored" where today's rows read not counted or "followed"). The hook writes a key only
 * when it has a value, so there is no marker for "recorded, all empty"; the keys that prove it are
 * effortApplied and agentEffort (written together with the rest), passedEffort and effortEnv
 * (a passed level wins over the agent file, and env is written beside it). A row with none of
 * them is treated as legacy by the backfill: it gets actualEffort but no effortFollow.
 */
export function effortFactsRecorded(e: RowEffort): boolean {
  return (
    e.applied !== undefined ||
    e.agent !== undefined ||
    e.passed !== undefined ||
    e.env !== undefined
  );
}

/**
 * Scores JSON with actualEffort and effortFollow merged into a copy (null scores start from {}).
 * effortFollow is removed when `follow` is undefined; actualEffort is left as it was when `actual`
 * is undefined. Returns undefined when the scores do not parse to an object. Key order is kept, so
 * the same input gives the same string.
 */
export function withEffortScores(
  scores: string | Record<string, unknown> | null | undefined,
  v: { actual?: Effort; follow?: EffortFollow },
): string | undefined {
  const o = parseScores(scores);
  if (!o) return undefined;
  const out: Record<string, unknown> = { ...o };
  if (v.actual) out[ACTUAL_EFFORT_FIELD] = v.actual;
  if (v.follow) out[EFFORT_FOLLOW_FIELD] = v.follow;
  else delete out[EFFORT_FOLLOW_FIELD];
  return JSON.stringify(out);
}
