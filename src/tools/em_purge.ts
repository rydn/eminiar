import { z } from "zod";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, text } from "./types.js";

export const emPurge = defineTool({
  name: "em_purge",
  description:
    "Permanently delete eminiar data for this project. scope: index (documents/chunks/vectors/caches), sessions (events, snapshots, stats), graph, memories (the database mirror only; the markdown files under .eminiar/memories stay and are re-imported on the next memory call — delete files with em_memory), usage (API calls, tool uses, context events, transcript offsets, statusline snapshots), or all. Requires confirm: true.",
  schema: {
    scope: z.enum(["index", "sessions", "graph", "memories", "usage", "all"]),
    confirm: z.boolean().describe("Must be true; this cannot be undone"),
  },
  handler: async (args, ctx) => {
    if (!args.confirm) return errorResult("refusing to purge without confirm: true");
    const db = getStorage(ctx);
    const before = db.countDocuments();
    db.purge(args.scope);
    const note =
      args.scope === "memories" || args.scope === "all"
        ? `; memory files under ${ctx.config.memories.dir} were left in place and will be re-imported (em_memory {action:"delete"} removes files)`
        : "";
    return text(`purged ${args.scope} for ${ctx.root} (${before} documents before)${note}`);
  },
});
