/**
 * Swarm plan advice (docs/design/adjudicator.md §16): after `em_swarm plan` adds its tasks, ONE
 * batched adjudication scores them all, stores a `plan` row per task keyed by (run, task), and
 * returns one suggestion line per task for the coordinator: the agent to spawn, the `model` and
 * `effort` to pass on the Agent call, plus a note when the scorer would pick a different role than
 * the plan did. An agent whose definition pins a model (or whose pin cannot be read) keeps it, like
 * apply mode: the line names the pin and what the adjudicator would pick, never a model to pass.
 *
 * What a suggestion tells the coordinator to pass follows ONE rule table, dispatchRule, shared
 * with the PreToolUse(Agent) note (hooks.ts onPreAgent) and the plan's "Next:" line (em_swarm):
 * a fork names neither `model` nor `effort`; under CLAUDE_CODE_SUBAGENT_MODEL_FORCE the model is
 * informational; a ranged agent (swarm.yaml `model_range`) gets the pick inside its range; a
 * respected pin is kept (pass no `model`); CLAUDE_CODE_EFFORT_LEVEL, an `effort` already on the
 * call, or a saturated brief makes the effort informational. In apply mode the hook sets the
 * effort itself (`effort X (applied by the hook)`), so the coordinator passes none.
 *
 * Everything here is a no-op while the adjudicator is off or `surfaces.plan` is false, and it
 * never throws: the plan is already committed when this runs, so a scoring failure costs the
 * advice, never the plan (the error goes to `log` and `onError`).
 */

import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { ModelRange, RunRow, SwarmSpec, TaskRow } from "../swarm/types.js";
import { type AgentPin, resolveAgentPin } from "./agent-pin.js";
import { effortLevel } from "./effort.js";
import { type Adjudication, adjudicate, type EngineOptions } from "./engine.js";
import { subagentModelForced } from "./env.js";
import { complexityBucket, topIntent } from "./heuristic.js";
import { biasFromRows, type LearningConfig } from "./learn.js";
import {
  ADVISED_PICK_FIELD,
  FALLBACK_PIN_FIELD,
  isPinned,
  type KeptModel,
  RANGED_FLAG,
  tierOf,
  tierRank,
  withKeptModel,
} from "./savings.js";
// Types only: this file is loaded by the hooks, which never load security/* while it is off.
import type { PlanAnswer, PlanSecurityResult } from "./security/assess.js";
import type { SecurityHint } from "./security/types.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  AGENT_EFFORT_SINCE,
  TIERS,
  type Tier,
} from "./types.js";

/** Text of one task sent to the scorer (title + detail), before redaction and the provider cap. */
const TASK_TEXT_MAX = 4000;

/** Plan advice runs: the adjudicator is enabled and its plan surface is on. */
export function planAdviceEnabled(config: Pick<Config, "adjudicator">): boolean {
  const a = config.adjudicator;
  return !!a?.enabled && a.surfaces.plan !== false;
}

/** The env flag that makes Claude Code ignore `model` on the Agent call (Claude Code's on/off rule). */
export function modelForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return subagentModelForced(env);
}

/**
 * What the advice for one Agent call tells the coordinator to pass (docs/adjudicator.md "What the
 * advice tells you to pass"). Checked against code.claude.com/docs/en/sub-agents.md:
 *
 *   dispatch                         model                         effort
 *   fork (subagent_type "fork")      fork: runs on the main        fork: per-call effort is for
 *                                    session's model               non-fork subagents only
 *   CLAUDE_CODE_SUBAGENT_MODEL_FORCE forced: informational (the    per the effort rule
 *                                    call's model and pins are
 *                                    ignored)
 *   ranged (swarm.yaml model_range)  ranged: pass the pick inside  per the effort rule
 *                                    the role's range ∩ apply
 *                                    floor..ceiling (rangedTier)
 *   pin respected (pinned/unknown)   pin: pass no `model`          per the effort rule
 *   otherwise                        pass                          per the effort rule
 *
 * A ranged agent whose pick is its fallback's tier, or whose range does not meet the apply
 * bounds, passes no `model`: it keeps its fallback pin, so it takes the `pin` row (passing the
 * bare tier would swap a pinned model id or [1m] variant for the alias).
 * Effort rule: in apply mode (effortApply) the hook sets the advised effort itself, whatever the
 * call or the agent file says, so nothing is passed: `applied`, unless CLAUDE_CODE_EFFORT_LEVEL is
 * set (it outranks the hook: informational). In advise mode: CLAUDE_CODE_EFFORT_LEVEL set, `effort`
 * already on the call (the env outranks the call), or a saturated brief (units.ts) →
 * informational; else pass `effort` (Claude Code AGENT_EFFORT_SINCE+). A model other than `pass`
 * or `ranged` is never credited with savings (savings.ts KeptModel).
 */
export interface DispatchRule {
  model: "pass" | "ranged" | "pin" | "forced" | "fork";
  effort: "pass" | "applied" | "informational" | "fork";
}

export interface DispatchFacts {
  fork?: boolean | undefined;
  /** CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on. */
  forced: boolean;
  /**
   * The agent has a model range respected under apply.respectFrontmatter, and its pick inside
   * the range is a tier other than its fallback's (else it is a kept pin: `pin`).
   */
  ranged?: boolean | undefined;
  /** The agent's pin (pinned or unknown) is respected under apply.respectFrontmatter. */
  pin?: boolean | undefined;
  /**
   * CLAUDE_CODE_EFFORT_LEVEL is set, or the call already passes `effort`. With `effortApply` only
   * the env counts (the hook's effort wins over the call's), so the caller passes just that.
   */
  effortSet: boolean;
  /** The brief sums past the 0..4 clamp (units.ts BriefUnits.saturated). */
  saturated?: boolean | undefined;
  /** Apply mode in scope with a valid advised effort: the hook sets `effort` on the call. */
  effortApply?: boolean | undefined;
}

export function dispatchRule(f: DispatchFacts): DispatchRule {
  if (f.fork) return { model: "fork", effort: "fork" };
  return {
    model: f.forced ? "forced" : f.ranged ? "ranged" : f.pin ? "pin" : "pass",
    effort: f.effortApply
      ? f.effortSet
        ? "informational"
        : "applied"
      : f.effortSet || f.saturated
        ? "informational"
        : "pass",
  };
}

/** A role note ("role suggested: …") needs at least this role-table confidence. */
export const ROLE_NOTE_MIN = 0.7;

/**
 * The tier a ranged agent's advice picks: `tier` clamped to the role's range ∩ the apply bounds
 * (`floor`..`ceiling`, read like hooks.ts clampTier). Undefined when `tier` is not on the ladder
 * or the two do not meet; the agent then keeps its fallback.
 */
export function rangedTier(
  tier: string | undefined,
  range: ModelRange,
  floor: Tier,
  ceiling: Tier,
): Tier | undefined {
  const r = tierRank(tier);
  const applyLo = tierRank(floor);
  const lo = Math.max(tierRank(range.floor), applyLo);
  const hi = Math.min(tierRank(range.ceiling), Math.max(applyLo, tierRank(ceiling)));
  if (r < 0 || lo < 0 || lo > hi) return undefined;
  return TIERS[Math.min(hi, Math.max(lo, r))];
}

/** The whole tier ladder as a range: rangedTier over it is hooks.ts clampTier. */
const LADDER: ModelRange = { floor: TIERS[0], ceiling: TIERS[TIERS.length - 1] as Tier };

/**
 * The tier a non-ranged agent's advice names: `tier` clamped to apply.floor..ceiling (a floor
 * above the ceiling wins), the same tier hooks.ts onPreAgent's note names (clampTier), so a plan
 * line, the Agent note and follow detection (savings.ts advisedPick) agree. Undefined when `tier`
 * is not on the ladder.
 */
export function appliedTier(
  tier: string | undefined,
  floor: Tier,
  ceiling: Tier,
): Tier | undefined {
  return rangedTier(tier, LADDER, floor, ceiling);
}

/** A ranged pick changes the model: it is a tier, and not the fallback's. */
export function rangedPasses(pick: Tier | undefined, fallback: string): pick is Tier {
  return !!pick && pick !== tierOf(fallback);
}

/**
 * The model part of a ranged agent's line or note: "model haiku (range haiku–opus, fallback
 * sonnet)" when the pick moves the model, else the kept fallback and why.
 */
export function rangedPart(range: PlanRange, pick: Tier | undefined): string {
  const span = `range ${range.floor}–${range.ceiling}`;
  if (rangedPasses(pick, range.fallback))
    return `model ${pick} (${span}, fallback ${range.fallback})`;
  return pick
    ? `fallback ${range.fallback} (${span}; matches the adjudicator's pick)`
    : `fallback ${range.fallback} (${span}; no pick inside apply.floor..ceiling)`;
}

/** The row flag (savings.ts KeptModel) of a rule whose model the advice does not name. */
export function keptModelOf(rule: DispatchRule): KeptModel | undefined {
  return rule.model === "pin"
    ? "pin"
    : rule.model === "forced"
      ? "force"
      : rule.model === "fork"
        ? "fork"
        : undefined;
}

/**
 * The agent's model pin as plan advice respects it: `pinned` (with the model) or `unknown` (the
 * definition cannot be read with certainty). Absent when the agent is unpinned or
 * apply.respectFrontmatter is off; then the model is advised as usual.
 */
export interface PlanPin {
  status: "pinned" | "unknown";
  model?: string | undefined;
  source?: AgentPin["source"];
}

/**
 * A ranged agent's model range (resolveAgentPin status ranged) as plan advice respects it: the
 * role's tiers and the fallback its agent file pins. Absent under FORCE or with
 * apply.respectFrontmatter off.
 */
export interface PlanRange extends ModelRange {
  fallback: string;
  source?: AgentPin["source"];
}

export interface PlanAdvice {
  taskId: number;
  /** The planned role, if any. */
  role?: string | undefined;
  /** The scorer's role, when it is a role of the swarm. */
  suggestedRole?: string | undefined;
  /** subagent_type to spawn: the planned role's agent, else the suggested role's. */
  agentType?: string | undefined;
  /**
   * Always one of the Agent `model` values (haiku | sonnet | opus | fable), or undefined: the
   * verdict clamped to apply.floor..ceiling (appliedTier), with `range` the pick inside it too
   * (rangedTier). The plan row's raw verdict stays in its `tier`.
   */
  model?: Tier | undefined;
  effort: string;
  complexity: number;
  confidence: number;
  rowId?: number | undefined;
  /** Set when the agent's model pin is respected: the line then names it instead of `model`. */
  pin?: PlanPin | undefined;
  /** Set for a ranged agent: `model` is passed only when its tier differs from the fallback's. */
  range?: PlanRange | undefined;
  /** CLAUDE_CODE_SUBAGENT_MODEL_FORCE was on: the model is informational and no pin is named. */
  forced?: boolean | undefined;
  /** The role table's confidence: the role note shows from ROLE_NOTE_MIN (none when unknown). */
  roleConfidence?: number | undefined;
  /** The brief sums past the 0..4 clamp (units.ts): its effort is informational. */
  saturated?: boolean | undefined;
  /** The security floor raised `model` (a HIGH or CRITICAL task never names a smaller tier). */
  floored?: boolean | undefined;
  /**
   * Apply mode will set `effort` on this task's dispatch (the hook wins over the call and the
   * agent file), so the coordinator passes none. Unset in advise mode and under
   * CLAUDE_CODE_EFFORT_LEVEL.
   */
  effortApplied?: boolean | undefined;
  /**
   * Every role of the swarm pins a model without a range (pins respected, FORCE off), so the
   * adjudicator cannot change any worker's model: the same on every suggestion of one plan.
   */
  allRolesPinned?: boolean | undefined;
}

/**
 * The security half of a plan (em_swarm builds it from planSecurity/finishPlan; this file only
 * loads their types): `hints[i]` rides on task i's engine request as hints.security, and `finish`
 * turns the engine's answers into the assessed plan, whose tierFor floors the advised model.
 */
export interface PlanSecurityHook {
  hints: ReadonlyArray<SecurityHint | undefined>;
  finish(answers: ReadonlyArray<PlanAnswer | undefined>): PlanSecurityResult;
}

/** What a plan line says about a model the security floor raised (advice.ts FLOOR_LABEL). */
export const SECURITY_FLOOR_LABEL = "security floor";

export interface PlanOptions {
  /** Test seam / long-lived instance; null forces the heuristic. */
  provider?: AdjudicatorProvider | null | undefined;
  sessionId?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
  /** Called when the advice fails (after `log`): the caller can say the advice is unavailable. */
  onError?: ((err: unknown) => void) | undefined;
  /** Security advice is on: ask its questions and floor the advised model on HIGH and CRITICAL. */
  security?: PlanSecurityHook | undefined;
}

/**
 * The request for one planned task. `security` (the task's hint, set only while security.model is
 * "provider") adds the security questions; without it the request is what it always was.
 */
export function taskRequest(
  task: TaskRow,
  swarm: SwarmSpec,
  security?: SecurityHint,
): AdjudicationRequest {
  const text = [task.title, task.detail ?? ""].join("\n").trim().slice(0, TASK_TEXT_MAX);
  const hints: NonNullable<AdjudicationRequest["hints"]> = {
    roles: swarm.roles.map((r) => ({ name: r.role, description: r.description })),
    files: task.files.length,
    deps: task.deps.length,
  };
  if (task.role) hints.role = task.role;
  if (security) hints.security = security;
  return { key: `#${task.id}`, surface: "plan", text, hints };
}

/**
 * The engine's per-request bias from the learned buckets (learn.ts), read once per batch;
 * undefined when learning is off or nothing has been learned yet.
 */
export function learnedBias(db: StorageAdapter, cfg: Config["adjudicator"]): EngineOptions["bias"] {
  if (!cfg.learning.enabled) return undefined;
  let rows: ReturnType<StorageAdapter["adjudicator"]["biasAll"]>;
  try {
    rows = db.adjudicator.biasAll();
  } catch {
    return undefined;
  }
  if (!rows.length) return undefined;
  const learning = cfg.learning as LearningConfig;
  return (_req, f, h) =>
    biasFromRows(rows, learning, { complexity: h.complexity, intent: topIntent(f) ?? "none" });
}

const asTier = (s: string | undefined): Tier | undefined =>
  (TIERS as readonly string[]).includes(s ?? "") ? (s as Tier) : undefined;

/** The pin plan advice respects for `agentType`, or undefined (unpinned / not respected). */
export function respectedPin(
  agentType: string | undefined,
  respectFrontmatter: boolean,
  lookup: (type: string) => AgentPin,
): PlanPin | undefined {
  if (!agentType || !respectFrontmatter) return undefined;
  const pin = lookup(agentType);
  if (pin.status === "pinned" && isPinned(pin.model))
    return { status: "pinned", model: pin.model, source: pin.source };
  if (pin.status === "unknown") return { status: "unknown", source: pin.source };
  return undefined;
}

/** The model range plan advice respects for `agentType`, or undefined (no range / not respected). */
export function respectedRange(
  agentType: string | undefined,
  respectFrontmatter: boolean,
  lookup: (type: string) => AgentPin,
): PlanRange | undefined {
  if (!agentType || !respectFrontmatter) return undefined;
  const pin = lookup(agentType);
  if (pin.status !== "ranged" || !pin.range || !isPinned(pin.model)) return undefined;
  return {
    floor: pin.range.floor,
    ceiling: pin.range.ceiling,
    fallback: pin.model,
    source: pin.source,
  };
}

/** A ranged suggestion that passes a model (its pick is not the fallback's tier). */
const rangedPass = (a: PlanAdvice): boolean => !!a.range && rangedPasses(a.model, a.range.fallback);

/** The dispatchRule facts of one suggestion; a ranged agent that passes nothing keeps its pin. */
function adviceFacts(a: PlanAdvice, forced: boolean, effortSet: boolean): DispatchFacts {
  const ranged = rangedPass(a);
  return {
    forced: forced || !!a.forced,
    ranged,
    pin: !!a.pin || (!!a.range && !ranged),
    effortSet,
    saturated: !!a.saturated,
    effortApply: !!a.effortApplied,
  };
}

function adviceOf(a: Adjudication, task: TaskRow, swarm: SwarmSpec): PlanAdvice {
  const v = a.verdict;
  const roles = new Map(swarm.roles.map((r) => [r.role, r]));
  const suggested = roles.has(v.role.choice) ? v.role.choice : undefined;
  const planned = task.role ?? undefined;
  const agentType = roles.get(planned ?? suggested ?? "")?.agentType;
  const advice: PlanAdvice = {
    taskId: task.id,
    role: planned,
    suggestedRole: suggested,
    agentType,
    model: asTier(v.tier.choice),
    effort: v.effort,
    complexity: v.complexity,
    confidence: v.tier.confidence,
    rowId: a.rowId,
    roleConfidence: v.role.confidence,
  };
  if (a.units?.saturated) advice.saturated = true;
  return advice;
}

/**
 * Score the tasks one plan call added, in ONE engine call (one batched provider request within
 * `timeouts.planMs`; the heuristic on any failure), and store a `plan` row per task by
 * (run, task). Returns [] when plan advice is off or nothing could be scored.
 */
export async function adjudicatePlan(
  ctx: Pick<ProjectContext, "config" | "root">,
  db: StorageAdapter,
  run: RunRow,
  swarm: SwarmSpec,
  tasks: readonly TaskRow[],
  opts: PlanOptions = {},
): Promise<PlanAdvice[]> {
  if (!tasks.length || !planAdviceEnabled(ctx.config)) return [];
  try {
    const cfg = ctx.config.adjudicator;
    const reqs = tasks.map((t, i) => taskRequest(t, swarm, opts.security?.hints[i]));
    const engine: EngineOptions = {
      config: cfg,
      store: db.adjudicator,
      context: "server",
      call: "inline",
      budgetMs: cfg.timeouts.planMs,
      row: {
        runId: run.id,
        sessionId: opts.sessionId ?? run.session_id ?? null,
        action: "advised",
      },
      rows: tasks.map((t) => ({ taskId: t.id })),
      roles: swarm.roles.map((r) => ({ name: r.role, description: r.description })),
      bias: learnedBias(db, cfg),
      projectRoot: ctx.root,
    };
    if (opts.provider !== undefined) engine.provider = opts.provider;
    if (opts.env) engine.env = opts.env;
    if (opts.now) engine.now = opts.now;
    if (opts.log) engine.log = opts.log;
    const out = await adjudicate(reqs, engine);
    // Security: blend the model's answers, store the plan rows, and get the floor (a failure
    // here costs the security block, never the routing advice).
    let secured: PlanSecurityResult | undefined;
    if (opts.security) {
      try {
        secured = opts.security.finish(
          out.map((a) => ({
            security: a.verdict.security,
            provider: a.verdict.provider,
            providerStatus: a.verdict.providerStatus,
            rowId: a.rowId,
          })),
        );
      } catch (err) {
        opts.log?.(`adjudicator: plan security skipped: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    // One pin lookup per agent type (the swarm's generated agents, usually a handful).
    const env = opts.env ?? process.env;
    const pins = new Map<string, AgentPin>();
    const lookup = (type: string): AgentPin => {
      let p = pins.get(type);
      if (!p) {
        p = resolveAgentPin(type, { root: ctx.root, cwd: ctx.root, env });
        pins.set(type, p);
      }
      return p;
    };
    // Under FORCE Claude Code ignores the agents' `model` too: no pin to name (dispatchRule).
    const forced = modelForced(env);
    const respect = cfg.apply.respectFrontmatter;
    // onPreAgent returns early when surfaces.agent is off, so then the hook sets nothing.
    const applyEffort = cfg.mode === "apply" && cfg.surfaces.agent !== false && !effortForced(env);
    // Every role keeps a plain pin: no suggestion can change a worker's model (the head says so).
    const allRolesPinned =
      !forced &&
      respect &&
      swarm.roles.length > 0 &&
      swarm.roles.every((r) => lookup(r.agentType).status === "pinned");
    return out.map((a, i) => {
      const advice = adviceOf(a, tasks[i] as TaskRow, swarm);
      const verdict = advice.model;
      // The tier the Agent note names (forced and pinned lines included): clamped to the apply bounds.
      advice.model = appliedTier(verdict, cfg.apply.floor, cfg.apply.ceiling);
      if (forced) advice.forced = true;
      else {
        const range = respectedRange(advice.agentType, respect, lookup);
        if (range) {
          advice.range = range;
          advice.model = rangedTier(verdict, range, cfg.apply.floor, cfg.apply.ceiling);
        } else {
          const pin = respectedPin(advice.agentType, respect, lookup);
          if (pin) advice.pin = pin;
        }
      }
      // The security floor goes before the row is marked: the row's advised pick and the line
      // both name the floored tier.
      const floor = secured?.tierFor(i, advice.model);
      if (floor?.floored) {
        advice.model = floor.tier;
        advice.floored = true;
      }
      if (allRolesPinned) advice.allRolesPinned = true;
      // Apply mode: the hook sets the effort at dispatch, so the coordinator is told to pass none
      // (CLAUDE_CODE_EFFORT_LEVEL outranks the hook: then the effort stays informational).
      if (applyEffort && effortLevel(advice.effort)) advice.effortApplied = true;
      markPlanRow(db, advice);
      return advice;
    });
  } catch (err) {
    opts.log?.(`adjudicator: plan advice skipped: ${(err as Error)?.message ?? String(err)}`);
    opts.onError?.(err);
    return [];
  }
}

/**
 * Store the KeptModel flag on the task's plan row (and the pin under `pin`), so a plan row that no
 * agent row tracks is counted like a dispatch: no follow, no credit, not in the matrix. A ranged
 * agent's row also gets the ranged flag and its fallback pin (savings.ts rangedFallback), with
 * that fallback as the baseline. Every row stores the tier its line names (`model`: the ranged
 * pick, else the verdict clamped to the apply bounds) as savings.ts advisedPick, what follow
 * detection compares the call with.
 */
function markPlanRow(db: StorageAdapter, a: PlanAdvice): void {
  const kept = keptModelOf(dispatchRule(adviceFacts(a, false, false)));
  if ((!kept && !a.range && !a.model) || a.rowId === undefined) return;
  const pick = a.model ? { [ADVISED_PICK_FIELD]: a.model } : {};
  try {
    const r = a.range;
    const extra: Record<string, unknown> = r
      ? {
          // the AgentPin shape, so keptPin compares the run with the fallback
          pin: {
            status: "ranged",
            model: r.fallback,
            range: { floor: r.floor, ceiling: r.ceiling },
            source: r.source,
          },
          [RANGED_FLAG]: true,
          [FALLBACK_PIN_FIELD]: r.fallback,
          ...pick,
        }
      : { ...(a.pin ? { pin: a.pin } : {}), ...pick };
    const scores = withKeptModel(db.adjudicator.get(a.rowId)?.scores, kept, extra);
    if (scores === undefined) return;
    db.adjudicator.update(a.rowId, r ? { scores, baselineModel: r.fallback } : { scores });
  } catch {
    // the row keeps its verdict without the flag
  }
}

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Where to remove a respected pin: swarm.yaml for the project agents eminiar generates. */
function pinHome(pin: PlanPin): string {
  return pin.source === "project" || pin.source === undefined
    ? "remove the pin in swarm.yaml"
    : `remove the ${pin.source} agent's model pin`;
}

/** "pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose)". */
export function pinnedPart(pin: PlanPin, model: Tier | undefined, fix = pinHome(pin)): string {
  if (pin.status === "unknown")
    return `model pin is unknown (${model ? `adjudicator would pick ${model}; ` : ""}not overridden while the agent's definition cannot be read)`;
  const pinned = pin.model ?? "?";
  if (!model || (tierOf(pinned) ?? pinned) === model)
    return `pinned ${pinned} (matches the adjudicator's pick)`;
  return `pinned ${pinned} (adjudicator would pick ${model}; ${fix} to let it choose)`;
}

/**
 * One line per task, e.g. "#5 → swarm-feature-coder · model haiku · effort low (complexity 1,
 * conf 0.82)", "#5 → swarm-feature-coder · pinned opus (adjudicator would pick haiku; …) ·
 * effort low (…)" for an agent whose pin is respected, or "#5 → swarm-feature-coder · model haiku
 * (range haiku–opus, fallback sonnet) · effort low (…)" for a ranged one. A saturated brief's
 * effort reads "effort high: informational (brief saturated; complexity 4, …)"; the role note
 * needs a role confidence of ROLE_NOTE_MIN.
 */
export function planLines(advice: readonly PlanAdvice[]): string[] {
  return advice.map((a) => {
    const floor = a.floored ? ` (${SECURITY_FLOOR_LABEL})` : "";
    const parts = [
      a.agentType ?? "any role",
      ...(a.range
        ? [`${rangedPart(a.range, a.model)}${floor}`]
        : a.pin
          ? [`${pinnedPart(a.pin, a.model)}${floor}`]
          : a.model
            ? [a.forced ? `model ${a.model} (informational)${floor}` : `model ${a.model}${floor}`]
            : []),
      a.effortApplied
        ? `effort ${a.effort} (applied by the hook)`
        : a.saturated
          ? `effort ${a.effort}: informational`
          : `effort ${a.effort}`,
    ];
    let line = `#${a.taskId} → ${parts.join(" · ")} (${a.saturated ? "brief saturated; " : ""}complexity ${complexityBucket(a.complexity)}, conf ${r2(a.confidence)})`;
    const noted = a.suggestedRole && (a.roleConfidence ?? 0) >= ROLE_NOTE_MIN;
    if (noted && a.role && a.suggestedRole !== a.role)
      line += `; role suggested: ${a.suggestedRole} (planned: ${a.role})`;
    else if (noted && !a.role) line += `; role suggested: ${a.suggestedRole}`;
    return line;
  });
}

/**
 * The head's nudge when no suggestion can change a worker's model (every role pins a model).
 * The effort is not affected: apply mode still sets it on every dispatch.
 */
export const ALL_PINNED_NOTE =
  "every role pins a model: the adjudicator cannot change any worker's model (add model_range in swarm.yaml)";

/** The advice block `em_swarm plan` appends; "" when there is no advice. */
export function planAdviceBlock(
  advice: readonly PlanAdvice[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!advice.length) return "";
  const nudge = advice.every((a) => a.allRolesPinned) ? [ALL_PINNED_NOTE] : [];
  return [planAdviceHead(advice, env), ...nudge, ...planLines(advice)].join("\n");
}

export { EFFORT_ENV_FIELD, EFFORT_ENV_OTHER, effortLevel, PASSED_EFFORT_FIELD } from "./effort.js";

/** CLAUDE_CODE_EFFORT_LEVEL outranks the Agent call's `effort` (and the agent file's). */
export function effortForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
  return !!v;
}

/**
 * What a plan's suggestions, taken together, tell the coordinator to pass (dispatchRule per task):
 * `model` when some task's model is to be passed, `effort` unless it is informational, and whether
 * some agents keep their pin (a ranged agent whose pick is its fallback included) or FORCE sets
 * the model. The block head and the "Next:" line both read it, so they never disagree.
 */
export interface PlanPassing {
  model: boolean;
  effort: boolean;
  /** Apply mode: the hook sets `effort` for some task, so the coordinator passes none for it. */
  applied: boolean;
  pinned: boolean;
  forced: boolean;
  /** Some brief is saturated while CLAUDE_CODE_EFFORT_LEVEL is unset: its effort is informational. */
  saturated: boolean;
}

export function planPassing(
  advice: readonly PlanAdvice[],
  env: NodeJS.ProcessEnv = process.env,
): PlanPassing {
  const forced = modelForced(env);
  const effortSet = effortForced(env);
  const rules = advice.map((a) => dispatchRule(adviceFacts(a, forced, effortSet)));
  return {
    model: rules.some((r, i) => (r.model === "pass" || r.model === "ranged") && !!advice[i]?.model),
    effort: rules.some((r) => r.effort === "pass"),
    applied: rules.some((r) => r.effort === "applied"),
    pinned: rules.some((r) => r.model === "pin"),
    forced: rules.some((r) => r.model === "forced"),
    saturated: !effortSet && advice.some((a) => a.saturated),
  };
}

const EFFORT_NOTE = "CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`";
const SATURATED_NOTE =
  "every brief is saturated, naming more work than its hardest statement scores";
/** Why no effort is to be passed: the env, else every brief is saturated. */
const noEffortWhy = (p: PlanPassing) => (p.saturated ? SATURATED_NOTE : EFFORT_NOTE);
const APPLIED_NOTE = "the hook sets `effort` on the Agent call in apply mode, so pass no `effort`";
/** What the effort clause says when no effort is to be passed: applied by the hook, or informational. */
const noEffortClause = (p: PlanPassing) =>
  p.applied ? APPLIED_NOTE : `effort is informational: ${noEffortWhy(p)}`;
const FORCE_NOTE =
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, so Claude Code ignores `model` on the Agent call and the agents' model pins";

/** The block's first line: what to pass on the Agent call, given FORCE, the effort env and pins. */
export function planAdviceHead(
  advice: readonly PlanAdvice[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const p = planPassing(advice, env);
  const effortPass = `pass the effort as \`effort\` (Claude Code ${AGENT_EFFORT_SINCE} or later)`;
  // Some briefs saturated, others not: their lines say "informational", the head says why.
  const saturated =
    p.effort && p.saturated
      ? "; a saturated brief's effort is informational: pass no `effort`"
      : "";
  if (p.forced)
    return `Adjudicator suggestions (${FORCE_NOTE}; the model is informational; ${
      p.effort ? effortPass : p.applied ? APPLIED_NOTE : `${noEffortWhy(p)}, so effort is too`
    }${saturated}):`;
  const pins = p.pinned ? "; a pinned agent keeps its model: pass no `model`" : "";
  let pass: string;
  if (p.model && p.effort)
    pass = `pass the model as \`model\` and the effort as \`effort\` on each Agent call (\`effort\` needs Claude Code ${AGENT_EFFORT_SINCE} or later)`;
  else if (p.model) pass = `pass the model as \`model\` on each Agent call (${noEffortClause(p)})`;
  else if (p.effort) pass = `${effortPass} on each Agent call`;
  else if (p.applied) pass = `pass nothing: ${APPLIED_NOTE}`;
  else pass = `informational only (effort: ${noEffortWhy(p)})`;
  return `Adjudicator suggestions: ${pass}${pins}${saturated}:`;
}

/**
 * The tail of em_swarm plan's "Next:" line (after "names \"task #N\" (the worker claims it)"):
 * the same instruction as the advice head, "" without advice.
 */
export function planNextHint(
  advice: readonly PlanAdvice[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!advice.length) return "";
  const p = planPassing(advice, env);
  const keep = p.forced
    ? "leave `model` unset (CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets it)"
    : p.pinned
      ? "leave `model` unset for pinned agents"
      : "";
  const pass = [p.model ? "`model`" : "", p.effort ? "`effort`" : ""].filter(Boolean).join(" and ");
  // Apply mode: the hook sets the effort, whether or not a model is passed.
  const applied =
    p.applied && !p.effort ? "; the hook sets `effort` (apply mode): pass no `effort`" : "";
  if (!pass)
    return p.applied
      ? `; the suggestions below are informational${keep ? `: ${keep}` : ""}${applied}`
      : `; the suggestions below are informational: ${keep ? `${keep} and ` : ""}pass no \`effort\` (${noEffortWhy(p)})`;
  return `, passing ${pass} as each suggestion below says${keep ? `; ${keep}` : ""}${applied}`;
}
