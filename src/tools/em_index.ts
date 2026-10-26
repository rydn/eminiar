import { z } from "zod";
import { kickEmbedding } from "../embeddings/queue.js";
import { indexContent, indexPath } from "../index/indexer.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, text } from "./types.js";

export const emIndex = defineTool({
  name: "em_index",
  description:
    "Index content into the local knowledge base so em_search can find it. Pass `content` (with a title) or a `path` (file or directory; directories use `glob`, default **/*.md). Markdown is chunked by heading, JSON by key path, code by declaration. Unchanged files are skipped.",
  schema: {
    path: z.string().optional().describe("File or directory, relative to the project root"),
    content: z.string().optional().describe("Inline content to index instead of a path"),
    title: z.string().optional().describe("Title for inline content (required with content)"),
    source: z.string().optional().describe("Source tag for filtering later (default: file)"),
    content_type: z.enum(["prose", "code", "json", "markdown"]).optional(),
    recursive: z.boolean().optional().describe("Recurse into directories (default true)"),
    glob: z
      .array(z.string())
      .optional()
      .describe('Globs for directory indexing, e.g. ["**/*.md", "docs/**"]'),
  },
  handler: async (args, ctx) => {
    const db = getStorage(ctx);
    if (args.content !== undefined) {
      if (!args.title) return errorResult("title is required when indexing inline content");
      const r = indexContent(db, {
        source: args.source ?? "inline",
        title: args.title,
        content: args.content,
        uri: `inline:${args.title}`,
        kind: args.content_type,
      });
      kickEmbedding(ctx, db);
      return text(
        `${r.created ? "indexed" : "unchanged"} "${args.title}" as doc ${r.documentId}: ${r.chunks} chunks, ${r.chars} chars (${r.kind})${r.fallback ? " (no sections found; indexed as one chunk)" : ""}`,
      );
    }
    if (!args.path) return errorResult("provide `path` or `content`");
    const s = indexPath(db, ctx.root, args.path, {
      source: args.source ?? "file",
      globs: args.glob ?? ctx.config.index.docs,
      recursive: args.recursive ?? true,
    });
    const lines = [
      `${args.path}: ${s.files} file(s), ${s.indexed} indexed, ${s.unchanged} unchanged, ${s.chunks} chunks${s.fallbacks ? ` (${s.fallbacks} with no sections found; indexed as one chunk)` : ""}`,
    ];
    for (const sk of s.skipped.slice(0, 10)) lines.push(`  skipped ${sk.path}: ${sk.reason}`);
    if (s.skipped.length > 10) lines.push(`  … ${s.skipped.length - 10} more skipped`);
    kickEmbedding(ctx, db);
    return text(lines.join("\n"));
  },
});
