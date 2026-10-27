import { getContext } from "../context.js";
import { cursorDir, detectClient, fromCursor, toCursor } from "./cursor.js";
import { handlers } from "./index.js";
import { hookLog } from "./log.js";
import type { HookInput, HookOutput } from "./types.js";

/**
 * One hook payload in, one JSON document out. The client dialect (Claude Code or Cursor)
 * is taken from `--client <name>` or detected from the payload. A hook must never block
 * the model: every failure path still returns a well-formed, permissive answer.
 */
export async function dispatch(raw: string, argv: string[]): Promise<string> {
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

  if (detectClient(parsed, argv) === "cursor") return runCursor(parsed);

  const input = parsed as unknown as HookInput;
  const handler = handlers[input.hook_event_name];
  if (!handler) return "{}";
  try {
    const out = await handler(input);
    return JSON.stringify(out ?? {});
  } catch (err) {
    hookLog("error", `${input.hook_event_name}: ${(err as Error).stack ?? String(err)}`);
    return "{}";
  }
}

async function runCursor(parsed: Record<string, unknown>): Promise<string> {
  const input = fromCursor(parsed);
  const event = input.hook_event_name;
  let out: HookOutput | undefined;
  const handler = handlers[event];
  if (handler) {
    try {
      out = await handler(input);
    } catch (err) {
      hookLog("error", `cursor ${event}: ${(err as Error).stack ?? String(err)}`);
    }
  }
  let root = input.cwd;
  try {
    root = getContext(input.cwd).root;
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
