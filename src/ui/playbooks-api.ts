/**
 * Dashboard API for Playbooks (the Playbooks tab). Playbooks are stored recurring tasks: this
 * lists, adds, edits and deletes them, records that one was copied for use, and shows the
 * suggested inbox when extraction is on. Nothing here runs or schedules a playbook.
 * The server has already checked the loopback origin and the JSON content type of every write.
 */
import type { ProjectContext } from "../context.js";
import { scan } from "../playbooks/extract.js";
import * as store from "../playbooks/store.js";
import { getStorage } from "../storage/index.js";
import type { PlaybookParam, PlaybookRow, PlaybookSuggestionRow } from "../storage/types.js";

export interface Reply {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

export interface PlaybookUi {
  name: string;
  title: string;
  prompt: string;
  params: PlaybookParam[];
  schedule: string | null;
  tags: string[];
  source: string;
  private: boolean;
  path: string | null;
  created: number;
  updated: number;
  runs: number;
  lastRun: number | null;
}

export interface PlaybookSuggestionUi {
  id: number;
  ts: number;
  name: string;
  title: string;
  prompt: string;
  params: PlaybookParam[];
  schedule: string | null;
  tags: string[];
  evidence: string | null;
}

function toUi(row: PlaybookRow, stats: Map<string, { runs: number; last: number }>): PlaybookUi {
  const s = stats.get(row.name);
  return {
    name: row.name,
    title: row.title,
    prompt: row.prompt,
    params: store.rowParams(row),
    schedule: row.schedule,
    tags: store.rowTags(row),
    source: row.source,
    private: row.private === 1,
    path: row.path,
    created: row.created_at,
    updated: row.updated_at ?? row.created_at,
    runs: s?.runs ?? 0,
    lastRun: s?.last ?? null,
  };
}

function suggestionUi(r: PlaybookSuggestionRow): PlaybookSuggestionUi {
  return {
    id: r.id,
    ts: r.ts,
    name: r.name,
    title: r.title,
    prompt: r.prompt,
    params: store.rowParams(r),
    schedule: r.schedule,
    tags: store.rowTags(r),
    evidence: r.evidence,
  };
}

export function playbooksOverview(ctx: ProjectContext): Record<string, unknown> {
  const c = ctx.config.playbooks;
  const base = {
    viewing: c.viewing,
    adding: c.adding,
    extraction: c.extraction.enabled,
    dir: store.playbooksRel(ctx),
    privateDir: store.privatePlaybooksRel(ctx),
  };
  if (!c.viewing) return { ...base, playbooks: [], runs: [], suggestions: [], skipped: [] };
  const db = getStorage(ctx);
  const rec = store.reconcile(ctx, db);
  const runs = store.runs(ctx, db, { limit: 200 });
  const stats = new Map<string, { runs: number; last: number }>();
  for (const [name, s] of db.playbooks.runStats())
    stats.set(name, { runs: s.runs, last: s.lastTs });
  return {
    ...base,
    skipped: rec.skipped,
    playbooks: store.list(ctx, db, { includePrivate: true }).map((r) => toUi(r, stats)),
    runs,
    suggestions: c.extraction.enabled
      ? store.suggestions(ctx, db, { status: "pending", limit: 100 }).map(suggestionUi)
      : [],
  };
}

const strOrUndef = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function paramsOf(v: unknown): PlaybookParam[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => {
      const name = String(p.name ?? "");
      const d = strOrUndef(p.default);
      return d === undefined || d === "" ? { name } : { name, default: d };
    });
}

function tagsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string");
  if (typeof v === "string")
    return v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

export async function playbooksRoute(
  ctx: ProjectContext,
  req: {
    path: string;
    method: string;
    query: URLSearchParams;
    body: () => Promise<unknown>;
  },
): Promise<Reply> {
  const { path, method } = req;
  const isGet = method === "GET" || method === "HEAD";
  const readBody = async (): Promise<Record<string, unknown>> => {
    const b = await req.body();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };
  try {
    if (path === "/api/playbooks") {
      if (!isGet) return fail(405, "GET only");
      return ok(playbooksOverview(ctx));
    }
    if (isGet) return fail(404, "not found");
    if (method !== "POST") return fail(405, "POST only");
    const c = ctx.config.playbooks;
    if (!c.viewing) return fail(403, "playbooks are hidden: playbooks.viewing is false");
    const db = getStorage(ctx);
    const b = await readBody();

    if (path === "/api/playbooks/save") {
      if (!c.adding) return fail(403, "playbooks are read-only: playbooks.adding is false");
      const saveName = strOrUndef(b.name)?.trim();
      // Without an explicit flag an existing playbook keeps its privacy, as the CLI and tool do.
      const priv =
        typeof b.private === "boolean"
          ? b.private
          : saveName
            ? db.playbooks.get(saveName)?.private === 1
            : false;
      const r = store.write(ctx, db, {
        name: strOrUndef(b.name),
        title: strOrUndef(b.title) ?? "",
        prompt: strOrUndef(b.prompt) ?? "",
        params: paramsOf(b.params),
        schedule: strOrUndef(b.schedule),
        tags: tagsOf(b.tags),
        private: priv,
        replace: b.replace === true,
      });
      return ok({ name: r.name, path: r.path, created: r.created });
    }
    if (path === "/api/playbooks/delete") {
      if (!c.adding) return fail(403, "playbooks are read-only: playbooks.adding is false");
      const name = strOrUndef(b.name) ?? "";
      return ok({ removed: store.remove(ctx, db, name) });
    }
    if (path === "/api/playbooks/run") {
      // "Run" copies the prompt for use: it records the use (trigger ui), nothing is executed.
      const name = strOrUndef(b.name) ?? "";
      const status = strOrUndef(b.status);
      const rec = store.recordRun(ctx, db, {
        playbook: name,
        trigger: "ui",
        status:
          status === "done" || status === "failed" || status === "skipped" ? status : "started",
        note: strOrUndef(b.note),
      });
      return ok({ id: rec.id });
    }
    if (path === "/api/playbooks/suggestion/accept") {
      if (!c.adding) return fail(403, "playbooks are read-only: playbooks.adding is false");
      const id = b.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
        return fail(400, "id must be a suggestion id");
      return ok(store.acceptSuggestion(ctx, db, id, { private: b.private === true }));
    }
    if (path === "/api/playbooks/suggestion/dismiss") {
      if (!c.adding) return fail(403, "playbooks are read-only: playbooks.adding is false");
      const id = b.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
        return fail(400, "id must be a suggestion id");
      return ok({ dismissed: store.dismissSuggestion(ctx, db, id) });
    }
    if (path === "/api/playbooks/scan") {
      if (!c.extraction.enabled)
        return fail(403, "playbook extraction is off: playbooks.extraction.enabled is false");
      const dryRun = b.dryRun === true;
      if (!dryRun && !c.adding)
        return fail(403, "playbooks are read-only: playbooks.adding is false");
      const r = await scan(ctx, db, { dryRun });
      return ok({
        dryRun,
        mode: r.mode,
        prompts: r.prompts,
        clusters: r.clusters,
        suggested: r.suggested,
        known: r.known,
        candidates: r.candidates.map((x) => ({
          title: x.title,
          sessions: x.sessions,
          days: x.days,
          servers: x.servers,
        })),
      });
    }
    return fail(404, "not found");
  } catch (err) {
    return fail(400, (err as Error).message);
  }
}
