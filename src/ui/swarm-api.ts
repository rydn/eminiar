/**
 * Dashboard API for agent swarms (the Swarms tab). Reads the swarm file and the run ledger;
 * the only writes are creating the starter file, syncing agent files and finishing a run.
 * Spec: docs/design/agent-swarms.md ("Dashboard: Swarms tab").
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { planAgentSync, type SyncActionKind, syncAgents } from "../swarm/agents.js";
import { activeSwarmConfig, loadSwarmConfig, STARTER_YAML, swarmFile } from "../swarm/config.js";
import {
  type Caller,
  COORDINATOR,
  callerOf,
  finishRun,
  type RunSnapshot,
  runSnapshot,
  STALE_MS,
  SwarmError,
  toolIo,
  workerStatus,
} from "../swarm/runtime.js";
import type {
  ConfigIssue,
  RunRow,
  RunStatus,
  SwarmEventRow,
  SwarmSpec,
  TaskStatus,
  WorkerStatus,
} from "../swarm/types.js";

/** Run ids are `YYYYMMDD-<6 hex>` (runtime.newRunId). */
export const RUN_ID_RE = /^\d{8}-[0-9a-f]{6}$/;
/** Events closer together than this belong to one busy segment of the timeline. */
export const SEGMENT_GAP_MS = 60_000;
const EVENTS_PAGE = 200;
/** Events read to build the timeline (pages of 1000); a longer run is cut at the start. */
const TIMELINE_EVENTS_MAX = 20_000;
const SNAPSHOT_EVENTS = 200;
const FINISH_STATUSES: RunStatus[] = ["done", "failed", "cancelled"];

export interface Reply {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  body: { error, ...extra },
});

// --- GET /api/swarm -----------------------------------------------------------------------

export type RoleFileAction = SyncActionKind | "disabled";

export interface RunCounts {
  tasks: Record<TaskStatus, number> & { total: number };
  workers: Record<WorkerStatus, number>;
}

function runCounts(db: StorageAdapter, run: RunRow, now: number): RunCounts {
  const tasks: RunCounts["tasks"] = {
    pending: 0,
    active: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    total: 0,
  };
  for (const t of db.swarm.tasks(run.id)) {
    tasks[t.status]++;
    tasks.total++;
  }
  const workers: RunCounts["workers"] = { running: 0, done: 0, stale: 0 };
  for (const w of db.swarm.workers(run.id)) {
    const s: WorkerStatus = workerStatus(w, now);
    workers[s]++;
  }
  return { tasks, workers };
}

function swarmView(
  spec: SwarmSpec,
  files: Map<string, { path: string; action: RoleFileAction; reason?: string | undefined }>,
) {
  return {
    name: spec.name,
    description: spec.description,
    topology: spec.topology,
    maxAgents: spec.maxAgents,
    stages: spec.stages,
    instructions: spec.instructions,
    roles: spec.roles.map((r) => ({
      role: r.role,
      agentType: r.agentType,
      description: r.description,
      // null: the role inherits the session's model / keeps every tool.
      model: r.model ?? null,
      count: r.count,
      tools: r.tools ?? null,
      disallowedTools: r.disallowedTools ?? null,
      skills: r.skills,
      scope: r.scope,
      memoryTags: r.memoryTags,
      isolation: r.isolation ?? null,
      hasHooks: !!r.hooks && Object.values(r.hooks).some((v) => Array.isArray(v) && v.length > 0),
      file: files.get(r.agentType) ?? {
        path: `.claude/agents/${r.agentType}.md`,
        action: "disabled" as const,
      },
    })),
  };
}

export function swarmOverview(ctx: ProjectContext, limit = 30) {
  const loaded = loadSwarmConfig(ctx.root);
  const now = Date.now();
  const db = getStorage(ctx);
  // Runs are listed whatever the file's state: the ledger outlives a deleted or broken file.
  const runs = db.swarm.runs({ limit: Math.max(1, Math.min(limit, 200)) }).map((r) => ({
    id: r.id,
    swarm: r.swarm,
    goal: r.goal,
    status: r.status,
    topology: r.topology,
    created_at: r.created_at,
    updated_at: r.updated_at,
    ended_at: r.ended_at,
    counts: runCounts(db, r, now),
  }));
  if (loaded.state === "absent")
    return {
      state: "absent" as const,
      enabled: false,
      file: loaded.rel,
      issues: [] as ConfigIssue[],
      swarms: [],
      orphans: [],
      syncNeeded: false,
      runs,
      starter: STARTER_YAML,
      now,
    };
  if (loaded.state === "invalid")
    return {
      state: "invalid" as const,
      enabled: false,
      file: loaded.rel,
      issues: loaded.issues,
      swarms: [],
      orphans: [],
      syncNeeded: false,
      runs,
      now,
    };
  const config = loaded.config;
  const plan = planAgentSync(ctx.root, config);
  const roleTypes = new Set(config.swarms.flatMap((s) => s.roles.map((r) => r.agentType)));
  const files = new Map(
    plan
      .filter((a) => roleTypes.has(a.agentType))
      .map((a) => [
        a.agentType,
        { path: a.path, action: a.action as RoleFileAction, reason: a.reason },
      ]),
  );
  return {
    state: "ok" as const,
    enabled: config.enabled,
    sync: config.sync,
    file: config.rel,
    issues: [] as ConfigIssue[],
    swarms: config.swarms.map((s) => swarmView(s, files)),
    // Generated files the YAML no longer produces (or every one, when disabled).
    orphans: plan
      .filter((a) => !roleTypes.has(a.agentType))
      .map((a) => ({ path: a.path, agentType: a.agentType, reason: a.reason ?? null })),
    syncNeeded: plan.some(
      (a) => a.action === "create" || a.action === "update" || a.action === "delete",
    ),
    runs,
    now,
  };
}

// --- GET /api/swarm/run -------------------------------------------------------------------

export interface BusySegment {
  start: number;
  end: number;
  /** Events in the segment. */
  n: number;
  errors: number;
  io: Record<Io, number>;
  /** The worker is still running and was active within the gap: the segment runs to now. */
  open?: boolean;
}

type Io = ReturnType<typeof toolIo>;

const ioOf = (e: SwarmEventRow): Io => {
  const p = e.payload?.io;
  if (p === "read" || p === "write" || p === "exec" || p === "swarm" || p === "other") return p;
  const tool = e.payload?.tool;
  if (typeof tool === "string") return toolIo(tool);
  // claim / update / post / plan come from em_swarm calls.
  return e.kind === "tool" || e.kind === "tool_error" ? "other" : "swarm";
};

/**
 * Busy segments of one worker from its events (oldest first): events closer than `gap`
 * merge into one segment. A running worker's last segment stays open up to `now`.
 */
export function busySegments(
  events: SwarmEventRow[],
  opts: { gap?: number; now?: number; running?: boolean } = {},
): BusySegment[] {
  const gap = opts.gap ?? SEGMENT_GAP_MS;
  const out: BusySegment[] = [];
  let cur: BusySegment | undefined;
  for (const e of [...events].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
    if (!cur || e.ts - cur.end > gap) {
      cur = {
        start: e.ts,
        end: e.ts,
        n: 0,
        errors: 0,
        io: { read: 0, write: 0, exec: 0, swarm: 0, other: 0 },
      };
      out.push(cur);
    }
    cur.end = Math.max(cur.end, e.ts);
    cur.n++;
    if (e.kind === "tool_error") cur.errors++;
    if (e.kind !== "start" && e.kind !== "stop") cur.io[ioOf(e)]++;
  }
  const last = out[out.length - 1];
  if (last && opts.running && opts.now !== undefined && opts.now - last.end <= gap) {
    last.end = opts.now;
    last.open = true;
  }
  return out;
}

/** Every event of a run, oldest first (bounded), for the timeline. */
function allEvents(ctx: ProjectContext, runId: string): { events: SwarmEventRow[]; cut: boolean } {
  const db = getStorage(ctx);
  const out: SwarmEventRow[] = [];
  let after = 0;
  for (;;) {
    const page = db.swarm.events(runId, { after, limit: 1000 });
    out.push(...page);
    if (page.length < 1000) return { events: out, cut: false };
    after = page[page.length - 1]!.id;
    if (out.length >= TIMELINE_EVENTS_MAX) return { events: out, cut: true };
  }
}

export function runDetail(ctx: ProjectContext, run: RunRow) {
  const db = getStorage(ctx);
  const snap: RunSnapshot = runSnapshot(db, run, SNAPSHOT_EVENTS);
  const now = Date.now();
  const { events: all, cut } = allEvents(ctx, run.id);
  const byAgent = new Map<string, SwarmEventRow[]>();
  for (const e of all) {
    if (!e.agent_id) continue;
    const list = byAgent.get(e.agent_id) ?? [];
    list.push(e);
    byAgent.set(e.agent_id, list);
  }
  const loaded = loadSwarmConfig(ctx.root);
  const spec =
    loaded.state === "ok" ? loaded.config.swarms.find((s) => s.name === run.swarm) : undefined;
  // Roles in config order, then any the ledger names that the file no longer has.
  const roles = [
    ...new Set([
      ...(spec?.roles.map((r) => r.role) ?? []),
      ...snap.workers.map((w) => w.role),
      ...snap.tasks.map((t) => t.role).filter((r): r is string => !!r),
    ]),
  ];
  const lastEventId = all.length ? all[all.length - 1]!.id : 0;
  return {
    ...snap,
    roles,
    stages: spec?.stages ?? [],
    maxAgents: spec?.maxAgents ?? null,
    configured: !!spec,
    timeline: {
      start: run.created_at,
      end: run.ended_at ?? (run.status === "active" ? now : run.updated_at),
      cut,
      workers: snap.workers.map((w) => ({
        agent_id: w.agent_id,
        role: w.role,
        status: w.status,
        spawned_at: w.spawned_at,
        ended_at: w.ended_at,
        segments: busySegments(byAgent.get(w.agent_id) ?? [], {
          now,
          running: w.status === "running" && run.status === "active",
        }),
      })),
    },
    lastEventId,
    staleMs: STALE_MS,
    now,
  };
}

// --- routing ------------------------------------------------------------------------------

function runFromId(ctx: ProjectContext, id: unknown): { run?: RunRow; error?: Reply } {
  if (typeof id !== "string" || !id) return { error: fail(400, "id required") };
  if (!RUN_ID_RE.test(id)) return { error: fail(400, `invalid run id "${id.slice(0, 40)}"`) };
  const run = getStorage(ctx).swarm.runGet(id);
  // Not the bare "not found" the client reads as "the server is older than the bundle".
  if (!run) return { error: fail(404, `run ${id} not found`) };
  return { run };
}

function initSwarm(ctx: ProjectContext): Reply {
  const where = swarmFile(ctx.root);
  if (where.exists) return fail(409, `${where.rel} already exists; edit it instead`);
  mkdirSync(dirname(where.file), { recursive: true });
  try {
    // wx: never overwrite a file created between the check and the write.
    writeFileSync(where.file, STARTER_YAML, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      return fail(409, `${where.rel} already exists; edit it instead`);
    throw err;
  }
  const config = activeSwarmConfig(ctx.root);
  return ok({ created: where.rel, sync: syncAgents(ctx.root, config) });
}

function syncSwarm(ctx: ProjectContext): Reply {
  const loaded = loadSwarmConfig(ctx.root);
  if (loaded.state === "absent")
    return fail(409, `no ${loaded.rel}; create it first (eminiar swarm init)`);
  if (loaded.state === "invalid")
    return fail(400, `${loaded.rel} is invalid; fix it before syncing`, { issues: loaded.issues });
  // A disabled config removes the generated files (planAgentSync's rule).
  return ok(syncAgents(ctx.root, loaded.config));
}

function finishSwarmRun(ctx: ProjectContext, body: Record<string, unknown>): Reply {
  const { run, error } = runFromId(ctx, body.id);
  if (error || !run) return error ?? fail(400, "id required");
  const status = body.status;
  if (typeof status !== "string" || !FINISH_STATUSES.includes(status as RunStatus))
    return fail(400, `status must be one of ${FINISH_STATUSES.join(", ")}`);
  if (body.summary !== undefined && body.summary !== null && typeof body.summary !== "string")
    return fail(400, "summary must be a string");
  if (run.status !== "active") return fail(409, `run ${run.id} is already ${run.status}`);
  const loaded = loadSwarmConfig(ctx.root);
  // The dashboard acts as the coordinator. A broken or deleted file must not strand a run.
  const caller: Caller =
    loaded.state === "ok" ? callerOf(loaded.config, {}) : { label: COORDINATOR };
  try {
    const r = finishRun(ctx, getStorage(ctx), run, caller, {
      status: status as RunStatus,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      remember: body.remember === true,
    });
    return ok({ run: r.run, memory: r.memory ?? null });
  } catch (err) {
    if (err instanceof SwarmError) return fail(409, err.message);
    throw err;
  }
}

/**
 * Route `/api/swarm` and `/api/swarm/*`. Writes are POST; the server has already checked
 * the loopback origin and the JSON content type for every non-GET request.
 */
export async function swarmRoute(
  ctx: ProjectContext,
  req: {
    path: string;
    method: string;
    query: URLSearchParams;
    body: () => Promise<unknown>;
  },
): Promise<Reply> {
  const { path, method, query } = req;
  const isGet = method === "GET" || method === "HEAD";
  const readBody = async (): Promise<Record<string, unknown>> => {
    const b = await req.body();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };

  if (path === "/api/swarm") {
    if (!isGet) return fail(405, "GET only");
    return ok(swarmOverview(ctx, Number(query.get("limit")) || 30));
  }
  if (path === "/api/swarm/run") {
    if (!isGet) return fail(405, "GET only");
    const { run, error } = runFromId(ctx, query.get("id"));
    return error ?? ok(runDetail(ctx, run!));
  }
  if (path === "/api/swarm/events") {
    if (!isGet) return fail(405, "GET only");
    const { run, error } = runFromId(ctx, query.get("id"));
    if (error || !run) return error ?? fail(400, "id required");
    const raw = query.get("after") ?? "0";
    if (!/^\d{1,15}$/.test(raw)) return fail(400, "after must be a non-negative integer");
    const events = getStorage(ctx).swarm.events(run.id, {
      after: Number(raw),
      limit: EVENTS_PAGE,
    });
    return ok({
      run: { id: run.id, status: run.status, updated_at: run.updated_at },
      events,
      last: events.length ? events[events.length - 1]!.id : Number(raw),
      more: events.length === EVENTS_PAGE,
      now: Date.now(),
    });
  }
  if (path === "/api/swarm/init") {
    if (method !== "POST") return fail(405, "POST only");
    return initSwarm(ctx);
  }
  if (path === "/api/swarm/sync") {
    if (method !== "POST") return fail(405, "POST only");
    return syncSwarm(ctx);
  }
  if (path === "/api/swarm/finish") {
    if (method !== "POST") return fail(405, "POST only");
    let body: Record<string, unknown>;
    try {
      body = await readBody();
    } catch {
      return fail(400, "invalid JSON body");
    }
    return finishSwarmRun(ctx, body);
  }
  return fail(404, "not found");
}
