import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getContext } from "../context.js";
import { projectDir } from "../paths.js";
import type { HookInput, HookOutput } from "./types.js";

/**
 * Cursor speaks a different hook dialect from Claude Code: camelCase event names, flat
 * output objects, `conversation_id` + `workspace_roots` instead of `session_id` + `cwd`,
 * `Shell` instead of `Bash`, and a JSON string for the tool result. This module translates
 * both directions so the handlers in ./index.ts stay Claude-shaped.
 *
 * Two Cursor hooks cannot carry context back to the model: `beforeSubmitPrompt` (only
 * `continue`) and `preToolUse` (only a permission). What those handlers would have attached
 * (prompt recall, file memories, fix history, fan-in) is parked per session and delivered
 * with the next `postToolUse` / `postToolUseFailure`, which do accept `additional_context`.
 */
export type HookClient = "claude" | "cursor";

/** Cursor event → the Claude Code event the handlers implement. PascalCase names pass through. */
export const CURSOR_EVENTS: Record<string, string> = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  // afterAgentResponse carries the assistant text that Claude Code's Stop event carries.
  afterAgentResponse: "Stop",
  stop: "Stop",
  afterFileEdit: "PostToolUse",
  sessionEnd: "SessionEnd",
};

/** Cursor tool names that differ from Claude Code's. Others (Read, Write, Grep, Task) match. */
const TOOL_NAMES: Record<string, string> = { Shell: "Bash" };

/** Parked context older than this is dropped rather than delivered out of the blue. */
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_MAX = 8000;

export function cursorDir(): string {
  return process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor");
}

export function detectClient(input: Record<string, unknown>, argv: string[]): HookClient {
  const i = argv.indexOf("--client");
  if (i !== -1 && argv[i + 1]) return argv[i + 1] === "cursor" ? "cursor" : "claude";
  const ev = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  if (
    typeof input.cursor_version === "string" ||
    Array.isArray(input.workspace_roots) ||
    (typeof input.conversation_id === "string" && !input.session_id) ||
    ev in CURSOR_EVENTS
  )
    return "cursor";
  return "claude";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);

function mapToolName(name: string): string {
  if (name in TOOL_NAMES) return TOOL_NAMES[name]!;
  // Cursor names MCP tools `MCP:<tool>`; Claude Code uses `mcp__<server>__<tool>`.
  const mcp = /^MCP:(.+)$/.exec(name);
  if (mcp) return `mcp__cursor__${mcp[1]}`;
  return name;
}

function toolInputOf(v: unknown): Record<string, unknown> | undefined {
  let obj = v;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const input = { ...(obj as Record<string, unknown>) };
  // Claude's file tools use `file_path`; keep both spellings so fileKnowledge finds the path.
  if (typeof input.path === "string" && input.file_path === undefined) input.file_path = input.path;
  return input;
}

/** Cursor stringifies the tool result; hand the handlers the object when it parses. */
function toolResponseOf(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Translate a Cursor hook payload into the Claude Code shape the handlers read. */
export function fromCursor(raw: Record<string, unknown>): HookInput {
  const event = str(raw.hook_event_name) ?? "";
  const roots = Array.isArray(raw.workspace_roots)
    ? raw.workspace_roots.filter((r): r is string => typeof r === "string")
    : [];
  const cwd =
    str(raw.cwd) ??
    roots[0] ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  const input: HookInput = {
    session_id:
      str(raw.session_id) ?? str(raw.conversation_id) ?? process.env.EMINIAR_SESSION_ID ?? "cursor",
    cwd,
    hook_event_name: CURSOR_EVENTS[event] ?? event,
  };
  const transcript = str(raw.transcript_path);
  if (transcript) input.transcript_path = transcript;
  // Every Cursor conversation is a fresh context; nothing to replay from a snapshot.
  if (input.hook_event_name === "SessionStart") input.source = "startup";
  const prompt = str(raw.prompt);
  if (prompt) input.prompt = prompt;
  if (event === "afterFileEdit") {
    input.tool_name = "Edit";
    const ti: Record<string, unknown> = {};
    if (str(raw.file_path)) ti.file_path = raw.file_path;
    if (Array.isArray(raw.edits)) ti.edits = raw.edits;
    input.tool_input = ti;
  } else {
    const tool = str(raw.tool_name);
    if (tool) input.tool_name = mapToolName(tool);
    const ti = toolInputOf(raw.tool_input);
    if (ti) input.tool_input = ti;
  }
  const useId = str(raw.tool_use_id);
  if (useId) input.tool_use_id = useId;
  if (raw.tool_output !== undefined) input.tool_response = toolResponseOf(raw.tool_output);
  const dur = typeof raw.duration === "number" ? raw.duration : raw.duration_ms;
  if (typeof dur === "number") input.duration_ms = dur;
  const err = str(raw.error_message) ?? str(raw.error);
  if (err) input.error = err;
  const text = str(raw.text) ?? str(raw.summary) ?? str(raw.last_assistant_message);
  if (text) input.last_assistant_message = text;
  const agent = str(raw.subagent_type) ?? str(raw.agent_type);
  if (agent) input.agent_type = agent;
  const agentTranscript = str(raw.agent_transcript_path);
  if (agentTranscript) input.agent_transcript_path = agentTranscript;
  if (raw.trigger === "manual" || raw.trigger === "auto") input.trigger = raw.trigger;
  const reason = str(raw.reason);
  if (reason) input.reason = reason;
  return input;
}

/** Flat Cursor output. Only the fields each event accepts are set. */
export interface CursorOutput {
  permission?: "allow" | "deny";
  user_message?: string;
  agent_message?: string;
  updated_input?: Record<string, unknown>;
  additional_context?: string;
  continue?: boolean;
  env?: Record<string, string>;
}

interface Pending {
  t: number;
  text: string;
}

function pendingFile(root: string, sessionId: string): string {
  const id = getContext(root).id;
  return join(projectDir(id), "pending-context", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

function readPending(file: string): Pending[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as Pending[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Park context that the current Cursor event cannot deliver. */
export function stashContext(root: string, sessionId: string, text: string): void {
  if (!text.trim()) return;
  const file = pendingFile(root, sessionId);
  mkdirSync(join(file, ".."), { recursive: true });
  const now = Date.now();
  const list = readPending(file).filter((p) => now - p.t < PENDING_TTL_MS);
  list.push({ t: now, text });
  writeFileSync(file, JSON.stringify(list));
}

/** Everything parked for the session that is still fresh; the file is removed. */
export function takeContext(root: string, sessionId: string): string | undefined {
  const file = pendingFile(root, sessionId);
  if (!existsSync(file)) return undefined;
  const now = Date.now();
  const list = readPending(file).filter((p) => now - p.t < PENDING_TTL_MS);
  rmSync(file, { force: true });
  const seen = new Set<string>();
  const texts = list.map((p) => p.text).filter((t) => !seen.has(t) && seen.add(t));
  const joined = texts.join("\n\n").slice(0, PENDING_MAX);
  return joined || undefined;
}

/** Is an eminiar MCP server registered for Cursor, so a denied call has something to retry with? */
export function cursorHasServer(): boolean {
  try {
    const raw = readFileSync(join(cursorDir(), "mcp.json"), "utf8");
    return raw.includes("em-server");
  } catch {
    return false;
  }
}

const joinText = (...parts: Array<string | undefined>): string | undefined => {
  const kept = parts.filter((p): p is string => !!p?.trim());
  return kept.length ? kept.join("\n\n") : undefined;
};

/**
 * Translate a handler result into the flat object Cursor expects for `event` (the Claude
 * Code event name). `scope` identifies the session for parked context.
 */
export function toCursor(
  event: string,
  out: HookOutput | undefined,
  scope: { root: string; sessionId: string },
): CursorOutput {
  const specific = out?.hookSpecificOutput;
  const context = specific?.additionalContext;
  switch (event) {
    case "PreToolUse": {
      if (specific?.permissionDecision === "deny") {
        // Denying only helps when the em_* tools exist on this side; otherwise annotate.
        if (!cursorHasServer()) {
          stashContext(
            scope.root,
            scope.sessionId,
            `${specific.permissionDecisionReason ?? ""} (eminiar MCP server is not registered with Cursor, so the call was allowed; run \`npx eminiar install --cursor\`)`.trim(),
          );
          return { permission: "allow" };
        }
        const reason = joinText(specific.permissionDecisionReason, context) ?? "eminiar: denied";
        return { permission: "deny", user_message: reason, agent_message: reason };
      }
      const res: CursorOutput = { permission: "allow" };
      if (specific?.updatedInput) res.updated_input = specific.updatedInput;
      // preToolUse cannot carry context; it rides along with the tool's result instead.
      if (context) stashContext(scope.root, scope.sessionId, context);
      return res;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const text = joinText(takeContext(scope.root, scope.sessionId), context);
      return text ? { additional_context: text } : {};
    }
    case "SessionStart": {
      const res: CursorOutput = {
        env: { EMINIAR_SESSION_ID: scope.sessionId, EMINIAR_PROJECT_ROOT: scope.root },
      };
      if (context) res.additional_context = context;
      return res;
    }
    case "UserPromptSubmit": {
      if (context) stashContext(scope.root, scope.sessionId, context);
      return { continue: true };
    }
    default:
      return {};
  }
}
