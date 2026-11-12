import { sessionContext } from "../context.js";
import { fillRecallIndexBriefly } from "../index/indexer.js";
import { getStorage } from "../storage/index.js";
import { subagentStart } from "../swarm/hooks.js";
import { hasBudget } from "./budget.js";
import {
  postToolUse,
  postToolUseFailure,
  sessionEnd,
  stop,
  subagentStop,
  userPromptSubmit,
} from "./capture.js";
import { hookLog } from "./log.js";
import { preCompact } from "./pre-compact.js";
import { preToolUse } from "./routing.js";
import { sessionStart } from "./session-start.js";
import type { HookHandler, HookInput } from "./types.js";

/** The most a hook spends on the recall index fill: its slices and the gaps between them. */
export const RECALL_FILL_BUDGET_MS = 300;
/** What a hook must have left of its run's budget to start, or go on with, the fill. */
export const RECALL_FILL_NEEDS_MS = 1000;

/**
 * A few slices of a recall index that is still filling (fillRecallIndexBriefly), after the
 * handler's own work. Best effort: out of time, a busy database or any error leaves the rest to
 * the next such hook, the MCP server or `eminiar reindex`, and the answer is unchanged.
 */
async function fillRecall(input: HookInput): Promise<void> {
  if (!hasBudget(RECALL_FILL_NEEDS_MS)) return;
  try {
    const db = getStorage(sessionContext(input.cwd), { vectors: false });
    const r = await fillRecallIndexBriefly(db, {
      budgetMs: RECALL_FILL_BUDGET_MS,
      stop: () => !hasBudget(RECALL_FILL_NEEDS_MS),
    });
    if (r.slices)
      hookLog(
        "info",
        `${input.hook_event_name}: recall index fill +${r.rows} rows in ${r.slices} slice(s)${r.done ? ", complete" : ""}`,
      );
  } catch (err) {
    hookLog(
      "info",
      `${input.hook_event_name}: recall index fill skipped: ${(err as Error).message}`,
    );
  }
}

/** `handler`, then a short recall index fill; only for hooks that do not hold up a prompt. */
function thenFillRecall(handler: HookHandler): HookHandler {
  return async (input) => {
    const out = await handler(input);
    await fillRecall(input);
    return out;
  };
}

/**
 * Event → handler. Unknown events are a no-op so hooks.json may list more than we handle.
 * Only the hooks nobody waits on run the recall fill; never UserPromptSubmit, PreToolUse or
 * PostToolUse*, which the user or the model waits on.
 */
export const handlers: Record<string, HookHandler> = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
  PostToolUseFailure: postToolUseFailure,
  // Agent swarms only: registers a swarm worker and injects its brief (src/swarm/hooks.ts).
  SubagentStart: subagentStart,
  SubagentStop: thenFillRecall(subagentStop),
  PreCompact: thenFillRecall(preCompact),
  Stop: thenFillRecall(stop),
  SessionEnd: thenFillRecall(sessionEnd),
};
