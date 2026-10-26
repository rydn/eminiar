import { z } from "zod";
import { describeRun, execute } from "../sandbox/execute.js";
import { processOutput } from "../sandbox/output.js";
import { formatResults } from "../search/format.js";
import { type SearchResponse, search } from "../search/pipeline.js";
import { recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, text } from "./types.js";

/** Per-output inline cap when `queries`/`intent` are given: the query hits carry the content. */
const INLINE_LIMIT_WITH_QUERIES = 1024;
const DEFAULT_MAX_TOKENS = 2000;

/**
 * Pick which outputs to return verbatim. Every output is indexed; an output is inlined
 * when it is at most `perOutputCap` chars and still fits the shared `budgetChars`, the
 * smallest outputs served first so one large output never starves the others. Returns
 * the indexes of the outputs to inline.
 */
export function chooseInline(lengths: number[], perOutputCap: number, budgetChars: number) {
  const candidates = lengths
    .map((len, i) => ({ len, i }))
    .filter((c) => c.len <= perOutputCap)
    .sort((a, b) => a.len - b.len);
  const inline = new Set<number>();
  let remaining = budgetChars;
  for (const c of candidates) {
    if (c.len > remaining) break;
    inline.add(c.i);
    remaining -= c.len;
  }
  return inline;
}

export const emBatchExecute = defineTool({
  name: "em_batch_execute",
  description:
    "Run several labelled commands in parallel, index every output under its label, and answer `queries` against all of them in the same round trip. Ideal for research: git status + recent commits + test output + dependency list in one call. Without `queries`/`intent`, each output up to the index threshold (5 KB) is returned inline, within `max_tokens` overall; with them, only outputs up to 1 KB are inlined and the query hits carry the rest. Every output is indexed; an elided one is fetched with em_search {document_ids: [N]}.",
  schema: {
    commands: z
      .array(
        z.object({
          label: z.string().min(1).describe("Section title for this output; make it descriptive"),
          command: z.string().min(1),
          language: z.string().optional().describe("default shell"),
        }),
      )
      .min(1)
      .max(32),
    queries: z.array(z.string()).optional().describe("Questions to answer across all outputs"),
    intent: z.string().optional().describe("Overall goal; used as an extra query"),
    concurrency: z.number().int().min(1).max(8).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
    max_tokens: z.number().int().min(100).max(20_000).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = getStorage(ctx);
    const concurrency = args.concurrency ?? 4;
    const results: Array<{
      label: string;
      header: string;
      stdout?: string | undefined;
      docId?: number | undefined;
      stderr?: string | undefined;
    }> = [];
    let rawChars = 0;
    const queries = [...(args.queries ?? [])];
    if (args.intent && !queries.includes(args.intent)) queries.unshift(args.intent);
    const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;

    const queue = [...args.commands];
    const worker = async () => {
      for (;;) {
        const cmd = queue.shift();
        if (!cmd) return;
        try {
          const r = await execute(ctx, {
            language: cmd.language ?? "shell",
            code: cmd.command,
            timeoutMs: args.timeout_ms,
          });
          rawChars += r.stdout.length + r.stderr.length;
          const p = await processOutput(db, ctx, {
            stdout: r.stdout,
            title: cmd.label,
            source: "batch",
            forceIndex: true,
          });
          results.push({
            label: cmd.label,
            header: describeRun(r),
            stdout: r.stdout,
            docId: p.documentId,
            stderr: r.exitCode !== 0 ? r.stderr.trim().slice(-800) : undefined,
          });
        } catch (err) {
          results.push({ label: cmd.label, header: `failed: ${(err as Error).message}` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

    const order = new Map(args.commands.map((c, i) => [c.label, i]));
    results.sort((a, b) => (order.get(a.label) ?? 0) - (order.get(b.label) ?? 0));

    // Inline rule: without queries, up to the index threshold per output (as em_execute
    // does), within the token budget overall; with queries, the 1 KB cap of old.
    const perOutputCap = queries.length
      ? INLINE_LIMIT_WITH_QUERIES
      : ctx.config.sandbox.indexThreshold;
    const inline = chooseInline(
      results.map((r) => r.stdout?.length ?? Number.POSITIVE_INFINITY),
      perOutputCap,
      maxTokens * 4,
    );

    const lines: string[] = [];
    results.forEach((r, i) => {
      const shown = inline.has(i) && r.stdout !== undefined;
      const hint =
        r.docId && !shown ? ` · em_search {document_ids: [${r.docId}]} for the output` : "";
      lines.push(`## ${r.label} — ${r.header}${r.docId ? ` · doc ${r.docId}` : ""}${hint}`);
      if (shown) lines.push(r.stdout!.trimEnd());
      if (r.stderr) lines.push(`stderr: ${r.stderr}`);
      lines.push("");
    });

    const docIds = results.map((r) => r.docId).filter((d): d is number => d !== undefined);
    if (queries.length && docIds.length) {
      const responses: SearchResponse[] = [];
      for (const q of queries) {
        responses.push(
          await search(db, q, { limit: 5, mode: "lexical", filters: { documentIds: docIds } }),
        );
      }
      lines.push("# query hits");
      lines.push(formatResults(responses, maxTokens));
    }
    const out = lines.join("\n");
    recordStat(ctx, "em_batch_execute", {
      rawChars,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});
