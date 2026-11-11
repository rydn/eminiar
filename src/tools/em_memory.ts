import { z } from "zod";
import { kickEmbedding } from "../embeddings/queue.js";
import {
  edit,
  list,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  memoriesDir,
  read,
  reconcile,
  remove,
  rename,
  setMeta,
} from "../memory/store.js";
import { getStorage } from "../storage/index.js";
import type { MemoryRow } from "../storage/types.js";
import { defineTool, errorResult, text } from "./types.js";

function firstLine(s: string, max = 140): string {
  const line = s.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? s;
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function memoryLine(m: MemoryRow): string {
  const tags = m.tags ? (JSON.parse(m.tags) as string[]) : [];
  const when = new Date(m.updated_at ?? m.created_at).toISOString().slice(0, 10);
  const status = m.status && m.status !== "accepted" ? ` (${m.status})` : "";
  return `${m.name} [${m.kind}${status}] ${when}${tags.length ? ` #${tags.join(",")}` : ""} — ${firstLine(m.content)} (${(m.content.length / 1024).toFixed(1)} KB)`;
}

export const emMemory = defineTool({
  name: "em_memory",
  description:
    "Manage the named markdown memories under .eminiar/memories (written by em_remember or by hand): list them (optionally one topic), read one, edit part of one, rename one (mem:<old> references follow), or delete one. Compact output; a read is trimmed to max_tokens.",
  schema: {
    action: z.enum(["list", "read", "edit", "rename", "delete", "status"]),
    name: z.string().optional().describe("topic/slug (read, edit, rename, delete, status)"),
    topic: z.string().optional().describe("list: only memories under this topic"),
    kind: z.enum(MEMORY_KINDS).optional().describe("list: only this kind"),
    status: z
      .enum(MEMORY_STATUSES)
      .optional()
      .describe(
        "list: only this status; status: the new status (proposed|accepted|superseded|deprecated)",
      ),
    find: z.string().optional().describe("edit: text (or regex) to replace in the body"),
    replace: z.string().optional().describe("edit: replacement"),
    regex: z.boolean().optional().describe("edit: treat find as a regular expression"),
    new_name: z.string().optional().describe("rename: the new topic/slug"),
    confirm: z.boolean().optional().describe("delete: must be true"),
    limit: z.number().int().min(1).max(200).optional(),
    max_tokens: z
      .number()
      .int()
      .min(100)
      .max(20000)
      .optional()
      .describe("read budget (default 2000)"),
  },
  handler: async (args, ctx) => {
    const db = getStorage(ctx);
    const summary = reconcile(ctx, db);
    try {
      switch (args.action) {
        case "status": {
          if (!args.name || !args.status) return errorResult("status needs `name` and `status`");
          if (!setMeta(ctx, db, args.name, { status: args.status }))
            return errorResult(`no memory named "${args.name}"`);
          return text(`${args.name} is now ${args.status}`);
        }
        case "list": {
          const rows = list(ctx, db, {
            topic: args.topic,
            kind: args.kind,
            status: args.status,
            limit: args.limit,
          });
          if (!rows.length)
            return text(
              `no memories${args.topic ? ` under ${args.topic}/` : ""}${args.kind ? ` of kind ${args.kind}` : ""} in ${memoriesDir(ctx)}; em_remember writes them${summary.skipped.length ? ` (${summary.skipped.length} file(s) skipped for invalid names or symlinks out of the project, e.g. ${summary.skipped[0]})` : ""}`,
            );
          return text(rows.map(memoryLine).join("\n"));
        }
        case "read": {
          if (!args.name) return errorResult("read needs `name`");
          const m = read(ctx, db, args.name);
          if (!m) return errorResult(`no memory named "${args.name}" (em_memory {action:"list"})`);
          const budget = (args.max_tokens ?? 2000) * 4;
          const head = `${m.name} [${m.kind}${m.status ? `, ${m.status}` : ""}]${m.supersedes ? ` supersedes ${m.supersedes}` : ""} created ${m.created.slice(0, 10)} updated ${m.updated.slice(0, 10)}${m.tags.length ? ` #${m.tags.join(",")}` : ""}${m.related.length ? ` related: ${m.related.join(", ")}` : ""} · ${m.path}`;
          const body =
            m.body.length > budget
              ? `${m.body.slice(0, budget)}\n… ${m.body.length - budget} more chars (em_search {document_ids:[${m.row.document_id}]} or raise max_tokens)`
              : m.body;
          return text(`${head}\n\n${body}`);
        }
        case "edit": {
          if (!args.name || args.find === undefined || args.replace === undefined)
            return errorResult("edit needs `name`, `find` and `replace`");
          const n = edit(ctx, db, args.name, {
            find: args.find,
            replace: args.replace,
            regex: args.regex,
          });
          if (n) kickEmbedding(ctx, db);
          return text(
            n ? `replaced ${n} occurrence(s) in ${args.name}` : `nothing matched in ${args.name}`,
          );
        }
        case "rename": {
          if (!args.name || !args.new_name)
            return errorResult("rename needs `name` and `new_name`");
          const r = rename(ctx, db, args.name, args.new_name);
          kickEmbedding(ctx, db);
          return text(
            `renamed ${args.name} → ${args.new_name}${r.refsUpdated ? `; updated mem: references in ${r.refsUpdated} memory file(s)` : ""}`,
          );
        }
        case "delete": {
          if (!args.name) return errorResult("delete needs `name`");
          if (!args.confirm)
            return errorResult(
              `refusing to delete "${args.name}" without confirm: true (only delete when the user asked for it)`,
            );
          return text(
            remove(ctx, db, args.name)
              ? `deleted ${args.name} (file and index)`
              : `no memory named "${args.name}"`,
          );
        }
      }
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
});
