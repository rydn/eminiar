import { z } from "zod";
import { getContext, type ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { planAgentSync, syncAgents } from "../swarm/agents.js";
import { coordinatorBrief, taskBrief } from "../swarm/brief.js";
import { findSwarm, loadSwarmConfig } from "../swarm/config.js";
import {
  capOutput,
  formatDisabled,
  formatInvalid,
  formatNote,
  formatNotes,
  formatNotOptedIn,
  formatReleased,
  formatRunList,
  formatRunStatus,
  formatSwarmList,
  formatSync,
  type RunListItem,
  runListItem,
  runRef,
} from "../swarm/format.js";
import { coordinationRoot } from "../swarm/hooks.js";
import { verifyCaller } from "../swarm/identity.js";
import {
  addTasks,
  type Caller,
  COORDINATOR,
  callerOf,
  claimTask,
  clip,
  eligibility,
  finishRun,
  isCoordinator,
  isWorker,
  postNote,
  releaseWorkers,
  resolveRun,
  runSnapshot,
  STALE_MS,
  SwarmError,
  startRun,
  updateTask,
  workerStatus,
} from "../swarm/runtime.js";
import type { RunRow, SwarmConfig, SwarmSpec, TaskRow } from "../swarm/types.js";
import { defineTool, errorResult, text } from "./types.js";

export const SWARM_ACTIONS = [
  "list",
  "start",
  "plan",
  "claim",
  "update",
  "post",
  "read",
  "status",
  "finish",
  "release",
  "sync",
] as const;

type Action = (typeof SWARM_ACTIONS)[number];

const TaskId = z.union([z.number().int().positive(), z.string()]);

/** The keys a planned task takes; anything else is refused instead of silently dropped. */
const PLAN_KEYS = ["key", "title", "detail", "role", "deps", "files"] as const;

// Loose, so unknown keys reach the handler and come back as an error naming them.
const PlanTask = z.looseObject({
  key: z.string().optional().describe("label that later tasks of this call can name in deps"),
  title: z.string(),
  detail: z.string().optional(),
  role: z.string().optional().describe("role that should do it (omit: anyone)"),
  deps: z
    .array(z.union([z.number().int(), z.string()]))
    .optional()
    .describe("task ids of this run, or keys of earlier tasks in this call"),
  files: z.array(z.string()).optional().describe("files the task touches"),
});

const HOOK_FIELD = "set by eminiar's hook; leave empty";

const schema = {
  action: z.enum(SWARM_ACTIONS),
  swarm: z.string().optional().describe("start/list: swarm name"),
  goal: z.string().optional().describe("start: what the run should achieve"),
  run: z
    .string()
    .optional()
    .describe("run id (default: this session's only active run; needed when several are active)"),
  tasks: z.array(PlanTask).max(50).optional().describe("plan: tasks to add"),
  task: TaskId.optional().describe("claim (optional) / update: task id"),
  status: z
    .enum(["pending", "done", "failed", "blocked", "cancelled"])
    .optional()
    .describe("update: done|failed|blocked|pending (reopen); finish: done|failed|cancelled"),
  result: z.string().optional().describe("update: what changed and how it was verified"),
  key: z.string().optional().describe("post/read: blackboard key"),
  value: z.string().optional().describe("post: the note"),
  summary: z.string().optional().describe("finish: the outcome"),
  remember: z.boolean().optional().describe("finish: keep the outcome as an eminiar memory"),
  agent: z.string().optional().describe("release: worker agent id (a prefix is enough)"),
  role: z.string().optional().describe("release: every running worker of this role"),
  force: z
    .boolean()
    .optional()
    .describe("sync: also overwrite generated agent files that were edited by hand"),
  caller_kind: z.string().optional().describe(HOOK_FIELD),
  caller_agent_id: z.string().optional().describe(HOOK_FIELD),
  caller_agent_type: z.string().optional().describe(HOOK_FIELD),
  caller_session_id: z.string().optional().describe(HOOK_FIELD),
  caller_sig: z.string().optional().describe(HOOK_FIELD),
};

type Args = z.infer<z.ZodObject<typeof schema>>;

export const emSwarm = defineTool({
  name: "em_swarm",
  description:
    'Agent swarms, opt-in via .eminiar/swarm.yaml. The coordinator (main session): start {swarm, goal} → plan {tasks} → spawn workers with the Agent tool (subagent_type swarm-<swarm>-<role>, a prompt naming "task #N"; the worker claims it) → status → finish {status, summary, remember}; release frees stuck workers. Workers: claim, update {task, status, result}, plan, post/read the blackboard. The em-swarm skill has the playbook.',
  schema,
  handler: async (args, ctx) => {
    try {
      return text(await dispatch(args, ctx));
    } catch (err) {
      if (err instanceof SwarmError) return text(`em_swarm: ${err.message}`);
      return errorResult(`em_swarm ${args.action} failed: ${(err as Error).message}`);
    }
  },
});

// --- who may do what ----------------------------------------------------------------------

/** Workers: everything about tasks and notes, in any topology; never the run itself. */
const WORKER_OK = new Set<Action>(["list", "status", "read", "post", "plan", "claim", "update"]);
/** Subagents that are not swarm workers (Explore, general-purpose, …). */
const FOREIGN_OK = new Set<Action>(["list", "status", "read", "post"]);
/** Calls eminiar's hook did not stamp: nobody can tell who made them. */
const UNVERIFIED_OK = new Set<Action>(["list", "status", "read"]);
const COORDINATOR_ONLY: Partial<Record<Action, string>> = {
  start: "start runs",
  finish: "finish runs",
  release: "release workers",
  sync: "sync agent files",
};

function unstampedNote(why: string): string {
  return `Note: this call was not stamped by eminiar's PreToolUse hook (${why}), so changes (start, plan, claim, update, post, finish, release, sync) are refused. Run \`eminiar upgrade\` (or \`eminiar install\`) and check /hooks.`;
}

interface Who {
  caller: Caller;
  sessionId?: string | undefined;
  /** Why the call is unverified; undefined when the hook's stamp checked out. */
  unverified?: string | undefined;
}

function identify(args: Args, config: SwarmConfig | undefined): Who {
  const v = verifyCaller(args as Record<string, unknown>);
  if (!v.verified) return { caller: { label: "unverified caller" }, unverified: v.why };
  if (v.kind === "main") return { caller: { label: COORDINATOR }, sessionId: v.sessionId };
  const ids = { agentId: v.agentId, agentType: v.agentType };
  const caller: Caller = config
    ? callerOf(config, ids)
    : { label: v.agentType || "subagent", ...ids };
  return { caller, sessionId: v.sessionId };
}

function unstamped(action: Action, why: string): SwarmError {
  return new SwarmError(
    `${action} was refused because ${why}. Without that signed stamp em_swarm cannot tell the coordinator from a worker, so only list, status and read work. eminiar's PreToolUse hook stamps every em_swarm call and did not stamp this one: hooks are disabled, the hook timed out, or the settings were installed by an eminiar older than 0.12, whose hook entries do not cover em_swarm. Run \`eminiar upgrade\` (or \`eminiar install\`), check /hooks, then retry.`,
  );
}

/** Throw unless `who` may run `action`. */
function authorize(action: Action, who: Who): void {
  if (who.unverified !== undefined) {
    if (!UNVERIFIED_OK.has(action)) throw unstamped(action, who.unverified);
    return;
  }
  const c = who.caller;
  if (isCoordinator(c)) return;
  if (isWorker(c)) {
    if (!WORKER_OK.has(action))
      throw new SwarmError(
        `only the coordinator (the main session) can ${COORDINATOR_ONLY[action] ?? action}; a worker claims, updates and plans tasks of its run and shares notes with post`,
      );
    return;
  }
  if (!FOREIGN_OK.has(action))
    throw new SwarmError(
      `${c.label} is not a worker of a swarm, so it cannot ${action}; it may list, status, read and post. Swarm workers are spawned with subagent_type swarm-<swarm>-<role>.`,
    );
}

// --- helpers -------------------------------------------------------------------------------

function taskNumber(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const m = /^\s*(?:task\s*)?#?\s*(\d{1,9})\s*$/i.exec(v);
  if (!m) throw new SwarmError(`task must be a task id such as 3 or "#3", not "${v}"`);
  return Number(m[1]);
}

/** A sentence that may already end with a period, ended with exactly one. */
const sentence = (s: string) => `${s.trim().replace(/\.+$/, "")}.`;

function noRun(config: SwarmConfig, swarm: string | undefined): never {
  throw new SwarmError(
    `no active run${swarm ? ` of swarm "${swarm}"` : ""}; the coordinator starts one with em_swarm {action:"start", swarm, goal} (swarms: ${config.swarms
      .map((s) => s.name)
      .join(", ")})`,
  );
}

function sameSwarm(run: RunRow, caller: Caller): void {
  if (caller.swarm && caller.swarm.name !== run.swarm)
    throw new SwarmError(
      `you are a worker of swarm "${caller.swarm.name}", but run ${run.id} belongs to swarm "${run.swarm}"`,
    );
}

function swarmOf(config: SwarmConfig, run: RunRow, caller: Caller): SwarmSpec {
  sameSwarm(run, caller);
  const swarm = findSwarm(config, run.swarm);
  if (!swarm)
    throw new SwarmError(
      `run ${run.id} belongs to swarm "${run.swarm}", which ${config.rel} no longer defines`,
    );
  return swarm;
}

function listItems(db: StorageAdapter, runs: RunRow[]): RunListItem[] {
  const now = Date.now();
  return runs.map((r) =>
    runListItem(
      r,
      db.swarm.tasks(r.id),
      db.swarm.workers(r.id).map((w) => ({ ...w, status: workerStatus(w, now) })),
    ),
  );
}

const listRuns = (runs: RunRow[], n = 8) =>
  `${runs.slice(0, n).map(runRef).join("; ")}${runs.length > n ? "; …" : ""}`;

/** Active runs, of `swarm` when given, that belong to this session (all of them without one). */
function activeRuns(
  db: StorageAdapter,
  swarm: string | undefined,
  sessionId: string | undefined,
): { mine: RunRow[]; others: RunRow[] } {
  const all = db.swarm.runs({ status: "active", swarm, limit: 500 });
  if (!sessionId) return { mine: all, others: [] };
  return {
    mine: all.filter((r) => r.session_id === sessionId),
    others: all.filter((r) => r.session_id !== sessionId),
  };
}

/** Prefix a runtime message with the run it is about when it does not name it already. */
function inRun(err: unknown, run: RunRow, task: number): never {
  if (err instanceof SwarmError && !err.message.includes(run.id))
    throw new SwarmError(
      `${err.message} (task #${task} is in run ${run.id}, swarm "${run.swarm}")`,
    );
  throw err;
}

function planned(
  db: StorageAdapter,
  rows: TaskRow[],
  swarm: SwarmSpec,
  run: RunRow,
  caller: Caller,
): string {
  const all = db.swarm.tasks(run.id);
  const byId = new Map(all.map((t) => [t.id, t]));
  const claimable = rows.filter((t) => eligibility(t, all, swarm, t.role ?? undefined, byId).ok);
  const agentOf = new Map(swarm.roles.map((r) => [r.role, r.agentType]));
  const used = [...new Set(rows.map((t) => t.role).filter((r): r is string => !!r))];
  const types = (used.length ? used : swarm.roles.map((r) => r.role))
    .map((r) => `${r} → ${agentOf.get(r)}`)
    .join(", ");
  const head = `Planned ${rows.length} task(s) in run ${run.id}; ${
    claimable.length
      ? `claimable now: ${claimable.map((t) => `#${t.id}`).join(", ")}`
      : "none is claimable yet (they wait on deps or earlier stages)"
  }.`;
  const next = isCoordinator(caller)
    ? `Next: spawn one worker per claimable task with the Agent tool: subagent_type ${types}${
        rows.some((t) => !t.role) ? " (a task without a role fits any)" : ""
      }, and a prompt that names "task #N" (the worker claims it); run_in_background: true runs them in parallel. Watch with em_swarm {action:"status"}.`
    : "Next: the coordinator spawns workers for these; name the new task ids in your final message.";
  return capOutput(
    [
      head,
      next,
      ...rows.map((t) => `#${t.id} ${clip(t.title, 120)}${t.role ? ` (${t.role})` : ""}`),
    ].join("\n"),
  );
}

// --- dispatch ------------------------------------------------------------------------------

async function dispatch(args: Args, callerCtx: ProjectContext): Promise<string> {
  // Isolated workers run in git worktrees; the ledger, the swarm file and the generated
  // agents belong to the main checkout, exactly as the hooks resolve them.
  const root = coordinationRoot(callerCtx.root);
  const ctx = root === callerCtx.root ? callerCtx : getContext(root);
  const loaded = loadSwarmConfig(ctx.root);
  if (loaded.state === "invalid") return formatInvalid(loaded.rel, loaded.issues);
  if (args.action === "sync") {
    const config = loaded.state === "ok" ? loaded.config : undefined;
    authorize("sync", identify(args, config));
    // With no file, or enabled: false, sync removes the generated agent files.
    const opts: { dryRun?: boolean; force?: boolean } = { dryRun: false, force: !!args.force };
    const r = syncAgents(ctx.root, config, opts);
    const reason =
      loaded.state === "absent"
        ? `no ${loaded.rel}: swarms are off`
        : config?.enabled
          ? undefined
          : "swarms are disabled";
    return formatSync(r, { reason });
  }
  if (loaded.state === "absent") return formatNotOptedIn(loaded.rel);
  const config = loaded.config;
  if (!config.enabled) return formatDisabled(config.rel);

  const db = getStorage(ctx);
  const who = identify(args, config);
  authorize(args.action, who);
  const { caller, sessionId } = who;
  const coordinator = isCoordinator(caller);

  /** Reads: the named run, a worker's own run, else the newest active one (this session first). */
  const readRun = () =>
    resolveRun(db, { run: args.run, swarm: args.swarm, sessionId, caller }) ??
    noRun(config, args.swarm ?? caller.swarm?.name);

  /**
   * Changes: the named run; a worker's own run; otherwise the only active run of this
   * session. Several active, or only another session's, is an error that asks for `run`.
   */
  const writeRun = (action: Action): RunRow => {
    if (args.run || isWorker(caller)) return readRun();
    const { mine, others } = activeRuns(db, args.swarm, sessionId);
    if (mine.length === 1) return mine[0]!;
    if (mine.length > 1)
      throw new SwarmError(
        `${mine.length} runs are active${sessionId ? " in this session" : ""}${
          args.swarm ? ` for swarm "${args.swarm}"` : ""
        }, so ${action} needs run: ${listRuns(mine)}. Pass run:"<id>".`,
      );
    if (others.length)
      throw new SwarmError(
        `no active run${args.swarm ? ` of swarm "${args.swarm}"` : ""} in this session; ${listRuns(others, 5)} ${
          others.length === 1 ? "belongs" : "belong"
        } to another Claude Code session. Pass run:"<id>" to act on it, or start one here with em_swarm {action:"start", swarm, goal}.`,
      );
    return noRun(config, args.swarm);
  };

  /** Task ids are global, so a task names its run; `run`, when given, must agree. */
  const runOfTask = (id: number): RunRow => {
    const named = args.run ? readRun() : undefined;
    const t = db.swarm.taskGet(id);
    if (!t)
      throw new SwarmError(
        `there is no task #${id}${named ? ` (run ${named.id} has ${db.swarm.tasks(named.id).length} task(s))` : ""}; em_swarm {action:"status"} lists the tasks`,
      );
    if (named && t.run_id !== named.id)
      throw new SwarmError(
        `task #${id} belongs to run ${t.run_id}, not run ${named.id}; drop run or name the right one`,
      );
    return named ?? db.swarm.runGet(t.run_id) ?? noRun(config, undefined);
  };

  switch (args.action) {
    case "list": {
      const plan = planAgentSync(ctx.root, config);
      const active = listItems(db, db.swarm.runs({ status: "active", limit: 10 }));
      const list = formatSwarmList(config, plan, active, { swarm: args.swarm, sessionId });
      return who.unverified !== undefined ? `${unstampedNote(who.unverified)}\n${list}` : list;
    }

    case "start": {
      if (!args.swarm)
        throw new SwarmError(
          `start needs swarm and goal; ${config.rel} defines: ${config.swarms.map((s) => s.name).join(", ")}`,
        );
      const swarm = findSwarm(config, args.swarm);
      const before = swarm ? activeRuns(db, swarm.name, sessionId).mine : [];
      const run = startRun(db, config, { swarm: args.swarm, goal: args.goal ?? "", sessionId });
      const spec = findSwarm(config, run.swarm)!;
      // Warnings first: a capped brief loses its tail, never these.
      const notes: string[] = [];
      if (before.length)
        notes.push(
          `Warning: swarm "${spec.name}" already had ${before.length} active run(s) in this session: ${listRuns(before, 5)}. Calls that do not name run now ask which one: pass run:"${run.id}" for this run, or close the old one with em_swarm {action:"finish", run:"<id>", status:"cancelled"}.`,
        );
      const plan = planAgentSync(ctx.root, config);
      const mine = new Set(spec.roles.map((r) => r.agentType));
      const conflicts = plan.filter((a) => mine.has(a.agentType) && a.action === "conflict");
      if (conflicts.length)
        notes.push(
          `Warning: sync leaves ${conflicts
            .map((a) => `${a.path} (${a.reason ?? "conflict"})`)
            .join(
              ", ",
            )} alone, so that role runs whatever the file says; fix it, or eminiar swarm sync --force for an edited generated file.`,
        );
      const stale = plan.filter(
        (a) => mine.has(a.agentType) && (a.action === "create" || a.action === "update"),
      );
      if (stale.length) {
        const r = syncAgents(ctx.root, config);
        notes.push(
          `Agent files synced first (${r.changed} written: ${stale.map((a) => a.agentType).join(", ")}). If the Agent tool does not offer a new subagent_type yet, open /agents or restart the session.`,
        );
      }
      const brief = await coordinatorBrief(ctx, db, config, spec, run);
      return capOutput([...notes, brief].join("\n\n"), 9000);
    }

    case "plan": {
      if (!args.tasks?.length)
        throw new SwarmError(`plan needs tasks: [{${PLAN_KEYS.join(", ")}}] (title is required)`);
      const allowed = new Set<string>(PLAN_KEYS);
      const extra = args.tasks.flatMap((t, i) =>
        Object.keys(t ?? {})
          .filter((k) => !allowed.has(k))
          .map((k) => `tasks[${i}].${k}`),
      );
      if (extra.length)
        throw new SwarmError(
          `unknown key(s) ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}; a task takes only ${PLAN_KEYS.join(", ")} (put anything else in detail). Nothing was planned.`,
        );
      const run = writeRun("plan");
      const swarm = swarmOf(config, run, caller);
      // File paths are made project-relative against the caller's own root (a worktree for
      // an isolated worker), so they match the main checkout's paths.
      const rows = addTasks(db, callerCtx, run, swarm, caller, args.tasks);
      return planned(db, rows, swarm, run, caller);
    }

    case "claim": {
      const id = taskNumber(args.task);
      const run = id !== undefined ? runOfTask(id) : writeRun("claim");
      const swarm = swarmOf(config, run, caller);
      let r: ReturnType<typeof claimTask>;
      try {
        r = claimTask(db, run, swarm, caller, id);
      } catch (err) {
        if (id === undefined) throw err;
        return inRun(err, run, id);
      }
      if (!r.task)
        return `Nothing to claim in run ${run.id}: ${sentence(r.reason ?? "no eligible task")}`;
      const brief = await taskBrief(db, run, caller.role, r.task);
      return capOutput(
        [
          `${r.already ? "You already hold" : "Claimed"} task #${r.task.id} (run ${run.id}). Report it with em_swarm {action:"update", task:${r.task.id}, status:"done"|"failed"|"blocked", result}.`,
          brief,
        ].join("\n\n"),
      );
    }

    case "update": {
      const id = taskNumber(args.task);
      if (id === undefined || !args.status || args.status === "cancelled")
        throw new SwarmError(
          "update needs task and status: done, failed or blocked (pending reopens the task; cancelled is for finish)",
        );
      // A late worker may still report on a finished run, so the swarm need not exist now.
      const run = runOfTask(id);
      sameSwarm(run, caller);
      let t: TaskRow;
      try {
        t = updateTask(db, run, caller, { task: id, status: args.status, result: args.result });
      } catch (err) {
        return inRun(err, run, id);
      }
      const fresh = db.swarm.runGet(run.id) ?? run;
      const c = runSnapshot(db, fresh, 1).counts.tasks;
      const tally = `run ${run.id}${fresh.status === "active" ? "" : ` (${fresh.status})`}: ${c.pending} pending · ${c.active} active · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ""}${c.blocked ? ` · ${c.blocked} blocked` : ""}`;
      const next =
        coordinator || t.status === "pending" || fresh.status !== "active"
          ? ""
          : ' Claim the next with em_swarm {action:"claim"}, or end with a final message for the coordinator.';
      return `Task #${t.id} is now ${t.status}${t.status === "pending" ? " (released for any eligible worker)" : ""}. ${tally}.${next}`;
    }

    case "post": {
      if (!args.key || args.value === undefined) throw new SwarmError("post needs key and value");
      const run = writeRun("post");
      sameSwarm(run, caller);
      const n = postNote(db, run, caller, args.key, args.value);
      return `Posted "${n.key}" (v${n.version}, ${n.value.length} characters) to the blackboard of run ${run.id}.`;
    }

    case "read": {
      const run = readRun();
      sameSwarm(run, caller);
      if (args.key) {
        const n = db.swarm.noteGet(run.id, args.key.trim());
        if (n) return capOutput(formatNote(n), 9000);
        const keys = db.swarm.notes(run.id).map((x) => x.key);
        return `No note "${args.key}" in run ${run.id}${keys.length ? `; keys: ${keys.join(", ")}` : "; the blackboard is empty"}.`;
      }
      return formatNotes(run.id, db.swarm.notes(run.id));
    }

    case "status": {
      const run = resolveRun(db, { run: args.run, swarm: args.swarm, sessionId, caller });
      if (!run) {
        const recent = listItems(db, db.swarm.runs({ swarm: args.swarm, limit: 5 }));
        return `No active run${args.swarm ? ` of swarm "${args.swarm}"` : ""}. ${
          recent.length ? `Recent runs:\n${formatRunList(recent)}` : "No runs yet."
        }\nStart one with em_swarm {action:"start", swarm, goal}.`;
      }
      sameSwarm(run, caller);
      const lead: string[] = who.unverified !== undefined ? [unstampedNote(who.unverified)] : [];
      if (!args.run && !isWorker(caller)) {
        const { mine, others } = activeRuns(db, args.swarm, sessionId);
        const rest = [...mine, ...others].filter((r) => r.id !== run.id);
        if (rest.length)
          lead.push(
            `Also active: ${listRuns(rest, 5)}. Pass run to see one${
              mine.length > 1 ? "; changes in this session need run while several are active" : ""
            }.`,
          );
      }
      return formatRunStatus(runSnapshot(db, run), { lead });
    }

    case "finish": {
      const run = writeRun("finish");
      const status = args.status ?? "done";
      if (status !== "done" && status !== "failed" && status !== "cancelled")
        throw new SwarmError("finish status must be done, failed or cancelled");
      const before = runSnapshot(db, run, 1);
      const r: { run: RunRow; memory?: string | undefined; memoryError?: string | undefined } =
        finishRun(ctx, db, run, caller, {
          status,
          summary: args.summary,
          remember: args.remember,
        });
      const open = before.counts.tasks.pending + before.counts.tasks.active;
      const running = before.counts.workers.running + before.counts.workers.stale;
      return [
        `Run ${run.id} (${run.swarm}) finished: ${r.run.status}. Tasks: ${before.counts.tasks.done} done of ${before.tasks.length}${
          open ? `; ${open} were still open` : ""
        }${running ? `; ${running} worker(s) still marked running were closed (a late report is still accepted)` : ""}.`,
        r.memory
          ? `Memory written: ${r.memory} (em_memory {action:"read", name:"${r.memory}"}). Record durable decisions separately with em_remember.`
          : r.memoryError
            ? `The run is closed, but its memory was not written: ${r.memoryError}. Record the outcome with em_remember.`
            : args.remember
              ? "No memory written."
              : "No memory written (pass remember:true to keep the outcome).",
      ].join("\n");
    }

    case "release": {
      const run = writeRun("release");
      const role = args.role?.trim() || undefined;
      const agent = args.agent?.trim() || undefined;
      if (role) {
        const roles = findSwarm(config, run.swarm)?.roles.map((r) => r.role) ?? [];
        if (roles.length && !roles.includes(role))
          throw new SwarmError(
            `role "${role}" is not a role of swarm "${run.swarm}" (${roles.join(", ")})`,
          );
      }
      const released = releaseWorkers(db, run, caller, { agent, role });
      const running = db.swarm.workers(run.id).filter((w) => w.status === "running");
      return formatReleased(run, released, running, {
        agent,
        role,
        staleMinutes: Math.round(STALE_MS / 60_000),
      });
    }
  }
  throw new SwarmError(`unknown action "${String(args.action)}"`);
}
