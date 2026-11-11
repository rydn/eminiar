import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { PlaybookParam } from "../storage/types.js";
import {
  fillPrompt,
  list,
  read,
  reconcile,
  recordRun,
  remove,
  rowParams,
  rowTags,
  runs,
  write,
} from "./store.js";

/**
 * `eminiar playbook <list|show|add|edit|rm|run|runs>`. Playbooks are stored recurring tasks;
 * nothing here executes or schedules one. `run` prints the filled prompt and records a run.
 * Kept out of src/cli.ts so it can be tested without process.exit. Returns the exit code.
 */

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

export const PLAYBOOK_USAGE =
  "usage: eminiar playbook <list [--tag t] [--limit N] | show <name> | add <name> --title T (--prompt P | --file F | stdin) [--param n[=default]] [--schedule S] [--tag t] [--private] [--replace] | edit <name> [--title T] [--prompt P | --file F] [--param n[=default]] [--schedule S] [--tag t] | rm <name> | run <name> [--set k=v] [--note N] | runs [name] [--limit N]> [--json]";

async function storage(ctx: ProjectContext): Promise<StorageAdapter> {
  const { getStorage } = await import("../storage/index.js");
  return getStorage(ctx, { vectors: false });
}

function parseParams(specs: string[]): PlaybookParam[] {
  return specs.map((s) => {
    const i = s.indexOf("=");
    return i < 0 ? { name: s.trim() } : { name: s.slice(0, i).trim(), default: s.slice(i + 1) };
  });
}

function parseSets(specs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of specs) {
    const i = s.indexOf("=");
    if (i <= 0) throw new Error(`--set expects name=value, got "${s}"`);
    out[s.slice(0, i).trim()] = s.slice(i + 1);
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const when = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-";

export async function playbookCommand(
  args: string[],
  ctx: ProjectContext,
  io: CliIO = defaultIO,
  stdin: () => Promise<string> = readStdin,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      title: { type: "string" },
      prompt: { type: "string" },
      file: { type: "string" },
      param: { type: "string", multiple: true },
      set: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      schedule: { type: "string" },
      note: { type: "string" },
      limit: { type: "string" },
      private: { type: "boolean" },
      replace: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const [sub = "list", name] = positionals;
  const json = !!values.json;
  for (const o of ["title", "prompt", "file", "schedule", "note", "limit"] as const)
    if (values[o] === true) {
      io.err(`--${o} needs a value`);
      return 2;
    }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const emit = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  let limit: number | undefined;
  if (str(values.limit) !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      io.err("--limit needs a positive whole number");
      return 2;
    }
  }
  const needName = (): string | undefined => {
    if (!name) io.err(`playbook ${sub} needs a name\n${PLAYBOOK_USAGE}`);
    return name;
  };

  try {
    const db = await storage(ctx);
    switch (sub) {
      case "list": {
        reconcile(ctx, db);
        const rows = list(ctx, db, { tag: strs(values.tag)[0], limit });
        if (json) {
          emit(
            rows.map((r) => ({
              name: r.name,
              title: r.title,
              schedule: r.schedule,
              tags: rowTags(r),
              params: rowParams(r),
              source: r.source,
              private: !!r.private,
              path: r.path,
            })),
          );
          return 0;
        }
        if (!rows.length) {
          io.out(
            "no playbooks yet; add one with: eminiar playbook add <name> --title T --prompt P",
          );
          return 0;
        }
        for (const r of rows) {
          const bits = [r.schedule, rowTags(r).join(","), r.private ? "private" : ""].filter(
            Boolean,
          );
          io.out(`${r.name}  ${r.title}${bits.length ? `  [${bits.join(" | ")}]` : ""}`);
        }
        return 0;
      }

      case "show": {
        if (!needName()) return 2;
        reconcile(ctx, db);
        const f = read(ctx, db, name as string);
        if (!f) {
          io.err(`no playbook named "${name}"`);
          return 1;
        }
        if (json) {
          const { row: _row, ...rest } = f;
          emit(rest);
          return 0;
        }
        io.out(
          [
            `${f.name}: ${f.title}`,
            `path: ${f.path}${f.private ? " (private)" : ""}  source: ${f.source}`,
            f.schedule ? `schedule: ${f.schedule} (a note; eminiar does not run it)` : "",
            f.tags.length ? `tags: ${f.tags.join(", ")}` : "",
            f.params.length
              ? `params: ${f.params.map((p) => (p.default !== undefined ? `${p.name}=${p.default}` : p.name)).join(", ")}`
              : "",
            "",
            f.prompt,
          ]
            .filter((l, i) => l !== "" || i > 0)
            .join("\n"),
        );
        return 0;
      }

      case "add":
      case "edit": {
        if (!needName()) return 2;
        const n = name as string;
        reconcile(ctx, db);
        const prev = sub === "edit" ? read(ctx, db, n) : undefined;
        if (sub === "edit" && !prev) {
          io.err(`no playbook named "${n}"`);
          return 1;
        }
        let prompt = str(values.prompt);
        if (prompt === undefined && str(values.file) !== undefined)
          prompt = readFileSync(values.file as string, "utf8");
        if (prompt === undefined && !prev) prompt = (await stdin()).trim() || undefined;
        const title = str(values.title) ?? prev?.title;
        if (!title || (prompt ?? prev?.prompt) === undefined) {
          io.err(`playbook add needs --title and a prompt (--prompt, --file or stdin)`);
          return 2;
        }
        const params = strs(values.param);
        const tags = strs(values.tag);
        const r = write(ctx, db, {
          name: n,
          title,
          prompt: (prompt ?? prev?.prompt) as string,
          params: params.length ? parseParams(params) : prev?.params,
          schedule: str(values.schedule) ?? prev?.schedule,
          tags: tags.length ? tags : prev?.tags,
          private: values.private === true ? true : prev?.private,
          replace: sub === "edit" || values.replace === true,
        });
        if (json) emit({ name: r.name, path: r.path, created: r.created });
        else io.out(`${r.created ? "added" : "updated"} ${r.name} (${r.path})`);
        return 0;
      }

      case "rm": {
        if (!needName()) return 2;
        const gone = remove(ctx, db, name as string);
        if (json) emit({ name, removed: gone });
        else if (gone) io.out(`removed ${name}`);
        else io.err(`no playbook named "${name}"`);
        return gone ? 0 : 1;
      }

      case "run": {
        if (!needName()) return 2;
        reconcile(ctx, db);
        const f = read(ctx, db, name as string);
        if (!f) {
          io.err(`no playbook named "${name}"`);
          return 1;
        }
        const filled = fillPrompt(f, parseSets(strs(values.set)));
        const missing = [...filled.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
          (m) => m[1] as string,
        );
        const rec = recordRun(ctx, db, {
          playbook: f.name,
          trigger: "cli",
          status: "started",
          note: str(values.note),
        });
        if (json) emit({ name: f.name, run: rec.id, prompt: filled, unfilled: missing });
        else {
          io.out(filled);
          if (missing.length)
            io.err(
              `unfilled parameters: ${[...new Set(missing)].join(", ")} (pass --set name=value)`,
            );
        }
        return 0;
      }

      case "runs": {
        const rows = runs(ctx, db, { playbook: name, limit });
        if (json) {
          emit(rows);
          return 0;
        }
        if (!rows.length) io.out("no runs recorded");
        for (const r of rows)
          io.out(
            `${when(r.ts)}  ${r.playbook}  ${r.status}  via ${r.trigger}${r.note ? `  ${r.note}` : ""}`,
          );
        return 0;
      }

      case "help":
        io.out(PLAYBOOK_USAGE);
        return 0;

      default:
        io.err(PLAYBOOK_USAGE);
        return 2;
    }
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
