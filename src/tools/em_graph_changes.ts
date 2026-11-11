import { z } from "zod";
import { detectChanges } from "../graph/changes.js";
import { formatHits } from "../graph/format.js";
import { fileBytes, recordStat } from "../stats/record.js";
import { ensureGraph } from "./em_graph.js";
import { defineTool, errorResult, READ_ONLY, text } from "./types.js";

export const emGraphChanges = defineTool({
  name: "em_graph_changes",
  annotations: READ_ONLY,
  description:
    "Map the current git diff (working tree + untracked files, or against a ref/range) to the symbols it touches, rate each by exposure (route handlers, fan-in, exports) and list the files the change can reach through imports, calls and co-change history. Run before committing or when asked what a change affects, instead of reading dependents by hand.",
  schema: {
    ref: z
      .string()
      .optional()
      .describe("Diff base, e.g. HEAD~1, main, or a range main...HEAD; default: working tree"),
    limit: z.number().int().min(1).max(200).optional().describe("affected files to list (30)"),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    let r: ReturnType<typeof detectChanges>;
    try {
      r = detectChanges(db, ctx.root, { ref: args.ref, limit: args.limit });
    } catch (err) {
      return errorResult(`git diff failed: ${(err as Error).message}`);
    }
    const lines: string[] = [];
    if (!r.files.length) lines.push(`no changes against ${r.base}`);
    else {
      lines.push(
        `${r.files.length} changed file(s) against ${r.base}: ${r.symbols.length} symbol(s), ${r.affected.length} affected file(s)${r.unindexed.length ? `, ${r.unindexed.length} not in the graph` : ""}`,
      );
      if (r.symbols.length) {
        lines.push("changed symbols:");
        for (const s of r.symbols.slice(0, args.limit ?? 30)) {
          const ranges = s.lines.map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`)).join(", ");
          lines.push(
            `- [${s.risk}] ${s.kind} ${s.name} (${s.path}: ${ranges})${s.reasons.length ? ` · ${s.reasons.join(", ")}` : ""}`,
          );
        }
      }
      if (r.affected.length) lines.push(formatHits("affected:", r.affected, args.limit ?? 30));
      if (r.unindexed.length)
        lines.push(
          `not in the graph: ${r.unindexed.slice(0, 10).join(", ")}${r.unindexed.length > 10 ? ` … +${r.unindexed.length - 10}` : ""}`,
        );
    }
    const out = lines.join("\n");
    recordStat(ctx, "em_graph_changes", {
      rawChars: fileBytes(db, [
        ...r.files.map((f) => f.path),
        ...r.affected.map((h) => h.node?.path),
      ]),
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});
