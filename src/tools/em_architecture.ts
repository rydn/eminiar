import { z } from "zod";
import { ASPECTS, architecture, formatArchitecture } from "../graph/architecture.js";
import { fileBytes, recordStat } from "../stats/record.js";
import { ensureGraph } from "./em_graph.js";
import { defineTool, READ_ONLY, text } from "./types.js";

export const emArchitecture = defineTool({
  name: "em_architecture",
  annotations: READ_ONLY,
  description:
    "One-screen picture of the project from the knowledge graph: languages and coverage, folders with size and heat, entry points (package.json bin/main/exports, orphan files), HTTP routes with handlers, hotspots (fan-in × churn × complexity), module clusters, import cycles and accepted decisions. Ask for specific aspects to keep it short. Use at the start of a task instead of listing directories and reading files.",
  schema: {
    aspects: z
      .array(z.enum(ASPECTS))
      .optional()
      .describe("default: overview, folders, entry_points, routes, hotspots, decisions"),
    max_tokens: z.number().int().min(100).max(20000).optional().describe("default 2500"),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    const aspects = args.aspects?.length
      ? args.aspects
      : (["overview", "folders", "entry_points", "routes", "hotspots", "decisions"] as const);
    const a = architecture(ctx, db, aspects);
    let out = formatArchitecture(a, aspects);
    const budget = (args.max_tokens ?? 2500) * 4;
    if (out.length > budget)
      out = `${out.slice(0, budget)}\n… truncated; ask for fewer aspects or raise max_tokens`;
    recordStat(ctx, "em_architecture", {
      // The counterfactual is reading the hot files and entry points by hand.
      rawChars: fileBytes(db, [
        ...a.hotspots.map((h) => (h.kind === "file" ? h.path : h.path.split(" > ")[0])),
        ...a.entryPoints.map((e) => e.path),
        ...a.routes.map((r) => r.file),
      ]),
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});
