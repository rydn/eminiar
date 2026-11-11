import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { redactSecrets } from "../adjudicator/redact.js";

/** Project-relative path; tolerates symlinked roots (macOS /var → /private/var). */
export function relPath(root: string, fp: string): string {
  const tryRel = (base: string, p: string) => {
    const r = relative(base, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : undefined;
  };
  const direct = tryRel(root, fp);
  if (direct) return direct;
  try {
    const real = tryRel(realpathSync(root), realpathSync(fp));
    if (real) return real;
  } catch {
    // file may not exist yet (Write)
  }
  return fp;
}

import type { EventInput } from "../storage/types.js";
import { CATEGORIES, type Category } from "./categories.js";

type Draft = Omit<EventInput, "sessionId" | "priority"> & { category: Category };

export function ev(category: Category, payload: Record<string, unknown>, tool?: string): Draft {
  return { category, payload, tool };
}

export function withPriority(sessionId: string, drafts: Draft[]): EventInput[] {
  return drafts.map((d) => ({ ...d, sessionId, priority: CATEGORIES[d.category] }));
}

export const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// --- lexicons -------------------------------------------------------------

const DECISION =
  /\b(let'?s go with|we'?ll use|decided|decision:|go with|use (?:the )?\w+ instead|stick with|switch(?:ing)? to|chose|prefer(?:red)?)\b/i;
const CONSTRAINT =
  /\b(must(?: not)?|never|always|only|do not|don'?t|should not|required?|hard requirement|no\s+\w+ allowed)\b/i;
const REJECTED =
  /\b(instead of|rather than|not \w+ing|don'?t use|drop(?:ped)?|revert(?:ed)?|abandon(?:ed)?|scrap(?:ped)?)\b/i;
const BLOCKER =
  /\b(blocked|blocker|can'?t (?:proceed|continue)|waiting (?:on|for)|need(?:s)? (?:access|permission|approval))\b/i;
const RESOLVED = /\b(fixed|resolved|now passes|passing now|works now|solved|green)\b/i;
const INTENT =
  /^\s*(?:(?:please|can you|could you|let'?s|i want to|i'?d like to|help me)\s+)?(\w+(?:\s+\w+){0,5})/i;

/** Events from a user prompt: the prompt itself plus any decisions/constraints it states. */
export function classifyPrompt(prompt: string): Draft[] {
  const out: Draft[] = [ev("user_prompt", { text: clip(prompt, 600) })];
  const first = prompt.split("\n").find((l) => l.trim()) ?? "";
  if (DECISION.test(prompt))
    out.push(ev("decision", { text: clip(firstMatchLine(prompt, DECISION), 300), by: "user" }));
  if (CONSTRAINT.test(prompt) && prompt.length < 2000)
    out.push(ev("constraint", { text: clip(firstMatchLine(prompt, CONSTRAINT), 300) }));
  if (REJECTED.test(prompt))
    out.push(ev("rejected", { text: clip(firstMatchLine(prompt, REJECTED), 300) }));
  if (BLOCKER.test(prompt))
    out.push(ev("blocker", { text: clip(firstMatchLine(prompt, BLOCKER), 300) }));
  const m = INTENT.exec(first);
  if (m?.[1]) out.push(ev("intent", { text: clip(m[1], 80) }));
  return out;
}

function firstMatchLine(text: string, re: RegExp): string {
  return text.split("\n").find((l) => re.test(l)) ?? text;
}

// --- tool calls -----------------------------------------------------------

export interface ToolCallInfo {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: unknown;
  durationMs?: number | undefined;
  error?: string | undefined;
  root: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_OP =
  /^\s*git\s+(commit|checkout|switch|merge|rebase|push|pull|stash|reset|revert|cherry-pick|tag|branch\s+-[dD])/;

export function callKey(toolName: string, toolInput: Record<string, unknown>): string {
  return `${toolName}:${createHash("sha1").update(JSON.stringify(toolInput)).digest("hex").slice(0, 12)}`;
}

function responseText(r: unknown): string {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    if (typeof o.stdout === "string")
      return `${o.stdout}\n${typeof o.stderr === "string" ? o.stderr : ""}`;
    if (Array.isArray(o.content)) {
      return o.content
        .map((c) =>
          c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
        )
        .join("\n");
    }
    if (typeof o.error === "string") return o.error;
  }
  return "";
}

function responseFailed(r: unknown): string | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  if (o.is_error === true || o.isError === true) return responseText(r);
  if (typeof o.exit_code === "number" && o.exit_code !== 0) return responseText(r);
  if (typeof o.interrupted === "boolean" && o.interrupted) return "interrupted";
  return undefined;
}

/**
 * A failed call's output as the error event keeps it, which persist() also indexes for em_recall:
 * its secrets masked before the cut (a cut token can be too short for its shape rule), and on the
 * first 4 KB only, so a failing 2 MB output costs the hook nothing.
 */
function errorText(text: string): string {
  return masked(text, 400);
}

/**
 * Text kept in an event, at most n chars: masked first, then cut, because a token cut short no
 * longer has its shape (`ghp_` + 12 chars) and a quoted value cut before its closing quote is
 * not a value; and masked on the first 4 KB only, so a long input costs the hook nothing.
 */
function masked(text: string, n: number): string {
  return clip(redactSecrets(text.slice(0, 4096)), n);
}

/** summarizeInput(), masked before it is cut to 160 chars. */
function maskedSummary(toolName: string, input: Record<string, unknown>): string {
  return masked(summarySource(toolName, input), 160);
}

/** Events for one completed (or failed) tool call. */
export function classifyToolCall(info: ToolCallInfo): Draft[] {
  const { toolName, toolInput, root } = info;
  const out: Draft[] = [];
  const key = callKey(toolName, toolInput);
  const summary = maskedSummary(toolName, toolInput);
  out.push(ev("tool_call", { key, summary }, toolName));

  if (EDIT_TOOLS.has(toolName)) {
    const fp = String(toolInput.file_path ?? toolInput.notebook_path ?? "");
    if (fp) {
      const rel = relPath(root, fp);
      if (/\.claude\/plans\/|\/plans\/.*\.md$/.test(fp))
        out.push(ev("plans", { path: rel, action: toolName }, toolName));
      else out.push(ev("files", { path: rel, action: toolName }, toolName));
      if (/(^|\/)(CLAUDE|AGENTS)\.md$|\.claude\/settings/.test(fp))
        out.push(ev("rules", { path: rel, action: toolName }, toolName));
    }
  }
  if (toolName === "Bash") {
    const cmd = String(toolInput.command ?? "");
    if (GIT_OP.test(cmd)) out.push(ev("git", { command: masked(cmd, 200) }, toolName));
  }
  if (toolName === "TodoWrite" && Array.isArray(toolInput.todos)) {
    const todos = toolInput.todos as Array<{ content?: string; status?: string }>;
    out.push(
      ev(
        "tasks",
        {
          todos: todos
            .slice(0, 12)
            .map(
              (t) =>
                `${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "} ${clip(t.content, 80)}`,
            ),
        },
        toolName,
      ),
    );
  }
  if (toolName === "ExitPlanMode") out.push(ev("plans", { action: "plan approved" }, toolName));
  if (toolName === "Agent" || toolName === "Task") {
    out.push(
      ev(
        "subagent",
        { description: clip(toolInput.description, 120), type: toolInput.subagent_type },
        toolName,
      ),
    );
  }
  if (toolName === "Skill") out.push(ev("skill", { skill: clip(toolInput.skill, 80) }, toolName));
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    const ref = toolInput.url ?? toolInput.query;
    out.push(
      ev(
        "external_ref",
        { url: masked(typeof ref === "string" ? ref : clip(ref, 4096), 200) },
        toolName,
      ),
    );
  }
  if (toolName.startsWith("mcp__")) out.push(ev("mcp_tool", { tool: toolName }, toolName));
  if (info.durationMs && info.durationMs > 5000) {
    out.push(ev("latency", { ms: info.durationMs, summary }, toolName));
  }
  const failure = info.error ?? responseFailed(info.toolResponse);
  if (failure)
    out.push(
      ev(
        "error",
        {
          tool: toolName,
          summary,
          error: errorText(failure),
        },
        toolName,
      ),
    );
  return out;
}

export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  return clip(summarySource(toolName, input), 160);
}

/** The text a summary is cut from: the tool name and its main argument. */
function summarySource(toolName: string, input: Record<string, unknown>): string {
  const pick =
    input.command ??
    input.file_path ??
    input.pattern ??
    input.url ??
    input.prompt ??
    input.query ??
    input.description ??
    input.skill;
  return `${toolName} ${pick ?? ""}`.trim();
}

/** Events from the assistant's final message of a turn. */
export function classifyAssistant(message: string): Draft[] {
  const out: Draft[] = [];
  if (!message.trim()) return out;
  out.push(ev("assistant_summary", { text: clip(message.replace(/\s+/g, " "), 500) }));
  if (DECISION.test(message))
    out.push(
      ev("decision", { text: clip(firstMatchLine(message, DECISION), 300), by: "assistant" }),
    );
  if (RESOLVED.test(message))
    out.push(ev("error_resolution", { text: clip(firstMatchLine(message, RESOLVED), 300) }));
  if (BLOCKER.test(message))
    out.push(ev("blocker", { text: clip(firstMatchLine(message, BLOCKER), 300), by: "assistant" }));
  return out;
}
