import { sessionContext } from "../context.js";
import { failedText, rawEnforced, swarmAgentReturned, swarmGate } from "../swarm/hooks.js";
import { budgetFor, budgetLeft, clearBudget, startBudget } from "./budget.js";
import { cursorDir, detectClient, fromCursor, toCursor } from "./cursor.js";
import { handlers } from "./index.js";
import { hookLog } from "./log.js";
import type { HookHandler, HookInput, HookOutput } from "./types.js";

/** Set when the last `dispatch` answered at its deadline with the handler still running. */
let late = false;

/** Did the last `dispatch` give up on its handler? The process should then exit, not wait. */
export function ranLate(): boolean {
  return late;
}

/**
 * Run a handler against the run's budget. A handler that has not answered by then loses:
 * `timedOut` is set and the caller answers without it. The handler keeps running in the
 * background; only a process exit ends it (src/hook.ts does that when `ranLate()`).
 */
async function runWithin(
  handler: HookHandler,
  input: HookInput,
  ms: number,
): Promise<{ out: HookOutput | undefined; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const r = await Promise.race([handler(input), deadline]);
    if (r === "late") {
      late = true;
      // A timer can fire a hair before the clock reaches the deadline: spend what is left.
      startBudget(0);
      return { out: undefined, timedOut: true };
    }
    return { out: r, timedOut: false };
  } finally {
    clearTimeout(timer);
    // A late handler keeps running: its budget stays spent, so it skips what is optional.
    if (!late) clearBudget();
  }
}

/**
 * One hook payload in, one JSON document out. The client dialect (Claude Code or Cursor)
 * is taken from `--client <name>` or detected from the payload. A hook must never block
 * the model: every failure path still returns a well-formed, permissive answer, and a run
 * that outlasts its budget (src/hooks/budget.ts) is answered without the handler, before
 * Claude Code's own timeout would discard the answer. `opts.startedAt` is when the budget began
 * on the `performance.now()` clock (default: now); src/hook.ts passes 0, the process start.
 */
export async function dispatch(
  raw: string,
  argv: string[],
  opts: { budgetMs?: number; startedAt?: number } = {},
): Promise<string> {
  late = false;
  let parsed: Record<string, unknown>;
  try {
    parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (err) {
    hookLog("error", `bad stdin JSON: ${(err as Error).message}`);
    return "{}";
  }
  // `--event <name>` lets the CLI / tests force an event without a full payload.
  const forced = argv.indexOf("--event");
  if (forced !== -1 && argv[forced + 1]) parsed.hook_event_name = argv[forced + 1];
  if (argv.includes("--selftest")) return JSON.stringify({ systemMessage: "eminiar hook ok" });

  if (detectClient(parsed, argv) === "cursor")
    return runCursor(parsed, opts.budgetMs, opts.startedAt);

  const input = parsed as unknown as HookInput;
  const handler = handlers[input.hook_event_name];
  if (!handler) return "{}";
  const ms = opts.budgetMs ?? budgetFor(input.hook_event_name);
  startBudget(ms, opts.startedAt);
  try {
    const r = await runWithin(handler, input, budgetLeft());
    if (r.timedOut) {
      const err = new Error(`hook budget of ${ms} ms exceeded`);
      hookLog("error", `${input.hook_event_name}: ${err.message}; answered without it`);
      return failClosed(input, err) ?? "{}";
    }
    return JSON.stringify(r.out ?? {});
  } catch (err) {
    hookLog("error", `${input.hook_event_name}: ${(err as Error).stack ?? String(err)}`);
    return failClosed(input, err) ?? "{}";
  }
}

/**
 * `em-hook --gate`: decide-only swarm enforcement for a project-level `onFailure: "block"`
 * entry. Deny is JSON (exit 0); allow and not-applicable are `{}`. THROWS on any error
 * (bad or empty stdin, a failed check) so src/hook.ts exits 1 and the blocking entry blocks.
 */
export function gate(raw: string): string {
  if (!raw.trim()) throw new Error("gate: empty stdin");
  const input = JSON.parse(raw) as HookInput;
  return JSON.stringify(swarmGate(input) ?? {});
}

/**
 * A subagent dispatch the project's swarm enforcement should still stop when the hook handler
 * itself threw: only on positive evidence (an enforcing swarm file) for an Agent/Task call, the main
 * session's or a subagent's (nested calls are enforced too). Everything else stays fail-open.
 */
function failClosed(input: HookInput, err: unknown): string | undefined {
  try {
    if (
      input.hook_event_name !== "PreToolUse" ||
      input.client === "cursor" ||
      (input.tool_name !== "Agent" && input.tool_name !== "Task") ||
      !rawEnforced({ cwd: input.cwd })
    )
      return undefined;
    // The handler may have reserved a spawn slot before it ran late or threw; the denied call
    // never starts a worker, so release it or the retry the deny text invites is refused.
    try {
      swarmAgentReturned(sessionContext(input.cwd), input);
    } catch {
      // best effort
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: failedText(err),
      },
    });
  } catch {
    return undefined;
  }
}

async function runCursor(
  parsed: Record<string, unknown>,
  budgetMs?: number,
  startedAt?: number,
): Promise<string> {
  const input = fromCursor(parsed);
  const event = input.hook_event_name;
  let out: HookOutput | undefined;
  const handler = handlers[event];
  if (handler) {
    const ms = budgetMs ?? budgetFor(event);
    startBudget(ms, startedAt);
    try {
      const r = await runWithin(handler, input, budgetLeft());
      if (r.timedOut) hookLog("error", `cursor ${event}: hook budget of ${ms} ms exceeded`);
      out = r.out;
    } catch (err) {
      hookLog("error", `cursor ${event}: ${(err as Error).stack ?? String(err)}`);
    }
  }
  let root = input.cwd;
  try {
    root = sessionContext(input.cwd).root;
  } catch {
    // the cwd is still a usable key for parked context
  }
  try {
    return JSON.stringify(toCursor(event, out, { root, sessionId: input.session_id }));
  } catch (err) {
    hookLog("error", `cursor ${event} output: ${(err as Error).stack ?? String(err)}`);
    // A permission hook that answers with an unknown shape blocks the call.
    return event === "PreToolUse" ? '{"permission":"allow"}' : "{}";
  }
}

export { cursorDir };
