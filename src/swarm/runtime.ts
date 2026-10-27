import { randomBytes } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { ProjectContext } from "../context.js";
import { slugify, write as writeMemory } from "../memory/store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { findRole, findSwarm } from "./config.js";
import type {
  NoteRow,
  RoleSpec,
  RunRow,
  RunStatus,
  SwarmConfig,
  SwarmEventRow,
  SwarmSpec,
  TaskRow,
  TaskStatus,
  WorkerRow,
  WorkerStatus,
} from "./types.js";

/** A running worker silent for this long no longer counts against capacity. */
export const STALE_MS = 30 * 60_000;
/** A spawn reservation counts against capacity this long before SubagentStart consumes it. */
export const SPAWN_TTL_MS = 2 * 60_000;
/** SubagentStart may match a reservation this old (slow starts, permission prompts). */
const SPAWN_MATCH_MS = 10 * 60_000;

const TITLE_MAX = 200;
const DETAIL_MAX = 4000;
const RESULT_MAX = 4000;
const NOTE_MAX = 8000;
const GOAL_MAX = 2000;
const PLAN_MAX = 50;
export const NOTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
/** `task #12` in a spawn prompt hands that task to the new worker. */
const TASK_REF_RE = /\btask\s*#\s*(\d{1,9})\b/i;

/** A user-facing failure (bad input, wrong state); tools render the message as is. */
export class SwarmError extends Error {}

export function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

export function newRunId(now = new Date()): string {
  return `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
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

const isCoordinator = (c: Caller) => c.label === COORDINATOR && !c.agentId;
/** Who holds a task: the worker's agent id, or the label when the coordinator works it. */
const holderOf = (c: Caller) => c.agentId ?? c.label;
/** How the blackboard and the feed name a caller: `coder@a1b2c3` or `coordinator`. */
export function authorOf(c: Caller): string {
  return c.agentId ? `${c.label}@${c.agentId.replace(/^agent-/, "").slice(0, 8)}` : c.label;
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

/** Re-read the run: another process (the coordinator, a hook) may have closed it since. */
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

/** Normalise a file path to project-relative with forward slashes. */
export function relPath(root: string, p: string): string {
  const s = p.trim().replace(/\\/g, "/");
  if (!isAbsolute(s)) return s.replace(/^\.\//, "");
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
  requireActive(db, run);
  if (!input.length) throw new SwarmError("tasks is empty: give at least one {title}");
  if (input.length > PLAN_MAX)
    throw new SwarmError(`too many tasks in one call (${input.length} > ${PLAN_MAX})`);
  const roles = new Set(swarm.roles.map((r) => r.role));
  const keys = new Map<string, number>();
  return db.swarm.immediate(() => {
    const existing = new Set(db.swarm.tasks(run.id).map((t) => t.id));
    const out: TaskRow[] = [];
    input.forEach((t, i) => {
      const at = `tasks[${i}]`;
      const title = (t.title ?? "").trim();
      if (!title) throw new SwarmError(`${at}.title is required`);
      if (title.length > TITLE_MAX)
        throw new SwarmError(`${at}.title is too long (max ${TITLE_MAX} characters)`);
      if ((t.detail?.length ?? 0) > DETAIL_MAX)
        throw new SwarmError(`${at}.detail is too long (max ${DETAIL_MAX} characters)`);
      const role = t.role?.trim() || null;
      if (role && !roles.has(role))
        throw new SwarmError(
          `${at}.role "${role}" is not a role of swarm "${swarm.name}" (${[...roles].join(", ")})`,
        );
      const deps: number[] = [];
      for (const d of t.deps ?? []) {
        const id =
          typeof d === "number"
            ? d
            : /^#?\d+$/.test(d.trim())
              ? Number(d.trim().replace("#", ""))
              : keys.get(d.trim());
        if (id === undefined)
          throw new SwarmError(
            `${at}.deps: "${d}" is neither a task id of this run nor the key of an earlier task in this call`,
          );
        if (!existing.has(id))
          throw new SwarmError(`${at}.deps: task #${id} is not in run ${run.id}`);
        if (!deps.includes(id)) deps.push(id);
      }
      const files = [...new Set((t.files ?? []).map((f) => relPath(ctx.root, f)).filter(Boolean))];
      if (files.length > 50) throw new SwarmError(`${at}.files: at most 50 files per task`);
      const row = db.swarm.taskAdd({
        run_id: run.id,
        title,
        detail: t.detail?.trim() || null,
        role,
        deps,
        files,
        created_by: authorOf(caller),
      });
      existing.add(row.id);
      const key = t.key?.trim();
      if (key) {
        if (keys.has(key)) throw new SwarmError(`${at}.key "${key}" is used twice in this call`);
        keys.set(key, row.id);
      }
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
): { ok: boolean; why?: string } {
  if (task.status !== "pending") return { ok: false, why: `it is ${task.status}` };
  const byId = new Map(all.map((t) => [t.id, t]));
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
      if (open.length)
        return {
          ok: false,
          why: `earlier stages are unfinished (${open
            .slice(0, 4)
            .map((t) => `#${t.id} ${t.role}`)
            .join(", ")})`,
        };
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
  requireActive(db, run);
  const holder = holderOf(caller);
  const role = caller.role?.role;
  return db.swarm.immediate(() => {
    const all = db.swarm.tasks(run.id);
    const mine = all.find((t) => t.status === "active" && t.agent_id === holder);
    let pick: TaskRow | undefined;
    if (taskId !== undefined) {
      const t = all.find((x) => x.id === taskId);
      if (!t) throw new SwarmError(`task #${taskId} is not in run ${run.id}`);
      if (t.status === "active" && t.agent_id === holder) return { task: t, already: true };
      const e = eligibility(t, all, swarm, role);
      if (!e.ok) throw new SwarmError(`cannot claim task #${taskId}: ${e.why}`);
      pick = t;
    } else {
      if (mine) return { task: mine, already: true };
      const open = all.filter((t) => eligibility(t, all, swarm, role).ok);
      pick = open.find((t) => role && t.role === role) ?? open[0];
      if (!pick) return { reason: nothingToClaim(all, swarm, role) };
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

function nothingToClaim(all: TaskRow[], swarm: SwarmSpec, role: string | undefined): string {
  const pending = all.filter((t) => t.status === "pending");
  if (!pending.length) {
    const active = all.filter((t) => t.status === "active").length;
    return all.length
      ? `no pending tasks (${active} active, ${all.length - active} closed)`
      : 'the run has no tasks yet; the coordinator adds them with em_swarm {action:"plan"}';
  }
  const why = pending
    .slice(0, 5)
    .map((t) => `#${t.id}: ${eligibility(t, all, swarm, role).why}`)
    .join("; ");
  return `${pending.length} pending task(s), none claimable now: ${why}`;
}

const SETTABLE: TaskStatus[] = ["pending", "done", "failed", "blocked"];

export function updateTask(
  db: StorageAdapter,
  run: RunRow,
  caller: Caller,
  opts: { task: number; status: TaskStatus; result?: string | undefined },
): TaskRow {
  requireActive(db, run);
  if (!SETTABLE.includes(opts.status))
    throw new SwarmError(
      `status must be one of ${SETTABLE.join(", ")} (claim a task to make it active)`,
    );
  return db.swarm.immediate(() => {
    const t = db.swarm.taskGet(opts.task);
    if (!t || t.run_id !== run.id)
      throw new SwarmError(`task #${opts.task} is not in run ${run.id}`);
    const holder = holderOf(caller);
    const coordinator = isCoordinator(caller);
    if (!coordinator && t.agent_id && t.agent_id !== holder)
      throw new SwarmError(
        `task #${t.id} is held by another worker; only that worker or the coordinator can update it`,
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
  requireActive(db, run);
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
}

// --- finish -------------------------------------------------------------------------------

const FINISH: RunStatus[] = ["done", "failed", "cancelled"];

export function finishRun(
  ctx: ProjectContext,
  db: StorageAdapter,
  run: RunRow,
  caller: Caller,
  opts: { status: RunStatus; summary?: string | undefined; remember?: boolean | undefined },
): { run: RunRow; memory?: string | undefined } {
  if (!isCoordinator(caller))
    throw new SwarmError("only the coordinator (the main session) can finish a run");
  requireActive(db, run);
  if (!FINISH.includes(opts.status))
    throw new SwarmError(`status must be one of ${FINISH.join(", ")}`);
  const summary = opts.summary?.trim() ? clip(opts.summary, RESULT_MAX) : null;
  const now = Date.now();
  db.swarm.immediate(() => {
    db.swarm.runUpdate(run.id, { status: opts.status, summary, ended_at: now });
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "run_finish",
      role: COORDINATOR,
      text: `${opts.status}${summary ? `: ${firstLine(summary).slice(0, 160)}` : ""}`,
    });
  });
  const closed = db.swarm.runGet(run.id)!;
  if (!opts.remember) return { run: closed };
  return { run: closed, memory: rememberRun(ctx, db, closed) };
}

/** Write the run's outcome as an eminiar memory (`swarm/run-<date>-<slug>`). */
function rememberRun(ctx: ProjectContext, db: StorageAdapter, run: RunRow): string {
  const tasks = db.swarm.tasks(run.id);
  const workers = db.swarm.workers(run.id);
  const date = new Date(run.created_at).toISOString().slice(0, 10);
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
  const base = `swarm/run-${date}-${slugify(run.goal, 32) || run.swarm}`;
  const name = db.memoryGetByName(base) ? `${base}-${run.id.slice(-6)}` : base;
  const r = writeMemory(ctx, db, {
    name,
    kind: "note",
    content: lines.join("\n"),
    tags: ["swarm", run.swarm],
    related: [...new Set(tasks.flatMap((t) => t.files))].slice(0, 20),
  });
  return r.name;
}

// --- hook side ----------------------------------------------------------------------------

export type SpawnDecision =
  | {
      decision: "allow";
      run: RunRow;
      role: RoleSpec;
      swarm: SwarmSpec;
      taskId?: number | undefined;
    }
  | { decision: "deny"; reason: string };

/** The task a spawn prompt hands over (`task #12`), if any. */
export function taskRef(prompt: string | undefined): number | undefined {
  const m = prompt ? TASK_REF_RE.exec(prompt) : null;
  return m ? Number(m[1]) : undefined;
}

const isLive = (w: WorkerRow, now: number) => w.status === "running" && now - w.last_ts < STALE_MS;

/**
 * PreToolUse on Agent for a swarm agent: check capacity and reserve a slot, atomically
 * across hook processes. Returns undefined for agent types that are not swarm workers.
 */
export function reserveSpawn(
  db: StorageAdapter,
  config: SwarmConfig,
  opts: {
    agentType: string;
    prompt?: string | undefined;
    description?: string | undefined;
    sessionId?: string | undefined;
  },
): SpawnDecision | undefined {
  const hit = findRole(config, opts.agentType);
  if (!hit) return undefined;
  const { swarm, role } = hit;
  return db.swarm.immediate(() => {
    const now = Date.now();
    const run =
      db.swarm.runActive(swarm.name, opts.sessionId) ??
      adhocRun(db, swarm, opts.sessionId, opts.description ?? firstLine(opts.prompt ?? ""));
    const live = db.swarm.workers(run.id).filter((w) => isLive(w, now));
    const since = now - SPAWN_TTL_MS;
    const starting = db.swarm.spawnsPending(run.id, since);
    const roleBusy =
      live.filter((w) => w.role === role.role).length +
      db.swarm.spawnsPending(run.id, since, role.agentType);
    let reason: string | undefined;
    if (live.length + starting >= swarm.maxAgents)
      reason = `swarm "${swarm.name}" is at capacity: ${live.length} worker(s) running and ${starting} starting, max_agents is ${swarm.maxAgents} (run ${run.id}). Wait for a worker to finish (em_swarm {action:"status"}) or raise max_agents in ${config.rel}.`;
    else if (roleBusy >= role.count)
      reason = `role "${role.role}" of swarm "${swarm.name}" already has ${roleBusy} worker(s) running or starting and its count is ${role.count}. Wait for one to finish or raise count in ${config.rel}.`;
    if (reason) {
      db.swarm.eventAdd({ run_id: run.id, kind: "deny", role: role.role, text: reason });
      return { decision: "deny" as const, reason };
    }
    const ref = taskRef(opts.prompt);
    const taskId = ref !== undefined && db.swarm.taskGet(ref)?.run_id === run.id ? ref : undefined;
    db.swarm.spawnAdd({
      run_id: run.id,
      session_id: opts.sessionId,
      agent_type: role.agentType,
      prompt: opts.prompt ? clip(opts.prompt, 4000) : null,
      task_id: taskId,
    });
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "spawn",
      role: role.role,
      task_id: taskId,
      text: clip(opts.description || firstLine(opts.prompt ?? "") || role.agentType, 160),
    });
    db.swarm.runTouch(run.id);
    return { decision: "allow" as const, run, role, swarm, taskId };
  });
}

export interface WorkerStart {
  run: RunRow;
  swarm: SwarmSpec;
  role: RoleSpec;
  worker: WorkerRow;
  task?: TaskRow | undefined;
  /** Why the task named in the spawn prompt was not handed over. */
  handoffNote?: string | undefined;
  prompt?: string | undefined;
}

/**
 * SubagentStart (or the first sign of a worker that missed it): register the worker in its
 * run and hand over the task named in its spawn prompt. Undefined for non-swarm agents.
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
    const spawn = db.swarm.spawnTake(role.agentType, now - SPAWN_MATCH_MS, opts.sessionId);
    const prior = db.swarm.workerFind(opts.agentId);
    const candidates = [spawn?.run_id, prior?.run_id]
      .map((id) => (id ? db.swarm.runGet(id) : undefined))
      .filter((r): r is RunRow => !!r && r.status === "active" && r.swarm === swarm.name);
    const run =
      candidates[0] ??
      db.swarm.runActive(swarm.name, opts.sessionId) ??
      adhocRun(db, swarm, opts.sessionId, firstLine(spawn?.prompt ?? ""));
    const worker = db.swarm.workerUpsert({
      run_id: run.id,
      agent_id: opts.agentId,
      agent_type: role.agentType,
      role: role.role,
      session_id: opts.sessionId,
      prompt: spawn?.prompt ?? null,
    });
    db.swarm.eventAdd({
      run_id: run.id,
      kind: "start",
      role: role.role,
      agent_id: opts.agentId,
      text: spawn?.prompt ? clip(firstLine(spawn.prompt), 160) : "worker started",
    });
    let task: TaskRow | undefined;
    let handoffNote: string | undefined;
    const ref = spawn?.task_id ?? taskRef(spawn?.prompt ?? undefined);
    if (ref !== undefined) {
      const t = db.swarm.taskGet(ref);
      if (!t || t.run_id !== run.id) handoffNote = `task #${ref} is not in run ${run.id}`;
      else if (t.status === "active" && t.agent_id === opts.agentId) task = t;
      else if (t.status !== "pending")
        handoffNote = `task #${ref} is ${t.status}${t.agent_id ? " (held by another worker)" : ""}`;
      else if (db.swarm.taskClaim(t.id, opts.agentId)) {
        task = db.swarm.taskGet(t.id);
        db.swarm.workerUpdate(run.id, opts.agentId, { task_id: t.id });
        db.swarm.eventAdd({
          run_id: run.id,
          kind: "claim",
          role: role.role,
          agent_id: opts.agentId,
          task_id: t.id,
          text: `${t.title} (handed over at spawn)`,
        });
      }
    }
    db.swarm.runTouch(run.id);
    return {
      run,
      swarm,
      role,
      worker: db.swarm.workerGet(run.id, opts.agentId) ?? worker,
      task,
      handoffNote,
      prompt: spawn?.prompt ?? undefined,
    };
  });
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

/** PostToolUse / PostToolUseFailure inside a swarm worker. */
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
    // SubagentStart was missed (older hooks.json, opted in mid-run): register now. A worker
    // that outlives its finished run keeps logging to that run rather than opening another.
    const started = registerWorker(db, config, opts);
    if (!started) return;
    w = started.worker;
  }
  db.swarm.workerTouch(w.run_id, w.agent_id, opts.tool.replace(/^mcp__.*__/, ""), !!opts.failed);
  const io = toolIo(opts.tool);
  // em_swarm calls already leave claim/post/update events; a tool line would repeat them.
  if (io === "swarm" && !opts.failed) return;
  db.swarm.eventAdd({
    run_id: w.run_id,
    kind: opts.failed ? "tool_error" : "tool",
    role: w.role,
    agent_id: w.agent_id,
    task_id: w.task_id,
    text: `${toolHead(root, opts.tool, opts.input)}${opts.failed && opts.error ? ` ✗ ${clip(firstLine(opts.error), 120)}` : ""}`,
    payload: { tool: opts.tool.replace(/^mcp__.*__/, ""), io },
  });
}

/** SubagentStop for a swarm worker: close it and settle the task it still holds. */
export function closeWorker(
  db: StorageAdapter,
  config: SwarmConfig,
  opts: {
    agentId: string;
    agentType: string;
    sessionId?: string | undefined;
    message?: string | undefined;
  },
): { run: RunRow; worker: WorkerRow; closed: TaskRow[] } | undefined {
  let w = db.swarm.workerFind(opts.agentId);
  if (!w) {
    const started = registerWorker(db, config, opts);
    if (!started) return undefined;
    w = started.worker;
  }
  const worker = w;
  const message = opts.message?.trim() ?? "";
  return db.swarm.immediate(() => {
    const now = Date.now();
    const closed: TaskRow[] = [];
    for (const t of db.swarm.tasks(worker.run_id)) {
      if (t.status !== "active" || t.agent_id !== worker.agent_id) continue;
      if (message) {
        db.swarm.taskUpdate(t.id, {
          status: "done",
          result: clip(message, RESULT_MAX),
          auto_closed: true,
        });
        db.swarm.eventAdd({
          run_id: worker.run_id,
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
          run_id: worker.run_id,
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
    return {
      run: db.swarm.runGet(worker.run_id)!,
      worker: db.swarm.workerGet(worker.run_id, worker.agent_id)!,
      closed,
    };
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
  notes: NoteRow[];
  events: SwarmEventRow[];
  counts: {
    tasks: Record<TaskStatus, number>;
    workers: Record<WorkerStatus, number>;
    toolCalls: number;
    errors: number;
    autoClosed: number;
  };
}

export function workerStatus(w: WorkerRow, now = Date.now()): WorkerStatus {
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
  return {
    run,
    tasks,
    workers,
    notes: db.swarm.notes(run.id),
    events: db.swarm.events(run.id, { limit: events }),
    counts: {
      tasks: taskCounts,
      workers: workerCounts,
      toolCalls: workers.reduce((n, w) => n + w.tool_calls, 0),
      errors: workers.reduce((n, w) => n + w.errors, 0),
      autoClosed: tasks.filter((t) => t.auto_closed).length,
    },
  };
}
