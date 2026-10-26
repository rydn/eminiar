import type { ProjectContext } from "../context.js";
import { reconcile } from "../memory/store.js";
import { getStorage } from "../storage/index.js";
import type { EventRow } from "../storage/types.js";
import {
  fileContext,
  fileSymbols,
  formatRecallStats,
  memoriesForFile,
  RECALL_CATEGORY,
  type RecallTrace,
  recallForText,
  recallStats,
  type TraceCandidate,
} from "./recall.js";

/**
 * `eminiar recall --explain / --file / --replay`: the hooks' recall decisions made
 * visible. Same storage mode as the hooks (no vectors), same rules, so what this prints
 * is what a prompt, a Read or an Edit would have attached.
 */

const MARK: Record<TraceCandidate["outcome"], string> = {
  shown: "✓ shown  ",
  seen: "· seen   ",
  gated: "· gated  ",
  skipped: "· skipped",
  "over-limit": "· limit  ",
};

function candidateLines(cands: TraceCandidate[], prefix: string): string[] {
  return cands.map(
    (c) =>
      `${prefix}${MARK[c.outcome]} ${c.label}${c.matched.length ? `  matched: ${c.matched.map((t) => t.replace(/\*$/, "")).join(", ")}` : ""}${c.why ? `  (${c.why})` : ""}`,
  );
}

function renderTrace(t: RecallTrace | undefined, fired: string[]): string[] {
  if (!t) return ["(no trace)"];
  const lines = [
    `terms (${t.terms.length}): ${t.terms.join(" ") || "—"}`,
    t.terms.length < 2
      ? "bar: too vague (fewer than two distinctive terms) — nothing is attached"
      : `bar: ${t.need} shared terms, or one term that names a memory (slug word or tag) when the prompt is short enough for it to be the topic`,
  ];
  const memories = t.candidates.filter((c) => c.key.startsWith("memory:"));
  const docs = t.candidates.filter((c) => c.key.startsWith("doc:"));
  lines.push(`memories (${memories.length} candidate${memories.length === 1 ? "" : "s"}):`);
  lines.push(...(memories.length ? candidateLines(memories, "  ") : ["  none share a term"]));
  lines.push(`docs (${docs.length} candidate${docs.length === 1 ? "" : "s"}):`);
  lines.push(...(docs.length ? candidateLines(docs, "  ") : ["  none share enough terms"]));
  lines.push(
    fired.length
      ? `result: would attach ${fired.length} item(s): ${fired.join(", ")}`
      : "result: stays quiet",
  );
  return lines;
}

/** Why hook recall would or would not fire for a prompt, candidate by candidate. */
export async function explainPrompt(
  ctx: ProjectContext,
  prompt: string,
  opts: { sessionId?: string | undefined } = {},
): Promise<string> {
  const db = getStorage(ctx, { vectors: false });
  reconcile(ctx, db);
  const { recall } = ctx.config;
  const r = await recallForText(db, prompt, {
    maxMemories: recall.maxMemories,
    maxDocs: recall.maxDocs,
    sessionId: opts.sessionId,
    repeatAfter: recall.repeatAfter,
    trace: true,
  });
  const head = [
    `prompt: ${prompt.length > 120 ? `${prompt.slice(0, 119)}…` : prompt}`,
    opts.sessionId
      ? `session ${opts.sessionId}: items shown in its current context window count as seen (repeat after ${recall.repeatAfter} prompts)`
      : "no --session: nothing counts as already seen",
  ];
  return [...head, ...renderTrace(r.trace, r.keys)].join("\n");
}

/** What a Read or Edit of a file would attach: memories about it, fix history, fan-in. */
export function explainFile(
  ctx: ProjectContext,
  path: string,
  opts: { sessionId?: string | undefined } = {},
): string {
  const db = getStorage(ctx, { vectors: false });
  reconcile(ctx, db);
  const rel = path.replace(/^\.\//, "");
  const { recall } = ctx.config;
  const symbols = fileSymbols(db, rel);
  const mem = memoriesForFile(db, rel, {
    sessionId: opts.sessionId,
    symbols,
    repeatAfter: recall.repeatAfter,
    trace: true,
  });
  const hist = fileContext(db, rel, { sessionId: opts.sessionId, edit: true, repeatAfter: 0 });
  const lines = [
    `file: ${rel} (${symbols.length} symbol${symbols.length === 1 ? "" : "s"} in the graph${symbols.length ? `: ${symbols.slice(0, 8).join(", ")}${symbols.length > 8 ? ", …" : ""}` : ""})`,
    `memories (${mem.trace?.candidates.length ?? 0} about this file — linked, naming the path, or naming a symbol):`,
    ...(mem.trace?.candidates.length
      ? candidateLines(mem.trace.candidates, "  ")
      : ["  none (link one with em_remember {related_files} or name the path in its body)"]),
    "history and graph (on an edit; the fix record also on a read):",
    ...(hist.text
      ? hist.text.split("\n").map((l) => `  ${l}`)
      : [
          db.metaGet("history_files")
            ? "  nothing to flag: not bug-prone, fewer than 5 importers"
            : '  history table not built yet (em_history {action:"overview"} or the server warm-up builds it)',
        ]),
  ];
  return lines.join("\n");
}

function parseSince(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const rel = /^(\d+)\s*(d|days?|w|weeks?|m|months?)$/i.exec(s.trim());
  if (rel) {
    const n = Number(rel[1]);
    const u = (rel[2] ?? "d")[0]!.toLowerCase();
    return Date.now() - n * (u === "d" ? 1 : u === "w" ? 7 : 30) * 86_400_000;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function promptOf(e: EventRow): string | undefined {
  try {
    const t = (JSON.parse(e.payload) as { text?: unknown }).text;
    return typeof t === "string" && t.trim() ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-run prompt recall over the prompts of past sessions with the current rules and
 * memories (nothing counts as seen) and report the hit rate, what held candidates back,
 * and the quiet prompts that came closest — the numbers to tune the bar against. The
 * live decisions recorded by the hooks are summarised alongside for comparison.
 */
export async function replayPrompts(
  ctx: ProjectContext,
  opts: { limit?: number | undefined; since?: string | undefined } = {},
): Promise<string> {
  const db = getStorage(ctx, { vectors: false });
  reconcile(ctx, db);
  const since = parseSince(opts.since);
  const limit = opts.limit ?? 200;
  const prompts = db
    .eventsRecent(limit * 2, ["user_prompt"])
    .filter((e) => !since || e.ts >= since)
    .map((e) => ({ when: e.ts, text: promptOf(e) }))
    .filter((p): p is { when: number; text: string } => !!p.text)
    .slice(0, limit);
  if (!prompts.length)
    return "no past prompts recorded yet (they are captured from the next session on)";

  const { recall } = ctx.config;
  let vague = 0;
  let withCandidates = 0;
  let fired = 0;
  let memories = 0;
  let docs = 0;
  const gated = new Map<string, number>();
  const near: Array<{ text: string; best: TraceCandidate }> = [];
  for (const p of prompts) {
    const r = await recallForText(db, p.text, {
      maxMemories: recall.maxMemories,
      maxDocs: recall.maxDocs,
      repeatAfter: 0,
      trace: true,
    });
    const t = r.trace!;
    if (t.terms.length < 2) {
      vague++;
      continue;
    }
    if (t.candidates.length) withCandidates++;
    if (r.keys.length) {
      fired++;
      memories += r.keys.filter((k) => k.startsWith("memory:")).length;
      docs += r.keys.filter((k) => k.startsWith("doc:")).length;
      continue;
    }
    for (const c of t.candidates) {
      if (c.outcome === "shown") continue;
      const why = (c.why ?? c.outcome).replace(/\d+\/\d+ terms/, "too few shared terms");
      gated.set(why, (gated.get(why) ?? 0) + 1);
    }
    const best = [...t.candidates].sort((a, b) => b.matched.length - a.matched.length)[0];
    if (best && near.length < 8) near.push({ text: p.text, best });
  }
  const total = prompts.length;
  const scored = total - vague;
  const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "–");
  const lines = [
    `replayed ${total} prompt(s)${since ? ` since ${new Date(since).toISOString().slice(0, 10)}` : ""} with the current rules and ${db.memoryCount()} memories:`,
    `  vague (fewer than 2 terms): ${vague}  ·  with a candidate: ${withCandidates}/${scored} (${pct(withCandidates, scored)})  ·  fired: ${fired}/${scored} (${pct(fired, scored)}) — ${memories} memories, ${docs} doc pages`,
  ];
  if (gated.size)
    lines.push(
      `  held back on quiet prompts: ${[...gated.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([w, n]) => `${w} ×${n}`)
        .join(", ")}`,
    );
  if (near.length) {
    lines.push("closest misses (quiet prompts and their best candidate):");
    for (const { text, best } of near)
      lines.push(
        `  "${text.length > 90 ? `${text.slice(0, 89)}…` : text.replace(/\s+/g, " ")}" → ${best.label} matched ${best.matched.map((t) => t.replace(/\*$/, "")).join(", ") || "nothing"} (${best.why ?? best.outcome})`,
      );
  }
  lines.push("");
  lines.push(
    formatRecallStats(
      "live decisions recorded by the hooks",
      recallStats(db.eventsRecent(5000, [RECALL_CATEGORY])),
    ),
  );
  lines.push(
    'tune: recall.maxMemories / maxDocs / repeatAfter in eminiar.config.json; `eminiar recall --explain "<prompt>"` for one prompt.',
  );
  return lines.join("\n");
}
