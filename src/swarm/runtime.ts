import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ProjectContext } from "../context.js";
import { relOf, slugify, write as writeMemory } from "../memory/store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { findRole, findSwarm } from "./config.js";
import type {
  NoteRow,
  RoleSpec,
  RunRow,
  RunStatus,
  SpawnRow,
  SwarmConfig,
  SwarmEventRow,
  SwarmSpec,
  TaskRow,
  TaskStatus,
  WorkerRow,
  WorkerStatus,
} from "./types.js";

/** A running worker silent for this long no longer counts against capacity. */
export const STALE_MS = 15 * 60_000;
/** A spawn reservation counts against capacity this long before SubagentStart consumes it. */
export const SPAWN_TTL_MS = 2 * 60_000;
/** SubagentStart may match a reservation this old (slow starts, permission prompts). */
const SPAWN_MATCH_MS = 10 * 60_000;
/** Events kept per run; older ones are pruned as workers add more. */
const EVENTS_KEEP = 5000;
/** Repeated identical denials within this window update one feed event instead of adding more. */
const DENY_COLLAPSE_MS = 5 * 60_000;

const TITLE_MAX = 200;
const DETAIL_MAX = 4000;
const RESULT_MAX = 4000;
const NOTE_MAX = 8000;
const GOAL_MAX = 2000;
const PLAN_MAX = 50;
export const NOTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
/** `task #12` in a spawn prompt names the task the new worker is for. */
const TASK_REF_RE = /\btask\s*#\s*(\d{1,9})\b/gi;

/** A user-facing failure (bad input, wrong state); tools render the message as is. */
export class SwarmError extends Error {}

/** Shorten to `n` characters without splitting a surrogate pair. */
export function clip(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  let cut = t.slice(0, Math.max(0, n - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYYMMDD-xxxxxx` with the local date, so ids match the day people see. */
export function newRunId(now = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${randomBytes(3).toString("hex")}`;
}

function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- callers ------------------------------------------------------------------------------

/** Who is calling: the coordinator (main session), a swarm worker, or another subagent. */
export interface Caller {
  /** "coordinator", a role name, or a foreign agent type. */
  label: string;
  agentId?: string | undefined;
  agentType?: string | undefined;
  swarm?: SwarmSpec | undefined;
  role?: RoleSpec | undefined;
}

export const COORDINATOR = "coordinator";

export function callerOf(
  config: SwarmConfig,
  ids: { agentId?: string | undefined; agentType?: string | undefined },
): Caller {
  if (!ids.agentId && !ids.agentType) return { label: COORDINATOR };
  const hit = findRole(config, ids.agentType);
  if (hit)
    return {
      label: hit.role.role,
      agentId: ids.agentId,
      agentType: ids.agentType,
      swarm: hit.swarm,
      role: hit.role,
    };
  return { label: ids.agentType || "subagent", agentId: ids.agentId, agentType: ids.agentType };
}

export const isCoordinator = (c: Caller) => c.label === COORDINATOR && !c.agentId && !c.agentType;
/** A swarm worker (a generated agent of one of the configured swarms). */
export const isWorker = (c: Caller) => !!c.role;
/** Who holds a task: the worker's agent id, or the label when the coordinator works it. */
const holderOf = (c: Caller) => c.agentId ?? c.label;
/** How the blackboard and the feed name a caller: `coder@a1b2c3` or `coordinator`. */
export function authorOf(c: Caller): string {
  return c.agentId ? `${c.label}@${c.agentId.replace(/^agent-/, "").slice(0, 8)}` : c.label;
}

/** Subagents that are not swarm workers may look but not change the board. */
function requireMember(c: Caller, what: string): void {
  if (!isCoordinator(c) && !isWorker(c))
    throw new SwarmError(
      `only the coordinator or a worker of the swarm can ${what}; "${c.label}" is not a swarm worker`,
    );
}

// --- runs ---------------------------------------------------------------------------------

export function startRun(
  db: StorageAdapter,
  config: SwarmConfig,
  opts: { swarm: string; goal: string; sessionId?: string | undefined },
): RunRow {
  const swarm = findSwarm(config, opts.swarm);
  if (!swarm)
    throw new SwarmError(
      `unknown swarm "${opts.swarm}"; ${config.rel} defines: ${config.swarms.map((s) => s.name).join(", ")}`,
    );
  const goal = opts.goal.trim();
  if (!goal) throw new SwarmError("goal is required: what should the swarm achieve?");
  if (goal.length > GOAL_MAX)
    throw new SwarmError(`goal is too long (${goal.length} > ${GOAL_MAX} characters)`);
  const run = db.swarm.runCreate({
    id: newRunId(),
    swarm: swarm.name,
    goal,
    topology: swarm.topology,
    session_id: opts.sessionId,
  });
  db.swarm.eventAdd({ run_id: run.id, kind: "run_start", role: COORDINATOR, text: goal });
  return run;
}

function adhocRun(
  db: StorageAdapter,
  swarm: SwarmSpec,
  sessionId: string | undefined,
  what: string,
): RunRow {
  const run = db.swarm.runCreate({
    id: newRunId(),
    swarm: swarm.name,
    goal: clip(`(ad hoc) ${what || "worker spawned without em_swarm start"}`, 200),
    topology: swarm.topology,
    session_id: sessionId,
  });
  db.swarm.eventAdd({
    run_id: run.id,
    kind: "run_start",
    role: COORDINATOR,
    text: `${run.goal} (opened automatically for a worker spawned outside a run)`,
  });
  return run;
}

/**
 * The run a call is about: the named one; for a worker, the run it belongs to; otherwise
 * the newest active run (of the caller's swarm, preferring this session's runs).
 */
export function resolveRun(
  db: StorageAdapter,
  opts: {
    run?: string | undefined;
    swarm?: string | undefined;
    sessionId?: string | undefined;
    caller?: Caller | undefined;
  },
): RunRow | undefined {
  if (opts.run) {
    const r = db.swarm.runGet(opts.run);
    if (!r) throw new SwarmError(`unknown run "${opts.run}"`);
    return r;
  }
  if (opts.caller?.agentId) {
    const w = db.swarm.workerFind(opts.caller.agentId);
    const r = w ? db.swarm.runGet(w.run_id) : undefined;
    if (r) return r;
  }
  return db.swarm.runActive(opts.swarm ?? opts.caller?.swarm?.name, opts.sessionId);
}

/** Re-read the run inside the caller's transaction: another process may have closed it. */
function requireActive(db: StorageAdapter, run: RunRow): void {
  const status = db.swarm.runGet(run.id)?.status ?? "deleted";
  if (status !== "active")
    throw new SwarmError(
      `run ${run.id} is ${status}; start a new run with em_swarm {action:"start", swarm, goal}`,
    );
}

// --- tasks --------------------------------------------------------------------------------

export interface PlanTaskInput {
  /** A label other tasks in the same call can name in `deps`. */
  key?: string | undefined;
  title: string;
  detail?: string | undefined;
  role?: string | undefined;
  /** Task ids of this run, or keys of tasks earlier in the same call. */
  deps?: Array<number | string> | undefined;
  files?: string[] | undefined;
}

/** Normalise a file path to project-relative with forward slashes (outside paths stay absolute). */
export function relPath(root: string, p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  if (!isAbsolute(s)) {
    while (s.startsWith("./")) s = s.slice(2);
    return s;
  }
  const r = relative(root, s).replace(/\\/g, "/");
  return r.startsWith("..") ? s : r;
}

export function addTasks(
  db: StorageAdapter,
  ctx: Pick<ProjectContext, "root">,
  run: RunRow,
  swarm: SwarmSpec,
  caller: Caller,
  input: PlanTaskInput[],
): TaskRow[] {
  requireMember(caller, "plan tasks");
  if (!Array.isArray(input) || !input.length)
    throw new SwarmError("tasks is empty: give at least one {title}");
  if (input.length > PLAN_MAX)
    throw new SwarmError(`too many tasks in one call (${input.length} > ${PLAN_MAX})`);
  const roles = new Set(swarm.roles.map((r) => r.role));
  const keys = new Map<string, number>();
  return db.swarm.immediate(() => {
    requireActive(db, run);
    const existing = new Set(db.swarm.tasks(run.id).map((t) => t.id));
    const out: TaskRow[] = [];
    input.forEach((t, i) => {
      const at = `tasks[${i}]`;
      const title = typeof t?.title === "string" ? t.title.trim() : "";
      if (!title) throw new SwarmError(`${at}.title is required`);
      if (title.length > TITLE_MAX)
        throw new SwarmError(`${at}.title is too long (max ${TITLE_MAX} characters)`);
      if ((t.detail?.length ?? 0) > DETAIL_MAX)
        throw new SwarmError(`${at}.detail is too long (max ${DETAIL_MAX} characters)`);
      const role = typeof t.role === "string" && t.role.trim() ? t.role.trim() : null;
      if (role && !roles.has(role))
        throw new SwarmError(
          `${at}.role "${role}" is not a role of swarm "${swarm.name}" (${[...roles].join(", ")})`,
        );
      const deps: number[] = [];
      for (const d of t.deps ?? []) {
        let id: number | undefined;
        if (typeof d === "number") id = d;
        else if (typeof d === "string") {
          const v = d.trim();
          id = /^#?\d+$/.test(v) ? Number(v.replace("#", "")) : keys.get(v);
        } else throw new SwarmError(`${at}.deps: each dep is a task id or a key`);
        if (id === undefined)
          throw new SwarmError(
            `${at}.deps: "${d}" is neither a task id of this run nor the key of an earlier task in this call`,
          );
        if (!Number.isInteger(id) || !existing.has(id))
          throw new SwarmError(`${at}.deps: task #${id} is not in run ${run.id}`);
        if (!deps.includes(id)) deps.push(id);
      }
      const files = [
        ...new Set(
          (t.files ?? [])
            .filter((f): f is string => typeof f === "string")
            .map((f) => relPath(ctx.root, f))
            .filter(Boolean),
        ),
      ];
      if (files.length > 50) throw new SwarmError(`${at}.files: at most 50 files per task`);
      const key = typeof t.key === "string" ? t.key.trim() : "";
      if (key && keys.has(key))
        throw new SwarmError(`${at}.key "${key}" is used twice in this call`);
      const row = db.swarm.taskAdd({
        run_id: run.id,
        title,
        detail: typeof t.detail === "string" && t.detail.trim() ? t.detail.trim() : null,
        role,
        deps,
        files,
        created_by: authorOf(caller),
      });
      existing.add(row.id);
      if (key) keys.set(key, row.id);
      db.swarm.eventAdd({
        run_id: run.id,
        kind: "plan",
        role: caller.label,
        agent_id: caller.agentId,
        task_id: row.id,
        text: `${title}${role ? ` → ${role}` : ""}`,
      });
      out.push(row);
    });
    db.swarm.runTouch(run.id);
    return out;
  });
}

/** Why a task can or cannot be claimed by `role` (undefined: the coordinator) right now. */
export function eligibility(
  task: TaskRow,
  all: TaskRow[],
  swarm: SwarmSpec,
  role: string | undefined,
  byId: Map<number, TaskRow> = new Map(all.map((t) => [t.id, t])),
): { ok: boolean; why?: string } {
  if (task.status !== "pending") return { ok: false, why: `it is ${task.status}` };
  const dead = task.deps.filter((d) => {
    const s = byId.get(d)?.status;
    return s === "failed" || s === "blocked";
  });
  if (dead.length)
    return {
      ok: false,
      why: `it depends on ${dead.map((d) => `#${d} (${byId.get(d)?.status})`).join(", ")}; reopen or replace those first`,
    };
  const waiting = task.deps.filter((d) => byId.get(d)?.status !== "done");
  if (waiting.length)
    return { ok: false, why: `it waits on ${waiting.map((d) => `#${d}`).join(", ")}` };
  const roleBound = swarm.topology === "hierarchical" || swarm.topology === "pipeline";
  if (roleBound && role && task.role && task.role !== role)
    return { ok: false, why: `it is for the ${task.role} role` };
  if (swarm.topology === "pipeline" && task.role) {
    const stage = swarm.stages.indexOf(task.role);
    if (stage > 0) {
      const earlier = new Set(swarm.stages.slice(0, stage));
      const open = all.filter((t) => t.role && earlier.has(t.role) && t.status !== "done");
      if (open.length) {
        const stuck = open.filter((t) => t.status === "failed" || t.status === "blocked");
        return {
          ok: false,
          why: stuck.length
            ? `an earlier stage has ${stuck.map((t) => `#${t.id} ${t.status}`).join(", ")}; reopen or replace it`
            : `earlier stages are unfinished (${open
                .slice(0, 4)
                .map((t) => `#${t.id} ${t.role}`)
                .join(", ")})`,
        };
      }
    }
  }
  return { ok: true };
}

export function claimTask(
  db: StorageAdapter,
  run: RunRow,
  swarm: SwarmSpec,
  caller: Caller,
  taskId?: number | undefined,
): { task?: TaskRow; already?: boolean; reason?: string } {
  requireMember(caller, "claim tasks");
  const holder = holderOf(caller);
  const role = caller.role?.role;
  return db.swarm.immediate(() => {
    requireActive(db, run);
    const all = db.swarm.tasks(run.id);
    const byId = new Map(all.map((t) => [t.id, t]));
    const mine = all.find((t) => t.status === "active" && t.agent_id === holder);
    let pick: TaskRow | undefined;
    if (taskId !== undefined) {
      const t = byId.get(taskId);
      if (!t) throw new SwarmError(`task #${taskId} is not in run ${run.id}`);
      if (t.status === "active" && t.agent_id === holder) return { task: t, already: true };
      const e = eligibility(t, all, swarm, role, byId);
      if (!e.ok) throw new SwarmError(`cannot claim task #${taskId}: ${e.why}`);
      pick = t;
    } else {
      if (mine) return { task: mine, already: true };
      const open = all.filter((t) => eligibility(t, all, swarm, role, byId).ok);
      pick = open.find((t) => role && t.role === role) ?? open[0];
      if (!pick) return { reason: nothingToClaim(db, run, all, swarm, role, byId) };
    }
    if (!db.swarm.taskClaim(pick.id, holder))
      throw new SwarmError(`task #${pick.id} was claimed by someone else a moment ago`);
    if (caller.agentId && db.swarm.workerGet(run.id, caller.agentId))
      db.swarm.workerUpdate(run.id, caller.agentId, { task_id: pick.id });
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "claim",
      role: caller.label,
      agent_id: caller.agentId,
      task_id: pick.id,
      text: pick.title,
    });
    db.swarm.runTouch(run.id);
    return { task: db.swarm.taskGet(pick.id)! };
  });
}

/** Active tasks whose holder is a worker that went quiet or stopped (looked up across runs). */
function staleHeld(db: StorageAdapter, run: RunRow, all: TaskRow[], now = Date.now()): TaskRow[] {
  const workers = new Map(db.swarm.workers(run.id).map((w) => [w.agent_id, w]));
  return all.filter((t) => {
    if (t.status !== "active" || !t.agent_id || t.agent_id === COORDINATOR) return false;
    const w = workers.get(t.agent_id) ?? db.swarm.workerFind(t.agent_id);
    if (!w) return false;
    return w.status === "done" || now - w.last_ts >= STALE_MS;
  });
}

function nothingToClaim(
  db: StorageAdapter,
  run: RunRow,
  all: TaskRow[],
  swarm: SwarmSpec,
  role: string | undefined,
  byId: Map<number, TaskRow>,
): string {
  const pending = all.filter((t) => t.status === "pending");
  const stale = staleHeld(db, run, all);
  const staleNote = stale.length
    ? ` ${stale.map((t) => `#${t.id}`).join(", ")} ${stale.length === 1 ? "is" : "are"} held by a worker that went quiet; the coordinator can free ${stale.length === 1 ? "it" : "them"} with em_swarm {action:"release"} (or {action:"release", agent}).`
    : "";
  if (!pending.length) {
    const active = all.filter((t) => t.status === "active").length;
    return all.length
      ? `no pending tasks (${active} active, ${all.length - active} closed).${staleNote}`
      : 'the run has no tasks yet; the coordinator adds them with em_swarm {action:"plan"}';
  }
  const why = pending
    .slice(0, 5)
    .map((t) => `#${t.id}: ${eligibility(t, all, swarm, role, byId).why}`)
    .join("; ");
  return `${pending.length} pending task(s), none claimable now: ${why}.${staleNote}`;
}

const SETTABLE: TaskStatus[] = ["pending", "done", "failed", "blocked"];

/**
 * Report on a task. Workers may only update tasks they hold; the coordinator may update any.
 * Works on finished runs too, so a worker that outlives its run can still report.
 */
export function updateTask(
  db: StorageAdapter,
  run: RunRow,
  caller: Caller,
  opts: { task: number; status: TaskStatus; result?: string | undefined },
): TaskRow {
  requireMember(caller, "update tasks");
  if (!SETTABLE.includes(opts.status))
    throw new SwarmError(
      `status must be one of ${SETTABLE.join(", ")} (claim a task to make it active)`,
    );
  return db.swarm.immediate(() => {
    const t = db.swarm.taskGet(opts.task);
    if (!t || t.run_id !== run.id)
      throw new SwarmError(`task #${opts.task} is not in run ${run.id}`);
    const holder = holderOf(caller);
    if (!isCoordinator(caller) && t.agent_id !== holder)
      throw new SwarmError(
        t.agent_id
          ? `task #${t.id} is held by another worker; only that worker or the coordinator can update it`
          : `task #${t.id} is not yours; claim it first with em_swarm {action:"claim", task:${t.id}}`,
      );
    const result = opts.result?.trim() ? clip(opts.result, RESULT_MAX) : undefined;
    db.swarm.taskUpdate(t.id, {
      status: opts.status,
      // Reopening releases the task so any eligible worker can claim it again.
      agent_id: opts.status === "pending" ? null : (t.agent_id ?? holder),
      auto_closed: false,
      ...(result !== undefined ? { result } : {}),
    });
    if (t.agent_id) {
      const w = db.swarm.workerGet(run.id, t.agent_id);
      if (w?.task_id === t.id) db.swarm.workerUpdate(run.id, t.agent_id, { task_id: null });
    }
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "update",
      role: caller.label,
      agent_id: caller.agentId,
      task_id: t.id,
      text: `${opts.status}${result ? `: ${firstLine(result).slice(0, 160)}` : ""}`,
      payload: { status: opts.status },
    });
    db.swarm.runTouch(run.id);
    return db.swarm.taskGet(t.id)!;
  });
}

// --- blackboard ---------------------------------------------------------------------------

export function postNote(
  db: StorageAdapter,
  run: RunRow,
  caller: Caller,
  key: string,
  value: string,
): NoteRow {
  const k = key.trim();
  if (!NOTE_KEY_RE.test(k))
    throw new SwarmError(
      'key must be 1-80 characters of letters, digits and . _ : / - (e.g. "design" or "api/contract")',
    );
  if (!value.trim()) throw new SwarmError("value is required");
  if (value.length > NOTE_MAX)
    throw new SwarmError(
      `value is too long (${value.length} > ${NOTE_MAX} characters); post a summary`,
    );
  return db.swarm.immediate(() => {
    requireActive(db, run);
    const note = db.swarm.noteSet(run.id, k, value, authorOf(caller));
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "post",
      role: caller.label,
      agent_id: caller.agentId,
      text: `${k} (v${note.version}): ${firstLine(value).slice(0, 120)}`,
    });
    db.swarm.runTouch(run.id);
    return note;
  });
}

// --- finish -------------------------------------------------------------------------------

const FINISH: RunStatus[] = ["done", "failed", "cancelled"];

export function finishRun(
  ctx: ProjectContext,
  db: StorageAdapter,
  run: RunRow,
  caller: Caller,
  opts: { status: RunStatus; summary?: string | undefined; remember?: boolean | undefined },
): { run: RunRow; memory?: string | undefined; memoryError?: string | undefined } {
  if (!isCoordinator(caller))
    throw new SwarmError("only the coordinator (the main session) can finish a run");
  if (!FINISH.includes(opts.status))
    throw new SwarmError(`status must be one of ${FINISH.join(", ")}`);
  const summary = opts.summary?.trim() ? clip(opts.summary, RESULT_MAX) : null;
  const now = Date.now();
  db.swarm.immediate(() => {
    requireActive(db, run);
    const active = db.swarm.tasks(run.id).filter((t) => t.status === "active").length;
    // The coordinator is done with the run: its workers stop counting against capacity
    // (a worker that crashed without SubagentStop would otherwise hold its slot). Spawns
    // still starting keep their reservations, so capacity holds for them.
    const running = db.swarm.workers(run.id).filter((w) => w.status === "running");
    for (const w of running)
      db.swarm.workerUpdate(run.id, w.agent_id, {
        status: "done",
        ended_at: now,
        summary: w.summary ?? "closed when the run finished",
      });
    db.swarm.runUpdate(run.id, { status: opts.status, summary, ended_at: now });
    const left = [
      active ? `${active} task(s) still active` : "",
      running.length ? `${running.length} worker(s) still running were closed` : "",
    ].filter(Boolean);
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "run_finish",
      role: COORDINATOR,
      text: `${opts.status}${summary ? `: ${firstLine(summary).slice(0, 160)}` : ""}${left.length ? ` (${left.join(", ")})` : ""}`,
    });
  });
  const closed = db.swarm.runGet(run.id)!;
  if (!opts.remember) return { run: closed };
  try {
    return { run: closed, memory: rememberRun(ctx, db, closed) };
  } catch (err) {
    return { run: closed, memoryError: (err as Error).message };
  }
}

/** Write the run's outcome as an eminiar memory (`swarm/run-<date>-<slug>`). */
function rememberRun(ctx: ProjectContext, db: StorageAdapter, run: RunRow): string {
  const tasks = db.swarm.tasks(run.id);
  const workers = db.swarm.workers(run.id);
  const date = localDate(run.created_at);
  const minutes = Math.max(1, Math.round(((run.ended_at ?? Date.now()) - run.created_at) / 60_000));
  const lines = [
    `Swarm run ${run.id} (swarm "${run.swarm}", ${run.topology}, ${date}): ${run.status}.`,
    `Goal: ${run.goal}`,
    ...(run.summary ? [`Outcome: ${run.summary}`] : []),
    `${tasks.length} task(s), ${workers.length} worker(s), ${minutes} min.`,
    ...tasks.map(
      (t) =>
        `- #${t.id} [${t.status}${t.auto_closed ? ", auto-closed" : ""}]${t.role ? ` (${t.role})` : ""} ${t.title}${
          t.result ? ` — ${clip(firstLine(t.result), 200)}` : ""
        }`,
    ),
  ];
  const slug = slugify(run.goal.replace(/^\(ad hoc\)\s*/, ""), 32) || run.swarm;
  const base = `swarm/run-${date}-${slug}`;
  // A teammate's memory file may exist on disk without being in this database yet.
  const taken = (n: string) => !!db.memoryGetByName(n) || existsSync(join(ctx.root, relOf(ctx, n)));
  const suffix = run.id.slice(-6);
  let name = base;
  for (let i = 0; taken(name) && i < 50; i++)
    name = i === 0 ? `${base}-${suffix}` : `${base}-${suffix}-${i}`;
  const r = writeMemory(ctx, db, {
    name,
    kind: "note",
    content: lines.join("\n"),
    tags: ["swarm", run.swarm],
    related: [...new Set(tasks.flatMap((t) => t.files))]
      .filter((f) => {
        try {
          return statSync(join(ctx.root, f)).isFile();
        } catch {
          return false;
        }
      })
      .slice(0, 20),
  });
  return r.name;
}

// --- hook side ----------------------------------------------------------------------------

export type SpawnDecision =
  | {
      decision: "allow";
      /** The run the spawn will likely join; undefined when none is active yet. */
      run?: RunRow | undefined;
      role: RoleSpec;
      swarm: SwarmSpec;
      taskId?: number | undefined;
    }
  | { decision: "deny"; reason: string };

/** Every distinct `task #N` a prompt names. */
export function taskRefs(prompt: string | undefined): number[] {
  if (!prompt) return [];
  return [...new Set([...prompt.matchAll(TASK_REF_RE)].map((m) => Number(m[1])))];
}

/** The task a spawn prompt is for, when it names exactly one. */
export function taskRef(prompt: string | undefined): number | undefined {
  const refs = taskRefs(prompt);
  return refs.length === 1 ? refs[0] : undefined;
}

const isLive = (w: WorkerRow, now: number) => w.status === "running" && now - w.last_ts < STALE_MS;

type DenyType = "max_agents" | "count";

/** Record a denial, folding repeats of the same kind for the same role into one event. */
function denyEvent(
  db: StorageAdapter,
  runId: string,
  role: string,
  type: DenyType,
  reason: string,
): void {
  const last = db.swarm.eventLast(runId);
  const now = Date.now();
  if (
    last &&
    last.kind === "deny" &&
    last.role === role &&
    last.payload?.type === type &&
    now - last.ts < DENY_COLLAPSE_MS
  ) {
    const count = Number(last.payload?.count ?? 1) + 1;
    db.swarm.eventUpdate(last.id, {
      ts: now,
      text: `${reason} (×${count})`,
      payload: { count, type, reason },
    });
    return;
  }
  db.swarm.eventAdd({
    run_id: runId,
    kind: "deny",
    role,
    text: reason,
    payload: { count: 1, type, reason },
  });
}

function describeBusy(db: StorageAdapter, workers: WorkerRow[], now: number): string {
  if (!workers.length) return "";
  const shown = workers
    .slice(0, 4)
    .map((w) => {
      const run = db.swarm.runGet(w.run_id);
      const where = run && run.status !== "active" ? `, run ${w.run_id} ${run.status}` : "";
      return `${w.role}@${w.agent_id.replace(/^agent-/, "").slice(0, 8)} (last seen ${Math.round((now - w.last_ts) / 60_000)}m ago${where})`;
    })
    .join(", ");
  return ` Running: ${shown}${workers.length > 4 ? ", …" : ""}; the coordinator can free a stuck one with em_swarm {action:"release", agent}.`;
}

/**
 * PreToolUse on Agent for a swarm agent: check capacity and reserve a slot, atomically
 * across hook processes. Capacity is per swarm: live workers of every run and every open
 * reservation count. Nothing is created for a spawn that may never happen: the run opens
 * at SubagentStart, and the reservation is released when the Agent call returns (or after
 * SPAWN_TTL_MS). Undefined for agent types that are not swarm workers.
 */
export function reserveSpawn(
  db: StorageAdapter,
  config: SwarmConfig,
  opts: {
    agentType: string;
    prompt?: string | undefined;
    description?: string | undefined;
    sessionId?: string | undefined;
    toolUseId?: string | undefined;
  },
): SpawnDecision | undefined {
  const hit = findRole(config, opts.agentType);
  if (!hit) return undefined;
  const { swarm, role } = hit;
  return db.swarm.immediate(() => {
    const now = Date.now();
    // A prompt naming a task of an active run of this swarm decides the run.
    const ref = taskRef(opts.prompt);
    const refTask = ref !== undefined ? db.swarm.taskGet(ref) : undefined;
    const refRun = refTask ? db.swarm.runGet(refTask.run_id) : undefined;
    const run =
      (refRun && refRun.status === "active" && refRun.swarm === swarm.name ? refRun : undefined) ??
      db.swarm.runActive(swarm.name, opts.sessionId);
    const live = db.swarm
      .liveWorkersOfSwarm(swarm.name, now - STALE_MS)
      .filter((w) => isLive(w, now));
    const since = now - SPAWN_TTL_MS;
    const starting = db.swarm.spawnsPendingOfSwarm(swarm.name, since);
    const roleLive = live.filter((w) => w.role === role.role);
    const roleBusy =
      roleLive.length + db.swarm.spawnsPendingOfSwarm(swarm.name, since, role.agentType);
    let reason: string | undefined;
    let type: DenyType = "max_agents";
    if (live.length + starting >= swarm.maxAgents)
      reason = `swarm "${swarm.name}" is at capacity: ${live.length} worker(s) running and ${starting} starting, max_agents is ${swarm.maxAgents}.${describeBusy(db, live, now)} Otherwise wait for a worker to finish (em_swarm {action:"status"}) or raise max_agents in ${config.rel}.`;
    else if (roleBusy >= role.count) {
      type = "count";
      reason = `role "${role.role}" of swarm "${swarm.name}" already has ${roleBusy} worker(s) running or starting and its count is ${role.count}.${describeBusy(db, roleLive, now)} Otherwise wait for one to finish or raise count in ${config.rel}.`;
    }
    if (reason) {
      if (run) denyEvent(db, run.id, role.role, type, reason);
      return { decision: "deny" as const, reason };
    }
    const taskId = refTask && run && refTask.run_id === run.id ? refTask.id : undefined;
    db.swarm.spawnAdd({
      swarm: swarm.name,
      run_id: run?.id ?? null,
      session_id: opts.sessionId,
      agent_type: role.agentType,
      prompt: opts.prompt ? clip(opts.prompt, 4000) : null,
      task_id: taskId,
      tool_use_id: opts.toolUseId,
    });
    if (run) {
      db.swarm.eventAdd({
        run_id: run.id,
        kind: "spawn",
        role: role.role,
        task_id: taskId,
        text: clip(opts.description || firstLine(opts.prompt ?? "") || role.agentType, 160),
      });
      db.swarm.runTouch(run.id);
    }
    return { decision: "allow" as const, run, role, swarm, taskId };
  });
}

/**
 * PostToolUse / PostToolUseFailure of the Agent call that reserved a slot: the worker has
 * started (and counts as running) or never will, so the reservation is done either way.
 */
export function releaseSpawn(db: StorageAdapter, toolUseId: string | undefined): boolean {
  return toolUseId ? db.swarm.spawnConsumeByToolUse(toolUseId) : false;
}

export interface WorkerStart {
  run: RunRow;
  swarm: SwarmSpec;
  role: RoleSpec;
  worker: WorkerRow;
  /** A task the worker already holds (a resumed worker). */
  task?: TaskRow | undefined;
  /** Kept for compatibility; SubagentStart no longer hands tasks over. */
  handoffNote?: string | undefined;
  prompt?: string | undefined;
}

/**
 * Consume the oldest open reservation of an agent type in this session: a worker has
 * started, so it now counts as running instead. Which reservation it was cannot be told
 * (SubagentStart does not see the spawn prompt), so only the count matters here.
 */
function consumeReservation(
  db: StorageAdapter,
  agentType: string,
  sessionId: string | undefined,
  now: number,
): SpawnRow | undefined {
  const open = db.swarm.spawnsOpen(agentType, now - SPAWN_MATCH_MS, sessionId);
  const spawn = open[0];
  if (spawn) db.swarm.spawnConsume(spawn.id);
  return spawn;
}

/**
 * SubagentStart: register the worker. A resumed worker keeps its run and task. A new one
 * joins the newest active run of its swarm in this session (else the run its reservation
 * was made for, else a new ad-hoc run) and consumes one reservation for capacity. No task is
 * handed over: parallel spawns of one role cannot be told apart here, so the worker claims
 * the task its prompt names itself. Undefined for non-swarm agents.
 */
export function registerWorker(
  db: StorageAdapter,
  config: SwarmConfig,
  opts: { agentId: string; agentType: string; sessionId?: string | undefined },
): WorkerStart | undefined {
  const hit = findRole(config, opts.agentType);
  if (!hit || !opts.agentId) return undefined;
  const { swarm, role } = hit;
  return db.swarm.immediate(() => {
    const now = Date.now();
    const prior = db.swarm.workerFind(opts.agentId);
    const usable = (r: RunRow | undefined) =>
      r && r.status === "active" && r.swarm === swarm.name ? r : undefined;
    const spawn = prior ? undefined : consumeReservation(db, role.agentType, opts.sessionId, now);
    const run =
      usable(prior ? db.swarm.runGet(prior.run_id) : undefined) ??
      db.swarm.runActive(swarm.name, opts.sessionId) ??
      usable(spawn?.run_id ? db.swarm.runGet(spawn.run_id) : undefined) ??
      adhocRun(db, swarm, opts.sessionId, "");
    db.swarm.workerUpsert({
      run_id: run.id,
      agent_id: opts.agentId,
      agent_type: role.agentType,
      role: role.role,
      session_id: opts.sessionId,
    });
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "start",
      role: role.role,
      agent_id: opts.agentId,
      text: prior ? "worker resumed" : "worker started",
    });
    const task = prior ? db.swarm.tasksHeldBy(opts.agentId)[0] : undefined;
    db.swarm.runTouch(run.id);
    return { run, swarm, role, worker: db.swarm.workerGet(run.id, opts.agentId)!, task };
  });
}

/**
 * PreToolUse inside a worker: refresh its liveness so a long tool call does not make it
 * look stale (and free its slot). Unknown workers are ignored.
 */
export function touchWorker(db: StorageAdapter, agentId: string): void {
  const w = db.swarm.workerFind(agentId);
  if (w && w.status === "running") db.swarm.workerPing(w.run_id, w.agent_id);
}

/** Read/write/exec class of a tool call, for the dashboard's activity flashes. */
export function toolIo(tool: string): "read" | "write" | "exec" | "swarm" | "other" {
  const t = tool.replace(/^mcp__.*__/, "");
  if (t === "em_swarm") return "swarm";
  if (/^(Edit|Write|MultiEdit|NotebookEdit|em_remember)$/.test(t)) return "write";
  if (/^(Bash|em_execute|em_execute_file|em_batch_execute)$/.test(t)) return "exec";
  if (
    /^(Read|Grep|Glob|LS|WebFetch|WebSearch|em_search|em_recall|em_symbols|em_history|em_graph_\w+|em_architecture|em_docs|em_memory|em_fetch_and_index|em_index_status)$/.test(
      t,
    )
  )
    return "read";
  return "other";
}

/** One-line description of a tool call: `Edit src/x.ts`, `Bash npm test`. */
export function toolHead(
  root: string,
  tool: string,
  input: Record<string, unknown> | undefined,
): string {
  const i = input ?? {};
  const short = tool.replace(/^mcp__.*__/, "");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const arg =
    str(i.file_path) ||
    str(i.notebook_path) ||
    str(i.path) ||
    str(i.command) ||
    str(i.pattern) ||
    str(i.url) ||
    str(i.query) ||
    str(i.node) ||
    str(i.name_path) ||
    str(i.action) ||
    str(i.subagent_type);
  const shown = arg && (isAbsolute(arg) ? relPath(root, arg) : arg);
  return clip(`${short}${shown ? ` ${firstLine(shown)}` : ""}`, 160);
}

/**
 * PostToolUse / PostToolUseFailure inside a swarm worker. A worker that missed SubagentStart
 * joins the newest active run of its swarm; activity never opens a run of its own.
 */
export function recordActivity(
  db: StorageAdapter,
  config: SwarmConfig,
  root: string,
  opts: {
    agentId: string;
    agentType: string;
    sessionId?: string | undefined;
    tool: string;
    input?: Record<string, unknown> | undefined;
    failed?: boolean | undefined;
    error?: string | undefined;
  },
): void {
  let w = db.swarm.workerFind(opts.agentId);
  if (!w) {
    const hit = findRole(config, opts.agentType);
    const run = hit ? db.swarm.runActive(hit.swarm.name, opts.sessionId) : undefined;
    if (!hit || !run) return;
    const unseen = run;
    w = db.swarm.immediate(() => {
      consumeReservation(db, hit.role.agentType, opts.sessionId, Date.now());
      return db.swarm.workerUpsert({
        run_id: unseen.id,
        agent_id: opts.agentId,
        agent_type: hit.role.agentType,
        role: hit.role.role,
        session_id: opts.sessionId,
      });
    });
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "start",
      role: hit.role.role,
      agent_id: opts.agentId,
      text: "worker joined (its start was not seen)",
    });
  }
  db.swarm.workerTouch(w.run_id, w.agent_id, opts.tool.replace(/^mcp__.*__/, ""), !!opts.failed);
  const io = toolIo(opts.tool);
  // em_swarm calls already leave claim/post/update events; a tool line would repeat them.
  if (io === "swarm" && !opts.failed) return;
  const id = db.swarm.eventAdd({
    run_id: w.run_id,
    kind: opts.failed ? "tool_error" : "tool",
    role: w.role,
    agent_id: w.agent_id,
    task_id: w.task_id,
    text: `${toolHead(root, opts.tool, opts.input)}${opts.failed && opts.error ? ` ✗ ${clip(firstLine(opts.error), 120)}` : ""}`,
    payload: { tool: opts.tool.replace(/^mcp__.*__/, ""), io },
  });
  // Tool events are the bulk of the ledger: keep each run's newest EVENTS_KEEP.
  if (id % 250 === 0) db.swarm.eventsPrune(w.run_id, EVENTS_KEEP);
}

/**
 * SubagentStop for a swarm worker: close it and settle the task it still holds. A worker
 * the ledger never saw is ignored (no run is created for it).
 */
export function closeWorker(
  db: StorageAdapter,
  _config: SwarmConfig,
  opts: {
    agentId: string;
    agentType: string;
    sessionId?: string | undefined;
    message?: string | undefined;
  },
): { run: RunRow; worker: WorkerRow; closed: TaskRow[] } | undefined {
  const worker = db.swarm.workerFind(opts.agentId);
  if (!worker) return undefined;
  const message = opts.message?.trim() ?? "";
  return db.swarm.immediate(() => {
    const now = Date.now();
    const closed: TaskRow[] = [];
    // Tasks it holds in any run (a worker can claim a task of another run by id).
    for (const t of db.swarm.tasksHeldBy(worker.agent_id)) {
      if (message) {
        db.swarm.taskUpdate(t.id, {
          status: "done",
          result: clip(message, RESULT_MAX),
          auto_closed: true,
        });
        db.swarm.eventAdd({
          run_id: t.run_id,
          kind: "auto_close",
          role: worker.role,
          agent_id: worker.agent_id,
          task_id: t.id,
          text: "closed as done from the worker's final message (it never reported); reopen with status pending if that is wrong",
        });
      } else {
        // No final message: the worker was interrupted. Release the task for someone else.
        db.swarm.taskUpdate(t.id, { status: "pending", agent_id: null, auto_closed: false });
        db.swarm.eventAdd({
          run_id: t.run_id,
          kind: "auto_close",
          role: worker.role,
          agent_id: worker.agent_id,
          task_id: t.id,
          text: "released back to pending: the worker stopped without a final message",
        });
      }
      closed.push(db.swarm.taskGet(t.id)!);
    }
    db.swarm.workerUpdate(worker.run_id, worker.agent_id, {
      status: "done",
      ended_at: now,
      task_id: null,
      summary: message ? clip(message, 2000) : null,
    });
    db.swarm.eventAdd({
      run_id: worker.run_id,
      kind: "stop",
      role: worker.role,
      agent_id: worker.agent_id,
      text: message ? clip(firstLine(message), 200) : "stopped without a final message",
    });
    db.swarm.runTouch(worker.run_id);
    closeIdleAdhoc(db, worker.run_id, now);
    return {
      run: db.swarm.runGet(worker.run_id)!,
      worker: db.swarm.workerGet(worker.run_id, worker.agent_id)!,
      closed,
    };
  });
}

/**
 * An ad-hoc run (opened for a worker spawned outside `em_swarm start`) closes itself once
 * its last worker stopped and no task is left open, so it does not linger as "active".
 */
function closeIdleAdhoc(db: StorageAdapter, runId: string, now: number): void {
  const run = db.swarm.runGet(runId);
  if (run?.status !== "active" || !run.goal.startsWith("(ad hoc)")) return;
  if (db.swarm.workers(runId).some((w) => w.status === "running")) return;
  if (db.swarm.tasks(runId).some((t) => t.status === "pending" || t.status === "active")) return;
  db.swarm.runUpdate(runId, {
    status: "done",
    ended_at: now,
    summary: "ad-hoc run closed after its last worker stopped",
  });
  db.swarm.eventAdd({
    run_id: runId,
    kind: "run_finish",
    role: COORDINATOR,
    text: "done: closed after its last worker stopped",
  });
}

/** Mark workers done and release the tasks they hold back to pending. */
function stopWorkers(
  db: StorageAdapter,
  workers: WorkerRow[],
  why: string,
  now: number,
): WorkerRow[] {
  for (const w of workers) {
    for (const t of db.swarm.tasksHeldBy(w.agent_id)) {
      db.swarm.taskUpdate(t.id, { status: "pending", agent_id: null, auto_closed: false });
      db.swarm.eventAdd({
        run_id: t.run_id,
        kind: "auto_close",
        role: w.role,
        agent_id: w.agent_id,
        task_id: t.id,
        text: `released back to pending: ${why}`,
      });
    }
    db.swarm.workerUpdate(w.run_id, w.agent_id, { status: "done", ended_at: now, task_id: null });
    db.swarm.eventAdd({
      run_id: w.run_id,
      kind: "stop",
      role: w.role,
      agent_id: w.agent_id,
      text: why,
    });
    db.swarm.runTouch(w.run_id);
  }
  return workers;
}

/**
 * SessionEnd: subagents do not outlive their session, so its workers that never got
 * SubagentStop (killed, interrupted) are closed and their tasks released.
 */
export function closeSessionWorkers(db: StorageAdapter, sessionId: string | undefined): number {
  if (!sessionId) return 0;
  return db.swarm.immediate(() => {
    const now = Date.now();
    const ws = db.swarm.workersOfSession(sessionId);
    stopWorkers(db, ws, "its Claude Code session ended", now);
    for (const runId of new Set(ws.map((w) => w.run_id))) closeIdleAdhoc(db, runId, now);
    return ws.length;
  });
}

/**
 * Coordinator: free workers that are stuck (no SubagentStop came). Matches one worker by
 * agent id (a prefix is enough), all running workers of a role, or every quiet worker of
 * the run. Their tasks go back to pending.
 */
export function releaseWorkers(
  db: StorageAdapter,
  run: RunRow,
  caller: Caller,
  opts: { agent?: string | undefined; role?: string | undefined },
): WorkerRow[] {
  if (!isCoordinator(caller))
    throw new SwarmError("only the coordinator (the main session) can release workers");
  const now = Date.now();
  return db.swarm.immediate(() => {
    const running = db.swarm.workers(run.id).filter((w) => w.status === "running");
    const agent = opts.agent?.trim().replace(/^agent-/, "");
    const pick = agent
      ? running.filter((w) => w.agent_id.replace(/^agent-/, "").startsWith(agent))
      : opts.role
        ? running.filter((w) => w.role === opts.role)
        : running.filter((w) => now - w.last_ts >= STALE_MS);
    if (agent && pick.length > 1)
      throw new SwarmError(
        `"${opts.agent}" matches ${pick.length} workers (${pick.map((w) => w.agent_id).join(", ")}); give more of the id`,
      );
    return stopWorkers(db, pick, "released by the coordinator", now);
  });
}

// --- snapshots ----------------------------------------------------------------------------

export interface WorkerView extends Omit<WorkerRow, "status"> {
  status: WorkerStatus;
}

export interface RunSnapshot {
  run: RunRow;
  tasks: TaskRow[];
  workers: WorkerView[];
  /** Holders of this run's active tasks that are registered in another run. */
  holders: WorkerView[];
  notes: NoteRow[];
  events: SwarmEventRow[];
  counts: {
    tasks: Record<TaskStatus, number>;
    workers: Record<WorkerStatus, number>;
    toolCalls: number;
    errors: number;
    autoClosed: number;
    /** Active tasks held by a worker that went quiet or stopped. */
    staleHeld: number;
  };
}

export function workerStatus(
  w: Pick<WorkerRow, "last_ts"> & { status: string },
  now = Date.now(),
): WorkerStatus {
  if (w.status === "done") return "done";
  return now - w.last_ts >= STALE_MS ? "stale" : "running";
}

export function runSnapshot(db: StorageAdapter, run: RunRow, events = 40): RunSnapshot {
  const now = Date.now();
  const tasks = db.swarm.tasks(run.id);
  const workers = db.swarm
    .workers(run.id)
    .map((w): WorkerView => ({ ...w, status: workerStatus(w, now) }));
  const taskCounts: Record<TaskStatus, number> = {
    pending: 0,
    active: 0,
    done: 0,
    failed: 0,
    blocked: 0,
  };
  for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
  const workerCounts: Record<WorkerStatus, number> = { running: 0, done: 0, stale: 0 };
  for (const w of workers) workerCounts[w.status]++;
  const mine = new Set(workers.map((w) => w.agent_id));
  const holders: WorkerView[] = [];
  for (const t of tasks) {
    if (t.status !== "active" || !t.agent_id || mine.has(t.agent_id) || t.agent_id === COORDINATOR)
      continue;
    const w = db.swarm.workerFind(t.agent_id);
    if (w && !holders.some((h) => h.agent_id === w.agent_id))
      holders.push({ ...w, status: workerStatus(w, now) });
  }
  return {
    run,
    tasks,
    workers,
    holders,
    notes: db.swarm.notes(run.id),
    events: events > 0 ? db.swarm.events(run.id, { limit: events }) : [],
    counts: {
      tasks: taskCounts,
      workers: workerCounts,
      toolCalls: workers.reduce((n, w) => n + w.tool_calls, 0),
      errors: workers.reduce((n, w) => n + w.errors, 0),
      autoClosed: tasks.filter((t) => t.auto_closed).length,
      staleHeld: staleHeld(db, run, tasks, now).length,
    },
  };
}
