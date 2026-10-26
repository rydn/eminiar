/**
 * Pure helpers for the Usage view (no Preact, no DOM) so the node test suite can cover
 * them: the per-model palette, the model-id shortener and the contiguous day axis.
 */

// --- payload shapes (mirror src/tools/em_usage.ts) --------------------------------------

export interface Totals {
  calls: number;
  input: number;
  output: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  thinking: number;
  costUsd: number;
  unpricedCalls: number;
  cacheHitRate: number;
  models: Record<string, number>;
}
export interface ModelSlice {
  model: string;
  calls: number;
  costUsd: number;
  unpricedCalls: number;
}
export interface PeriodRow {
  key: string;
  totals: Totals;
  models: ModelSlice[];
}

export const EMPTY_TOTALS: Totals = {
  calls: 0,
  input: 0,
  output: 0,
  cacheCreate5m: 0,
  cacheCreate1h: 0,
  cacheRead: 0,
  thinking: 0,
  costUsd: 0,
  unpricedCalls: 0,
  cacheHitRate: 0,
  models: {},
};

// --- palette ---------------------------------------------------------------------------

/**
 * Categorical palette: the model family sets the hue (opus violet #7c3aed, sonnet blue
 * #2563eb, haiku green #16a34a, fable rose #e11d48, other grey; the hues stay apart under
 * CVD) and each distinct model id within a family gets its own lightness step, so
 * `sonnet-4-5` and `sonnet-4-5[1m]`, or `opus-4-1` and `opus-5-5`, never share a colour.
 * Every swatch is drawn next to the model's name, so colour is never the only signal.
 */
type Hsl = [h: number, s: number, l: number];
const FAMILY_HSL: Record<string, Hsl> = {
  opus: [263, 84, 58],
  sonnet: [221, 83, 53],
  haiku: [142, 76, 36],
  fable: [347, 77, 50],
  other: [220, 9, 46],
};
const OTHER: Hsl = [220, 9, 46];
const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

export function familyOf(model: string): string {
  const m = model.toLowerCase();
  for (const k of FAMILIES) if (m.includes(k)) return k === "mythos" ? "fable" : k;
  return "other";
}
const hsl = ([h, s, l]: Hsl) => `hsl(${h} ${s}% ${l}%)`;

/** The family's base colour: what a model gets when it is the only id of its family. */
export function modelColor(model: string): string {
  return hsl(FAMILY_HSL[familyOf(model)] ?? OTHER);
}

/** One colour per distinct model id (see above); ids absent from the map fall back to modelColor. */
export function buildPalette(ids: Iterable<string>): Map<string, string> {
  const byFamily = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const fam = familyOf(id);
    const list = byFamily.get(fam);
    if (list) list.push(id);
    else byFamily.set(fam, [id]);
  }
  const out = new Map<string, string>();
  for (const [fam, list] of byFamily) {
    const [h, s, l] = FAMILY_HSL[fam] ?? OTHER;
    list.sort();
    const n = list.length;
    const step = n > 1 ? Math.min(14, 40 / (n - 1)) : 0;
    list.forEach((id, i) => {
      const light = Math.max(28, Math.min(72, l + (i - (n - 1) / 2) * step));
      out.set(id, hsl([h, s, Math.round(light)]));
    });
  }
  return out;
}
export type ColorFn = (model: string) => string;

// --- labels ----------------------------------------------------------------------------

/** `claude-sonnet-4-5-20250929[1m]` → `sonnet-4-5[1m]`. */
export const shortModel = (m: string): string =>
  m.replace(/^claude-/, "").replace(/-\d{8}(\[1m\])?$/, "$1");

// --- day axis --------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Every local calendar day from the start of the range (or the earliest row, whichever is
 * older) to today, with zero rows where there were no calls, so the x axis is contiguous.
 * Walks the local calendar (not 24-hour steps) so DST changes neither skip nor repeat a day.
 */
export function fillDays(rows: PeriodRow[], days: number, now = Date.now()): PeriodRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const today = new Date(now);
  let start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  const first = rows[0]?.key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (first) {
    const d = new Date(Number(first[1]), Number(first[2]) - 1, Number(first[3]));
    if (d < start) start = d;
  }
  const out: PeriodRow[] = [];
  for (
    let d = start, i = 0;
    d <= today && i < 400;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), i += 1
  ) {
    const key = localKey(d);
    out.push(byKey.get(key) ?? { key, totals: EMPTY_TOTALS, models: [] });
    byKey.delete(key);
  }
  for (const r of rows) if (byKey.has(r.key)) out.push(r); // the odd row past "today"
  return out;
}
