/**
 * The header of a playbook file. The same tiny `key: value` format as memory files (no YAML
 * dependency), with one difference: a value or a list item may be a JSON string ("a #b",
 * "x, y"), so a `#` or a comma inside quotes is not a comment or a separator.
 *
 *   ---
 *   name: review-open-prs
 *   title: Review open PRs
 *   params: [repo, "channel=#eng-prs"]    # name or name=default
 *   schedule: every weekday 9am           # a hint for people; eminiar never runs it
 *   tags: [github, review]
 *   source: manual                        # manual | suggested
 *   created: 2026-11-11T09:00:00Z
 *   updated: 2026-11-11T09:00:00Z
 *   ---
 *
 *   The prompt, as markdown. {{repo}} marks a parameter.
 *
 * Unknown keys survive a rewrite.
 */
export type PlaybookMeta = Record<string, string | string[]>;

/** Known keys are written first, in this order. */
const ORDER = ["name", "title", "params", "schedule", "tags", "source", "created", "updated"];

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Reads a JSON string starting at `s[i]` (a `"`); returns the value and the index after it. */
function readQuoted(s: string, i: number): { value: string; end: number } | undefined {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === '"') {
      try {
        return { value: JSON.parse(s.slice(i, j + 1)) as string, end: j + 1 };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function unquoteSingle(t: string): string {
  return t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t;
}

/** `s` starts with "[": the items up to the matching "]", split at top-level commas. */
function parseList(s: string): { items: string[]; end: number } | undefined {
  const items: string[] = [];
  let cur = "";
  let quoted = false;
  const flush = () => {
    const t = quoted ? cur : unquoteSingle(cur.trim());
    if (t.length > 0) items.push(t);
    cur = "";
    quoted = false;
  };
  for (let i = 1; i < s.length; ) {
    const c = s[i]!;
    if (c === '"' && !quoted && cur.trim() === "") {
      const q = readQuoted(s, i);
      if (q) {
        cur = q.value;
        quoted = true;
        i = q.end;
        continue;
      }
    }
    if (c === "]") {
      flush();
      return { items, end: i + 1 };
    }
    if (c === ",") flush();
    else if (!quoted) cur += c;
    i++;
  }
  return undefined; // unterminated: the caller keeps the raw text as a scalar
}

function parseValue(raw: string): string | string[] {
  const v = raw.trim();
  if (v.startsWith("[")) {
    const list = parseList(v);
    if (list && /^\s*(?:#.*)?$/.test(v.slice(list.end))) return list.items;
  }
  if (v.startsWith('"')) {
    const q = readQuoted(v, 0);
    if (q && /^\s*(?:#.*)?$/.test(v.slice(q.end))) return q.value;
  }
  return unquoteSingle(v.replace(/\s+#.*$/, "").trim());
}

export function parsePlaybookFile(text: string): {
  meta: PlaybookMeta;
  body: string;
  hadFrontmatter: boolean;
} {
  // A UTF-8 byte order mark (some editors add one) would hide the opening ---.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text, hadFrontmatter: false };
  const open = text.indexOf("\n") + 1;
  const close = /\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open - 1));
  if (!close) return { meta: {}, body: text, hadFrontmatter: false };
  const header = text.slice(open, open - 1 + close.index);
  const body = text.slice(open - 1 + close.index + close[0].length);
  const meta: PlaybookMeta = {};
  // The close marker starts at its "\n", so a CRLF header's last line still ends in "\r".
  for (const line of header.replace(/\r$/, "").split(/\r?\n/)) {
    // `[^\n\r]*`, not `.*`: a value holding U+2028 / U+2029 must not drop the whole line.
    const m = /^([A-Za-z0-9_-]+):\s*([^\n\r]*)$/.exec(line);
    // `__proto__: [a]` would set meta's prototype (a playbook file can come with the repo).
    if (!m || UNSAFE_KEYS.has(m[1]!)) continue;
    meta[m[1]!] = parseValue(m[2]!);
  }
  return { meta, body, hadFrontmatter: true };
}

/**
 * One line, no control characters (a newline in a header value would start a new key) and no
 * Unicode line or paragraph separators (U+2028, U+2029, NEL): a JS regex treats them as line ends.
 */
export function oneLine(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").trim();
}

/** A header value, quoted as JSON unless it reads back as itself bare. */
function scalar(v: string): string {
  const t = oneLine(v);
  return t.length > 0 && !/^["'[]/.test(t) && !/\s#/.test(t) ? t : JSON.stringify(t);
}

function item(v: string): string {
  const t = oneLine(v);
  return t.length > 0 && !/[,[\]#"']/.test(t) ? t : JSON.stringify(t);
}

export function serializePlaybookFile(meta: PlaybookMeta, body: string): string {
  const keys = [
    ...ORDER.filter((k) => k in meta),
    ...Object.keys(meta).filter((k) => !ORDER.includes(k) && !UNSAFE_KEYS.has(k)),
  ];
  const lines = keys.map((k) => {
    const v = meta[k];
    return Array.isArray(v) ? `${k}: [${v.map(item).join(", ")}]` : `${k}: ${scalar(v ?? "")}`;
  });
  // A leading "\n" in the body is the blank line that separates header from text.
  return `---\n${lines.join("\n")}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`;
}
