import { z } from "zod";
import { getCodeBackend } from "../code/backend.js";
import {
  children,
  findSymbols,
  formatSymbol,
  isExported,
  overview,
  symbolBody,
} from "../code/symbols.js";
import { recordStat } from "../stats/record.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { GraphEdgeRow, GraphNodeRow } from "../storage/types.js";
import { ensureGraph } from "./em_graph.js";
import { defineTool, errorResult, text } from "./types.js";

function fence(body: string, budget: number, docId: number | undefined): string {
  const cut = body.length > budget;
  const shown = cut ? body.slice(0, budget) : body;
  return `\`\`\`\n${shown}\n\`\`\`${cut ? `\n… ${body.length - budget} more chars (raise max_tokens${docId ? ` or em_search {document_ids:[${docId}]}` : ""})` : ""}`;
}

function referrerLabel(db: StorageAdapter, id: string, nodes: Map<string, GraphNodeRow>): string {
  const n = nodes.get(id) ?? db.graphGetNode(id);
  if (!n) return id;
  if (n.kind === "file") return `${n.path ?? n.name} (top level)`;
  return `${n.path} > ${n.name}`;
}

export const emSymbols = defineTool({
  name: "em_symbols",
  description:
    "Symbol-level code navigation on the tree-sitter graph (TS/JS): overview lists every symbol in a file with kinds and line ranges; find matches a name path (`method`, `Class/method`, `Class.method`, `/Class/method` for whole-name, `src/x.ts#Class.method`), optionally with the body; references lists what calls, references, extends or implements a symbol, grouped by the referencing symbol. Compact output; prefer this over reading whole files.",
  schema: {
    mode: z.enum(["overview", "find", "references"]).optional().describe("default find"),
    file: z
      .string()
      .optional()
      .describe("overview: the file; find/references: restrict to (or referrers in) this path"),
    name_path: z.string().optional().describe("find/references: the symbol"),
    substring: z.boolean().optional().describe("find: match the last segment as a substring"),
    depth: z.number().int().min(0).max(3).optional().describe("find: also list members this deep"),
    include_body: z.boolean().optional().describe("find: include the source of each match"),
    kind: z
      .array(z.string())
      .optional()
      .describe(
        "find: only these kinds (function, class, method, interface, type, enum, variable, field)",
      ),
    limit: z.number().int().min(1).max(100).optional().describe("default 20"),
    max_tokens: z
      .number()
      .int()
      .min(100)
      .max(20000)
      .optional()
      .describe("output budget (default 2000)"),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    const mode = args.mode ?? "find";
    const limit = args.limit ?? 20;
    const budget = (args.max_tokens ?? 2000) * 4;
    let out: string;

    if (mode === "overview") {
      if (!args.file) return errorResult("overview needs `file`");
      const syms = overview(db, args.file);
      if (!syms.length)
        out = `${args.file}: no symbols (not indexed, not TS/JS, or empty; em_reindex {scope:"code", paths:["${args.file}"]})`;
      else {
        const lines = syms.map((n) => {
          const depth = n.name.split(".").length - 1;
          const short = n.name.split(".").pop();
          return `${"  ".repeat(depth)}${n.kind} ${short} L${n.start_line}-${n.end_line}${isExported(n) ? " exported" : ""}`;
        });
        out = `${args.file} — ${syms.length} symbol(s)\n${lines.join("\n")}`;
      }
    } else if (mode === "find") {
      if (!args.name_path) return errorResult("find needs `name_path`");
      const found = findSymbols(db, args.name_path, {
        substring: args.substring,
        kinds: args.kind,
        file: args.file,
        limit,
      });
      if (!found.length)
        out = `no symbol matches "${args.name_path}"${args.file ? ` in ${args.file}` : ""} (try substring: true, or em_symbols {mode:"overview", file})`;
      else {
        const perBody = Math.max(200, Math.floor(budget / found.length) - 200);
        const blocks: string[] = [];
        for (const n of found) {
          const parts = [`- ${formatSymbol(n)}`];
          if (args.depth) {
            for (const c of children(db, n, args.depth)) {
              const d = c.name.split(".").length - n.name.split(".").length;
              parts.push(
                `${"  ".repeat(d)}- ${c.kind} ${c.name.split(".").pop()} L${c.start_line}-${c.end_line}`,
              );
            }
          }
          if (args.include_body) {
            const body = symbolBody(db, ctx.root, n);
            const doc = db.fileIndexGet(n.path ?? "")?.document_id ?? undefined;
            parts.push(body === undefined ? "(body unavailable)" : fence(body, perBody, doc));
          }
          blocks.push(parts.join("\n"));
        }
        out = blocks.join("\n");
      }
    } else {
      if (!args.name_path) return errorResult("references needs `name_path`");
      const targets = findSymbols(db, args.name_path, { limit: 5 });
      if (!targets.length) out = `no symbol matches "${args.name_path}"`;
      else {
        const backend = getCodeBackend(ctx);
        const blocks: string[] = [];
        for (const t of targets) {
          const edges = backend
            .references(db, t.id)
            .filter((e) => !args.file || referrerPath(db, e.src)?.includes(args.file));
          const grouped = groupBySource(edges);
          const nodes = new Map(db.graphGetNodes([...grouped.keys()]).map((n) => [n.id, n]));
          const lines = [...grouped.entries()]
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, limit)
            .map(
              ([src, g]) =>
                `- ${referrerLabel(db, src, nodes)} · ${g.parts.join(", ")} · ${g.confidence.toFixed(2)}`,
            );
          blocks.push(
            `${formatSymbol(t)}\n${lines.length ? lines.join("\n") : "  no references in the graph (exports used only via re-exports or dynamic access are not tracked)"}${grouped.size > limit ? `\n… ${grouped.size - limit} more referrer(s)` : ""}`,
          );
        }
        out = blocks.join("\n\n");
      }
    }
    recordStat(ctx, "em_symbols", {
      rawChars: 0,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(
      out.length > budget ? `${out.slice(0, budget)}\n… truncated; raise max_tokens` : out,
    );
  },
});

function referrerPath(db: StorageAdapter, id: string): string | undefined {
  return db.graphGetNode(id)?.path ?? undefined;
}

function groupBySource(edges: GraphEdgeRow[]) {
  const out = new Map<string, { parts: string[]; confidence: number; score: number }>();
  for (const e of edges) {
    const meta = e.meta ? (JSON.parse(e.meta) as { count?: number; lines?: number[] }) : {};
    const g = out.get(e.src) ?? { parts: [], confidence: 0, score: 0 };
    g.parts.push(
      `${e.kind} ×${meta.count ?? 1}${meta.lines?.length ? ` (L${meta.lines.join(", L")})` : ""}`,
    );
    g.confidence = Math.max(g.confidence, e.confidence);
    g.score += e.confidence * (meta.count ?? 1);
    out.set(e.src, g);
  }
  return out;
}
