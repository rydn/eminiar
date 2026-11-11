/**
 * Read-only view of what the adjudicator decided for each task of a swarm run, and what actually
 * ran: the plan row's advice (suggested model and effort, pin / range / FORCE) next to the
 * PreToolUse(Agent) row's applied or passed model and effort, and whether the dispatch followed
 * the advice. Built from rows the hooks already wrote (hooks.ts onPreAgent, swarm.ts markPlanRow);
 * nothing is injected and nothing is written. Free text is redacted and clipped, raw prompts are
 * never included (rows hold at most an 80-char redacted head, which this view does not read).
 */

import type { StorageAdapter } from "../storage/adapter.js";
import { keptModel, tierOf } from "../storage/dispatch.js";
import type { TaskRow } from "../swarm/types.js";
import {
  ACTUAL_EFFORT_FIELD,
  AGENT_EFFORT_FIELD,
  EFFORT_APPLIED_FIELD,
  EFFORT_ENV_FIELD,
  EFFORT_ENV_OTHER,
  EFFORT_FOLLOW_FIELD,
  type EffortFollow,
  effortLevel,
  PASSED_EFFORT_FIELD,
} from "./effort.js";
import { redact } from "./redact.js";
import { advisedPick, RANGED_FLAG, rangedFallback } from "./savings.js";
import type {
  DecisionFollow,
  SwarmDecision,
  SwarmDecisionAdvice,
  SwarmDecisionRan,
} from "./swarm-decision-types.js";
import type { AdjudicationRow } from "./types.js";

export type {
  DecisionFollow,
  SwarmDecision,
  SwarmDecisionAdvice,
  SwarmDecisionRan,
} from "./swarm-decision-types.js";

export const TITLE_MAX = 120;
export const REASONS_MAX = 4;
const REASON_MAX = 100;

const clip = (s: string, n: number): string => {
  const one = redact(s).replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function scoresOf(row: Pick<AdjudicationRow, "scores"> | undefined): Record<string, unknown> {
  if (!row?.scores) return {};
  try {
    const o: unknown = JSON.parse(row.scores);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const strOf = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function reasonsOf(s: Record<string, unknown>): string[] {
  const r = s.complexityReasons;
  if (!Array.isArray(r)) return [];
  return r
    .filter((x): x is { note?: unknown; weight?: unknown } => !!x && typeof x === "object")
    .map((x) => ({ note: strOf(x.note), weight: typeof x.weight === "number" ? x.weight : 0 }))
    .filter((x): x is { note: string; weight: number } => !!x.note)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, REASONS_MAX)
    .map((x) => clip(x.note, REASON_MAX));
}

function pinOf(s: Record<string, unknown>): {
  pin: SwarmDecisionAdvice["pin"];
  model?: string | undefined;
} {
  const p = s.pin;
  if (!p || typeof p !== "object") return { pin: "none" };
  const o = p as Record<string, unknown>;
  const model = strOf(o.model);
  if (o.status === "pinned") return { pin: "pinned", model };
  if (o.status === "unknown") return { pin: "unknown" };
  if (o.status === "ranged") return { pin: "ranged", model };
  return { pin: "none" };
}

function adviceOf(
  plan: AdjudicationRow | undefined,
  agent: AdjudicationRow | undefined,
): SwarmDecisionAdvice | undefined {
  // The plan row is the decision; an agent row without one scored the dispatch itself.
  const row = plan ?? agent;
  if (!row) return undefined;
  // Pin / range / FORCE flags: the dispatch row's lookup is the newer, so it wins over the plan's.
  const flags = scoresOf(agent ?? row);
  const planScores = scoresOf(row);
  const { pin, model } = pinOf(agent ? flags : planScores);
  const kept = keptModel(agent ?? row);
  const fallback = rangedFallback(agent ?? row);
  const rangeRec = ((): { floor?: unknown; ceiling?: unknown } | undefined => {
    const p = (agent ? flags : planScores).pin;
    const r = p && typeof p === "object" ? (p as Record<string, unknown>).range : undefined;
    return r && typeof r === "object" ? (r as { floor?: unknown; ceiling?: unknown }) : undefined;
  })();
  const range =
    flags[RANGED_FLAG] === true && fallback && strOf(rangeRec?.floor) && strOf(rangeRec?.ceiling)
      ? {
          floor: strOf(rangeRec?.floor) as string,
          ceiling: strOf(rangeRec?.ceiling) as string,
          fallback,
        }
      : undefined;
  // Rows older than advisedPick fall back like learn.ts: the plan row's verdict tier, then the row's.
  const pick =
    advisedPick(agent ?? row) ??
    advisedPick(row) ??
    (kept ? undefined : (tierOf(plan?.tier) ?? tierOf(agent?.tier)));
  const units = planScores.units;
  const saturated =
    !!units && typeof units === "object" && (units as Record<string, unknown>).saturated === true;
  const out: SwarmDecisionAdvice = {
    model: pick,
    verdictTier: row.tier ?? undefined,
    effort: row.effort ?? undefined,
    complexity: row.complexity ?? undefined,
    confidence: row.confidence ?? undefined,
    role: row.role ?? undefined,
    saturated,
    reasons: reasonsOf(planScores),
    pin,
    pinDeferred: kept === "pin",
    forced: kept === "force",
    fork: kept === "fork",
    rowId: row.id,
    ts: row.ts,
  };
  if (model) out.pinnedModel = model;
  if (range) out.range = range;
  if (row.source) out.source = row.source;
  return out;
}

function ranOf(agent: AdjudicationRow, fallbackAgentId: string | undefined): SwarmDecisionRan {
  const s = scoresOf(agent);
  const kept = keptModel(agent);
  // A fork takes no per-call effort: the passed level is recorded but never effective.
  const passedRaw = effortLevel(s[PASSED_EFFORT_FIELD]);
  const passed = kept === "fork" ? undefined : passedRaw;
  // The level the hook set on the Agent call: it overrides the call's and the agent file's.
  const applied = kept === "fork" ? undefined : effortLevel(s[EFFORT_APPLIED_FIELD]);
  const env = effortLevel(s[EFFORT_ENV_FIELD]);
  // An env level outside EFFORTS still outranks the call, but what it sets is unknown.
  const envOther = !env && s[EFFORT_ENV_FIELD] === EFFORT_ENV_OTHER;
  const agentEffort = kept === "fork" ? undefined : effortLevel(s[AGENT_EFFORT_FIELD]);
  const effective = envOther ? undefined : (env ?? applied ?? passed ?? agentEffort);
  const actual = effortLevel(s[ACTUAL_EFFORT_FIELD]);
  // Under FORCE or a fork Claude Code ignores the call's model: the requested model (and a final
  // model that only echoes it in advise mode) is not what ran. Only actualModel, or under FORCE in
  // apply mode the CLAUDE_CODE_SUBAGENT_MODEL that modelFinal then holds, is known.
  const tier =
    tierOf(agent.actualModel) ??
    (kept === "fork" || (kept === "force" && agent.action === "advised")
      ? undefined
      : kept === "force"
        ? tierOf(agent.modelFinal)
        : (tierOf(agent.modelFinal) ?? tierOf(agent.modelRequested)));
  const out: SwarmDecisionRan = {
    tier,
    applied: agent.action === "applied",
    effortSource:
      env || envOther
        ? "env"
        : applied
          ? "applied"
          : passed
            ? "call"
            : kept === "fork"
              ? "fork"
              : agentEffort
                ? "agent-file"
                : "agent-default",
    rowId: agent.id,
    ts: agent.ts,
  };
  if (agent.modelRequested) out.requestedModel = agent.modelRequested;
  if (agent.modelFinal) out.finalModel = agent.modelFinal;
  if (agent.actualModel) out.actualModel = agent.actualModel;
  if (agent.baselineModel) out.baselineModel = agent.baselineModel;
  if (agent.action) out.action = agent.action;
  if (passedRaw) out.effortPassed = passedRaw;
  if (env) out.effortEnv = env;
  if (effective) out.effortEffective = effective;
  if (actual) out.effortActual = actual;
  const id = agent.agentId ?? fallbackAgentId;
  if (id) out.agentId = id;
  if (agent.outcome) out.outcome = agent.outcome;
  return out;
}

/** How the dispatch relates to the advice (DecisionFollow). */
export function followOf(
  advice: SwarmDecisionAdvice | undefined,
  agent: AdjudicationRow | undefined,
): DecisionFollow {
  if (!agent) return "none";
  const kept = keptModel(agent);
  if (kept === "force") return "forced";
  if (kept === "fork") return "fork";
  const advised = advice?.model;
  const requested = tierOf(agent.modelRequested);
  if (kept === "pin") {
    // The pin stays only when the call passed no model; a passed model is what runs.
    if (!agent.modelRequested) return "pinned";
    return requested && requested === advised ? "followed" : "overrode";
  }
  if (agent.modelRequested) {
    // Never "none" for a call that passed a model; with no advice to compare, the call overrode.
    return requested && requested === advised ? "followed" : "overrode";
  }
  // No model passed: apply mode may have set the advised tier.
  if (agent.action === "applied" && advised && tierOf(agent.modelFinal) === advised)
    return "followed";
  return "none";
}

/**
 * Model differs only when both tiers are known and the dispatch was not decided elsewhere: a kept
 * pin (no model passed), FORCE or a fork ran what the advice never could change, so the advice is
 * informational and no mismatch is claimed.
 */
function modelDiffers(
  advice: SwarmDecisionAdvice | undefined,
  agent: AdjudicationRow | undefined,
  ran: SwarmDecisionRan | undefined,
): boolean {
  const advised = advice?.model;
  if (!advised || !ran?.tier) return false;
  const kept = agent ? keptModel(agent) : undefined;
  if (kept === "force" || kept === "fork") return false;
  if (kept === "pin" && !agent?.modelRequested) return false;
  return advised !== ran.tier;
}

/** Effort differs only when both sides are known; the level that actually ran beats the intended one. */
function effortDiffers(advice?: SwarmDecisionAdvice, ran?: SwarmDecisionRan): boolean {
  if (ran?.effortSource === "fork") return false;
  const got = ran?.effortActual ?? ran?.effortEffective;
  return !!advice?.effort && !!got && advice.effort !== got;
}

function effortFollowOfRow(agent: AdjudicationRow | undefined): EffortFollow | undefined {
  const f = scoresOf(agent)[EFFORT_FOLLOW_FIELD];
  return f === "followed" || f === "ignored" ? f : undefined;
}

/**
 * One decision per task of the run, by task id: the adjudicator's plan advice, the dispatch row of
 * its worker and how they relate. Never throws: a task whose rows cannot be read comes back with
 * follow "none" and no advice.
 */
export function swarmDecisions(db: StorageAdapter, runId: string): SwarmDecision[] {
  let tasks: TaskRow[];
  try {
    tasks = db.swarm.tasks(runId);
  } catch {
    return [];
  }
  // One query for the run; a failure leaves `byTask` unset and every task reads its own rows.
  let byTask: Map<number, AdjudicationRow[]> | undefined;
  try {
    byTask = new Map();
    for (const r of db.adjudicator.forRun(runId)) {
      if (r.taskId == null) continue;
      const list = byTask.get(r.taskId);
      if (list) list.push(r);
      else byTask.set(r.taskId, [r]);
    }
  } catch {
    byTask = undefined;
  }
  return tasks.map((t) => decisionOf(db, runId, t, byTask ? (byTask.get(t.id) ?? []) : undefined));
}

/** `rows` are the task's adjudication rows when the caller already holds them. */
export function decisionOf(
  db: StorageAdapter,
  runId: string,
  t: TaskRow,
  known?: AdjudicationRow[],
): SwarmDecision {
  let rows: AdjudicationRow[] = known ?? [];
  if (!known) {
    try {
      rows = db.adjudicator.forTask(runId, t.id);
    } catch {
      // no rows: the task shows without a decision
    }
  }
  const plan = rows.filter((r) => r.surface === "plan").pop();
  const agent = rows.filter((r) => r.surface === "agent").pop();
  const advice = adviceOf(plan, agent);
  const ran = agent ? ranOf(agent, t.agent_id ?? undefined) : undefined;
  const out: SwarmDecision = {
    taskId: t.id,
    title: clip(t.title, TITLE_MAX),
    status: t.status,
    follow: followOf(advice, agent),
    modelDiffers: modelDiffers(advice, agent, ran),
    effortDiffers: effortDiffers(advice, ran),
  };
  if (t.role) out.role = t.role;
  if (t.agent_id) out.agentId = t.agent_id;
  if (advice) out.advice = advice;
  if (ran) out.ran = ran;
  const ef = effortFollowOfRow(agent);
  if (ef) out.effortFollow = ef;
  return out;
}
