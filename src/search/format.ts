import type { SearchResponse } from "./pipeline.js";

/** Render one or more search responses within a shared character budget (≈ tokens × 4). */
export function formatResults(responses: SearchResponse[], maxTokens: number): string {
  const budget = maxTokens * 4;
  const perQuery = Math.floor(budget / Math.max(1, responses.length));
  const out: string[] = [];
  for (const r of responses) {
    const lines: string[] = [];
    if (responses.length > 1) lines.push(`# ${r.query}`);
    if (r.corrections.length) {
      lines.push(`(corrected: ${r.corrections.map((c) => `${c.from}→${c.to}`).join(", ")})`);
    }
    if (!r.hits.length) {
      lines.push("no matches");
      out.push(lines.join("\n"));
      continue;
    }
    let used = lines.join("\n").length;
    for (const h of r.hits) {
      const d = h.chunk.document;
      const when = new Date(d.created_at).toISOString().slice(0, 16).replace("T", " ");
      const loc = h.chunk.start_line ? ` L${h.chunk.start_line}-${h.chunk.end_line}` : "";
      // A window of a huge symbol is titled "… > Name (L a-b)"; name the symbol so the
      // reader can jump to it with em_symbols even though the title is a fragment.
      const sym =
        h.chunk.symbol_id && /\(L\d+-\d+\)$/.test(h.chunk.title) ? ` · ${h.chunk.symbol_id}` : "";
      const header = `## ${h.chunk.title} (${d.source} · doc ${d.id} · chunk ${h.chunk.ord}${loc} · ${when} · ${h.score.toFixed(3)}${sym})`;
      const block = `${header}\n${h.snippet}\n`;
      if (used + block.length > perQuery && lines.length > 1) {
        lines.push(
          `… ${r.hits.length - (lines.length - 1)} more hit(s) omitted; narrow the query or raise max_tokens`,
        );
        break;
      }
      lines.push(block);
      used += block.length;
    }
    out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}
