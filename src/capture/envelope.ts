/**
 * Turns Claude Code sends through UserPromptSubmit that the user did not type, and how to find
 * the user's words in a prompt that carries harness context. Shared by the prompt recall
 * (src/hooks/capture.ts) and the adjudicator (src/adjudicator/hooks.ts).
 */

/**
 * The opening tags of turns Claude Code sends through UserPromptSubmit that the user did not
 * type: a subagent's hand-back (`<agent-message from="…">`), a background task's notification
 * (`<task-notification>`), a CI monitor's event (`<ci-monitor-event>`) and harness context
 * (`<system-reminder>`, `<system-reminder id="…">`).
 */
const HARNESS_ENVELOPE =
  /^\s*<(?:agent-message|task-notification|ci-monitor-event|system-reminder)[\s>]/;

/** One closed `<system-reminder …>…</system-reminder>` block at the start (after whitespace). */
const LEADING_REMINDER = /^\s*<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/;

/**
 * The prompt without its leading closed system-reminder blocks, trimmed. Claude Code can put
 * harness context ahead of the typed text (a worktree note, for example); the rest is the user's.
 */
export function stripLeadingReminders(text: string): string {
  let rest = text;
  for (let m = LEADING_REMINDER.exec(rest); m; m = LEADING_REMINDER.exec(rest)) {
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

/**
 * Is this prompt a harness envelope rather than the user's words? Only the start counts: after
 * leading whitespace, `<agent-message`, `<task-notification`, `<ci-monitor-event` or
 * `<system-reminder` followed by
 * `>` or whitespace. Closed system-reminder blocks are stripped first: text after them is the
 * user's, and only nothing left (or another envelope, or an unclosed reminder) is an envelope.
 * A prompt that mentions one of these tags later on is the user's, and anything that is not a
 * string is not an envelope (when unsure, the prompt is scored).
 */
export function isHarnessEnvelope(text: unknown): boolean {
  if (typeof text !== "string" || !HARNESS_ENVELOPE.test(text)) return false;
  const rest = stripLeadingReminders(text);
  return rest === "" || HARNESS_ENVELOPE.test(rest);
}
