import { z } from "zod";
import { kickEmbedding } from "../embeddings/queue.js";
import { fetchMarkdown } from "../fetch/fetcher.js";
import { indexContent } from "../index/indexer.js";
import { formatResults } from "../search/format.js";
import { type SearchResponse, search } from "../search/pipeline.js";
import { getCurrentSession } from "../session/current.js";
import { recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, LOCAL_WRITE, text } from "./types.js";

export const emFetchAndIndex = defineTool({
  name: "em_fetch_and_index",
  annotations: { ...LOCAL_WRITE, idempotentHint: false, openWorldHint: true },
  description:
    "Fetch one or more URLs, convert to markdown, index them (24h cache) and optionally answer `queries` right away. Use instead of WebFetch for documentation, API references, issues and changelogs — the page never enters context, only the matching sections do.",
  schema: {
    url: z.string().url().optional(),
    urls: z.array(z.string().url()).max(16).optional(),
    queries: z
      .array(z.string())
      .optional()
      .describe("Questions to answer against the fetched pages"),
    ttl_hours: z
      .number()
      .min(0)
      .max(24 * 30)
      .optional()
      .describe("Cache TTL (default 24)"),
    force: z.boolean().optional().describe("Bypass the cache"),
    concurrency: z.number().int().min(1).max(8).optional(),
    max_tokens: z.number().int().min(100).max(20_000).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const urls = [...(args.url ? [args.url] : []), ...(args.urls ?? [])];
    if (!urls.length) return errorResult("provide url or urls");
    const db = getStorage(ctx);
    const ttlMs = (args.ttl_hours ?? 24) * 3600 * 1000;
    const results: Array<{ url: string; line: string; docId?: number }> = [];
    let rawChars = 0;

    const queue = [...urls];
    const worker = async () => {
      for (;;) {
        const url = queue.shift();
        if (!url) return;
        try {
          const f = await fetchMarkdown(url, { ttlMs, force: args.force ?? false });
          rawChars += f.markdown.length;
          if (!f.markdown.trim()) {
            results.push({ url, line: `empty body${f.status ? ` (HTTP ${f.status})` : ""}` });
            continue;
          }
          const r = indexContent(db, {
            source: "url",
            title: f.title ? `${f.title} (${url})` : url,
            uri: url,
            content: f.markdown,
            kind: "markdown",
            sessionId: getCurrentSession(ctx),
          });
          results.push({
            url,
            docId: r.documentId,
            line: `${f.cached ? "cached" : `fetched${f.status ? ` HTTP ${f.status}` : ""}`} · ${f.markdown.length} chars · ${r.chunks} chunks · doc ${r.documentId}${r.created ? "" : " (unchanged)"}`,
          });
        } catch (err) {
          results.push({ url, line: `failed: ${(err as Error).message}` });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(args.concurrency ?? 4, queue.length) }, worker),
    );

    kickEmbedding(ctx, db);
    const lines = results.map((r) => `${r.url}: ${r.line}`);
    const docIds = results.map((r) => r.docId).filter((d): d is number => d !== undefined);
    if (args.queries?.length && docIds.length) {
      const responses: SearchResponse[] = [];
      for (const q of args.queries) {
        responses.push(await search(db, q, { limit: 5, filters: { documentIds: docIds } }));
      }
      lines.push("", formatResults(responses, args.max_tokens ?? 2000));
    } else if (docIds.length) {
      lines.push(`\nuse em_search with document_ids: [${docIds.join(", ")}] to query the content`);
    }
    const out = lines.join("\n");
    recordStat(ctx, "em_fetch_and_index", {
      rawChars,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});
