/**
 * Path globs for swarm role scopes, matched without regular expressions so a pattern from
 * a committed YAML file can never backtrack for seconds inside a hook.
 *
 * - `**` as a whole segment matches any number of segments (including none);
 * - `*` matches within a segment, `?` one character, `[abc]` / `[a-z]` / `[!a]` a class;
 * - `{a,b}` alternatives expand first (nested braces work, at most MAX_EXPANSIONS);
 * - a pattern without glob characters matches the path and everything under it
 *   (`src/ui` covers `src/ui/web/app.tsx`).
 */

const MAX_EXPANSIONS = 64;
const MAX_LENGTH = 300;

type Tok =
  | { t: "lit"; c: string }
  | { t: "any" }
  | { t: "one" }
  | { t: "class"; neg: boolean; ranges: Array<[string, string]> };

interface Compiled {
  /** Each expansion as a list of segments; a segment is "**" or a token list. */
  alts: Array<Array<"**" | Tok[]>>;
  prefix: boolean;
}

const cache = new Map<string, Compiled>();

export class GlobError extends Error {}

function normalize(g: string): string {
  let s = g.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Expand `{a,b}` alternatives, nested braces included. */
function expand(g: string, out: string[] = []): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        const body = g.slice(start + 1, i);
        const parts: string[] = [];
        let d = 0;
        let from = 0;
        for (let j = 0; j < body.length; j++) {
          if (body[j] === "{") d++;
          else if (body[j] === "}") d--;
          else if (body[j] === "," && d === 0) {
            parts.push(body.slice(from, j));
            from = j + 1;
          }
        }
        parts.push(body.slice(from));
        for (const p of parts) {
          expand(g.slice(0, start) + p + g.slice(i + 1), out);
          if (out.length > MAX_EXPANSIONS)
            throw new GlobError(`expands to more than ${MAX_EXPANSIONS} alternatives`);
        }
        return out;
      }
    }
  }
  if (depth !== 0) throw new GlobError("unbalanced {");
  out.push(g);
  return out;
}

function tokenize(seg: string): Tok[] {
  const toks: Tok[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") {
      // `a**b` inside a segment means the same as `a*b`; collapse runs of stars.
      if (toks.at(-1)?.t !== "any") toks.push({ t: "any" });
    } else if (c === "?") toks.push({ t: "one" });
    else if (c === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end === -1) throw new GlobError("unclosed [");
      let body = seg.slice(i + 1, end);
      const neg = body.startsWith("!") || body.startsWith("^");
      if (neg) body = body.slice(1);
      const ranges: Array<[string, string]> = [];
      for (let j = 0; j < body.length; j++) {
        const a = body[j]!;
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([a, body[j + 2]!]);
          j += 2;
        } else ranges.push([a, a]);
      }
      toks.push({ t: "class", neg, ranges });
      i = end;
    } else toks.push({ t: "lit", c });
  }
  return toks;
}

function compile(glob: string): Compiled {
  const hit = cache.get(glob);
  if (hit) return hit;
  const g = normalize(glob);
  if (g.length > MAX_LENGTH) throw new GlobError(`longer than ${MAX_LENGTH} characters`);
  const prefix = !/[*?[{]/.test(g);
  const alts = expand(g).map((p) =>
    p
      .split("/")
      .filter((s, _i, a) => s !== "" || a.length === 1)
      .map((s): "**" | Tok[] => (s === "**" ? "**" : tokenize(s))),
  );
  const c: Compiled = { alts, prefix };
  if (cache.size > 256) cache.clear();
  cache.set(glob, c);
  return c;
}

function tokMatch(t: Tok, ch: string): boolean {
  if (t.t === "one") return true;
  if (t.t === "lit") return t.c === ch;
  if (t.t === "class") {
    const inside = t.ranges.some(([a, b]) => ch >= a && ch <= b);
    return t.neg ? !inside : inside;
  }
  return false;
}

/** Wildcard match of one segment: two pointers with star backtracking, O(n·m) worst case. */
function segMatch(toks: Tok[], s: string): boolean {
  let ti = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    const t = toks[ti];
    if (t && t.t !== "any" && tokMatch(t, s[si]!)) {
      ti++;
      si++;
    } else if (t && t.t === "any") {
      star = ti++;
      mark = si;
    } else if (star !== -1) {
      ti = star + 1;
      si = ++mark;
    } else return false;
  }
  while (toks[ti]?.t === "any") ti++;
  return ti === toks.length;
}

/** Match path segments against pattern segments; `**` handled with a memoised walk. */
function pathMatch(pat: Array<"**" | Tok[]>, segs: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (pi: number, si: number): boolean => {
    const key = pi * (segs.length + 1) + si;
    const m = memo.get(key);
    if (m !== undefined) return m;
    let r: boolean;
    if (pi === pat.length) r = si === segs.length;
    else {
      const p = pat[pi]!;
      if (p === "**") r = go(pi + 1, si) || (si < segs.length && go(pi, si + 1));
      else r = si < segs.length && segMatch(p, segs[si]!) && go(pi + 1, si + 1);
    }
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** Throws GlobError when the pattern is unusable (for validation). */
export function checkGlob(glob: string): void {
  compile(glob);
}

export function globMatch(glob: string, path: string): boolean {
  let c: Compiled;
  try {
    c = compile(glob);
  } catch {
    return false;
  }
  const p = normalize(path);
  if (c.prefix) {
    const base = normalize(glob);
    return base === "" || p === base || p.startsWith(`${base}/`);
  }
  const segs = p.split("/");
  return c.alts.some((a) => pathMatch(a, segs));
}

/** True when `path` (project-relative) matches any glob; an empty glob list matches all. */
export function inScope(path: string, globs: string[]): boolean {
  if (!globs.length) return true;
  return globs.some((g) => globMatch(g, path));
}
