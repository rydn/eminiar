/**
 * Types of the swarm decision view (see swarm-decisions.ts). A leaf module: `export type` only, no
 * runtime imports and nothing node-typed, so the web dashboard (tsconfig.web.json, no node types)
 * can import them without pulling in redact.ts / savings.ts / env.ts.
 */

import type { EffortFollow } from "./effort.js";
import type { Tier } from "./types.js";

/** How the dispatch relates to the advice. */
export type DecisionFollow =
  /** the model that ran is the advised tier (passed by the call, or applied by apply mode) */
  | "followed"
  /** the call passed a model other than the advised tier */
  | "overrode"
  /** the agent's model pin was kept: the advice named no model */
  | "pinned"
  /** CLAUDE_CODE_SUBAGENT_MODEL_FORCE set the model: the advice was informational */
  | "forced"
  /** a fork runs on the main session's model: nothing to pass */
  | "fork"
  /** no dispatch yet, or the call passed no model and the advice was not applied */
  | "none";

export interface SwarmDecisionAdvice {
  /** The tier the advice names (clamped to apply.floor..ceiling, or the ranged pick). */
  model?: Tier | undefined;
  /** The raw verdict tier before clamping. */
  verdictTier?: string | undefined;
  effort?: string | undefined;
  complexity?: number | undefined;
  confidence?: number | undefined;
  /** The role the scorer suggested. */
  role?: string | undefined;
  /** The brief sums past the 0..4 clamp: its effort is informational. */
  saturated: boolean;
  /** Top complexity reasons, redacted and clipped (at most REASONS_MAX). */
  reasons: string[];
  /** Why no model is advised, when the agent's definition or env decides it. */
  pin: "pinned" | "unknown" | "ranged" | "none";
  /** The pinned model id (pinned) or the fallback (ranged). */
  pinnedModel?: string | undefined;
  /** A pin is kept: the advice did not move the model (pinDeferred). */
  pinDeferred: boolean;
  /** Set for a ranged role: its tiers and fallback. */
  range?: { floor: string; ceiling: string; fallback: string } | undefined;
  forced: boolean;
  fork: boolean;
  source?: string | undefined;
  /** The plan row id (or the agent row's, when no plan row exists). */
  rowId: number;
  ts: number;
}

export interface SwarmDecisionRan {
  /** The model the Agent call passed (`model`), as given. */
  requestedModel?: string | undefined;
  /** The model apply mode set / the hook settled on (null: none). */
  finalModel?: string | undefined;
  /** The model the subagent resolved to once it started (PostToolUse / reconcile). */
  actualModel?: string | undefined;
  /** What the agent would have run on without the adjudicator. */
  baselineModel?: string | undefined;
  /** The tier of the best-known model: actual, else final, else requested. */
  tier?: Tier | undefined;
  /** apply mode set the model (action applied). */
  applied: boolean;
  action?: string | undefined;
  /** The `effort` the Agent call passed. */
  effortPassed?: string | undefined;
  /** CLAUDE_CODE_EFFORT_LEVEL when it was set (outranks the call and the agent file). */
  effortEnv?: string | undefined;
  /** The effort that decides the run when known: env, else the one the hook applied, else the call's, else the agent file's. */
  effortEffective?: string | undefined;
  /** The effort the subagent actually ran at, read from its transcript calls (reconcile). */
  effortActual?: string | undefined;
  /** "applied": the hook set the advised effort on the call (it outranks the call's and the agent file's, not env). "agent-default": a session or model default whose level is unknown. */
  effortSource: "env" | "applied" | "call" | "agent-file" | "agent-default" | "fork";
  agentId?: string | undefined;
  outcome?: string | undefined;
  rowId: number;
  ts: number;
}

export interface SwarmDecision {
  taskId: number;
  /** Redacted, clipped to TITLE_MAX. */
  title: string;
  status: string;
  role?: string | undefined;
  agentId?: string | undefined;
  advice?: SwarmDecisionAdvice | undefined;
  /** Absent until the task's agent was dispatched. */
  ran?: SwarmDecisionRan | undefined;
  follow: DecisionFollow;
  /** Model: the tier advised differs from the tier that ran (only when both are known). */
  modelDiffers: boolean;
  /** Effort: the effort advised differs from the one that ran (only when both are known). */
  effortDiffers: boolean;
  /** Whether the subagent ran at the advised effort; absent when not counted. */
  effortFollow?: EffortFollow | undefined;
}
