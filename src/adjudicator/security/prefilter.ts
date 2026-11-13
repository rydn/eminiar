/**
 * A literal prefilter for the signal patterns (signals.ts). V8 compiles a RegExp the first time it
 * runs, and again (to native code) the second time: about 0.1 to 0.3 ms per pattern, so the ~40
 * cue patterns cost a hook process 3 to 6 ms before they have matched anything. Most texts can
 * match only a few of them. needlesOf(source) derives, from the pattern's own source, literal
 * strings of which every match contains at least one; GatedRegExp skips the regex (and its
 * compilation) when the text contains none of them. Derived, never hand-written, so a pattern
 * edit cannot leave its filter behind.
 *
 * Sound by construction: anything the small parser does not understand (a flag other than g, m
 * or s, a backreference, a named group, \p, \u, \x, ...) gives no needles, and the pattern then
 * always runs. A unit test checks every match of every signal pattern on the eval set against it.
 */

/** Literal strings of which every match contains at least one; null when none is known. */
type Req = readonly string[] | null;

class Unsupported extends Error {}

/** Escapes that stand for one literal character. */
const LITERAL_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
  v: "\v",
};
/** Escapes that match a class of characters or nothing (\b): no literal, but understood. */
const CLASS_ESCAPES = new Set(["s", "S", "w", "W", "d", "D", "b", "B"]);
/** Punctuation that a backslash makes literal. */
const PUNCT = new Set([..."\\/^$.|?*+()[]{}-,:=!<>#&~'\"`@% _;"]);

/**
 * A stretch of characters that stand for themselves outside a class. A sticky RegExp, not a
 * per-character loop: this code runs cold (interpreted), where a call per character costs more
 * than the patterns it spares.
 */
const PLAIN_RUN = /[a-zA-Z0-9 _\-'",:;=!<>@#%&~/]+/y;

/** `?`, `*`, `+` or `{`: what may quantify the character before it. */
function isQuantifier(c: string | undefined): boolean {
  return c === "?" || c === "*" || c === "+" || c === "{";
}

/** The better of two requirements: the one whose shortest needle is longest, then the fewer. */
function better(a: Req, b: Req): Req {
  if (!a) return b;
  if (!b) return a;
  const ma = shortest(a);
  const mb = shortest(b);
  if (ma !== mb) return ma > mb ? a : b;
  return a.length <= b.length ? a : b;
}

function shortest(r: readonly string[]): number {
  let m = Number.POSITIVE_INFINITY;
  for (const s of r) if (s.length < m) m = s.length;
  return m;
}

/** A recursive-descent reading of the subset of RegExp syntax the signal patterns use. */
class Reader {
  i = 0;
  constructor(readonly s: string) {}

  /** alternation := seq ('|' seq)* — every alternative must bring a needle. */
  alternation(): Req {
    const out: string[] = [];
    let known = true;
    for (;;) {
      const alt = this.seq();
      if (!alt) known = false;
      else if (known) for (const n of alt) if (!out.includes(n)) out.push(n);
      if (this.s[this.i] !== "|") break;
      this.i++;
    }
    return known ? out : null;
  }

  /** seq := (atom quantifier?)* — any one element's requirement holds for the sequence. */
  seq(): Req {
    let best: Req = null;
    let run = "";
    const flush = () => {
      if (run) best = better(best, [run]);
      run = "";
    };
    const s = this.s;
    while (this.i < s.length && s[this.i] !== "|" && s[this.i] !== ")") {
      // Fast path (this runs cold, once per pattern per process): a stretch of plain characters,
      // less a last one that a quantifier follows, joins the run in one slice.
      PLAIN_RUN.lastIndex = this.i;
      let j = PLAIN_RUN.test(s) ? PLAIN_RUN.lastIndex : this.i;
      if (j > this.i && isQuantifier(s[j])) j--;
      if (j > this.i) {
        run += s.slice(this.i, j);
        this.i = j;
        continue;
      }
      const atom = this.atom();
      const min = this.quantifier();
      if (atom.kind === "char" && min === -1) {
        run += atom.ch;
        continue;
      }
      if (atom.kind === "char") {
        // `x+` / `x{2,}` keep x itself; `x?` / `x*` drop it. Either way the run ends here.
        if (min >= 1) run += atom.ch;
        flush();
        continue;
      }
      flush();
      if (atom.kind === "group" && min !== 0) best = better(best, atom.req);
    }
    flush();
    return best;
  }

  /** -1: no quantifier; otherwise its minimum count. */
  quantifier(): number {
    const c = this.s[this.i];
    let min = -1;
    if (c === "?" || c === "*") {
      min = 0;
      this.i++;
    } else if (c === "+") {
      min = 1;
      this.i++;
    } else if (c === "{") {
      // {m}, {m,} or {m,n}; anything else (a literal brace) is not modelled.
      const end = this.s.indexOf("}", this.i);
      const body = end < 0 ? "" : this.s.slice(this.i + 1, end);
      const [lo = "", hi, extra] = body.split(",");
      const digits = (t: string) => t.length > 0 && [...t].every((d) => d >= "0" && d <= "9");
      if (!digits(lo) || extra !== undefined || (hi !== undefined && hi !== "" && !digits(hi)))
        throw new Unsupported("brace");
      min = Number(lo);
      this.i = end + 1;
    } else return -1;
    if (this.s[this.i] === "?") this.i++; // lazy
    return min;
  }

  atom(): { kind: "char"; ch: string } | { kind: "group"; req: Req } | { kind: "other" } {
    const c = this.s[this.i++];
    if (c === undefined) throw new Unsupported("end");
    if (c === "(") {
      let look = false;
      if (this.s.startsWith("?:", this.i)) this.i += 2;
      else if (this.s.startsWith("?=", this.i) || this.s.startsWith("?!", this.i)) {
        this.i += 2;
        look = true;
      } else if (this.s.startsWith("?<=", this.i) || this.s.startsWith("?<!", this.i)) {
        this.i += 3;
        look = true;
      } else if (this.s[this.i] === "?") throw new Unsupported("group");
      const req = this.alternation();
      if (this.s[this.i++] !== ")") throw new Unsupported("paren");
      // A lookaround consumes nothing: it brings no needle (and must not be quantified into one).
      return look ? { kind: "other" } : { kind: "group", req };
    }
    if (c === "[") {
      // A class: no literal. Skip to its end, minding escapes.
      if (this.s[this.i] === "^") this.i++;
      if (this.s[this.i] === "]") this.i++;
      while (this.i < this.s.length && this.s[this.i] !== "]") {
        if (this.s[this.i] === "\\") this.i++;
        this.i++;
      }
      if (this.s[this.i++] !== "]") throw new Unsupported("class");
      return { kind: "other" };
    }
    if (c === "\\") {
      const e = this.s[this.i++];
      if (e === undefined) throw new Unsupported("escape");
      if (CLASS_ESCAPES.has(e)) return { kind: "other" };
      const lit = LITERAL_ESCAPES[e];
      if (lit !== undefined) return { kind: "char", ch: lit };
      if (PUNCT.has(e)) return { kind: "char", ch: e };
      throw new Unsupported(`escape ${e}`);
    }
    if (c === "." || c === "^" || c === "$") return { kind: "other" };
    if (c === ")" || c === "|" || c === "?" || c === "*" || c === "+" || c === "{")
      throw new Unsupported(`stray ${c}`);
    return { kind: "char", ch: c };
  }
}

const cache = new Map<string, Req>();

/**
 * Literal strings of which every match of `source` (with `flags`) contains at least one; null
 * when the pattern could match without any (or the parser does not know its syntax).
 */
export function needlesOf(source: string, flags = ""): Req {
  const key = `${flags}/${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let req: Req = null;
  // Case folding (i), unicode syntax (u, v) and sticky matching (y) are not modelled.
  if ([...flags].every((f) => f === "g" || f === "m" || f === "s")) {
    try {
      const r = new Reader(source);
      req = r.alternation();
      if (r.i !== source.length) req = null;
    } catch {
      req = null;
    }
  }
  if (req && (req.length === 0 || req.some((n) => n.length === 0))) req = null;
  cache.set(key, req);
  return req;
}

/** May `text` hold a match of a pattern with these needles? */
export function mayMatch(needles: Req, text: string): boolean {
  if (!needles) return true;
  for (const n of needles) if (text.includes(n)) return true;
  return false;
}

/**
 * A RegExp that does not run (so is not compiled) on a text without any of its needles. Only
 * test() and matchAll() are gated, the two ways signals.ts uses its patterns; every other method
 * is the plain RegExp's.
 */
export class GatedRegExp extends RegExp {
  #needles: Req | undefined;
  /** Derived on first use: a pattern that never runs costs nothing. */
  get needles(): Req {
    if (this.#needles === undefined) this.#needles = needlesOf(this.source, this.flags);
    return this.#needles;
  }

  override test(text: string): boolean {
    if (mayMatch(this.needles, String(text))) return super.test(text);
    if (this.global) this.lastIndex = 0; // what a failed test leaves behind
    return false;
  }

  override [Symbol.matchAll](text: string): RegExpStringIterator<RegExpMatchArray> {
    if (mayMatch(this.needles, String(text))) return super[Symbol.matchAll](text);
    return ([] as RegExpMatchArray[]).values() as unknown as RegExpStringIterator<RegExpMatchArray>;
  }
}
