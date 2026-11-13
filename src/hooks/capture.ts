import {
  classifyAssistant,
  classifyPrompt,
  classifyToolCall,
  clip,
  ev,
  withPriority,
} from "../capture/classify.js";
import { sessionContext } from "../context.js";
import { indexContent } from "../index/indexer.js";
import { recallForError, recallForText, recordShown } from "../session/recall.js";
import { globalDb } from "../stats/global.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type { EventInput } from "../storage/types.js";
import {
  swarmActivity,
  swarmAgentReturned,
  swarmSessionEnd,
  swarmSubagentStop,
} from "../swarm/hooks.js";
import { budgetWarnings } from "../usage/brief.js";
import { ingestSession, ingestTranscript, usageEnabled } from "../usage/ingest.js";
import { HOOK_BUSY_TIMEOUT_MS, hasBudget } from "./budget.js";
import { hookLog } from "./log.js";
import type { HookHandler, HookInput } from "./types.js";

/** What a stage of the prompt hook needs left of the run's budget to be worth starting. */
const RECALL_NEEDS_MS = 600;
const ADJUDICATOR_NEEDS_MS = 1500;
/**
 * The security line of a prompt: a heuristic over the prompt and a handful of reads, a few
 * milliseconds. Defined here, not in security/hook.ts: importing the constant would load the module.
 */
const SECURITY_NEEDS_MS = 200;
/** What one best-effort write of PostToolUseFailure needs left: its short wait and a margin. */
const BEST_EFFORT_NEEDS_MS = 1000;

/** Categories worth finding again with em_recall / em_search (source "session"). */
const INDEXED = new Set([
  "decision",
  "constraint",
  "rejected",
  "blocker",
  "error",
  "error_resolution",
  "agent_findings",
]);

/** Insert events; the memorable ones are also indexed so they are searchable. */
export function persist(db: StorageAdapter, sessionId: string, events: EventInput[]): void {
  for (const e of events) {
    const id = db.eventInsert(e);
    if (!INDEXED.has(e.category)) continue;
    const p = e.payload;
    const body =
      typeof p.text === "string"
        ? p.text
        : typeof p.error === "string"
          ? `${p.summary ?? ""}: ${p.error}`
          : "";
    if (!body.trim()) continue;
    try {
      indexContent(db, {
        source: "session",
        title: e.category,
        uri: `event:${id}`,
        content: body,
        kind: "prose",
        sessionId,
        meta: { eventId: id, category: e.category },
      });
    } catch {
      // indexing is best effort inside hooks
    }
  }
}

function open(input: HookInput): { db: StorageAdapter; root: string; sessionId: string } {
  const ctx = sessionContext(input.cwd);
  const db = getStorage(ctx, { vectors: false });
  const sessionId = input.session_id || "unknown";
  db.sessionUpsert({
    id: sessionId,
    project_root: ctx.root,
    transcript_path: input.transcript_path,
  });
  return { db, root: ctx.root, sessionId };
}

/** Set once the first ingest failure of this process has been logged; later ones stay quiet. */
let usageFailureLogged = false;

/**
 * Pull the session's new transcript entries (model calls, tool result sizes, compactions)
 * into the usage tables. Reads only the tail past the stored offset, so it is cheap; it
 * never throws, since a hook must not fail over bookkeeping. A failure is written to
 * ~/.eminiar/hook.log once per process so a broken ingest does not go unnoticed.
 */
export function ingestUsage(db: StorageAdapter, input: HookInput, sessionId: string): void {
  try {
    const ctx = sessionContext(input.cwd);
    if (!usageEnabled(ctx)) return;
    const overrides = ctx.config.usage.pricing;
    ingestSession(db, ctx.root, sessionId, input.transcript_path, { overrides });
    if (input.agent_transcript_path)
      ingestTranscript(db, input.agent_transcript_path, { sessionId, overrides });
  } catch (err) {
    // usage capture is best effort
    if (usageFailureLogged) return;
    usageFailureLogged = true;
    hookLog(
      "error",
      `usage ingest failed (session ${sessionId}): ${(err as Error).message}; run \`eminiar usage ingest\` to see the error`,
    );
  }
}

export const userPromptSubmit: HookHandler = async (input) => {
  if (!input.prompt?.trim()) return undefined;
  const ctx = sessionContext(input.cwd);
  const db = getStorage(ctx, { vectors: false });
  const sessionId = input.session_id || "unknown";
  // The session row and the prompt's events are bookkeeping: a database another process holds
  // locked must not cost the prompt its recall. A reader is not blocked by a writer, so the
  // reads below still run; the first locked write ends this block, since the next would only
  // wait for the same lock again (src/hooks/budget.ts).
  try {
    db.sessionUpsert({
      id: sessionId,
      project_root: ctx.root,
      transcript_path: input.transcript_path,
      last_prompt: clip(input.prompt, 600),
    });
    persist(db, sessionId, withPriority(sessionId, classifyPrompt(input.prompt)));
  } catch (err) {
    hookLog("info", `UserPromptSubmit: prompt not recorded: ${(err as Error).message}`);
  }
  // Hand Claude the memories and doc pages this prompt touches, so it does not have
  // to remember to ask em_recall / em_docs first.
  const { recall } = ctx.config;
  const parts: string[] = [];
  if (recall.onPrompt && hasBudget(RECALL_NEEDS_MS)) {
    try {
      const r = await recallForText(db, input.prompt, {
        maxMemories: recall.maxMemories,
        maxDocs: recall.maxDocs,
        sessionId,
        repeatAfter: recall.repeatAfter,
        trace: true,
        path: "prompt",
      });
      if (r.text) parts.push(r.text);
      // Quiet decisions are recorded too: the hit rate is only measurable with both sides.
      // A statistic, written after the recall is in hand: a locked database loses the count,
      // not the answer.
      try {
        recordShown(db, sessionId, r.keys, { path: "prompt", trace: r.trace });
      } catch {
        // statistics only
      }
    } catch {
      // recall is best effort; never block a prompt on it
    }
  }
  // The adjudicator (off by default; loaded only when enabled): one advice line for Claude
  // and, now and then, a main-session note for the user. Skipped when the run is already late.
  let systemMessage: string | undefined;
  if (
    ctx.config.adjudicator.enabled &&
    input.client !== "cursor" &&
    hasBudget(ADJUDICATOR_NEEDS_MS)
  ) {
    try {
      const { onPrompt } = await import("../adjudicator/hooks.js");
      const a = await onPrompt(ctx, db, input, sessionId);
      if (a?.context) parts.push(a.context);
      systemMessage = a?.systemMessage;
    } catch {
      // advice is optional
    }
  }
  // Security advice (off by default; loaded only when on, with or without the adjudicator): its
  // line goes after the routing line as a part of its own, and a CRITICAL prompt tells the user.
  // Which prompts speak (CRITICAL, once per session) is decided in securityOnPrompt.
  const adj = ctx.config.adjudicator;
  if (
    adj.security.enabled &&
    adj.security.surfaces.prompt &&
    input.client !== "cursor" &&
    hasBudget(SECURITY_NEEDS_MS)
  ) {
    try {
      const { securityOnPrompt } = await import("../adjudicator/security/hook.js");
      const s = securityOnPrompt(ctx, db, input, sessionId);
      if (s?.context) parts.push(s.context);
      if (s?.systemMessage)
        systemMessage = systemMessage ? `${systemMessage}\n${s.systemMessage}` : s.systemMessage;
    } catch {
      // advice is optional
    }
  }
  // A crossed budget is said once per threshold; the Stop hook already ingested the
  // transcript, so this only reads totals.
  try {
    if (usageEnabled(ctx)) parts.push(...budgetWarnings(db, ctx, sessionId));
  } catch {
    // budgets are advisory
  }
  if (!parts.length) return systemMessage ? { systemMessage } : undefined;
  return {
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: parts.join("\n\n"),
    },
  };
};

/** 3+ calls with identical input in the last 30 → iteration loop (recorded once per key). */
function detectLoop(db: StorageAdapter, sessionId: string, key: string, summary: string): void {
  const recent = db.eventsRecent(30, ["tool_call"]).filter((e) => e.session_id === sessionId);
  const same = recent.filter((e) => (JSON.parse(e.payload) as { key?: string }).key === key).length;
  if (same < 3) return;
  const already = db
    .eventsBySession(sessionId, { categories: ["iteration_loop"] })
    .some((e) => (JSON.parse(e.payload) as { key?: string }).key === key);
  if (!already)
    db.eventInsert({
      sessionId,
      category: "iteration_loop",
      priority: 2,
      payload: { key, summary, count: same },
    });
}

export const postToolUse: HookHandler = async (input) => {
  if (!input.tool_name) return undefined;
  // A swarm worker's call feeds the swarm ledger too (a no-op for every other caller).
  if (input.agent_id) swarmActivity(sessionContext(input.cwd), input, false);
  // A swarm worker's Agent call returned: its spawn reservation is done.
  const isAgent = input.tool_name === "Agent" || input.tool_name === "Task";
  if (isAgent) swarmAgentReturned(sessionContext(input.cwd), input);
  const { db, root, sessionId } = open(input);
  const drafts = classifyToolCall({
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    toolResponse: input.tool_response,
    durationMs: input.duration_ms,
    root,
  });
  persist(db, sessionId, withPriority(sessionId, drafts));
  const call = drafts.find((d) => d.category === "tool_call");
  if (call) detectLoop(db, sessionId, String(call.payload.key), String(call.payload.summary));
  // Edited code files are re-parsed into the graph on the next em_* call.
  for (const d of drafts) {
    if (
      d.category === "files" &&
      typeof d.payload.path === "string" &&
      /\.(m?[jt]sx?|c[jt]s|py|pyi|go|php)$/.test(d.payload.path)
    ) {
      db.reindexQueuePush(d.payload.path, String(d.payload.action ?? "edit"));
    }
  }
  // The adjudicator (off by default; loaded only when enabled): the dispatch row of this
  // Agent call gets the exact subagent id from tool_response.
  if (isAgent && input.client !== "cursor") {
    const ctx = sessionContext(input.cwd);
    if (ctx.config.adjudicator.enabled) {
      try {
        const { onPostAgent } = await import("../adjudicator/hooks.js");
        onPostAgent(ctx, db, input);
      } catch {
        // reconcile's window matching still links what it can
      }
    }
  }
  return undefined;
};

/**
 * The best-effort writes of PostToolUseFailure, once the spawn release has had its long wait:
 * each waits at most HOOK_BUSY_TIMEOUT_MS for the lock, needs BEST_EFFORT_NEEDS_MS of the run's
 * budget, and the first one that fails ends the rest (the database is busy; the answer is not).
 * An Agent call's hook opens with a 1500 ms wait for the release, and three more writes at that
 * wait would take it past its 5 s timeout under a sustained lock.
 */
function bestEffortWrites(db: StorageAdapter): (what: string, fn: () => void) => void {
  let done = false;
  return (what, fn) => {
    if (done) return;
    if (!hasBudget(BEST_EFFORT_NEEDS_MS)) {
      done = true;
      hookLog("info", `PostToolUseFailure: ${what} skipped: out of time`);
      return;
    }
    try {
      const short = db.adjudicator.withLockWait?.bind(db.adjudicator);
      if (short) short(HOOK_BUSY_TIMEOUT_MS, fn);
      else fn();
    } catch (err) {
      done = true;
      hookLog("info", `PostToolUseFailure: ${what} not recorded: ${(err as Error).message}`);
    }
  };
}

export const postToolUseFailure: HookHandler = async (input) => {
  if (!input.tool_name) return undefined;
  const ctx = sessionContext(input.cwd);
  // The one write this hook must not lose, first and with the event's full lock wait: a lost
  // release keeps the worker's slot until the reservation expires, so the retry is denied.
  if (input.tool_name === "Agent" || input.tool_name === "Task") swarmAgentReturned(ctx, input);
  const db = getStorage(ctx, { vectors: false });
  const sessionId = input.session_id || "unknown";
  const write = bestEffortWrites(db);
  if (input.agent_id) write("swarm activity", () => swarmActivity(ctx, input, true));
  write("session", () =>
    db.sessionUpsert({
      id: sessionId,
      project_root: ctx.root,
      transcript_path: input.transcript_path,
    }),
  );
  // Look the error up before it is persisted, so it does not find itself. Reads are not
  // blocked by another process's write lock (WAL), so the recall runs whatever the writes did.
  let recalled: string | undefined;
  const { recall } = ctx.config;
  if (recall.onError && input.error) {
    try {
      const r = await recallForError(db, input.error, {
        sessionId,
        maxMemories: Math.min(2, recall.maxMemories),
        repeatAfter: recall.repeatAfter,
      });
      if (r.text) {
        recalled = r.text;
        write("recall", () => recordShown(db, sessionId, r.keys, { path: "error" }));
      }
    } catch {
      // recall is best effort
    }
  }
  const drafts = classifyToolCall({
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    error: input.error ?? "tool failed",
    root: ctx.root,
  }).filter((d) => d.category !== "tool_call");
  write("failure", () => persist(db, sessionId, withPriority(sessionId, drafts)));
  return recalled
    ? { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: recalled } }
    : undefined;
};

export const subagentStop: HookHandler = (input) => {
  // A swarm worker is closed first: its task must not stay held if capture fails below.
  if (input.agent_id) swarmSubagentStop(sessionContext(input.cwd), input);
  const { db, sessionId } = open(input);
  const msg = input.last_assistant_message ?? "";
  if (msg.trim()) {
    // Through persist() so the findings are indexed (source "session") for em_recall.
    persist(
      db,
      sessionId,
      withPriority(sessionId, [
        ev("agent_findings", {
          agent: input.agent_type ?? input.agent_id,
          text: clip(msg.replace(/\s+/g, " "), 1000),
        }),
      ]),
    );
  }
  ingestUsage(db, input, sessionId);
  return undefined;
};

export const stop: HookHandler = (input) => {
  const { db, sessionId } = open(input);
  const msg = input.last_assistant_message ?? "";
  persist(db, sessionId, withPriority(sessionId, classifyAssistant(msg)));
  ingestUsage(db, input, sessionId);
  return undefined;
};

export const sessionEnd: HookHandler = async (input) => {
  // Workers of this session that never sent SubagentStop are closed (no-op without swarms).
  const ctx = sessionContext(input.cwd);
  swarmSessionEnd(ctx, input);
  const { db, sessionId } = open(input);
  db.sessionUpsert({ id: sessionId, ended_at: Date.now() });
  db.eventInsert({
    ...withPriority(sessionId, [ev("session_start", { ended: input.reason ?? "unknown" })])[0]!,
  });
  ingestUsage(db, input, sessionId);
  // The adjudicator (off by default) links outcomes and savings once the usage is in.
  if (ctx.config.adjudicator.enabled && input.client !== "cursor") {
    try {
      const { onSessionEnd } = await import("../adjudicator/hooks.js");
      onSessionEnd(ctx, db, input);
    } catch {
      // reconcile runs again at the next session end
    }
  }
  // keep the global DB warm so lifetime stats include this session's last calls
  globalDb();
  return undefined;
};
