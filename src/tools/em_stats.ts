import { z } from "zod";
import { getCurrentSession } from "../session/current.js";
import { formatRecallStats, RECALL_CATEGORY, recallStats } from "../session/recall.js";
import { globalDb } from "../stats/global.js";
import { fmtTokens, formatStats } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, text } from "./types.js";

export const emStats = defineTool({
  name: "em_stats",
  description:
    "Show how much context eminiar has kept out of the conversation: tokens seen vs returned per tool for this session, this project, and lifetime across all projects, plus index/graph sizes and how often proactive recall (memories, docs, history before prompts, reads and edits) fired versus stayed quiet, with the reasons.",
  schema: {
    scope: z.enum(["session", "project", "lifetime", "all"]).optional().describe("default all"),
  },
  handler: async (args, ctx) => {
    const scope = args.scope ?? "all";
    const db = getStorage(ctx);
    const sessionId = getCurrentSession(ctx);
    const parts: string[] = [];
    if (scope === "session" || scope === "all") {
      parts.push(formatStats(`session ${sessionId.slice(0, 8)}`, db.statsBySession(sessionId)));
      parts.push(
        formatRecallStats(
          "recall (session)",
          recallStats(db.eventsBySession(sessionId, { categories: [RECALL_CATEGORY] })),
        ),
      );
    }
    if (scope === "project" || scope === "all") {
      parts.push(formatStats(`project ${ctx.root}`, mergeByTool(db.statsAll())));
      parts.push(
        formatRecallStats(
          "recall (project, last 2000 decisions)",
          recallStats(db.eventsRecent(2000, [RECALL_CATEGORY])),
        ),
      );
    }
    if (scope === "lifetime" || scope === "all") {
      const g = globalDb();
      parts.push(formatStats("lifetime (all projects)", g.lifetime()));
      const days = g.daily(7);
      if (days.length) {
        parts.push(
          `last 7 days: ${days
            .reverse()
            .map((d) => `${d.day.slice(5)} ${fmtTokens(Math.ceil(d.saved_chars / 4))}`)
            .join(" · ")}`,
        );
      }
    }
    parts.push(
      `index: ${db.countDocuments()} documents (${db.countDocuments("exec")} exec, ${db.countDocuments("batch")} batch, ${db.countDocuments("file")} file, ${db.countDocuments("url")} url, ${db.countDocuments("code")} code), ${db.vecCount()} vectors`,
    );
    return text(parts.join("\n\n"));
  },
});

function mergeByTool(rows: ReturnType<ReturnType<typeof getStorage>["statsAll"]>) {
  const m = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = m.get(r.tool);
    if (!cur) m.set(r.tool, { ...r, session_id: "project" });
    else {
      cur.calls += r.calls;
      cur.raw_chars += r.raw_chars;
      cur.returned_chars += r.returned_chars;
      cur.duration_ms += r.duration_ms;
    }
  }
  return [...m.values()];
}
