/**
 * The adjudicator's hook call-outs (docs/design/adjudicator.md §10–§11). These are the only
 * functions src/hooks/* call, and they import this module lazily and only while
 * `adjudicator.enabled` is on, so a disabled adjudicator costs one boolean check per hook.
 *
 *   onPrompt        UserPromptSubmit: one advice line, maybe a main-session note (cooldown)
 *   afterRouting    PreToolUse: Agent/Task → onPreAgent + withModel; other raw tools → onPreTool
 *   onPostAgent     PostToolUse Agent/Task: the exact dispatch → subagent link (agentId)
 *   onSessionStart  one line when enabled but degraded; the ollama keep-alive warm-up
 *   onSessionEnd    reconcile; drop the session's main-advice counter
 *
 * Rules that hold everywhere: never deny, respect CLAUDE_CODE_SUBAGENT_MODEL_FORCE, an explicit
 * `model` and a frontmatter pin (managed, project, user or plugin agent; one that cannot be read
 * is not overridden) in advise mode as in apply mode (the advice then names the pin, never a model
 * to pass), move a ranged swarm agent (swarm.yaml `model_range`) only inside its range, skip the
 * Cursor client, and never throw (advice must not break a hook).
 *
 * Effort: advise mode never touches it (the Agent call takes `effort` since Claude Code 2.1.292,
 * it stays advice for the coordinator to pass). Apply mode in scope ALWAYS sets the advised effort
 * on the call, in the same updatedInput as `model` and even when no model is applied (a pinned
 * agent, a ranged one that stays, FORCE) or the call or the agent file already sets an effort:
 * measured on Claude Code 2.1.311, the hook's value wins over both. Never sent: a value outside
 * EFFORTS (it fails the whole Agent call), for a fork (dropped silently), under
 * CLAUDE_CODE_EFFORT_LEVEL (it outranks the hook), or on a denied or asked call. No Claude Code
 * version gate: eminiar holds no version in memory or its DB, and the hook input carries none
 * (only the transcript does, which the hot path does not read); a CLI below 2.1.292 is expected
 * to drop the unknown key.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isHarnessEnvelope, stripLeadingReminders } from "../capture/envelope.js";
import type { AdjudicatorConfig } from "../config.js";
import { getContext, type ProjectContext } from "../context.js";
import { manifestPath, readManifestAt } from "../docs/manifest.js";
import { hookLog } from "../hooks/log.js";
import type { HookInput, HookOutput } from "../hooks/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type { AdjudicationInput, AdjudicationPatch } from "../storage/types.js";
import { coordinationRoot, type SwarmSpawnCheck } from "../swarm/hooks.js";
import type { TaskRow } from "../swarm/types.js";
import { type AgentPin, isFork, resolveAgentPin } from "./agent-pin.js";
import { type AsyncJob, spawnAsyncJob } from "./async.js";
import { resolveAdjudicator } from "./config.js";
import { AGENT_EFFORT_FIELD, EFFORT_APPLIED_FIELD } from "./effort.js";
import { adjudicateOne, cacheKeyFor, type EngineOptions } from "./engine.js";
import { subagentModelForced } from "./env.js";
import { extractFeatures, type FeatureHints } from "./features.js";
import { topIntent } from "./heuristic.js";
import { biasFor, reconcile } from "./learn.js";
import type { FetchLike } from "./providers/http.js";
import {
  ADVISED_PICK_FIELD,
  FALLBACK_PIN_FIELD,
  isPinned,
  type KeptModel,
  RANGED_FLAG,
  resolveBaseline,
  tierOf,
  tierRank,
  withKeptModel,
} from "./savings.js";
import {
  appliedTier,
  dispatchRule,
  EFFORT_ENV_FIELD,
  EFFORT_ENV_OTHER,
  effortForced,
  effortLevel,
  keptModelOf,
  PASSED_EFFORT_FIELD,
  type PlanRange,
  pinnedPart,
  ROLE_NOTE_MIN,
  rangedPart,
  rangedPasses,
  rangedTier,
} from "./swarm.js";
import {
  type AdjudicationAction,
  type AdjudicationRequest,
  type AdjudicationRow,
  type AdjudicatorProvider,
  AGENT_EFFORT_SINCE,
  type Effort,
  type Features,
  type Tier,
  type Verdict,
} from "./types.js";
import { briefUnitsOf } from "./units.js";

// The envelope matchers live in src/capture so the prompt recall can use them without this module.
export { isHarnessEnvelope, stripLeadingReminders };

/** The UserPromptSubmit advice line. */
export const ADVICE_MAX = 220;
/** The SessionStart degraded line. */
export const DEGRADED_MAX = 200;
/** A prompt's tool hint is not given for calls this long after the prompt. */
export const HINT_WINDOW_MS = 30 * 60_000;
/** The Ollama keep-alive job's budget: loading a cold model takes seconds. */
export const WARMUP_BUDGET_MS = 10_000;

/** Native tools whose call may contradict the prompt's advised em_* tool. */
const RAW_TOOLS = new Set(["Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Test seams; the hook call-outs pass none. */
export interface HookDeps {
  /** A ready provider (null forces the heuristic). */
  provider?: AdjudicatorProvider | null | undefined;
  fetch?: FetchLike | undefined;
  spawn?: ((job: AsyncJob) => boolean) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function log(line: string): void {
  hookLog("info", line);
}

/** Is this surface on for this hook call? Cursor never gets adjudicator output. */
function active(cfg: AdjudicatorConfig, input: Pick<HookInput, "client">): boolean {
  return cfg.enabled && input.client !== "cursor";
}

/**
 * The project's indexed documentation names (em_docs manifest: each source's name and its npm/
 * pypi/go/crate package), lower case, for the features' `libraries` hint: a kebab-case name is a
 * package only when listed (review #98 F3). Undefined when nothing is registered, so the lexical
 * rule stands. One small sync read (routing.ts reads the same file on preToolUse), only for a
 * request that gets scored; a hook process handles one event, so there is nothing to cache.
 */
function docsLibraries(ctx: ProjectContext): string[] | undefined {
  const names = new Set<string>();
  for (const src of readManifestAt(manifestPath(ctx), ctx.root).sources) {
    names.add(src.name.toLowerCase());
    const pkg = /^(?:npm|pypi|go|crates?):(.+)$/.exec(String(src.provider ?? ""))?.[1];
    if (pkg) names.add(pkg.toLowerCase());
  }
  return names.size ? [...names] : undefined;
}

function engineOptions(db: StorageAdapter, cfg: AdjudicatorConfig, deps: HookDeps): EngineOptions {
  const o: EngineOptions = {
    config: cfg,
    store: db.adjudicator,
    context: "hook",
    log,
    bias: (_req, f, h) =>
      biasFor(db, cfg.learning, { complexity: h.complexity, intent: topIntent(f) ?? "none" }),
  };
  if (deps.env) o.env = deps.env;
  if (deps.now) o.now = deps.now;
  if (deps.provider !== undefined) o.provider = deps.provider;
  if (deps.fetch) o.deps = { fetch: deps.fetch };
  return o;
}

// --- UserPromptSubmit -----------------------------------------------------------------

export interface PromptAdvice {
  /** One line for Claude (additionalContext). */
  context?: string;
  /** Main-session advice for the user (advice.mainSession "user"). */
  systemMessage?: string;
}

/**
 * "eminiar adjudicator: complexity 1/4 (lookup) · start with em_symbols → em_search · if you
 * delegate: haiku, role explorer" (≤ ADVICE_MAX chars).
 */
export function adviceLine(v: Verdict, f: Features): string {
  const c = Math.round(v.complexity);
  const intent = topIntent(f);
  const parts = [`eminiar adjudicator: complexity ${c}/4${intent ? ` (${intent})` : ""}`];
  if (v.tool.choice !== "none") {
    const tools = v.tool.entries
      .filter((e, i) => e.option !== "none" && (i === 0 || e.score >= 0.1))
      .slice(0, 2)
      .map((e) => e.option);
    if (tools.length) parts.push(`start with ${tools.join(" → ")}`);
  }
  const role = v.role.choice && v.role.choice !== "none" ? `, role ${v.role.choice}` : "";
  parts.push(`if you delegate: ${v.tier.choice}${role}`);
  return clip(parts.join(" · "), ADVICE_MAX);
}

/**
 * Score the prompt: skipped below minPromptChars, for slash commands and chat-only input.
 * A harness envelope (isHarnessEnvelope) is not a prompt at all: no row, no advice, no
 * cooldown tick, and the previous prompt keeps its tool hint.
 * promptMode heuristic → no provider; async → a detached job; blocking → inline within promptMs.
 */
export async function onPrompt(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: HookInput,
  sessionId: string,
  deps: HookDeps = {},
): Promise<PromptAdvice | undefined> {
  try {
    const cfg = ctx.config.adjudicator;
    if (!active(cfg, input) || !cfg.surfaces.prompt) return undefined;
    const raw = (input.prompt ?? "").trim();
    // A subagent's hand-back or a task notification arrives while the user's prompt is still
    // being worked on: leave that prompt's row, hint and cooldown as they are.
    if (isHarnessEnvelope(raw)) return undefined;
    // Harness context ahead of typed text: score the typed text.
    const text = stripLeadingReminders(raw);
    if (text.length < cfg.minPromptChars || text.startsWith("/") || extractFeatures(text).chat) {
      // A skipped prompt still ends the previous prompt's tool hint.
      if (cfg.surfaces.tools) closeToolHint(db, sessionId);
      return undefined;
    }
    const opts = engineOptions(db, cfg, deps);
    opts.call =
      cfg.promptMode === "heuristic" ? "never" : cfg.promptMode === "async" ? "async" : "inline";
    if (opts.call === "async") {
      opts.spawn = deps.spawn ?? ((job) => spawnAsyncJob(job));
      opts.projectRoot = ctx.root;
    }
    if (sessionId && sessionId !== "unknown") opts.row = { sessionId };
    const req: AdjudicationRequest = { key: "prompt", surface: "prompt", text };
    const libraries = docsLibraries(ctx);
    if (libraries) {
      const hints: FeatureHints = { libraries };
      req.hints = hints;
    }
    const a = await adjudicateOne(req, opts);
    const out: PromptAdvice = { context: adviceLine(a.verdict, a.features) };
    const main = mainSessionAdvice(db, cfg, sessionId, a.verdict, (deps.now ?? Date.now)());
    if (main) {
      if (cfg.advice.mainSession === "user") out.systemMessage = main;
      else out.context = `${out.context}\n${main}`;
    }
    return out;
  } catch (err) {
    log(`adjudicator: onPrompt ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

/**
 * Main-session advice: only when the session model (the latest main-thread api_calls row) is
 * at least 2 tiers above the advice, and at most once per cooldownPrompts prompts. The prompt
 * counter lives in meta `adjudicator:main:<session>` as {n, last}.
 */
function mainSessionAdvice(
  db: StorageAdapter,
  cfg: AdjudicatorConfig,
  sessionId: string,
  v: Verdict,
  now: number,
): string | undefined {
  if (cfg.advice.mainSession === "off" || !sessionId || sessionId === "unknown") return undefined;
  const key = `adjudicator:main:${sessionId}`;
  let st: { n: number; last?: number } = { n: 0 };
  try {
    const raw = db.metaGet(key);
    if (raw) st = JSON.parse(raw) as typeof st;
  } catch {
    // a bad counter restarts it
  }
  st.n = (Number(st.n) || 0) + 1;
  let line: string | undefined;
  if (st.last === undefined || st.n - st.last >= cfg.advice.cooldownPrompts) {
    // The main session's own model: CLAUDE_CODE_SUBAGENT_MODEL is a subagent baseline only.
    const base = resolveBaseline(db, { sessionId, ts: now, env: {} });
    const current = base.source === "session" ? tierOf(base.model) : undefined;
    const advice = v.tier.choice;
    if (current && tierRank(advice) >= 0 && tierRank(current) - tierRank(advice) >= 2) {
      const c = Math.round(v.complexity);
      line = `eminiar adjudicator: this prompt looks ${c <= 1 ? "small" : "moderate"} (complexity ${c}/4); /model ${advice} would be cheaper than ${current}`;
      st.last = st.n;
    }
  }
  db.metaSet(key, JSON.stringify(st));
  return line;
}

// --- PreToolUse -----------------------------------------------------------------------

/**
 * The model and/or the effort on an Agent call, merged into the ONE updatedInput routing returns:
 * routing's own updatedInput (enforce prefix) when there is one, else the full original input.
 * The effort is sent only when it is a member of EFFORTS (any other value fails the whole call).
 * A deny or ask is never turned into an allow.
 */
export function withModel(
  out: HookOutput | undefined,
  input: Record<string, unknown>,
  model: string | undefined,
  effort?: string,
): HookOutput | undefined {
  const h = out?.hookSpecificOutput;
  if (h?.permissionDecision === "deny" || h?.permissionDecision === "ask") return out;
  const level = effortLevel(effort);
  if (!model && !level) return out;
  return {
    ...out,
    hookSpecificOutput: {
      ...h,
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...(h?.updatedInput ?? input),
        ...(model ? { model } : {}),
        ...(level ? { effort: level } : {}),
      },
    },
  };
}

/** One more additionalContext line on a PreToolUse output. */
export function withNote(
  out: HookOutput | undefined,
  note: string | undefined,
): HookOutput | undefined {
  if (!note) return out;
  const h = out?.hookSpecificOutput;
  const cur = h?.additionalContext;
  return {
    ...out,
    hookSpecificOutput: {
      ...h,
      hookEventName: "PreToolUse",
      additionalContext: cur ? `${cur}\n${note}` : note,
    },
  };
}

/**
 * Called by routing after it decided: the Agent model (apply) or advice note, or a tool hint
 * for a raw tool. Returns routing's output, extended; never throws.
 */
export async function afterRouting(
  ctx: ProjectContext,
  input: HookInput,
  spawn: SwarmSpawnCheck | undefined,
  out: HookOutput | undefined,
  deps: HookDeps = {},
): Promise<HookOutput | undefined> {
  try {
    if (!active(ctx.config.adjudicator, input) || !input.tool_input) return out;
    if (AGENT_TOOLS.has(input.tool_name ?? "")) {
      // A denied or asked call is never rewritten: onPreAgent then applies no effort either.
      const pd = out?.hookSpecificOutput?.permissionDecision;
      const a = await onPreAgent(ctx, input, spawn, deps, pd === "deny" || pd === "ask");
      if (!a) return out;
      const next = a.model || a.effort ? withModel(out, input.tool_input, a.model, a.effort) : out;
      return withNote(next, a.note);
    }
    return withNote(out, onPreTool(ctx, input, out, deps));
  } catch (err) {
    log(`adjudicator: afterRouting ${(err as Error)?.message ?? String(err)}`);
    return out;
  }
}

export interface AgentAdvice {
  /** Set only when apply mode applies a tier. */
  model?: Tier;
  /** Set when apply mode puts the advised effort on the call (a member of EFFORTS). */
  effort?: Effort;
  note?: string;
  action: AdjudicationAction;
  rowId?: number;
}

/**
 * The tier within [floor, ceiling] on the haiku < sonnet < opus < fable ladder. Same rule as
 * swarm.ts appliedTier, which plan lines use, so the plan line and the Agent note agree.
 */
export function clampTier(tier: string, floor: Tier, ceiling: Tier): Tier | undefined {
  return appliedTier(tier, floor, ceiling);
}

/**
 * The row's scores JSON with the agent-pin lookup added under `pin`, so a decision shows why a
 * model was or was not applied. Empty when the row or its scores cannot be read.
 */
function withPin(
  db: StorageAdapter,
  rowId: number,
  pin: AgentPin,
  kept: KeptModel | undefined,
  extra: Record<string, unknown> = {},
): { scores?: string } {
  try {
    // The KeptModel flag (pinDeferred / forced / fork): the advice named no model, so reconcile
    // neither detects a follow nor credits savings for the row (savings.ts).
    const scores = withKeptModel(db.adjudicator.get(rowId)?.scores, kept, { pin, ...extra });
    return scores === undefined ? {} : { scores };
  } catch {
    return {};
  }
}

/**
 * The role-table confidence a stored row was scored with: its scores JSON `role` table (the one
 * its role came from), else the brief's heuristic role confidence (units.ts).
 */
function storedRoleConfidence(scores: string | null | undefined): number | undefined {
  if (!scores) return undefined;
  try {
    const c = (JSON.parse(scores) as { role?: { confidence?: unknown } } | null)?.role?.confidence;
    if (typeof c === "number" && Number.isFinite(c)) return c;
  } catch {
    return undefined;
  }
  return briefUnitsOf(scores)?.roleConfidence;
}

/** The swarm task of a worker dispatch: this project's ledger, else the coordination root's. */
function findTask(
  ctx: ProjectContext,
  db: StorageAdapter,
  runId: string,
  taskId: number,
): { db: StorageAdapter; task: TaskRow } | undefined {
  const t = db.swarm.taskGet(taskId);
  if (t && t.run_id === runId) return { db, task: t };
  const main = coordinationRoot(ctx.root);
  if (main === ctx.root) return undefined;
  const mdb = getStorage(getContext(main), { vectors: false });
  const m = mdb.swarm.taskGet(taskId);
  return m && m.run_id === runId ? { db: mdb, task: m } : undefined;
}

/**
 * An Agent/Task dispatch: plan row (run, task) → cache → heuristic; on a miss in apply mode the
 * provider within agentMs. Inserts one `agent` row (parent = plan row, model requested, baseline
 * model, action). Advise mode never calls the network.
 */
export async function onPreAgent(
  ctx: ProjectContext,
  input: HookInput,
  spawn: SwarmSpawnCheck | undefined,
  deps: HookDeps = {},
  /** Routing denied or asked: the call is not rewritten, so no effort is applied. */
  blocked = false,
): Promise<AgentAdvice | undefined> {
  const cfg = ctx.config.adjudicator;
  if (!active(cfg, input) || !cfg.surfaces.agent) return undefined;
  if (!AGENT_TOOLS.has(input.tool_name ?? "")) return undefined;
  const ti = input.tool_input ?? {};
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const worker = spawn?.kind === "worker" ? spawn : undefined;
  const agentType = str(ti.subagent_type) ?? "general-purpose";

  let db = getStorage(ctx, { vectors: false });
  let task: TaskRow | undefined;
  if (worker?.runId && typeof worker.taskId === "number") {
    try {
      const found = findTask(ctx, db, worker.runId, worker.taskId);
      if (found) ({ db, task } = found);
    } catch {
      // no task text: fall back to the dispatch's own
    }
  }
  const text = task
    ? `${task.title}\n${task.detail ?? ""}`
    : `${str(ti.description) ?? ""}\n${str(ti.prompt) ?? ""}`;
  if (!text.trim()) return undefined;

  let plan: AdjudicationRow | undefined;
  if (task && worker?.runId) {
    try {
      plan = db.adjudicator
        .forTask(worker.runId, task.id)
        .filter((r) => r.surface === "plan")
        .pop();
    } catch {
      // no plan verdict
    }
  }

  const explicit = str(ti.model);
  // The agent's definition in Claude Code's lookup order. A pin that cannot be read (a plugin
  // agent without a readable file, a --agents session agent) is never overridden: advice only.
  const pin = resolveAgentPin(agentType, { root: ctx.root, cwd: input.cwd, env });
  const pinned = pin.status === "pinned" ? pin.model : undefined;
  const pinnedRespected = cfg.apply.respectFrontmatter && isPinned(pinned);
  const pinUnknown = cfg.apply.respectFrontmatter && pin.status === "unknown";
  const isForced = subagentModelForced(env);
  const fork = isFork(agentType);
  const effortEnv = effortForced(env);
  const effortSet = !!str(ti.effort) || effortEnv;
  // The agent file's own `effort` (a fork has no file); an applied effort overrides it.
  const agentEffort = fork ? undefined : pin.effort;
  // A ranged swarm agent (swarm.yaml model_range) runs on its fallback pin unless the adjudicator
  // picks another tier inside its range. A fork and FORCE come first, as in dispatchRule.
  const ranged: PlanRange | undefined =
    cfg.apply.respectFrontmatter &&
    !fork &&
    !isForced &&
    pin.status === "ranged" &&
    pin.range &&
    isPinned(pin.model)
      ? { floor: pin.range.floor, ceiling: pin.range.ceiling, fallback: pin.model }
      : undefined;
  // One rule table for plan advice, the plan's Next line and this note (swarm.ts dispatchRule).
  // Before the verdict a ranged agent may move; whether its pick does is settled below.
  const facts = { fork, forced: isForced, pin: pinnedRespected || pinUnknown, effortSet };
  const before = dispatchRule({ ...facts, ranged: !!ranged });
  const applyMode = cfg.mode === "apply";
  const inScope = cfg.apply.scope === "all" || !!worker;
  const mayApply =
    applyMode && inScope && (before.model === "pass" || before.model === "ranged") && !explicit;
  const sessionId =
    input.session_id && input.session_id !== "unknown" ? input.session_id : undefined;
  // Without the adjudicator: FORCE runs CLAUDE_CODE_SUBAGENT_MODEL (else the main session's model)
  // and ignores pins; a fork runs on the main session's model; a ranged agent runs on its
  // fallback; an agent without a `model` line runs on CLAUDE_CODE_SUBAGENT_MODEL when it is set
  // (`model: inherit` outranks it). FORCE is settled here, so only that variable is passed on.
  const subagentEnv =
    before.model === "fork" || before.model === "forced" || pin.inherit
      ? {}
      : { CLAUDE_CODE_SUBAGENT_MODEL: env.CLAUDE_CODE_SUBAGENT_MODEL };
  // A ranged agent whose range is not respected (apply.respectFrontmatter off) still runs its
  // `model:` line without the adjudicator, so that pin is its baseline, as for a plain pin. Only
  // the baseline widens: `pinned` stays plain so a respected range never takes the pin branch.
  const baselinePin = pin.status === "ranged" ? pin.model : pinned;
  const baseline = resolveBaseline(db, {
    pinned:
      before.model === "fork"
        ? undefined
        : before.model === "forced"
          ? str(env.CLAUDE_CODE_SUBAGENT_MODEL)
          : baselinePin,
    fallbackPin: ranged?.fallback,
    env: subagentEnv,
    sessionId,
    ts: now,
  });

  const row: Partial<AdjudicationInput> = {
    modelRequested: explicit ?? null,
    baselineModel: baseline.model,
  };
  if (sessionId) row.sessionId = sessionId;
  if (input.tool_use_id) row.toolUseId = input.tool_use_id;
  if (worker?.runId && task) {
    row.runId = worker.runId;
    row.taskId = task.id;
  }
  if (plan) {
    // The plan already scored this task: its verdict is the decision, no provider call.
    row.parentId = plan.id;
    for (const k of ["complexity", "tier", "effort", "tool", "role", "confidence"] as const)
      if (plan[k] !== undefined && plan[k] !== null) (row as Record<string, unknown>)[k] = plan[k];
  }

  const opts = engineOptions(db, cfg, deps);
  // The provider is consulted when the verdict will be applied: the model (mayApply) or, on a
  // pinned, explicit-model or FORCE dispatch, the effort alone, which overrides the call's and
  // the agent file's own. Advise mode, a fork, a blocked call and CLAUDE_CODE_EFFORT_LEVEL
  // (nothing to apply) stay call-free.
  const willApplyEffort = applyMode && inScope && !blocked && !fork && !effortEnv;
  opts.call = (mayApply || willApplyEffort) && !plan ? "inline" : "never";
  opts.row = row;
  const req: AdjudicationRequest = { key: "agent", surface: "agent", text };
  const hints: FeatureHints = {};
  if (task) {
    hints.files = task.files.length;
    hints.deps = task.deps.length;
    if (task.role) hints.role = task.role;
  }
  const libraries = docsLibraries(ctx);
  if (libraries) hints.libraries = libraries;
  if (Object.keys(hints).length) req.hints = hints;
  const a = await adjudicateOne(req, opts);
  const v = a.verdict;
  const tier = plan?.tier ?? v.tier.choice;
  const conf = plan?.confidence ?? v.tier.confidence;
  const c = Math.round(plan?.complexity ?? v.complexity);
  const effort = plan?.effort ?? v.effort;
  const role = plan?.role ?? v.role.choice;
  const clamped = clampTier(tier, cfg.apply.floor, cfg.apply.ceiling);
  // The plan row's brief scoring when there is one (its verdict is the decision), else this one's;
  // a row without `units` counts as not saturated (units.ts).
  const units = plan ? briefUnitsOf(plan.scores) : a.units;
  const saturated = !!units?.saturated;
  const roleConf = (plan ? storedRoleConfidence(plan.scores) : undefined) ?? v.role.confidence;
  // A ranged agent's pick inside its range ∩ apply.floor..ceiling; it moves the model only when
  // it is not the fallback's tier (the bare tier would replace a pinned id or [1m] variant).
  const pick = ranged ? rangedTier(tier, ranged, cfg.apply.floor, cfg.apply.ceiling) : undefined;
  const moves = !!ranged && rangedPasses(pick, ranged.fallback);
  // Apply mode in scope sets the advised effort whatever the call or the agent file says (the
  // hook's value wins); only CLAUDE_CODE_EFFORT_LEVEL outranks it, so that alone is `effortSet`.
  const effortApply = applyMode && inScope && !blocked && !!effortLevel(effort);
  const rule = dispatchRule({
    ...facts,
    ranged: moves,
    pin: facts.pin || (!!ranged && !moves),
    saturated,
    effortApply,
    effortSet: effortApply ? effortEnv : facts.effortSet,
  });
  const effortSent = rule.effort === "applied" ? effortLevel(effort) : undefined;

  let action: AdjudicationAction;
  let model: Tier | undefined;
  let modelFinal: string | null;
  if (!applyMode || !inScope) {
    action = "advised";
    modelFinal = explicit ?? null;
  } else if (fork) {
    // A fork runs on the main session's model: nothing to apply or keep.
    action = "respected";
    modelFinal = null;
  } else if (isForced || explicit || pinnedRespected) {
    action = "respected";
    // Under FORCE Claude Code ignores the call's model and the pin: CLAUDE_CODE_SUBAGENT_MODEL
    // runs, else the main session's model (unknown here).
    modelFinal = isForced
      ? (str(env.CLAUDE_CODE_SUBAGENT_MODEL) ?? null)
      : (explicit ?? (isPinned(pinned) ? pinned : null));
  } else if (ranged) {
    // Inside the range only; a pick that is the fallback's tier, or a low confidence, leaves the
    // call alone and the agent runs on its fallback.
    if (moves && pick && conf >= cfg.apply.minConfidence) {
      action = "applied";
      model = pick;
      modelFinal = pick;
    } else {
      action = moves ? "advised" : "respected";
      modelFinal = ranged.fallback;
    }
  } else if (clamped && conf >= cfg.apply.minConfidence && !pinUnknown) {
    action = "applied";
    model = clamped;
    modelFinal = clamped;
  } else {
    action = "advised";
    modelFinal = null;
  }
  // Advise mode respects a pin, FORCE and a fork like apply mode: no model to pass, and no
  // savings credit later (also when the coordinator passes a model anyway: it was not advised).
  const kept = model ? undefined : keptModelOf(rule);
  const pinDeferred = kept === "pin";
  const advised = ranged ? pick : clamped;
  if (a.rowId !== undefined) {
    try {
      db.adjudicator.update(a.rowId, {
        action,
        modelFinal,
        // A ranged dispatch is flagged with its fallback, the savings baseline. Every dispatch
        // stores the tier its note names (the ranged pick, else the verdict clamped to the apply
        // bounds), the model follow detection compares the call with (savings.ts advisedPick).
        ...withPin(db, a.rowId, pin, kept, {
          ...(ranged ? { [RANGED_FLAG]: true, [FALLBACK_PIN_FIELD]: ranged.fallback } : {}),
          ...(advised ? { [ADVISED_PICK_FIELD]: advised } : {}),
          // What the agent file sets, what the call passed, and the effort the hook put on the
          // call (it overrides both), for the swarm decision view and the follow check.
          ...(agentEffort ? { [AGENT_EFFORT_FIELD]: agentEffort } : {}),
          ...(effortSent ? { [EFFORT_APPLIED_FIELD]: effortSent } : {}),
          ...(effortLevel(ti.effort) ? { [PASSED_EFFORT_FIELD]: effortLevel(ti.effort) } : {}),
          // A level outside EFFORTS (e.g. "auto") still outranks the call: stored as "other".
          ...(effortForced(env)
            ? { [EFFORT_ENV_FIELD]: effortLevel(env.CLAUDE_CODE_EFFORT_LEVEL) ?? EFFORT_ENV_OTHER }
            : {}),
        }),
      });
    } catch {
      // the row keeps its verdict without the action
    }
  }

  const why = `complexity ${c}, conf ${conf.toFixed(2)}`;
  if (rule.model === "fork") {
    // A fork runs on the main session's model and takes no per-call effort: nothing to pass, and
    // an effort the hook set would be dropped, so apply mode does not set one.
    const note =
      applyMode && inScope
        ? `adjudicator: fork runs on the main session's model; no \`model\` to pass, effort not applied (a fork takes none; ${why})`
        : `adjudicator: fork runs on the main session's model; no \`model\` or \`effort\` to pass (${why})`;
    const out: AgentAdvice = { action, note: clip(note, ADVICE_MAX) };
    if (a.rowId !== undefined) out.rowId = a.rowId;
    return out;
  }
  // Apply mode sets `effort` itself (it wins over the call and the agent file) unless
  // CLAUDE_CODE_EFFORT_LEVEL outranks it. Advise mode: the Agent call takes `effort` (Claude Code
  // 2.1.292+) unless that env var outranks it, the call already passes one, or the brief is
  // saturated, and the coordinator passes it; when the agent file sets one, the note says whether
  // it already matches the advice.
  const effortHint =
    rule.effort === "applied"
      ? `effort ${effort} applied`
      : applyMode && inScope && effortEnv && !blocked
        ? `effort ${effort} not applied: CLAUDE_CODE_EFFORT_LEVEL is set and outranks it`
        : rule.effort === "pass"
          ? agentEffort === effort
            ? `effort ${effort}: the agent file already sets it`
            : `pass effort:'${effort}' (Claude Code ${AGENT_EFFORT_SINCE}+)${
                agentEffort ? ` over the agent file's ${agentEffort}` : ""
              }`
          : saturated && !effortSet
            ? `effort ${effort}: informational (brief saturated)${
                agentEffort ? `; the agent file runs ${agentEffort}` : ""
              }`
            : `suggested effort ${effort}`;
  const extras = [effortHint];
  // A role is named only from a confident role table.
  if (role && role !== "none" && roleConf >= ROLE_NOTE_MIN) extras.push(`role ${role}`);
  if (applyMode && inScope && pinUnknown && !isForced && !explicit)
    extras.push("not applied: the agent's model pin is unknown");
  const span = ranged
    ? `range ${ranged.floor}–${ranged.ceiling}, fallback ${ranged.fallback}; `
    : "";
  let note: string;
  if (action === "applied") {
    note = `adjudicator: model ${model} applied (${span}${why}); ${extras.join(", ")}`;
  } else if (rule.model === "forced") {
    // Claude Code ignores `model` on the call and the agent's pin: the model is informational.
    note = `adjudicator: CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets the model${
      clamped ? ` (adjudicator would pick ${clamped}; ${why})` : ` (${why})`
    }; ${extras.join(", ")}`;
  } else if (rule.model === "ranged" && !explicit) {
    note = `adjudicator: model ${pick} would do (${span}${why}): pass model:'${pick}'; ${extras.join(", ")}`;
  } else if (ranged && pinDeferred && !explicit) {
    // The pick is the fallback's tier (or outside the apply bounds): the fallback stays.
    note = `adjudicator: ${rangedPart(ranged, pick)}; ${extras.join(", ")}`;
  } else if (pinDeferred && !explicit) {
    const part = pinnedPart(
      { status: pinUnknown ? "unknown" : "pinned", model: pinned, source: pin.source },
      clamped,
      worker && pin.source === "project"
        ? undefined
        : `remove the model pin in ${pin.file ?? "the agent's definition"}`,
    );
    note = `adjudicator: ${part}; ${extras.filter((e) => !e.startsWith("not applied")).join(", ")}`;
  } else if (
    action === "advised" &&
    !explicit &&
    clamped &&
    clamped !== (tierOf(baseline.model) ?? baseline.model)
  ) {
    note = `adjudicator: model ${clamped} would do (${why}): pass model:'${clamped}'; ${extras.join(", ")}`;
  } else {
    note = `adjudicator: ${extras.join(", ")}`;
  }
  const out: AgentAdvice = { action, note: clip(note, ADVICE_MAX) };
  if (model) out.model = model;
  if (effortSent) out.effort = effortSent;
  if (a.rowId !== undefined) out.rowId = a.rowId;
  return out;
}

// --- PostToolUse ----------------------------------------------------------------------

/** How far back onPostAgent looks for the dispatch row (a foreground agent can run for hours). */
export const POST_AGENT_LOOKBACK_MS = 24 * 3_600_000;

/**
 * The subagent an Agent/Task call started, from its PostToolUse payload. Claude Code passes the
 * tool's structured output as `tool_response` (the transcript's toolUseResult): both the
 * foreground `completed` and the background `async_launched` shapes carry `agentId` (the id
 * sidechain transcript entries, so api_calls.agent_id, use) and `resolvedModel` (the model the
 * subagent started on). Without an agentId, the session's subagents/agent-<id>.meta.json whose
 * `toolUseId` matches is the fallback.
 */
export function agentLinkOf(
  input: Pick<HookInput, "tool_response" | "tool_use_id" | "transcript_path">,
): { agentId: string; resolvedModel?: string } | undefined {
  const r = input.tool_response;
  const o = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
  const resolvedModel = str(o.resolvedModel);
  const agentId = str(o.agentId) ?? agentFromMeta(input.transcript_path, input.tool_use_id);
  if (!agentId) return undefined;
  return resolvedModel ? { agentId, resolvedModel } : { agentId };
}

/** The agent id whose `<session>/subagents/agent-<id>.meta.json` names this tool_use_id. */
function agentFromMeta(
  transcriptPath: string | undefined,
  toolUseId: string | undefined,
): string | undefined {
  if (!transcriptPath || !toolUseId) return undefined;
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(n));
  } catch {
    return undefined;
  }
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as { toolUseId?: unknown };
      if (m?.toolUseId === toolUseId) return n.slice("agent-".length, -".meta.json".length);
    } catch {
      // an unreadable meta file is skipped
    }
  }
  return undefined;
}

/**
 * PostToolUse for an Agent/Task call: the dispatch row PreToolUse wrote (same tool_use_id) gets
 * the subagent's agentId, and its resolvedModel as actualModel until reconcile prices the
 * subagent's own calls. An exact link, so parallel same-tier dispatches that the window
 * matcher must leave ambiguous are linked too; reconcile already prefers row.agentId. A row
 * that has an agent id keeps it. Returns the row id it linked; never throws.
 */
export function onPostAgent(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: HookInput,
  deps: Pick<HookDeps, "now"> = {},
): number | undefined {
  try {
    const cfg = ctx.config.adjudicator;
    if (!active(cfg, input) || !cfg.surfaces.agent) return undefined;
    if (!AGENT_TOOLS.has(input.tool_name ?? "") || !input.tool_use_id) return undefined;
    const link = agentLinkOf(input);
    if (!link) return undefined;
    const since = (deps.now ?? Date.now)() - POST_AGENT_LOOKBACK_MS;
    // A worker's dispatch row may live in the coordination root's ledger (onPreAgent findTask).
    const dbs = [db];
    const main = coordinationRoot(ctx.root);
    if (main !== ctx.root) dbs.push(getStorage(getContext(main), { vectors: false }));
    for (const d of dbs) {
      // One indexed lookup (adjudications_tool_use), not a scan of recent rows.
      const row = d.adjudicator.byToolUseId(input.tool_use_id, { surface: "agent", since });
      if (!row) continue;
      if (row.agentId) {
        if (row.agentId !== link.agentId)
          log(
            `adjudicator: row ${row.id} keeps agent ${row.agentId}, dispatch says ${link.agentId}`,
          );
        return undefined;
      }
      const patch: AdjudicationPatch = { agentId: link.agentId };
      if (link.resolvedModel && !row.actualModel) patch.actualModel = link.resolvedModel;
      d.adjudicator.update(row.id, patch);
      return row.id;
    }
    return undefined;
  } catch (err) {
    log(`adjudicator: onPostAgent ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

/**
 * A raw tool call that contradicts the prompt's advised em_* tool: one hint per prompt, only
 * when routing said nothing. Exactly one SELECT (the session's latest prompt row); the prompt
 * row's tool_use_id marks that its hint was given.
 */
export function onPreTool(
  ctx: ProjectContext,
  input: HookInput,
  out: HookOutput | undefined,
  deps: HookDeps = {},
): string | undefined {
  const cfg = ctx.config.adjudicator;
  if (!active(cfg, input) || !cfg.surfaces.tools) return undefined;
  if (!RAW_TOOLS.has(input.tool_name ?? "") || !input.session_id) return undefined;
  const h = out?.hookSpecificOutput;
  if (h?.additionalContext || h?.permissionDecision) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    const row = db.adjudicator.latestForSession(input.session_id, "prompt");
    if (!row || row.toolUseId || !row.tool?.startsWith("em_")) return undefined;
    if ((deps.now ?? Date.now)() - row.ts > HINT_WINDOW_MS) return undefined;
    db.adjudicator.update(row.id, { toolUseId: input.tool_use_id || "hinted" });
    const c = Math.round(row.complexity ?? 0);
    return clip(
      `eminiar adjudicator: this prompt was scored for ${row.tool} (complexity ${c}/4); ${input.tool_name} works, but ${row.tool} usually answers it with less context.`,
      ADVICE_MAX,
    );
  } catch {
    return undefined;
  }
}

/** Mark the session's latest prompt row as hinted, so a skipped prompt does not inherit its hint. */
function closeToolHint(db: StorageAdapter, sessionId: string): void {
  try {
    const row = db.adjudicator.latestForSession(sessionId, "prompt");
    if (row && !row.toolUseId) db.adjudicator.update(row.id, { toolUseId: "superseded" });
  } catch {
    // hints are optional
  }
}

// --- SessionStart / SessionEnd ------------------------------------------------------------

/**
 * One line (≤ DEGRADED_MAX) only when the adjudicator is on but degraded: no key, no consent,
 * misconfigured, breaker open or slow, apply not taking effect. No network inline; with the
 * ollama preset it spawns an async keep-alive job.
 */
export function onSessionStart(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: Pick<HookInput, "client">,
  deps: HookDeps = {},
): string | undefined {
  try {
    const cfg = ctx.config.adjudicator;
    if (!active(cfg, input)) return undefined;
    const env = deps.env ?? process.env;
    const now = (deps.now ?? Date.now)();
    const r = resolveAdjudicator(cfg, { context: "hook", env });
    const issues: string[] = [];
    if (r.degraded === "no_key") issues.push(`no key for ${r.configured}`);
    else if (r.degraded === "no_consent")
      issues.push(`${r.configured} is remote and has no consent`);
    else if (r.degraded && r.degraded !== "hook_context")
      // misconfigured, or a reason added later: hooks use the heuristic + cached verdicts.
      issues.push(
        `${r.configured}: ${String(r.degraded).replace(/_/g, " ")}${r.detail ? ` (${r.detail})` : ""}`,
      );
    if (r.provider !== "heuristic") {
      const s = db.adjudicator.providerState(r.provider);
      if (s && s.state !== "closed" && s.retryAt !== null && s.retryAt > now)
        issues.push(`${r.provider} ${s.state === "slow" ? "is slow" : "breaker open"}`);
    }
    if (cfg.mode === "apply") {
      const sum = db.adjudicator.summary(now - 7 * 86_400_000);
      if (sum.applyIneffective > 0)
        issues.push(
          `apply did not take effect on ${sum.applyIneffective} of ${sum.applyChecked} dispatches: use advise`,
        );
    }
    if (
      r.provider === "openai-compatible" &&
      r.preset === "ollama" &&
      cfg.promptMode !== "heuristic"
    )
      warmUp(ctx, cfg, r, deps);
    if (!issues.length) return undefined;
    return clip(
      `eminiar adjudicator: ${issues.join("; ")}; \`eminiar adjudicator status\` explains.`,
      DEGRADED_MAX,
    );
  } catch {
    return undefined;
  }
}

function warmUp(
  ctx: ProjectContext,
  cfg: AdjudicatorConfig,
  r: ReturnType<typeof resolveAdjudicator>,
  deps: HookDeps,
): void {
  const request: AdjudicationRequest = { key: "warmup", surface: "test", text: "warm up" };
  const job: AsyncJob = {
    v: 1,
    projectRoot: ctx.root,
    request,
    // The same key the child computes (no hints or catalogues: just the config's ladder and weights).
    cacheKey: cacheKeyFor(request, r, { config: cfg }),
    config: cfg,
    context: "hook",
    budgetMs: WARMUP_BUDGET_MS,
  };
  (deps.spawn ?? ((j: AsyncJob) => spawnAsyncJob(j)))(job);
}

/** Link outcomes, tokens and savings for the rows this session left behind. */
export function onSessionEnd(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: Pick<HookInput, "client" | "session_id">,
): void {
  try {
    if (!active(ctx.config.adjudicator, input)) return;
    // The main-session advice counter (mainSessionAdvice) is per session; drop it with the session.
    if (input.session_id) db.metaDelete(`adjudicator:main:${input.session_id}`);
    reconcile(db, { limit: 200, config: ctx.config });
  } catch (err) {
    log(`adjudicator: reconcile ${(err as Error)?.message ?? String(err)}`);
  }
}
