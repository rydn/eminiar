/**
 * Dashboard API for agent swarms (the Swarms tab). Reads the swarm file and the run ledger;
 * the only writes are creating the starter file, syncing agent files, finishing a run and
 * releasing a stuck worker.
 * A run snapshot cuts long task text (GET /api/swarm/task has a whole task) and can send
 * only the tasks changed since the client's last snapshot, so a big run stays cheap to poll.
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
  releaseWorkers,
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
  TaskRow,
  TaskStatus,
  WorkerStatus,
} from "../swarm/types.js";

/** Run ids are `YYYYMMDD-<6 hex>` (runtime.newRunId). */
export const RUN_ID_RE = /^\d{8}-[0-9a-f]{6}$/;
/** Events closer together than this belong to one busy segment of the timeline. */
export const SEGMENT_GAP_MS = 60_000;
const EVENTS_PAGE = 200;
/** The store's largest page. */
const READ_PAGE = 1000;
/** The timeline is drawn from the newest this many events; older ones are cut. */
export const TIMELINE_EVENTS_MAX = 20_000;
const SNAPSHOT_EVENTS = 200;
/** Task `detail` / `result` in a run snapshot are cut to this; GET /api/swarm/task has it all. */
export const TASK_TEXT_MAX = 300;
/** A task delta (`tasksSince`) re-sends this much before it: clock and commit skew. */
const TASKS_SINCE_OVERLAP_MS = 5_000;
/** Runs listed by default and at most (active runs are always listed, on top). */
const RUNS_LIMIT = 30;
const RUNS_LIMIT_MAX = 500;
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

/**
 * Active runs first (all of them, whatever the limit), then the newest others up to
 * `limit` runs in all; `more` when older runs were left out.
 */
function listRuns(db: StorageAdapter, limit: number): { runs: RunRow[]; more: boolean } {
  const active = db.swarm.runs({ status: "active", limit: RUNS_LIMIT_MAX });
  const room = Math.max(0, limit - active.length);
  // One more than fits shows whether there are more; active runs among them are skipped.
  const rest = db.swarm
    .runs({ limit: Math.min(RUNS_LIMIT_MAX, room + active.length + 1) })
    .filter((r) => r.status !== "active");
  return { runs: [...active, ...rest.slice(0, room)], more: rest.length > room };
}

export function swarmOverview(ctx: ProjectContext, limit = RUNS_LIMIT) {
  const loaded = loadSwarmConfig(ctx.root);
  const now = Date.now();
  const db = getStorage(ctx);
  const runsLimit = Math.max(1, Math.min(Math.floor(limit) || RUNS_LIMIT, RUNS_LIMIT_MAX));
  // Runs are listed whatever the file's state: the ledger outlives a deleted or broken file.
  const listed = listRuns(db, runsLimit);
  const runs = listed.runs.map((r) => ({
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
  const runsMore = listed.more;
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
      runsMore,
      runsLimit,
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
      runsMore,
      runsLimit,
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
    runsMore,
    runsLimit,
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

/**
 * The newest `max` events of a run, oldest first, for the timeline; `cut` when older ones
 * were left out. The store reads forward from an id or returns the latest page, so each
 * older window is sized from how many ids the events read so far took (ids are shared by
 * every run, so concurrent runs interleave) and read forward.
 */
export function newestEvents(
  db: StorageAdapter,
  runId: string,
  max = TIMELINE_EVENTS_MAX,
): { events: SwarmEventRow[]; cut: boolean } {
  const latest = db.swarm.events(runId, { limit: READ_PAGE });
  if (latest.length < READ_PAGE)
    return latest.length > max
      ? { events: latest.slice(-max), cut: true }
      : { events: latest, cut: false };
  const first = db.swarm.events(runId, { after: 0, limit: 1 })[0]!;
  const chunks: SwarmEventRow[][] = [latest];
  let have = latest.length;
  // Every event with an id at or above `upper` has been read.
  let upper = latest[0]!.id;
  let idsPerEvent = Math.max(1, (latest[latest.length - 1]!.id - upper + 1) / latest.length);
  while (have < max && upper > first.id) {
    const want = Math.min(max - have, 5 * READ_PAGE);
    let lower = Math.max(first.id - 1, Math.floor(upper - want * idsPerEvent) - 1);
    let win: SwarmEventRow[] = [];
    let after = lower;
    for (;;) {
      const page = db.swarm.events(runId, { after, limit: READ_PAGE });
      let end = page.length < READ_PAGE;
      for (const e of page) {
        if (e.id >= upper) {
          end = true;
          break;
        }
        win.push(e);
      }
      if (end) break;
      after = page[page.length - 1]!.id;
      if (win.length > 2 * want + READ_PAGE) {
        // Far denser than estimated: start the window again nearer `upper`.
        const dense = Math.max(1, (after - lower) / win.length);
        lower = Math.max(after, Math.floor(upper - want * dense) - 1);
        win = [];
        after = lower;
      }
    }
    chunks.unshift(win);
    have += win.length;
    // An empty window means the run was quiet there: look twice as far next time.
    idsPerEvent = win.length ? Math.max(1, (upper - lower) / win.length) : idsPerEvent * 2;
    upper = lower + 1;
  }
  const all = chunks.flat();
  return {
    events: all.length > max ? all.slice(-max) : all,
    cut: all.length > max || upper > first.id,
  };
}

export type TaskView = TaskRow & {
  /** `detail` / `result` were cut to TASK_TEXT_MAX; GET /api/swarm/task has the whole task. */
  clipped?: true;
};

const clipText = (s: string | null) =>
  s !== null && s.length > TASK_TEXT_MAX ? s.slice(0, TASK_TEXT_MAX) : s;

function clipTask(t: TaskRow): TaskView {
  if ((t.detail?.length ?? 0) <= TASK_TEXT_MAX && (t.result?.length ?? 0) <= TASK_TEXT_MAX)
    return t;
  return { ...t, detail: clipText(t.detail), result: clipText(t.result), clipped: true };
}

export interface RunDetailOpts {
  /**
   * Only tasks updated at or after this (ms; minus a few seconds of skew), for a client
   * that merges them by id into the tasks it has. Tasks are never deleted, and
   * `taskCount` lets the client check that it has them all.
   */
  tasksSince?: number | undefined;
  /** false: leave out the snapshot's latest events (the client follows the event feed). */
  events?: boolean | undefined;
}

export function runDetail(ctx: ProjectContext, run: RunRow, opts: RunDetailOpts = {}) {
  const db = getStorage(ctx);
  const snap: RunSnapshot = runSnapshot(db, run, opts.events === false ? 0 : SNAPSHOT_EVENTS);
  const now = Date.now();
  const { events: all, cut } = newestEvents(db, run.id);
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
  const since = opts.tasksSince;
  const tasks = (
    since === undefined
      ? snap.tasks
      : snap.tasks.filter((t) => t.updated_at >= since - TASKS_SINCE_OVERLAP_MS)
  ).map(clipTask);
  return {
    ...snap,
    tasks,
    /** Every task of the run, whether or not `tasks` holds them all. */
    taskCount: snap.tasks.length,
    /** `tasks` holds only the tasks updated since `tasksSince`. */
    tasksPartial: since !== undefined,
    roles,
    stages: spec?.stages ?? [],
    maxAgents: spec?.maxAgents ?? null,
    configured: !!spec,
    timeline: {
      start: run.created_at,
      end: run.ended_at ?? (run.status === "active" ? now : run.updated_at),
      cut,
      /** With `cut`: the time of the oldest event drawn; activity before it is not shown. */
      from: cut ? (all[0]?.ts ?? null) : null,
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
    /** The run's newest event id (the snapshot's own events may stop short of it). */
    lastEventId: db.swarm.eventLast(run.id)?.id ?? 0,
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
    // The run is closed either way; a failed memory write is reported, not an error.
    return ok({ run: r.run, memory: r.memory ?? null, memoryError: r.memoryError ?? null });
  } catch (err) {
    if (err instanceof SwarmError) return fail(409, err.message);
    throw err;
  }
}

/** Free one stuck worker (no SubagentStop came): it stops and its task goes back to pending. */
function releaseSwarmWorker(ctx: ProjectContext, body: Record<string, unknown>): Reply {
  const { run, error } = runFromId(ctx, body.id);
  if (error || !run) return error ?? fail(400, "id required");
  const agent = body.agent;
  if (typeof agent !== "string" || !agent.trim() || agent.length > 200)
    return fail(400, "agent must be a worker's agent id");
  if (run.status !== "active") return fail(409, `run ${run.id} is already ${run.status}`);
  const loaded = loadSwarmConfig(ctx.root);
  const caller: Caller =
    loaded.state === "ok" ? callerOf(loaded.config, {}) : { label: COORDINATOR };
  try {
    const released = releaseWorkers(getStorage(ctx), run, caller, { agent });
    if (!released.length) return fail(404, `no running worker ${agent.slice(0, 80)} in this run`);
    return ok({ released: released.map((w) => w.agent_id) });
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
    return ok(swarmOverview(ctx, Number(query.get("limit")) || RUNS_LIMIT));
  }
  if (path === "/api/swarm/run") {
    if (!isGet) return fail(405, "GET only");
    const { run, error } = runFromId(ctx, query.get("id"));
    if (error || !run) return error ?? fail(400, "id required");
    const since = query.get("tasksSince");
    if (since !== null && !/^\d{1,15}$/.test(since))
      return fail(400, "tasksSince must be a non-negative integer (ms)");
    return ok(
      runDetail(ctx, run, {
        tasksSince: since === null ? undefined : Number(since),
        events: query.get("events") !== "0",
      }),
    );
  }
  if (path === "/api/swarm/task") {
    if (!isGet) return fail(405, "GET only");
    const raw = query.get("id") ?? "";
    if (!/^\d{1,15}$/.test(raw)) return fail(400, "id must be a task id");
    const task = getStorage(ctx).swarm.taskGet(Number(raw));
    const runId = query.get("run");
    if (!task || (runId && task.run_id !== runId)) return fail(404, `task ${raw} not found`);
    return ok({ task });
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
  if (path === "/api/swarm/release") {
    if (method !== "POST") return fail(405, "POST only");
    let body: Record<string, unknown>;
    try {
      body = await readBody();
    } catch {
      return fail(400, "invalid JSON body");
    }
    return releaseSwarmWorker(ctx, body);
  }
  return fail(404, "not found");
}
