import { z } from "zod";
import { exportMarkdown, exportSkill, schedulePrompt } from "../playbooks/export.js";
import { scan } from "../playbooks/extract.js";
import {
  acceptSuggestion,
  closeRun,
  dismissSuggestion,
  fillPrompt,
  list,
  type PlaybookFile,
  read,
  reconcile,
  recordRun,
  remove,
  rowParams,
  rowTags,
  suggestions,
  write,
} from "../playbooks/store.js";
import { getCurrentSession } from "../session/current.js";
import { getStorage } from "../storage/index.js";
import { PLAYBOOK_RUN_STATUSES, type PlaybookRow } from "../storage/types.js";
import { defineTool, errorResult, LOCAL_WRITE, text } from "./types.js";

function line(r: PlaybookRow): string {
  const tags = rowTags(r);
  const params = rowParams(r).map((p) => p.name);
  const when = new Date(r.updated_at ?? r.created_at).toISOString().slice(0, 10);
  return `${r.name} — ${r.title}${r.private ? " (private)" : ""}${r.schedule ? ` [${r.schedule}]` : ""}${params.length ? ` {${params.join(",")}}` : ""}${tags.length ? ` #${tags.join(",")}` : ""} ${when}`;
}

function paramItems(f: PlaybookFile): string[] {
  return f.params.map((p) => (p.default === undefined ? p.name : `${p.name}=${p.default}`));
}

function describe(f: PlaybookFile): string {
  const head = [
    `${f.name} — ${f.title}${f.private ? " (private)" : ""} · ${f.path}`,
    f.schedule ? `schedule: ${f.schedule}` : "",
    f.params.length ? `params: ${paramItems(f).join(", ")}` : "",
    f.tags.length ? `tags: ${f.tags.join(", ")}` : "",
  ].filter(Boolean);
  return `${head.join("\n")}\n\n${f.prompt}`;
}

export const emPlaybook = defineTool({
  name: "em_playbook",
  // delete removes a playbook, edit and export skill overwrite files, and run/report/scan add a
  // row on every call; nothing reaches the network.
  annotations: { ...LOCAL_WRITE, destructiveHint: true, idempotentHint: false },
  description:
    "Playbooks: stored recurring tasks (prompt, {{params}}, schedule hint). list, read, add, edit, delete, export (format markdown|skill|schedule: skill writes a Claude Code SKILL.md, schedule returns text to paste into a Desktop or cloud scheduled task); run returns the filled prompt for you to carry out and records the run; report closes it; schedule returns an instruction to start a /loop or cron job. eminiar never runs or schedules anything. Opt-in (playbooks.extraction.enabled): scan mines session history for recurring tasks into suggestions; suggestions lists them; accept (id) makes one a playbook; dismiss (id) rejects it for good.",
  schema: {
    action: z.enum([
      "list",
      "read",
      "add",
      "edit",
      "delete",
      "run",
      "report",
      "schedule",
      "export",
      "scan",
      "suggestions",
      "accept",
      "dismiss",
    ]),
    name: z
      .string()
      .optional()
      .describe("playbook name (all but list/add; add derives it from title)"),
    title: z.string().optional(),
    prompt: z.string().optional().describe("the task; {{param}} marks a parameter"),
    params: z.array(z.object({ name: z.string(), default: z.string().optional() })).optional(),
    schedule: z.string().optional().describe('hint such as "every weekday 9am"'),
    tags: z.array(z.string()).optional(),
    private: z.boolean().optional().describe("add: keep it in the git-ignored folder"),
    values: z.record(z.string(), z.string()).optional().describe("run/schedule: parameter values"),
    status: z.enum(PLAYBOOK_RUN_STATUSES).optional().describe("report: done|failed|skipped"),
    note: z.string().optional().describe("report: what happened"),
    run_id: z
      .number()
      .int()
      .optional()
      .describe("report: the id run returned (omitted: the newest started run)"),
    tag: z.string().optional().describe("list: only this tag"),
    id: z.number().int().optional().describe("accept/dismiss: the suggestion id"),
    dry_run: z.boolean().optional().describe("scan: report candidates without storing them"),
    confirm: z.boolean().optional().describe("delete: must be true"),
    format: z
      .enum(["markdown", "skill", "schedule"])
      .optional()
      .describe(
        "export: markdown (default; returns the file), skill (writes <target>/<name>/SKILL.md), schedule (returns text for a Desktop or cloud scheduled task)",
      ),
    target: z
      .string()
      .optional()
      .describe(
        "export skill: directory for the skill folder (default .claude/skills in the project)",
      ),
    side_effecting: z
      .boolean()
      .optional()
      .describe(
        "export skill: the task changes things outside the repo; true (default) keeps the model from starting it on its own",
      ),
  },
  handler: async (args, ctx) => {
    const db = getStorage(ctx);
    const need = (v: string | undefined, what: string): string => {
      if (!v) throw new Error(`${args.action} needs \`${what}\``);
      return v;
    };
    try {
      reconcile(ctx, db);
      switch (args.action) {
        case "list": {
          const rows = list(ctx, db, { tag: args.tag });
          return text(
            rows.length
              ? rows.map(line).join("\n")
              : 'no playbooks; em_playbook {action:"add", title, prompt} stores one',
          );
        }
        case "read": {
          const f = read(ctx, db, need(args.name, "name"));
          if (!f) return errorResult(`no playbook named "${args.name}"`);
          return text(describe(f));
        }
        case "export": {
          const name = need(args.name, "name");
          const format = args.format ?? "markdown";
          if (format === "skill") {
            const r = exportSkill(ctx, db, name, {
              targetDir: args.target,
              sideEffecting: args.side_effecting,
              values: args.values,
            });
            return text(
              `${r.created ? "wrote" : "updated"} skill ${r.name} at ${r.path}${r.sideEffecting ? " (disable-model-invocation: only you can start it)" : ""}`,
            );
          }
          if (format === "schedule") return text(schedulePrompt(ctx, db, name, args.values));
          const f = read(ctx, db, name);
          if (!f) return errorResult(`no playbook named "${name}"`);
          return text(exportMarkdown(f));
        }
        case "add": {
          const r = write(ctx, db, {
            name: args.name,
            title: need(args.title, "title"),
            prompt: need(args.prompt, "prompt"),
            params: args.params,
            schedule: args.schedule,
            tags: args.tags,
            private: args.private,
          });
          return text(`stored playbook ${r.name} in ${r.path}`);
        }
        case "edit": {
          const f = read(ctx, db, need(args.name, "name"));
          if (!f) return errorResult(`no playbook named "${args.name}"`);
          const r = write(ctx, db, {
            name: f.name,
            title: args.title ?? f.title,
            prompt: args.prompt ?? f.prompt,
            params: args.params ?? f.params,
            schedule: args.schedule ?? f.schedule,
            tags: args.tags ?? f.tags,
            private: args.private ?? f.private,
            replace: true,
          });
          return text(`updated playbook ${r.name} in ${r.path}`);
        }
        case "delete": {
          const name = need(args.name, "name");
          if (args.confirm !== true) return errorResult("delete needs confirm: true");
          return remove(ctx, db, name)
            ? text(`deleted playbook ${name}`)
            : errorResult(`no playbook named "${name}"`);
        }
        case "run": {
          const f = read(ctx, db, need(args.name, "name"));
          if (!f) return errorResult(`no playbook named "${args.name}"`);
          const { id } = recordRun(ctx, db, {
            playbook: f.name,
            trigger: "mcp",
            status: "started",
            sessionId: getCurrentSession(ctx),
          });
          return text(
            `${fillPrompt(f, args.values)}\n\n— playbook ${f.name}, run ${id}. Carry out the task above, then em_playbook {action:"report", name:"${f.name}", run_id:${id}, status:"done"|"failed"|"skipped", note}.`,
          );
        }
        case "report": {
          const name = need(args.name, "name");
          if (!args.status || args.status === "started")
            return errorResult("report needs `status`: done, failed or skipped");
          const { id } = closeRun(ctx, db, {
            playbook: name,
            runId: args.run_id,
            status: args.status,
            note: args.note,
          });
          return text(`closed run ${id} of ${name} as ${args.status}`);
        }
        case "scan": {
          const r = await scan(ctx, db, { dryRun: args.dry_run });
          const head = `scanned ${r.prompts} prompts in ${r.clusters} clusters (${r.mode}): ${r.candidates.length} recurring, ${args.dry_run ? "none stored (dry run)" : `${r.suggested} new suggestions`}, ${r.known} already known`;
          return text(
            [
              head,
              ...r.candidates.map(
                (c) =>
                  `- ${c.title}: ${c.sessions} sessions, ${c.days} days; ${c.prompt.slice(0, 120)}`,
              ),
            ].join("\n"),
          );
        }
        case "suggestions": {
          const rows = suggestions(ctx, db, { status: "pending" });
          return text(
            rows.length
              ? rows.map((r) => `#${r.id} ${r.name} — ${r.title}`).join("\n")
              : 'no pending suggestions; em_playbook {action:"scan"} looks for recurring tasks',
          );
        }
        case "accept": {
          if (args.id === undefined) throw new Error("accept needs `id`");
          const r = acceptSuggestion(ctx, db, args.id, {
            ...(args.name ? { name: args.name } : {}),
            ...(args.title ? { title: args.title } : {}),
            ...(args.prompt ? { prompt: args.prompt } : {}),
            ...(args.private !== undefined ? { private: args.private } : {}),
          });
          return text(`accepted: stored playbook ${r.name} in ${r.path}`);
        }
        case "dismiss": {
          if (args.id === undefined) throw new Error("dismiss needs `id`");
          return dismissSuggestion(ctx, db, args.id)
            ? text(`dismissed suggestion ${args.id}; it will not be proposed again`)
            : errorResult(`no pending suggestion ${args.id}`);
        }
        case "schedule": {
          const f = read(ctx, db, need(args.name, "name"));
          if (!f) return errorResult(`no playbook named "${args.name}"`);
          if (!f.schedule)
            return errorResult(`playbook ${f.name} has no schedule hint; set one with edit`);
          const call = `em_playbook {action:"run", name:"${f.name}"${args.values ? `, values:${JSON.stringify(args.values)}` : ""}}`;
          return text(
            `eminiar does not schedule anything. To repeat "${f.title}" (schedule hint: "${f.schedule}"), start it yourself: /loop for an interval, or the schedule skill or cron for a clock time. Give the job this instruction: call ${call}, carry out the prompt it returns, then em_playbook {action:"report", name:"${f.name}", status:"done"|"failed"|"skipped", note}.`,
          );
        }
      }
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
});
