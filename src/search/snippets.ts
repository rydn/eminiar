/** Matching lines with `context` lines around each, merged, at most `max` windows. */
export function regexSnippet(
  body: string,
  re: RegExp,
  opts: { context?: number; max?: number } = {},
): string {
  const context = opts.context ?? 2;
  const max = opts.max ?? 3;
  const lines = body.split("\n");
  const windows: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (!re.test(lines[i]!)) continue;
    const a = Math.max(0, i - context);
    const b = Math.min(lines.length - 1, i + context);
    const last = windows[windows.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else windows.push([a, b]);
  }
  if (!windows.length) return lines.slice(0, context * 2 + 1).join("\n");
  return windows
    .slice(0, max)
    .map(([a, b]) => lines.slice(a, b + 1).join("\n"))
    .join("\n⋯\n");
}

/**
 * Cut windows of ±`radius` chars around each matched term, merge overlaps, cap
 * the count. Code chunks are expanded to whole lines so snippets stay readable.
 */
export function snippet(
  body: string,
  terms: string[],
  opts: { radius?: number; max?: number; wholeLines?: boolean } = {},
): string {
  const radius = opts.radius ?? 180;
  const max = opts.max ?? 3;
  const lower = body.toLowerCase();
  const hits: number[] = [];
  for (const t of terms) {
    const needle = t.replace(/\*$/, "").toLowerCase();
    if (!needle) continue;
    let i = lower.indexOf(needle);
    while (i !== -1 && hits.length < 40) {
      hits.push(i);
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  if (!hits.length) return body.length <= radius * 2 ? body : `${body.slice(0, radius * 2)}…`;
  hits.sort((a, b) => a - b);
  const windows: Array<[number, number]> = [];
  for (const h of hits) {
    const start = Math.max(0, h - radius);
    const end = Math.min(body.length, h + radius);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }
  return windows
    .slice(0, max)
    .map(([s, e]) => {
      let a = s;
      let b = e;
      if (opts.wholeLines) {
        a = body.lastIndexOf("\n", s) + 1;
        const nl = body.indexOf("\n", e);
        b = nl === -1 ? body.length : nl;
      }
      return `${a > 0 ? "…" : ""}${body.slice(a, b).trim()}${b < body.length ? "…" : ""}`;
    })
    .join("\n⋯\n");
}
