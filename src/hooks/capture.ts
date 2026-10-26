import {
  classifyAssistant,
  classifyPrompt,
  classifyToolCall,
  clip,
  ev,
  withPriority,
} from "../capture/classify.js";
import { getContext } from "../context.js";
import { indexContent } from "../index/indexer.js";
import { recallForError, recallForText, recordShown } from "../session/recall.js";
import { globalDb } from "../stats/global.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type { EventInput } from "../storage/types.js";
import type { HookHandler, HookInput } from "./types.js";

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
  const ctx = getContext(input.cwd);
  const db = getStorage(ctx, { vectors: false });
  const sessionId = input.session_id || "unknown";
  db.sessionUpsert({
    id: sessionId,
    project_root: ctx.root,
    transcript_path: input.transcript_path,
  });
  return { db, root: ctx.root, sessionId };
}

export const userPromptSubmit: HookHandler = async (input) => {
  if (!input.prompt?.trim()) return undefined;
  const { db, sessionId } = open(input);
  db.sessionUpsert({ id: sessionId, last_prompt: clip(input.prompt, 600) });
  persist(db, sessionId, withPriority(sessionId, classifyPrompt(input.prompt)));
  // Hand Claude the memories and doc pages this prompt touches, so it does not have
  // to remember to ask em_recall / em_docs first.
  const { recall } = getContext(input.cwd).config;
  if (!recall.onPrompt) return undefined;
  try {
    const r = await recallForText(db, input.prompt, {
      maxMemories: recall.maxMemories,
      maxDocs: recall.maxDocs,
      sessionId,
      repeatAfter: recall.repeatAfter,
      trace: true,
      path: "prompt",
    });
    // Quiet decisions are recorded too: the hit rate is only measurable with both sides.
    recordShown(db, sessionId, r.keys, { path: "prompt", trace: r.trace });
    if (!r.text) return undefined;
    return {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: r.text },
    };
  } catch {
    // recall is best effort; never block a prompt on it
    return undefined;
  }
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

export const postToolUse: HookHandler = (input) => {
  if (!input.tool_name) return undefined;
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
  return undefined;
};

export const postToolUseFailure: HookHandler = async (input) => {
  if (!input.tool_name) return undefined;
  const { db, root, sessionId } = open(input);
  // Look the error up before it is persisted, so it does not find itself.
  let recalled: string | undefined;
  const { recall } = getContext(input.cwd).config;
  if (recall.onError && input.error) {
    try {
      const r = await recallForError(db, input.error, {
        sessionId,
        maxMemories: Math.min(2, recall.maxMemories),
        repeatAfter: recall.repeatAfter,
      });
      if (r.text) {
        recalled = r.text;
        recordShown(db, sessionId, r.keys, { path: "error" });
      }
    } catch {
      // recall is best effort
    }
  }
  const drafts = classifyToolCall({
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    error: input.error ?? "tool failed",
    root,
  }).filter((d) => d.category !== "tool_call");
  persist(db, sessionId, withPriority(sessionId, drafts));
  return recalled
    ? { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: recalled } }
    : undefined;
};

export const subagentStop: HookHandler = (input) => {
  const { db, sessionId } = open(input);
  const msg = input.last_assistant_message ?? "";
  if (!msg.trim()) return undefined;
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
  return undefined;
};

export const stop: HookHandler = (input) => {
  const { db, sessionId } = open(input);
  const msg = input.last_assistant_message ?? "";
  persist(db, sessionId, withPriority(sessionId, classifyAssistant(msg)));
  return undefined;
};

export const sessionEnd: HookHandler = (input) => {
  const { db, sessionId } = open(input);
  db.sessionUpsert({ id: sessionId, ended_at: Date.now() });
  db.eventInsert({
    ...withPriority(sessionId, [ev("session_start", { ended: input.reason ?? "unknown" })])[0]!,
  });
  // keep the global DB warm so lifetime stats include this session's last calls
  globalDb();
  return undefined;
};
