import { z } from "zod";
import { kickEmbedding } from "../embeddings/queue.js";
import { gitignoreHint, MEMORY_KINDS, MEMORY_STATUSES, reconcile, write } from "../memory/store.js";
import { getCurrentSession } from "../session/current.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, LOCAL_WRITE, text } from "./types.js";

export { MEMORY_KINDS };

export const emRemember = defineTool({
  name: "em_remember",
  annotations: { ...LOCAL_WRITE, idempotentHint: false },
  description:
    "Record something worth keeping across sessions as a named markdown memory under .eminiar/memories/<topic>/<name>.md (human-editable, git-shareable): a decision and why, a constraint, a project fact, a user preference, a todo, a note, or onboarding knowledge. It is indexed for em_search / em_recall and linked in the graph to related_files / related_nodes. Manage existing memories with em_memory.",
  schema: {
    content: z.string().min(3).describe("The memory, written so it makes sense without context"),
    kind: z.enum(MEMORY_KINDS),
    name: z
      .string()
      .optional()
      .describe(
        "topic/slug (lowercase, [a-z0-9._-]), e.g. auth/session-tokens; derived from kind + content when omitted",
      ),
    replace: z.boolean().optional().describe("Overwrite a memory that already has this name"),
    status: z
      .enum(MEMORY_STATUSES)
      .optional()
      .describe("decisions: proposed | accepted (default) | superseded | deprecated"),
    supersedes: z
      .string()
      .optional()
      .describe("Name of the decision this one replaces; it is marked superseded"),
    tags: z.array(z.string()).optional(),
    related_files: z
      .array(z.string())
      .optional()
      .describe("Project-relative paths this memory is about"),
    related_nodes: z
      .array(z.string())
      .optional()
      .describe("Graph node ids (file:…, sym:…, concept:…)"),
  },
  handler: async (args, ctx) => {
    const db = getStorage(ctx);
    reconcile(ctx, db);
    const sessionId = getCurrentSession(ctx);
    const related = [
      ...(args.related_files ?? []).map((f) => `file:${f.replace(/^\.\//, "")}`),
      ...(args.related_nodes ?? []),
    ];
    let r: ReturnType<typeof write>;
    try {
      r = write(ctx, db, {
        name: args.name,
        kind: args.kind,
        content: args.content,
        tags: args.tags,
        related,
        replace: args.replace,
        sessionId,
        status: args.status,
        supersedes: args.supersedes,
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
    db.eventInsert({
      sessionId,
      category:
        args.kind === "constraint" ? "constraint" : args.kind === "decision" ? "decision" : "data",
      priority: args.kind === "constraint" || args.kind === "decision" ? 2 : 4,
      payload: { text: args.content.slice(0, 300), by: "em_remember", memory: r.name },
    });
    kickEmbedding(ctx, db);
    const hint = gitignoreHint(ctx);
    return text(
      `remembered ${r.name} (${args.kind}${args.status ? `, ${args.status}` : ""}) → ${r.path}${r.created ? "" : " (replaced)"}${r.superseded ? `; ${r.superseded} marked superseded` : ""}${hint ? `\n${hint}` : ""}`,
    );
  },
});
