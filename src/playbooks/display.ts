/**
 * How the playbook CLI and em_playbook print stored text (a committed file can hold anything in
 * it) next to eminiar's own words, and how a prompt is shown on a terminal. Pure: the MCP server
 * bundle imports it, so it must not reach storage or any lazily imported module.
 */

/**
 * C0 and C1 controls, DEL, the line and paragraph separators and the bidi controls (embeddings,
 * overrides, isolates, marks): a terminal acts on them, or they reorder what is shown around them.
 */
const DISPLAY_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;
/** eminiar's own annotations next to stored text; stored text never shows them unescaped. */
const MARKERS = /\(private\)|\bhides\b|\btracked\b/gi;
/** A character as a JSON \u escape. */
const jsonEscape = (c: string): string =>
  `\\u${(c.codePointAt(0) as number).toString(16).padStart(4, "0")}`;
const STORED_TEXT_MAX = 200;

/**
 * Stored text (a title, a schedule hint, a tag, a parameter default: a committed file can hold
 * anything there) as eminiar prints it next to its own words: one line without control or bidi
 * characters, at most 200 characters, JSON-quoted so it cannot close the quote and carry on in
 * eminiar's voice. Inside the quotes, eminiar's markers ((private), [hides committed …], hides,
 * tracked) have the word's first letter written as a JSON escape, so a title cannot pass for
 * them; JSON.parse still gives the text back.
 */
export function fenced(s: string): string {
  const line = s.replace(DISPLAY_CONTROLS, " ").trim();
  const chars = Array.from(line);
  const capped =
    chars.length > STORED_TEXT_MAX ? `${chars.slice(0, STORED_TEXT_MAX - 1).join("")}…` : line;
  // the word's first letter is escaped: `(private)` keeps its parentheses, `[hides` its bracket
  return JSON.stringify(capped).replace(MARKERS, (m) => {
    const at = m.startsWith("(") ? 1 : 0;
    return `${m.slice(0, at)}${jsonEscape(m[at] as string)}${m.slice(at + 1)}`;
  });
}

/** A prompt's characters that a terminal would act on (ESC, a lone CR, BS, bidi controls…). */
const TERMINAL_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The prompt as a terminal should show it: every character in TERMINAL_CONTROLS written as a
 * visible escape (`\u001b`, `\r`); tabs, newlines and CRLF stay. `count` says how many.
 */
export function visibleControls(s: string): { text: string; count: number } {
  let count = 0;
  const text = s.replace(TERMINAL_CONTROLS, (c) => {
    count++;
    return c === "\r" ? "\\r" : jsonEscape(c);
  });
  return { text, count };
}
