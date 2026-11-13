/**
 * The hook entry points of the security advice (docs/design/adjudicator-security.md, part 9).
 * The hooks import this module lazily, and only after `adjudicatorWanted` (src/config.ts) said the
 * surface is on, so a build with security off never loads it. It does not load the routing
 * adjudicator (hooks.ts, the engine, the providers): security-only mode must stay light.
 *
 *   securityPreAgent       PreToolUse Agent/Task: assess the dispatch; no write, no network
 *   recordAdvice           store the row (beside the routing row when there is one), word the user message
 *   withSecurity           add the line and the user message to the hook's output, never a decision
 *   securityAfterRouting   security-only mode: the three above for Agent/Task
 *   securityOnPrompt       UserPromptSubmit: the prompt's line, in both modes
 *
 * Rules that hold here: advice only (nothing is denied, asked, allowed or rewritten: no
 * permissionDecision, no updatedInput), a dispatch never waits for a model (a worker reuses the
 * plan's answer), a HIGH or CRITICAL dispatch holds the adjudicator's apply mode (no model, no
 * effort, so no auto-allow), the Cursor client is skipped, and nothing throws.
 */

import type { AdjudicatorConfig } from "../../config.js";
import type { ProjectContext } from "../../context.js";
import { hookLog } from "../../hooks/log.js";
import type { HookInput, HookOutput } from "../../hooks/types.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import { getStorage } from "../../storage/index.js";
import type { SwarmSpawnCheck } from "../../swarm/hooks.js";
import type { AgentPin } from "../agent-pin.js";
import {
  type AssessDeps,
  assessDispatch,
  assessPrompt,
  type DispatchAssessment,
  hookText,
  type PromptAssessment,
  record,
} from "./assess.js";
import { levelRank } from "./combine.js";
import type { Level } from "./types.js";

// The model floor at dispatch lives in assess.ts; re-exported so the routing adjudicator's one lazy
// import of this module brings everything a dispatch needs.
export { keepNote, type SecureModel, secureModel } from "./assess.js";

const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** Is the security advice on for this surface and client? (A Cursor payload never gets any.) */
export function securityActive(
  ctx: Pick<ProjectContext, "config">,
  input: Pick<HookInput, "client">,
  point: "agent" | "prompt",
): boolean {
  const s = ctx.config.adjudicator.security;
  return s.enabled && s.surfaces[point] && input.client !== "cursor";
}

/**
 * The note an apply-mode dispatch gets when security held it: "apply held: security HIGH". The
 * routing adjudicator records the action "advised" and names no model and no effort.
 */
export function heldNote(adv: Pick<SecurityAdvice, "level">): string {
  return `apply held: security ${adv.level.toUpperCase()}`;
}

/** A denied call is not annotated: nothing runs. (An `ask` still is: the user is shown the line too.) */
export function isDenied(out: HookOutput | undefined): boolean {
  return out?.hookSpecificOutput?.permissionDecision === "deny";
}

/** One dispatch's security advice: the assessment, what it earned, and what is left to store. */
export interface SecurityAdvice {
  surface: "agent" | "prompt";
  assessed: DispatchAssessment | PromptAssessment;
  level: Level;
  /**
   * HIGH or CRITICAL: the adjudicator's apply mode stands down for this dispatch (no `model`, no
   * `effort`, so no updatedInput and no permissionDecision "allow"), and its model advice keeps
   * the security floor (assess.secureModel).
   */
  hold: boolean;
  /** The additionalContext line, when the level reaches security.minLevel. */
  note?: string;
  /** The message for the user, when the level reaches security.notifyUser. */
  systemMessage?: string;
  /** adjudicator_security.id, once recordAdvice stored it. */
  id?: number;
  /** For the user message: the agent type, and the swarm task. */
  who?: string;
  taskId?: number;
  // what recordAdvice needs
  cfg: AdjudicatorConfig;
  db: StorageAdapter;
}

function logFail(what: string, err: unknown): void {
  hookLog("info", `security: ${what} ${(err as Error)?.message ?? String(err)}`);
}

/**
 * Assess an Agent/Task dispatch. Heuristic only: the grant of the agent's definition, the task or
 * the call's text, the session taint and the plan's model answer (a worker's), at most ten
 * milliseconds and never the network. Returns undefined when the surface is off, the tool is not an
 * agent spawn or anything failed (the call then goes on as routing decided). `pin` is the agent's
 * definition when the caller resolved it already (afterRouting does, once).
 */
export function securityPreAgent(
  ctx: ProjectContext,
  input: HookInput,
  spawn: SwarmSpawnCheck | undefined,
  o: { pin?: AgentPin | undefined; deps?: AssessDeps | undefined } = {},
): SecurityAdvice | undefined {
  try {
    if (!securityActive(ctx, input, "agent") || !AGENT_TOOLS.has(input.tool_name ?? ""))
      return undefined;
    const cfg = ctx.config.adjudicator;
    const db = getStorage(ctx, { vectors: false });
    const a = assessDispatch(ctx, db, input, { ...o.deps, spawn, pin: o.pin });
    if (!a) return undefined;
    const level = a.assessment.level;
    const adv: SecurityAdvice = {
      surface: "agent",
      assessed: a,
      level,
      hold: levelRank(level) >= levelRank("high"),
      who: a.agentType,
      cfg,
      db: a.db,
    };
    if (a.taskId !== undefined) adv.taskId = a.taskId;
    const t = hookText(cfg.security, a.view, {
      surface: "agent",
      who: a.agentType,
      taskId: a.taskId,
    });
    if (t.note) adv.note = t.note;
    if (t.user) adv.systemMessage = t.user;
    return adv;
  } catch (err) {
    logFail("preAgent", err);
    return undefined;
  }
}

/**
 * Store the assessment (next to the routing row `adjudicationId`, when the adjudicator made one)
 * and, now that its id is known, word the user message so it names `security explain <id>`.
 * Returns the id; undefined when security.store is off or the insert failed (the advice stays).
 * Never throws.
 */
export function recordAdvice(
  adv: SecurityAdvice,
  o: { adjudicationId?: number | undefined } = {},
): number | undefined {
  try {
    const a = adv.assessed;
    const id = record(adv.db, adv.cfg, {
      surface: adv.surface,
      assessed: a,
      text: a.text,
      sessionId: a.sessionId,
      toolUseId: "toolUseId" in a ? a.toolUseId : undefined,
      agentType: "agentType" in a ? a.agentType : undefined,
      runId: "runId" in a ? a.runId : undefined,
      taskId: "taskId" in a ? a.taskId : undefined,
      adjudicationId: o.adjudicationId,
      noted: !!(adv.note || adv.systemMessage),
    });
    if (id === undefined) return undefined;
    adv.id = id;
    if (adv.systemMessage) {
      const t = hookText(adv.cfg.security, a.view, {
        surface: adv.surface,
        who: adv.who,
        taskId: adv.taskId,
        id,
      });
      if (t.user) adv.systemMessage = t.user;
    }
    return id;
  } catch (err) {
    logFail("record", err);
    return undefined;
  }
}

/**
 * The hook's output with the advice added: the line to additionalContext, the user message to
 * systemMessage. Everything routing decided stays as it was: no permissionDecision and no
 * updatedInput is ever written here, and a denied call is not annotated.
 */
export function withSecurity(
  out: HookOutput | undefined,
  adv: Pick<SecurityAdvice, "note" | "systemMessage"> | undefined,
): HookOutput | undefined {
  if (!adv || (!adv.note && !adv.systemMessage) || isDenied(out)) return out;
  let next: HookOutput | undefined = out;
  if (adv.note) {
    const h = out?.hookSpecificOutput;
    const cur = h?.additionalContext;
    next = {
      ...out,
      hookSpecificOutput: {
        ...h,
        hookEventName: "PreToolUse",
        additionalContext: cur ? `${cur}\n${adv.note}` : adv.note,
      },
    };
  }
  if (adv.systemMessage)
    next = {
      ...next,
      systemMessage: next?.systemMessage
        ? `${next.systemMessage}\n${adv.systemMessage}`
        : adv.systemMessage,
    };
  return next;
}

/**
 * Security-only mode (the adjudicator is off): routing.ts calls this for Agent/Task after it
 * decided. Assess, store, and extend routing's output; a denied call and any failure leave it
 * exactly as it was. Does not load the routing adjudicator.
 */
export function securityAfterRouting(
  ctx: ProjectContext,
  input: HookInput,
  spawn: SwarmSpawnCheck | undefined,
  out: HookOutput | undefined,
  deps: AssessDeps = {},
): HookOutput | undefined {
  try {
    if (isDenied(out)) return out;
    const adv = securityPreAgent(ctx, input, spawn, { deps });
    if (!adv) return out;
    recordAdvice(adv);
    return withSecurity(out, adv);
  } catch (err) {
    logFail("afterRouting", err);
    return out;
  }
}

/** What UserPromptSubmit gets: the line for Claude and the message for the user. */
export interface SecurityPromptAdvice {
  /** A line of its own after the routing line (never squeezed into it). */
  context?: string;
  systemMessage?: string;
}

/**
 * The prompt surface speaks only at this level (and above). A prompt is the user's own words, and
 * a URL or a word like "token" in them lifts the main session (which holds every tool) to HIGH, so
 * a HIGH prompt line would be noise; the spawn notes, the plan and the dashboard keep
 * security.minLevel. The assessment is still stored at every level the store keeps. This is the
 * seam to change if the prompt surface should ever speak lower (there is deliberately no config
 * key for it: docs/design/adjudicator-security.md).
 */
export const PROMPT_MIN_LEVEL: Level = "critical";

/** One distinct warning per session: how many sessions and signatures the dedupe state keeps. */
export const PROMPT_DEDUPE_SESSIONS = 8;
export const PROMPT_DEDUPE_SIGNATURES = 16;
/** meta key of the dedupe state: {sessions: {<session id>: [signature]}}, newest session last. */
export const PROMPT_DEDUPE_KEY = "adjudicator:security:prompt";

/** Does the prompt surface speak at this level? */
export function promptSpeaks(level: Level): boolean {
  return levelRank(level) >= levelRank(PROMPT_MIN_LEVEL);
}

/** Level plus the rules and floors that fired: the same warning, whatever the wording. */
function promptSignature(a: PromptAssessment): string {
  const h = a.assessment.heuristic;
  const ids = [...h.rules.map((r) => r.id), ...h.floors].sort();
  return `${a.assessment.level}:${[...new Set(ids)].join(",")}`;
}

/**
 * Is this the first time this session sees this warning? Remembers it. Read and written only
 * for a prompt that would speak (CRITICAL), so the common prompt costs nothing; one small meta
 * row, bounded to the last PROMPT_DEDUPE_SESSIONS sessions, so a new session starts fresh. A
 * session-less prompt is never deduplicated; a state that cannot be read or written speaks again.
 */
function firstWarning(db: StorageAdapter, sessionId: string | undefined, sig: string): boolean {
  if (!sessionId) return true;
  let sessions: Record<string, string[]> = {};
  try {
    const raw = db.metaGet(PROMPT_DEDUPE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { sessions?: unknown }) : undefined;
    if (parsed?.sessions && typeof parsed.sessions === "object")
      sessions = parsed.sessions as Record<string, string[]>;
  } catch {
    sessions = {};
  }
  const seen = Array.isArray(sessions[sessionId]) ? sessions[sessionId] : [];
  if (seen.includes(sig)) return false;
  try {
    delete sessions[sessionId];
    const kept = Object.entries(sessions).slice(-(PROMPT_DEDUPE_SESSIONS - 1));
    kept.push([sessionId, [...seen, sig].slice(-PROMPT_DEDUPE_SIGNATURES)]);
    db.metaSet(PROMPT_DEDUPE_KEY, JSON.stringify({ sessions: Object.fromEntries(kept) }));
  } catch {
    // speaks again next time rather than never
  }
  return true;
}

/**
 * The prompt's security line. Both modes call this: the prompt hook (src/hooks/capture.ts) in
 * security-only mode behind hasBudget(SECURITY_NEEDS_MS) and next to the routing line when the
 * adjudicator is on. The main session's tools are the inherit set; harness envelopes and slash
 * commands are skipped. Every assessed prompt is stored (security.store); only PROMPT_MIN_LEVEL
 * and above speaks, and each distinct warning (level and fired rule ids) only once per session.
 */
export function securityOnPrompt(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: HookInput,
  sessionId: string,
  deps: AssessDeps = {},
): SecurityPromptAdvice | undefined {
  try {
    if (!securityActive(ctx, input, "prompt")) return undefined;
    const cfg = ctx.config.adjudicator;
    const a = assessPrompt(ctx, db, { ...input, session_id: sessionId }, deps);
    if (!a) return undefined;
    const level = a.assessment.level;
    let t = promptSpeaks(level) ? hookText(cfg.security, a.view, { surface: "prompt" }) : {};
    if ((t.note || t.user) && !firstWarning(db, a.sessionId, promptSignature(a))) t = {};
    const id = record(db, cfg, {
      surface: "prompt",
      assessed: a,
      text: a.text,
      sessionId: a.sessionId,
      noted: !!(t.note || t.user),
    });
    const user =
      t.user && id !== undefined
        ? hookText(cfg.security, a.view, { surface: "prompt", id }).user
        : t.user;
    const out: SecurityPromptAdvice = {};
    if (t.note) out.context = t.note;
    if (user) out.systemMessage = user;
    return out.context || out.systemMessage ? out : undefined;
  } catch (err) {
    logFail("onPrompt", err);
    return undefined;
  }
}
