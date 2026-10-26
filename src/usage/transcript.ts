/**
 * Pure parser for Claude Code transcript JSONL (~/.claude/projects/<slug>/<session>.jsonl).
 * Turns raw lines into api_calls / tool_uses / context_events rows; never throws on a bad
 * line and tolerates schema drift (every field is read defensively).
 *
 * Entry shapes verified against real transcripts (Claude Code 2.1.292, 2026-10-26):
 *
 * - assistant: {type:"assistant", requestId, uuid, parentUuid, sessionId, timestamp (ISO),
 *   cwd, gitBranch, version, entrypoint, isSidechain, agentId?, promptId?, effort?,
 *   message:{id, model, stop_reason, usage:{input_tokens, output_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens,
 *   cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens},
 *   output_tokens_details:{thinking_tokens}, server_tool_use:{web_search_requests,
 *   web_fetch_requests}, service_tier, speed, iterations:[...]}, content:[block]}}.
 *   One API response is written as several entries (one per content block) that share
 *   requestId + message.id and repeat the usage: in a sample of 61 assistant entries there
 *   were 19 distinct (requestId, message.id) pairs. tool_use blocks: {type, id, name, input, caller}.
 * - user with tool results: message.content = [{type:"tool_result", tool_use_id, content:
 *   string | [{type:"text", text}], is_error?}], plus top-level toolUseResult (string|object).
 * - user prompt: message.content is a string (or text blocks) and isMeta is not true. Hooks
 *   already store prompts, so the parser ignores them.
 * - system compact_boundary (observed 2026-10-17/18, version 2.1.292):
 *   {type:"system", subtype:"compact_boundary", content:"Conversation compacted", isMeta:false,
 *   parentUuid:null, logicalParentUuid, timestamp, uuid, level:"info", sessionId, cwd, gitBranch,
 *   version, slug, compactMetadata:{trigger:"auto"|"manual", preTokens, postTokens, durationMs,
 *   cumulativeDroppedTokens, preCompactDiscoveredTools:[tool names],
 *   preservedSegment:{headUuid, anchorUuid, tailUuid}, preservedMessages:{anchorUuid, uuids, allUuids}}}.
 * - system local_command: {subtype:"local_command", commandRun:{command:"clear", args}} marks /clear.
 * - other system subtypes seen: turn_duration ({durationMs, messageCount}), stop_hook_summary.
 * - ignored top-level types: attachment, mode, atis-latch, last-prompt, ai-title,
 *   file-history-snapshot, file-history-delta, summary.
 * - subagent transcripts live at <dir>/<sessionId>/subagents/agent-<id>.jsonl (next to an
 *   agent-<id>.meta.json with agentType/description/toolUseId); their entries carry
 *   isSidechain:true, agentId and the parent sessionId. No top-level agent-*.jsonl was seen.
 */

import type { ApiCallInput, ContextEventInput, ToolUseRow } from "../storage/types.js";

export interface ParseContext {
  /** Fallback when an entry carries no sessionId of its own. */
  sessionId: string;
  /** The file the lines came from (diagnostics only). */
  path: string;
  /**
   * Epoch ms used for an entry with a missing or unparseable timestamp when no earlier
   * entry in the batch had one (ingest passes the file mtime). Defaults to now; never 0.
   */
  fallbackTs?: number | undefined;
}

export interface ParsedTranscript {
  calls: ApiCallInput[];
  toolUses: ToolUseRow[];
  contextEvents: ContextEventInput[];
  /** Newest entry timestamp seen, epoch ms. */
  lastTs?: number;
  /**
   * tool_result blocks flagged is_error that were really hook or permission denials
   * (eminiar's own PreToolUse routing, "permission denied"); stored with is_error = 0.
   */
  denied: number;
}

/** Chars charged for a non-text content part (image, document, tool_reference): ≈1,600 tokens. */
export const NON_TEXT_PART_CHARS = 6_400;

/**
 * A tool_result marked is_error whose text is a hook or permission denial rather than a
 * tool failure: eminiar's own PreToolUse routing hook ("PreToolUse:Bash hook error: …"),
 * any other hook error, or a permission denial.
 */
const DENIAL_RE = /^\s*PreToolUse:|hook error|\bdenied\b/i;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/**
 * An entry's timestamp in epoch ms, or undefined when it is missing or unparseable.
 * ISO strings go through Date.parse; a number below 1e12 is epoch seconds.
 */
function tsOf(e: Obj): number | undefined {
  const t = e.timestamp;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > 0) return ms;
    return undefined;
  }
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return t < 1e12 ? t * 1000 : t;
  return undefined;
}

/**
 * Characters in a tool_result block's content: a string, or the sum of its parts. Text
 * parts count their text; image / document / tool_reference parts count a fixed
 * NON_TEXT_PART_CHARS rather than their base64 payload, which is not what the model reads.
 */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (!isObj(part)) {
        n += safeJsonLength(part);
        continue;
      }
      const kind = str(part.type);
      if (kind === "text" || typeof part.text === "string") n += str(part.text)?.length ?? 0;
      else if (kind === "image" || kind === "document" || kind === "tool_reference")
        n += NON_TEXT_PART_CHARS;
      else n += safeJsonLength(part);
    }
    return n;
  }
  if (content === undefined || content === null) return 0;
  return safeJsonLength(content);
}

/** The text of a tool_result's content (string or the text parts), for denial detection. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content)
      if (isObj(part) && typeof part.text === "string") parts.push(part.text);
    return parts.join("\n");
  }
  return "";
}

function safeJsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function parseTranscriptLines(lines: string[], ctx: ParseContext): ParsedTranscript {
  const calls = new Map<string, ApiCallInput>();
  const toolUses = new Map<string, ToolUseRow>();
  const contextEvents: ContextEventInput[] = [];
  let lastTs: number | undefined;
  // The previous entry's ts (real or substituted) is the first fallback for a missing one;
  // substituted timestamps never move lastTs, which only reports what the file said.
  let prevTs: number | undefined;
  const fallbackTs =
    typeof ctx.fallbackTs === "number" && Number.isFinite(ctx.fallbackTs) && ctx.fallbackTs > 0
      ? ctx.fallbackTs
      : Date.now();
  let denied = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    const type = str(e.type);
    if (!type) continue;
    const sessionId = str(e.sessionId) ?? ctx.sessionId;
    const agentId = str(e.agentId);
    const sidechain = e.isSidechain === true ? 1 : 0;
    const real = tsOf(e);
    const ts = real ?? prevTs ?? fallbackTs;
    prevTs = ts;
    if (real !== undefined) lastTs = lastTs === undefined ? real : Math.max(lastTs, real);

    if (type === "assistant") {
      const msg = isObj(e.message) ? e.message : undefined;
      if (!msg) continue;
      const messageId = str(msg.id);
      const requestId = str(e.requestId) ?? messageId;
      // Tool-use blocks are recorded even when the entry has no usage (streaming partials).
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!isObj(block) || block.type !== "tool_use") continue;
          const id = str(block.id);
          if (!id) continue;
          const prev = toolUses.get(id);
          toolUses.set(id, {
            tool_use_id: id,
            session_id: prev?.session_id ?? sessionId,
            agent_id: prev?.agent_id ?? agentId,
            ts: prev?.ts ?? ts,
            tool: str(block.name) ?? prev?.tool ?? "",
            input_chars: block.input === undefined ? 0 : safeJsonLength(block.input),
            result_chars: prev?.result_chars ?? null,
            is_error: prev?.is_error ?? 0,
            request_id: requestId ?? prev?.request_id ?? null,
          });
        }
      }
      const usage = isObj(msg.usage) ? msg.usage : undefined;
      if (!usage || !messageId || !requestId) continue;
      const model = str(msg.model) ?? "unknown";
      const cc = isObj(usage.cache_creation) ? usage.cache_creation : undefined;
      const create5m = cc
        ? num(cc.ephemeral_5m_input_tokens)
        : num(usage.cache_creation_input_tokens);
      const create1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
      const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
      const server = isObj(usage.server_tool_use) ? usage.server_tool_use : undefined;
      const key = `${requestId}\u0000${messageId}`;
      const prev = calls.get(key);
      // Later entries for the same request can carry the final counts: keep the last usage seen.
      calls.set(key, {
        request_id: requestId,
        message_id: messageId,
        session_id: prev?.session_id ?? sessionId,
        agent_id: agentId ?? prev?.agent_id ?? null,
        sidechain: prev?.sidechain || sidechain,
        ts: prev?.ts ?? ts,
        model,
        input_tokens: num(usage.input_tokens),
        output_tokens: num(usage.output_tokens),
        cache_create_5m: create5m,
        cache_create_1h: create1h,
        cache_read: num(usage.cache_read_input_tokens),
        thinking_tokens: details ? num(details.thinking_tokens) : 0,
        web_searches: server ? num(server.web_search_requests) : 0,
        web_fetches: server ? num(server.web_fetch_requests) : 0,
        service_tier: str(usage.service_tier),
        speed: str(usage.speed),
        stop_reason: str(msg.stop_reason) ?? prev?.stop_reason ?? null,
        prompt_id: str(e.promptId) ?? prev?.prompt_id ?? null,
        git_branch: str(e.gitBranch) ?? prev?.git_branch ?? null,
        cwd: str(e.cwd) ?? prev?.cwd ?? null,
        effort: str(e.effort) ?? prev?.effort ?? null,
        version: str(e.version) ?? prev?.version ?? null,
        entrypoint: str(e.entrypoint) ?? prev?.entrypoint ?? null,
      });
      continue;
    }

    if (type === "user") {
      const msg = isObj(e.message) ? e.message : undefined;
      if (!msg || !Array.isArray(msg.content)) continue; // a plain prompt: hooks store those
      for (const block of msg.content) {
        if (!isObj(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        if (!id) continue;
        const prev = toolUses.get(id);
        let isError = prev?.is_error ?? 0;
        if (block.is_error === true) {
          // A hook or permission denial is not a tool failure: the tool never ran.
          if (DENIAL_RE.test(resultText(block.content))) denied += 1;
          else isError = 1;
        }
        toolUses.set(id, {
          tool_use_id: id,
          session_id: prev?.session_id ?? sessionId,
          agent_id: prev?.agent_id ?? agentId,
          ts: prev?.ts ?? ts,
          tool: prev?.tool ?? "",
          input_chars: prev?.input_chars ?? 0,
          result_chars: resultChars(block.content),
          is_error: isError,
          request_id: prev?.request_id ?? null,
        });
      }
      continue;
    }

    if (type === "system") {
      const subtype = str(e.subtype);
      if (subtype === "compact_boundary") {
        const meta = isObj(e.compactMetadata) ? e.compactMetadata : undefined;
        contextEvents.push({
          session_id: sessionId,
          ts,
          kind: "compact",
          trigger: meta ? str(meta.trigger) : null,
          pre_tokens: meta ? numOrNull(meta.preTokens) : null,
          post_tokens: meta ? numOrNull(meta.postTokens) : null,
        });
      } else if (subtype === "local_command") {
        const run = isObj(e.commandRun) ? e.commandRun : undefined;
        if (run && str(run.command) === "clear") {
          contextEvents.push({
            session_id: sessionId,
            ts,
            kind: "clear",
            trigger: "manual",
            pre_tokens: null,
            post_tokens: null,
          });
        }
      }
    }
    // attachment, mode, atis-latch, last-prompt, ai-title, file-history-*, summary: ignored
  }

  const out: ParsedTranscript = {
    calls: [...calls.values()],
    toolUses: [...toolUses.values()],
    contextEvents,
    denied,
  };
  if (lastTs !== undefined) out.lastTs = lastTs;
  return out;
}
