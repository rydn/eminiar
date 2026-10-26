import { z } from "zod";
import { vectorRanker } from "../embeddings/queue.js";
import { formatResults } from "../search/format.js";
import { contentTypeFilter, type SearchResponse, search } from "../search/pipeline.js";
import { recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, text } from "./types.js";

/** `docs:*` selects every source with that prefix; anything else is an exact tag (or list). */
export function sourceFilter(source: string | string[] | undefined): {
  source?: string | string[] | undefined;
  sourcePrefix?: string | undefined;
} {
  if (typeof source === "string" && source.endsWith("*"))
    return { sourcePrefix: source.slice(0, -1) };
  return { source };
}

export const emSearch = defineTool({
  name: "em_search",
  description:
    'Search everything eminiar has indexed: sandbox outputs, files, fetched pages, session memory, memories, commit messages (source git) and code (chunks named by symbol, e.g. `src/auth.ts > Session.refresh`). Reach for it before Grep or Bash when looking for where something lives, what an earlier command printed, or what a past session found: `source: "code"` answers code questions by symbol, `sort: timeline` orders by recency (use after a resume), `mode: regex` scans indexed content with a JS regular expression and returns the matching lines with context (for ad-hoc greps over files not indexed, use em_execute with rg). Pass several queries at once — the round trip is paid once. Hybrid BM25 (porter + trigram) with typo correction.',
  schema: {
    queries: z.array(z.string().min(1)).min(1).describe("One or more search queries"),
    source: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Restrict to a source tag (exec, batch, file, url, session, memory, code, docs:<name>, …); a trailing * matches a prefix (docs:* = all documentation sources)",
      ),
    content_type: z.enum(["code", "prose", "json"]).optional(),
    sort: z.enum(["relevance", "timeline"]).optional(),
    mode: z
      .enum(["hybrid", "lexical", "semantic", "regex"])
      .optional()
      .describe(
        "Default hybrid; falls back to lexical when embeddings are unavailable. regex: each query is a JS regular expression",
      ),
    limit: z.number().int().min(1).max(50).optional().describe("Hits per query (default 5)"),
    max_tokens: z
      .number()
      .int()
      .min(100)
      .max(20000)
      .optional()
      .describe("Total output budget (default 2000)"),
    since: z.string().optional().describe("ISO date/time; only documents created after this"),
    document_ids: z
      .array(z.number().int())
      .optional()
      .describe("Restrict to specific documents (e.g. from em_execute)"),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = getStorage(ctx);
    const since = args.since ? Date.parse(args.since) : undefined;
    const mode = args.mode ?? "hybrid";
    const vectorSearch =
      mode === "lexical" || mode === "regex" ? undefined : await vectorRanker(ctx, db);
    const responses: SearchResponse[] = [];
    for (const q of args.queries) {
      try {
        responses.push(
          await search(db, q, {
            limit: args.limit ?? ctx.config.search.defaultLimit,
            mode,
            sort: args.sort ?? "relevance",
            vectorSearch,
            filters: {
              ...sourceFilter(args.source),
              contentType: contentTypeFilter(args.content_type),
              since: since && !Number.isNaN(since) ? since : undefined,
              documentIds: args.document_ids,
            },
          }),
        );
      } catch (err) {
        if (mode === "regex") return errorResult(`invalid regex "${q}": ${(err as Error).message}`);
        throw err;
      }
    }
    const out = formatResults(responses, args.max_tokens ?? ctx.config.search.defaultMaxTokens);
    const note =
      mode !== "lexical" && mode !== "regex" && !vectorSearch && ctx.config.embeddings.enabled
        ? "\n\n(embeddings: model still loading — lexical results only this time)"
        : "";
    recordStat(ctx, "em_search", {
      rawChars: responses.reduce(
        (a, r) => a + r.hits.reduce((b, h) => b + h.chunk.body.length, 0),
        0,
      ),
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out + note);
  },
});
