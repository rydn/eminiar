/**
 * Orchestration of the security adjudication (docs/design/adjudicator-security.md, parts 4 and
 * 9): one assessment of "this agent, with these tools, doing this task, in this session" for each
 * surface, and the one place that stores it.
 *
 *   assessDispatch  PreToolUse Agent/Task: the grant of the agent definition (or the role, or the
 *                   built-in table), the task or the call's own text, the session taint, and the
 *                   plan-time model answer of a worker's task. Never waits for a model.
 *   assessPrompt    UserPromptSubmit: the main session's tools and the prompt.
 *   assessText      on demand (em_adjudicate security, the CLI, the dashboard's try-it): the
 *                   caller's tools, an agent type or a role, and a model answer when the caller has one.
 *   planSecurity    em_swarm plan: every task against its role's grant; finishPlan blends the
 *                   engine's model answers in, applies the model floor and stores the rows.
 *   record          the one INSERT (db.security), honouring security.store and the privacy setting.
 *
 * Advice only: nothing in here denies, asks or rewrites a call. Nothing here is imported by the
 * config or the storage layer, and a build with security off never loads it (the hooks gate on
 * adjudicatorWanted before importing).
 */

import type { AdjudicatorConfig } from "../../config.js";
import type { ProjectContext } from "../../context.js";
import type { HookInput } from "../../hooks/types.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import { tierOf } from "../../storage/dispatch.js";
import type { SecurityInput, SecurityRow } from "../../storage/types.js";
import type { SwarmSpawnCheck } from "../../swarm/hooks.js";
import type { RunRow, SwarmSpec, TaskRow } from "../../swarm/types.js";
import { type AgentPin, resolveAgentPin } from "../agent-pin.js";
import { head, inputHash } from "../redact.js";
import { findTask } from "../task-lookup.js";
import { type ProviderStatus, TIERS, type Tier } from "../types.js";
import {
  type AssessmentView,
  hookLine,
  notifiesUser,
  planHead,
  planLine,
  showsLine,
  userMessage,
  viewOf,
  viewOfRow,
} from "./advice.js";
import { type CombineOptions, combine, floorTier, levelRank } from "./combine.js";
import {
  autonomyOf,
  grantForAgent,
  grantForSession,
  grantFromCaller,
  grantFromRole,
} from "./grant.js";
import { assessHeuristic } from "./score.js";
import { extractAll, sessionTaint, type Taint, taintingTool } from "./signals.js";
import {
  type Autonomy,
  CAP_TAG,
  CAPS,
  type HeuristicAssessment,
  type Level,
  SECURITY_VERSION,
  type SecurityAssessment,
  type SecurityHint,
  type SecurityModelAnswer,
  type SecurityModelStatus,
  type SecuritySurface,
  type ToolGrant,
} from "./types.js";

/** adjudicator.security, as the config parses it. */
export type SecurityConfig = AdjudicatorConfig["security"];

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const sessionOf = (id: string | undefined): string | undefined =>
  id && id !== "unknown" ? id : undefined;

// --- the core: grant + text + taint + autonomy -> an assessment --------------------------------

/** Tools that bring web content in: research verbs count as untrusted input only with one. */
const WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch", "em_fetch_and_index"]);

const hasWebTool = (g: ToolGrant): boolean =>
  g.tools.some((t) => WEB_TOOLS.has(t.id) || (t.kind === "mcp" && t.mcp?.cls === "browser"));

export interface ScoreInput {
  grant: ToolGrant;
  /**
   * The task's own text (title and detail, the call's description and prompt, the typed prompt):
   * every cue counts, review wording too.
   */
  task?: ReadonlyArray<string | undefined>;
  /**
   * Other text the cues are read from: the agent's or role's description. It is committed to the
   * repository, so review wording there never counts (signals.ts extractAll).
   */
  texts?: ReadonlyArray<string | undefined>;
  autonomy: Autonomy;
  taint?: Taint | undefined;
}

/** The heuristic half of an assessment: everything but the model's answer. */
export interface Scored {
  grant: ToolGrant;
  taint: Taint;
  heuristic: HeuristicAssessment;
  /** What a provider may be asked besides the text (ids and capability tags only). */
  hint: SecurityHint;
}

/**
 * The provider-safe hint of an assessment: the grant's tool ids (MCP as mcp:<class>:<verb>, at
 * most 40) and the capability tags of the grant exposures from .3. Never arguments, paths, MCP
 * server names, session history or our own verdict.
 */
export function securityHint(h: HeuristicAssessment, grant: ToolGrant): SecurityHint {
  return {
    tools: [...new Set(grant.tools.map((t) => t.id))].slice(0, 40),
    caps: CAPS.filter((c) => h.caps[c].grant >= 0.3).map((c) => CAP_TAG[c]),
  };
}

/** Signals, then the heuristic engine. Deterministic and pure; tens of microseconds. */
export function scoreInput(sec: SecurityConfig, i: ScoreInput): Scored {
  const s = extractAll(
    i.task ?? [],
    { webTool: hasWebTool(i.grant), secretPaths: sec.secretPaths },
    i.texts ?? [],
  );
  const taint: Taint = i.taint ?? { tools: [], status: "off" };
  const heuristic = assessHeuristic({
    grant: i.grant,
    cues: s.cues,
    intent: s.intent,
    taint: taint.tools,
    autonomy: i.autonomy,
  });
  return { grant: i.grant, taint, heuristic, hint: securityHint(heuristic, i.grant) };
}

/** An assessment with the view the advice and the store read. */
export interface Assessed {
  assessment: SecurityAssessment;
  grant: ToolGrant;
  taint: Taint;
  /** The hint for the model request (what a provider may see). */
  hint: SecurityHint;
  view: AssessmentView;
}

/** Why there is no model answer when nothing was asked: security.model "off", or not asked here. */
export function baseModelStatus(sec: Pick<SecurityConfig, "model">): SecurityModelStatus {
  return sec.model === "provider" ? "none" : "off";
}

export interface BlendOptions {
  answer?: SecurityModelAnswer | undefined;
  /** Default: "ok" with a usable answer, else baseModelStatus. */
  status?: SecurityModelStatus | undefined;
  source?: SecurityAssessment["source"] | undefined;
}

/** Blend the model's answer (it can only raise; never CRITICAL) into a scored assessment. */
export function blend(
  sec: Pick<SecurityConfig, "model">,
  s: Scored,
  o: BlendOptions = {},
): Assessed {
  const opts: CombineOptions = {};
  const status = o.status ?? (o.answer ? undefined : baseModelStatus(sec));
  if (status) opts.status = status;
  if (o.source) opts.source = o.source;
  const assessment = combine(s.heuristic, o.answer, opts);
  return {
    assessment,
    grant: s.grant,
    taint: s.taint,
    hint: s.hint,
    view: viewOf(assessment, { grant: s.grant, taint: s.taint }),
  };
}

/** scoreInput + blend. */
export function assessCore(sec: SecurityConfig, i: ScoreInput, o: BlendOptions = {}): Assessed {
  return blend(sec, scoreInput(sec, i), o);
}

/** The untrusted-input tools the session used (one indexed read; "history unavailable" on failure). */
function taintOf(
  sec: SecurityConfig,
  db: StorageAdapter | undefined,
  sessionId: string | undefined,
  now: number,
): Taint {
  return sessionTaint(db, sessionId, sec.taintLookbackMin, sec.trustedMcpServers, now);
}

/** The model answer a stored row kept, if any. */
export function modelAnswerOf(row: SecurityRow | undefined): SecurityModelAnswer | undefined {
  return row ? viewOfRow(row).detail.model?.answer : undefined;
}

// --- storing ----------------------------------------------------------------------------------

export interface RecordInput {
  surface: SecuritySurface;
  assessed: Assessed;
  /** The assessed text: hashed, and its redacted head is kept when privacy.storeHead is on. */
  text?: string | undefined;
  sessionId?: string | undefined;
  toolUseId?: string | undefined;
  agentType?: string | undefined;
  runId?: string | undefined;
  taskId?: number | undefined;
  /** adjudications.id of the routing row this one sits beside. */
  adjudicationId?: number | undefined;
  /** A line reached the agent or the user. */
  noted?: boolean | undefined;
}

/**
 * Store one assessment (adjudicator_security); undefined when security.store is off or the insert
 * failed (a busy or foreign database: the advice still shows). Only ids, numbers and tags are
 * kept, plus the redacted 80-character head of the text. Never throws.
 */
export function record(
  db: StorageAdapter,
  cfg: Pick<AdjudicatorConfig, "security" | "privacy">,
  r: RecordInput,
  o: { lockWaitMs?: number } = {},
): number | undefined {
  if (!cfg.security.store) return undefined;
  try {
    const a = r.assessed.assessment;
    const h = a.heuristic;
    const input: SecurityInput = {
      surface: r.surface,
      level: a.level,
      score: a.score,
      action: a.action,
      heuristicLevel: h.level,
      heuristicScore: h.score,
      modelStatus: a.modelStatus,
      source: a.source,
      autonomy: h.autonomy,
      grantStatus: h.grantStatus,
      rules: [...h.rules.map((x) => x.id), ...h.floors],
      detail: r.assessed.view.detail,
      noted: r.noted ?? false,
      version: SECURITY_VERSION,
    };
    if (a.model) {
      input.modelLevel = a.model.level;
      input.modelScore = a.model.score;
    }
    if (r.sessionId) input.sessionId = r.sessionId;
    if (r.toolUseId) input.toolUseId = r.toolUseId;
    if (r.agentType) input.agentType = r.agentType;
    if (r.runId) input.runId = r.runId;
    if (r.taskId !== undefined) input.taskId = r.taskId;
    if (r.adjudicationId !== undefined) input.adjudicationId = r.adjudicationId;
    if (r.text?.trim()) {
      input.inputHash = inputHash(r.text);
      if (cfg.privacy.storeHead) input.inputHead = head(r.text);
    }
    return db.security.insert(input, o);
  } catch {
    return undefined;
  }
}

// --- the hook surfaces -------------------------------------------------------------------------

/** Test seams; the hooks pass none. */
export interface AssessDeps {
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
}

export interface DispatchOptions extends AssessDeps {
  /** The swarm spawn check routing already made (a worker names its run and task). */
  spawn?: SwarmSpawnCheck | undefined;
  /** The agent's definition, resolved once by the caller (afterRouting); looked up when absent. */
  pin?: AgentPin | undefined;
}

export interface DispatchAssessment extends Assessed {
  /** The database the task lives in (this project's, or the coordination root's): rows go beside it. */
  db: StorageAdapter;
  agentType: string;
  /** The text the row's hash and head come from (the task, or the call's description and prompt). */
  text: string;
  runId?: string;
  taskId?: number;
  sessionId?: string;
  toolUseId?: string;
  /** The model's answer is the plan's, reused: a dispatch never waits for a model. */
  reusedPlan: boolean;
}

const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * One Agent/Task call. The grant is the agent definition's own (AgentPin.grant), else the
 * built-in table, a fork's inherit set or, when the definition cannot be read, the inherit set
 * with status "unknown". A worker's task text and its plan-time model answer (db.security.forTask)
 * are used when the task is found. No network, no model: heuristic ≤ 1 ms plus three indexed reads.
 * Undefined for any other tool. Never throws on a missing task or an unreadable history.
 */
export function assessDispatch(
  ctx: Pick<ProjectContext, "config" | "root">,
  db: StorageAdapter,
  input: HookInput,
  o: DispatchOptions = {},
): DispatchAssessment | undefined {
  if (!AGENT_TOOLS.has(input.tool_name ?? "")) return undefined;
  const cfg = ctx.config.adjudicator;
  const sec = cfg.security;
  const ti = input.tool_input ?? {};
  const env = o.env ?? process.env;
  const now = (o.now ?? Date.now)();
  const agentType = str(ti.subagent_type) ?? "general-purpose";

  let taskDb = db;
  let task: TaskRow | undefined;
  const w = o.spawn?.kind === "worker" ? o.spawn : undefined;
  if (w?.runId && typeof w.taskId === "number") {
    try {
      const found = findTask(ctx, db, w.runId, w.taskId);
      if (found) ({ db: taskDb, task } = found);
    } catch {
      // no task text: the call's own text stands in
    }
  }

  const pin = o.pin ?? resolveAgentPin(agentType, { root: ctx.root, cwd: input.cwd, env });
  const grant = grantForAgent(agentType, pin, sec.trustedMcpServers);
  const sessionId = sessionOf(input.session_id);
  const taint = taintOf(sec, db, sessionId, now);
  const text = task
    ? `${task.title}\n${task.detail ?? ""}`
    : `${str(ti.description) ?? ""}\n${str(ti.prompt) ?? ""}`;

  // The plan already asked the model about this task: reuse its answer, never ask again here.
  let answer: SecurityModelAnswer | undefined;
  let status: SecurityModelStatus | undefined;
  if (task && w?.runId && sec.model === "provider") {
    try {
      const prior = taskDb.security.forTask(w.runId, task.id);
      answer = modelAnswerOf(prior);
      if (!answer && prior && prior.modelStatus !== "ok" && prior.modelStatus !== "off")
        status = prior.modelStatus as SecurityModelStatus;
    } catch {
      // no plan row (or an older database): heuristic only
    }
  }

  const scored = scoreInput(sec, {
    grant,
    task: task ? [task.title, task.detail ?? undefined] : [str(ti.description), str(ti.prompt)],
    texts: [grant.description],
    autonomy: autonomyOf(input.permission_mode, grant.permissionMode),
    taint,
  });
  const assessed = blend(sec, scored, {
    answer,
    status,
    source: answer ? "plan" : "heuristic",
  });
  const out: DispatchAssessment = {
    ...assessed,
    db: taskDb,
    agentType,
    text,
    reusedPlan: !!answer,
  };
  if (w?.runId && task) {
    out.runId = w.runId;
    out.taskId = task.id;
  }
  if (sessionId) out.sessionId = sessionId;
  if (input.tool_use_id) out.toolUseId = input.tool_use_id;
  return out;
}

const HARNESS_ENVELOPE =
  /^\s*<(?:agent-message|task-notification|ci-monitor-event|system-reminder)[\s>]/;
const LEADING_REMINDER = /^\s*<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/;

/**
 * The text the user typed, or undefined when the prompt is not worth reading: nothing typed, a
 * harness envelope (a subagent's hand-back, a task notification, a CI event, a bare reminder), or
 * a slash command. The same rules as the routing adjudicator's onPrompt (a test keeps them equal);
 * copied because that module is not loaded in security-only mode.
 */
export function typedPrompt(raw: string | undefined): string | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  let rest = text;
  for (let m = LEADING_REMINDER.exec(rest); m; m = LEADING_REMINDER.exec(rest))
    rest = rest.slice(m[0].length);
  rest = rest.trim();
  // An envelope is a prompt that starts with a harness tag and has nothing typed after it (or
  // another envelope); anything typed after leading reminders is the user's.
  if (HARNESS_ENVELOPE.test(text) && (rest === "" || HARNESS_ENVELOPE.test(rest))) return undefined;
  return rest && !rest.startsWith("/") ? rest : undefined;
}

export interface PromptAssessment extends Assessed {
  text: string;
  sessionId?: string;
}

/** The prompt of the main session: its inherited tools, the typed text, the session taint. */
export function assessPrompt(
  ctx: Pick<ProjectContext, "config">,
  db: StorageAdapter,
  input: Pick<HookInput, "prompt" | "permission_mode" | "session_id">,
  o: AssessDeps = {},
): PromptAssessment | undefined {
  const text = typedPrompt(input.prompt);
  if (!text) return undefined;
  const sec = ctx.config.adjudicator.security;
  const sessionId = sessionOf(input.session_id);
  const grant = grantForSession();
  const scored = scoreInput(sec, {
    grant,
    task: [text],
    autonomy: autonomyOf(input.permission_mode, grant.permissionMode),
    taint: taintOf(sec, db, sessionId, (o.now ?? Date.now)()),
  });
  const out: PromptAssessment = { ...blend(sec, scored), text };
  if (sessionId) out.sessionId = sessionId;
  return out;
}

// --- on demand: em_adjudicate security, the CLI, the dashboard's try-it --------------------------

export interface TextInput {
  text: string;
  /** The caller's tool names as an agent file spells them; unknown names are dropped. */
  tools?: readonly string[] | undefined;
  /** An agent type whose definition (or built-in entry) gives the grant. */
  agentType?: string | undefined;
  /** A swarm role the caller found: its grant is what the generated agent file carries. */
  role?:
    | {
        tools?: string[] | undefined;
        disallowedTools?: string[] | undefined;
        description?: string | undefined;
        /** `tools_profile: readonly` narrows the grant, as the generated agent file has it. */
        toolsProfile?: "readonly" | undefined;
      }
    | undefined;
  /** Default "default". */
  autonomy?: Autonomy | undefined;
  /** Untrusted-input tools the session already used (an eval item, the try-it form). */
  taint?: readonly string[] | undefined;
  /** Read the real session taint instead (needs `db`). */
  sessionId?: string | undefined;
}

export interface TextOptions extends AssessDeps, BlendOptions {
  /** The project root and cwd the agent definition is looked up from. */
  root?: string | undefined;
  cwd?: string | undefined;
  /** A resolved definition (otherwise looked up from `agentType`). */
  pin?: AgentPin | undefined;
  db?: StorageAdapter | undefined;
}

export interface TextAssessment extends Assessed {
  text: string;
}

/**
 * Assess text for a grant the caller names: its `tools` when any are usable, else the role's, else
 * the agent type's definition, else the inherit set. The model's answer, when the caller asked a
 * provider, comes in through `o` (answer, status, source); nothing here calls one.
 */
export function assessText(sec: SecurityConfig, i: TextInput, o: TextOptions = {}): TextAssessment {
  const env = o.env ?? process.env;
  let grant = grantFromCaller(i.tools, sec.trustedMcpServers);
  if (grant.status !== "known") {
    if (i.role)
      grant = grantFromRole(
        {
          tools: i.role.tools,
          disallowedTools: i.role.disallowedTools,
          description: i.role.description ?? "",
          toolsProfile: i.role.toolsProfile,
        },
        sec.trustedMcpServers,
      );
    else if (i.agentType && o.root) {
      const pin =
        o.pin ??
        resolveAgentPin(i.agentType, { root: o.root, ...(o.cwd ? { cwd: o.cwd } : {}), env });
      grant = grantForAgent(i.agentType, pin, sec.trustedMcpServers);
    } else if (i.agentType) grant = grantForAgent(i.agentType, o.pin, sec.trustedMcpServers);
  }
  let taint: Taint = { tools: [], status: "off" };
  if (i.sessionId && o.db) taint = taintOf(sec, o.db, i.sessionId, (o.now ?? Date.now)());
  else if (i.taint?.length) {
    const tools = [
      ...new Set(
        i.taint.map((t) => taintingTool(t, sec.trustedMcpServers)).filter((t): t is string => !!t),
      ),
    ].slice(0, 8);
    taint = { tools, status: "ok" };
  }
  const scored = scoreInput(sec, {
    grant,
    task: [i.text],
    texts: [grant.description],
    autonomy: i.autonomy ?? autonomyOf(undefined, grant.permissionMode),
    taint,
  });
  const out: TextAssessment = { ...blend(sec, scored, o), text: i.text };
  return out;
}

// --- the plan ---------------------------------------------------------------------------------

export interface PlanOptions extends AssessDeps {
  /** The plan will ask the engine (adjudicator enabled and plan advice on): hints are produced. */
  engine?: boolean | undefined;
}

export interface PlanItem {
  taskId: number;
  role?: string;
  agentType?: string;
  /** Title and detail: the row's hash and head. */
  text: string;
  scored: Scored;
}

export interface PlanSecurity {
  /** One per task, in order. */
  items: PlanItem[];
  /**
   * Ask the model too: security.model is "provider" and the adjudicator is on for the plan. Then
   * `hints[i]` goes on task i's engine request as hints.security.
   */
  askModel: boolean;
  hints: Array<SecurityHint | undefined>;
  /** Everything finishPlan needs to store the rows and word the lines. */
  db: StorageAdapter;
  cfg: AdjudicatorConfig;
  run: Pick<RunRow, "id" | "session_id">;
}

/**
 * Score every planned task against its role's grant, as the generated agent file has it (a task
 * without a role: the inherit set). Heuristic only, at most a millisecond a task, nothing stored
 * yet. Undefined when security or its plan surface is off.
 */
export function planSecurity(
  ctx: Pick<ProjectContext, "config">,
  db: StorageAdapter,
  run: Pick<RunRow, "id" | "session_id">,
  swarm: Pick<SwarmSpec, "roles">,
  tasks: readonly TaskRow[],
  o: PlanOptions = {},
): PlanSecurity | undefined {
  const cfg = ctx.config.adjudicator;
  const sec = cfg.security;
  if (!sec.enabled || !sec.surfaces.plan || !tasks.length) return undefined;
  const askModel = sec.model === "provider" && cfg.enabled && o.engine !== false;
  const items: PlanItem[] = tasks.map((t) => {
    const role = swarm.roles.find((r) => r.role === t.role);
    const grant = role
      ? grantFromRole(role, sec.trustedMcpServers)
      : grantFromCaller(undefined, sec.trustedMcpServers);
    const scored = scoreInput(sec, {
      grant,
      task: [t.title, t.detail ?? undefined],
      texts: [grant.description],
      autonomy: autonomyOf(undefined, grant.permissionMode),
    });
    const item: PlanItem = {
      taskId: t.id,
      text: `${t.title}\n${t.detail ?? ""}`,
      scored,
    };
    if (t.role) item.role = t.role;
    if (role) item.agentType = role.agentType;
    return item;
  });
  return {
    items,
    askModel,
    hints: items.map((i) => (askModel ? i.scored.hint : undefined)),
    db,
    cfg,
    run,
  };
}

/** What the engine said about one task (a Verdict has these fields), and its routing row. */
export interface PlanAnswer {
  security?: SecurityModelAnswer | undefined;
  provider?: string | undefined;
  providerStatus?: string | undefined;
  /** adjudications.id of the task's plan row. */
  rowId?: number | undefined;
}

const FAILED: ReadonlySet<string> = new Set([
  "timeout",
  "http_error",
  "rate_limited",
  "invalid",
  "breaker_open",
  "slow_guard",
  "over_budget",
  "auth_failed",
  "no_key",
  "no_consent",
]);

/** Why a task has no model answer, from what the engine reported. */
export function planModelStatus(
  sec: Pick<SecurityConfig, "model">,
  asked: boolean,
  a: PlanAnswer | undefined,
): SecurityModelStatus {
  if (!asked) return baseModelStatus(sec);
  if (a?.security) return "ok";
  if (a?.providerStatus && FAILED.has(a.providerStatus)) return a.providerStatus as ProviderStatus;
  if (a?.provider && a.provider !== "typesafe") return "unsupported";
  return "none";
}

export interface PlanTaskResult {
  taskId: number;
  role?: string;
  level: Level;
  assessed: Assessed;
  view: AssessmentView;
  /** adjudicator_security.id, when stored. */
  id?: number;
  /** The line of this task, when its level reaches security.minLevel. */
  line?: string;
}

export interface PlanSecurityResult {
  items: PlanTaskResult[];
  /** "Security (advice only): 1 critical, 2 high · model jev ok" */
  head: string;
  /** One line per task at or above minLevel (at most 240 characters each). */
  lines: string[];
  /** head + lines. */
  block: string;
  /** The worst level over the tasks; null with no tasks. */
  worst: Level | null;
  counts: Record<Level, number>;
  /** Tasks the model answered for. */
  answered: number;
  /**
   * The tier a plan line may name for task `i` (D6): on HIGH and CRITICAL never below
   * security.modelFloor; `floored` is set when this raised it. Other levels, and no tier, pass through.
   */
  tierFor(i: number, tier: Tier | undefined): { tier: Tier | undefined; floored: boolean };
}

/**
 * Blend the engine's answers in (they can only raise a level), apply the model floor, store one
 * row per task (surface "plan", the engine's row linked) and word the block. `answers[i]` belongs
 * to task i; none at all (security only, or the plan advice is off) leaves the heuristic as it was.
 */
export function finishPlan(
  p: PlanSecurity,
  answers: ReadonlyArray<PlanAnswer | undefined> = [],
): PlanSecurityResult {
  const sec = p.cfg.security;
  const out: PlanTaskResult[] = [];
  const counts: Record<Level, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let answered = 0;
  let status: string | undefined;
  p.items.forEach((item, i) => {
    const a = answers[i];
    const answer = p.askModel ? a?.security : undefined;
    const st = planModelStatus(sec, p.askModel, a);
    if (p.askModel && !answer && st !== "none" && !status) status = st;
    const assessed = blend(sec, item.scored, {
      answer,
      status: answer ? undefined : st,
      source: answer ? "blend" : "heuristic",
    });
    if (assessed.assessment.model) answered++;
    const level = assessed.assessment.level;
    counts[level]++;
    const view = assessed.view;
    const shown = showsLine(level, sec.minLevel);
    const id = record(
      p.db,
      p.cfg,
      {
        surface: "plan",
        assessed,
        text: item.text,
        runId: p.run.id,
        taskId: item.taskId,
        noted: shown,
        ...(p.run.session_id ? { sessionId: p.run.session_id } : {}),
        ...(item.agentType ? { agentType: item.agentType } : {}),
        ...(a?.rowId !== undefined ? { adjudicationId: a.rowId } : {}),
      },
      { lockWaitMs: 100 },
    );
    const r: PlanTaskResult = { taskId: item.taskId, level, assessed, view };
    if (item.role) r.role = item.role;
    if (id !== undefined) {
      r.id = id;
      view.id = id;
    }
    if (shown) r.line = planLine(view, { taskId: item.taskId, role: item.role });
    out.push(r);
  });
  const levels = out.map((x) => x.level);
  const lines = out.flatMap((x) => (x.line ? [x.line] : []));
  const headLine = planHead(levels, { answered, asked: p.askModel, status });
  let worst: Level | null = null;
  for (const l of levels) if (!worst || levelRank(l) > levelRank(worst)) worst = l;
  return {
    items: out,
    head: headLine,
    lines,
    block: [headLine, ...lines].join("\n"),
    worst,
    counts,
    answered,
    tierFor(i, tier) {
      const level = out[i]?.level;
      if (!tier || !level) return { tier, floored: false };
      const t = floorTier(level, tier, sec.modelFloor as Tier);
      return { tier: t, floored: t !== tier };
    },
  };
}

// --- the model floor at dispatch ----------------------------------------------------------------

export interface SecureModel {
  /** The tier the advice may name. */
  tier: Tier;
  /** The advice would name a tier below the floor or the baseline: it says "keep <model>" instead. */
  keep?: string;
  /** The floor raised the tier. */
  floored: boolean;
}

/**
 * What a model advice may say under security (D6): on HIGH and CRITICAL never a tier below
 * `modelFloor` and never one below the dispatch's baseline tier. When the larger of the two is the
 * baseline's own tier there is nothing to pass: `keep` carries the baseline model ("keep <model>:
 * security HIGH"). Below HIGH the tier is returned as it was.
 */
export function secureModel(
  level: Level,
  tier: Tier,
  modelFloor: Tier,
  baselineModel?: string | null,
): SecureModel {
  if (levelRank(level) < levelRank("high")) return { tier, floored: false };
  const floored = floorTier(level, tier, modelFloor);
  const base = tierOf(baselineModel);
  if (base && TIERS.indexOf(base) >= TIERS.indexOf(floored))
    return { tier: base, keep: baselineModel as string, floored: base !== tier };
  return { tier: floored, floored: floored !== tier };
}

/** "keep opus: security HIGH": what a model advice says when the floor leaves nothing to pass. */
export function keepNote(level: Level, keep: string): string {
  return `keep ${keep}: security ${level.toUpperCase()}`;
}

// --- text for the hook surfaces ----------------------------------------------------------------

export interface HookText {
  /** The line for the agent, when the level reaches minLevel. */
  note?: string;
  /** The message for the user, when the level reaches notifyUser. */
  user?: string;
}

/**
 * The words an assessment earns on a hook surface: the additionalContext line when its level
 * reaches security.minLevel, and the user message when it reaches security.notifyUser. `id` is the
 * stored assessment (the message names it for `security explain`).
 */
export function hookText(
  sec: Pick<SecurityConfig, "minLevel" | "notifyUser">,
  view: AssessmentView,
  o: {
    surface: "agent" | "prompt";
    who?: string | undefined;
    taskId?: number | undefined;
    id?: number | undefined;
  },
): HookText {
  const out: HookText = {};
  const v: AssessmentView = o.id !== undefined ? { ...view, id: o.id } : view;
  if (showsLine(v.level, sec.minLevel)) out.note = hookLine(v, { surface: o.surface });
  if (notifiesUser(v.level, sec.notifyUser))
    out.user = userMessage(v, { who: o.who, taskId: o.taskId });
  return out;
}
