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
  formatRunList,
  formatRunStatus,
  formatSwarmList,
  formatSync,
  type RunListItem,
  runListItem,
} from "../swarm/format.js";
import { coordinationRoot } from "../swarm/hooks.js";
import {
  addTasks,
  type Caller,
  COORDINATOR,
  callerOf,
  claimTask,
  finishRun,
  postNote,
  resolveRun,
  runSnapshot,
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
  "sync",
] as const;

const TaskId = z.union([z.number().int().positive(), z.string()]);

const PlanTask = z.object({
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

function taskNumber(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const m = /^\s*(?:task\s*)?#?\s*(\d{1,9})\s*$/i.exec(v);
  if (!m) throw new SwarmError(`task must be a task id such as 3 or "#3", not "${v}"`);
  return Number(m[1]);
}

const isCoordinator = (c: Caller) => c.label === COORDINATOR && !c.agentId;

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

function planned(rows: TaskRow[], swarm: SwarmSpec, run: RunRow): string {
  const agentOf = new Map(swarm.roles.map((r) => [r.role, r.agentType]));
  const lines = rows.map(
    (t) =>
      `#${t.id} ${t.title}${t.role ? ` → ${t.role} (subagent_type "${agentOf.get(t.role)}")` : ""}${
        t.deps.length ? ` · after ${t.deps.map((d) => `#${d}`).join(", ")}` : ""
      }${t.files.length ? ` · files ${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? " …" : ""}` : ""}`,
  );
  return capOutput(
    [
      `Planned ${rows.length} task(s) in run ${run.id}:`,
      ...lines,
      'Spawn a worker per claimable task with the Agent tool: the subagent_type above and a prompt naming "task #N" (run_in_background: true for parallel work). Watch with em_swarm {action:"status"}.',
    ].join("\n"),
  );
}

const schema = {
  action: z.enum(SWARM_ACTIONS),
  swarm: z.string().optional().describe("start/list: swarm name"),
  goal: z.string().optional().describe("start: what the run should achieve"),
  run: z.string().optional().describe("run id (default: the newest active run)"),
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
  force: z
    .boolean()
    .optional()
    .describe("sync: also overwrite generated agent files that were edited by hand"),
  caller_agent_id: z.string().optional().describe("set by eminiar's hook; leave empty"),
  caller_agent_type: z.string().optional().describe("set by eminiar's hook; leave empty"),
};

type Args = z.infer<z.ZodObject<typeof schema>>;

export const emSwarm = defineTool({
  name: "em_swarm",
  description:
    'Agent swarms, opt-in via .eminiar/swarm.yaml. The coordinator (main session): start {swarm, goal} → plan {tasks} → spawn workers with the Agent tool (subagent_type swarm-<swarm>-<role>, prompt naming "task #N") → status → finish {status, summary, remember}. Workers: claim, update {task, status, result}, post/read the shared blackboard. list shows swarms and runs; sync regenerates the agent files. The em-swarm skill has the playbook.',
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

/** Actions a subagent that is not a swarm worker (Explore, general-purpose, …) may use. */
const FOREIGN_OK = new Set<Args["action"]>(["list", "status", "read", "post", "sync"]);

async function dispatch(args: Args, callerCtx: ProjectContext): Promise<string> {
  // Isolated workers run in git worktrees; the ledger, the swarm file and the generated
  // agents belong to the main checkout, exactly as the hooks resolve them.
  const root = coordinationRoot(callerCtx.root);
  const ctx = root === callerCtx.root ? callerCtx : getContext(root);
  const loaded = loadSwarmConfig(ctx.root);
  if (loaded.state === "invalid") return formatInvalid(loaded.rel, loaded.issues);
  if (args.action === "sync") {
    // With no file, or enabled: false, sync removes the generated agent files.
    const config = loaded.state === "ok" ? loaded.config : undefined;
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
  const caller = callerOf(config, {
    agentId: args.caller_agent_id || undefined,
    agentType: args.caller_agent_type || undefined,
  });
  if (caller.agentId && !caller.role && !FOREIGN_OK.has(args.action))
    throw new SwarmError(
      `${caller.label} is not a worker of a swarm, so it cannot ${args.action}; it may list, status, read and post. Swarm workers are spawned with subagent_type swarm-<swarm>-<role>.`,
    );
  const current = () => {
    const run = resolveRun(db, { run: args.run, swarm: args.swarm, caller });
    return run ?? noRun(config, args.swarm ?? caller.swarm?.name);
  };

  switch (args.action) {
    case "list": {
      const plan = planAgentSync(ctx.root, config);
      const active = listItems(db, db.swarm.runs({ status: "active", limit: 10 }));
      return formatSwarmList(config, plan, active, { swarm: args.swarm });
    }

    case "start": {
      if (!isCoordinator(caller))
        throw new SwarmError(
          "only the coordinator (the main session) starts runs; a worker claims tasks of the run it was spawned for",
        );
      if (!args.swarm)
        throw new SwarmError(
          `start needs swarm and goal; ${config.rel} defines: ${config.swarms.map((s) => s.name).join(", ")}`,
        );
      const swarm = findSwarm(config, args.swarm);
      let syncNote = "";
      if (swarm) {
        const plan = planAgentSync(ctx.root, config);
        const mine = new Set(swarm.roles.map((r) => r.agentType));
        const stale = plan.filter(
          (a) => mine.has(a.agentType) && (a.action === "create" || a.action === "update"),
        );
        const conflicts = plan.filter((a) => mine.has(a.agentType) && a.action === "conflict");
        if (stale.length) {
          const r = syncAgents(ctx.root, config);
          syncNote = `Agent files synced first (${r.changed} written: ${stale.map((a) => a.agentType).join(", ")}). If the Agent tool does not offer a new subagent_type yet, open /agents or restart the session.`;
        }
        if (conflicts.length)
          syncNote += `${syncNote ? "\n" : ""}Warning: sync left ${conflicts
            .map((a) => `${a.path} (${a.reason ?? "conflict"})`)
            .join(
              ", ",
            )} alone, so that role runs whatever the file says; fix it, or eminiar swarm sync --force for an edited generated file.`;
      }
      const run = startRun(db, config, { swarm: args.swarm, goal: args.goal ?? "" });
      const brief = await coordinatorBrief(ctx, db, config, findSwarm(config, run.swarm)!, run);
      return capOutput([brief, syncNote].filter(Boolean).join("\n\n"), 9000);
    }

    case "plan": {
      if (!args.tasks?.length)
        throw new SwarmError("plan needs tasks: [{key?, title, detail?, role?, deps?, files?}]");
      const run = current();
      const swarm = swarmOf(config, run, caller);
      // File paths are made project-relative against the caller's own root (a worktree for
      // an isolated worker), so they match the main checkout's paths.
      const rows = addTasks(db, callerCtx, run, swarm, caller, args.tasks);
      return planned(rows, swarm, run);
    }

    case "claim": {
      const run = current();
      const swarm = swarmOf(config, run, caller);
      const r = claimTask(db, run, swarm, caller, taskNumber(args.task));
      if (!r.task) return `Nothing to claim in run ${run.id}: ${r.reason ?? "no eligible task"}.`;
      const brief = await taskBrief(db, run, caller.role, r.task);
      return capOutput(
        [
          `${r.already ? "You already hold" : "Claimed"} task #${r.task.id} (run ${run.id}).`,
          brief,
          `Report it with em_swarm {action:"update", task:${r.task.id}, status:"done"|"failed"|"blocked", result}.`,
        ].join("\n\n"),
      );
    }

    case "update": {
      const task = taskNumber(args.task);
      if (task === undefined || !args.status || args.status === "cancelled")
        throw new SwarmError(
          "update needs task and status: done, failed or blocked (pending reopens the task; cancelled is for finish)",
        );
      // A late worker may still report on a finished run, so the swarm need not exist now.
      const run = current();
      sameSwarm(run, caller);
      const t = updateTask(db, run, caller, { task, status: args.status, result: args.result });
      const fresh = db.swarm.runGet(run.id) ?? run;
      const c = runSnapshot(db, fresh, 1).counts.tasks;
      const tally = `run ${run.id}${fresh.status === "active" ? "" : ` (${fresh.status})`}: ${c.pending} pending · ${c.active} active · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ""}${c.blocked ? ` · ${c.blocked} blocked` : ""}`;
      const next =
        isCoordinator(caller) || t.status === "pending" || fresh.status !== "active"
          ? ""
          : ' Claim the next with em_swarm {action:"claim"}, or end with a final message for the coordinator.';
      return `Task #${t.id} is now ${t.status}${t.status === "pending" ? " (released for any eligible worker)" : ""}. ${tally}.${next}`;
    }

    case "post": {
      if (!args.key || args.value === undefined) throw new SwarmError("post needs key and value");
      const run = current();
      sameSwarm(run, caller);
      const n = postNote(db, run, caller, args.key, args.value);
      return `Posted "${n.key}" (v${n.version}, ${n.value.length} characters) to the blackboard of run ${run.id}.`;
    }

    case "read": {
      const run = current();
      if (args.key) {
        const n = db.swarm.noteGet(run.id, args.key.trim());
        if (n) return capOutput(formatNote(n), 9000);
        const keys = db.swarm.notes(run.id).map((x) => x.key);
        return `No note "${args.key}" in run ${run.id}${keys.length ? `; keys: ${keys.join(", ")}` : "; the blackboard is empty"}.`;
      }
      return formatNotes(run.id, db.swarm.notes(run.id));
    }

    case "status": {
      const run = resolveRun(db, { run: args.run, swarm: args.swarm, caller });
      if (!run) {
        const recent = listItems(db, db.swarm.runs({ swarm: args.swarm, limit: 5 }));
        return `No active run${args.swarm ? ` of swarm "${args.swarm}"` : ""}. ${
          recent.length ? `Recent runs:\n${formatRunList(recent)}` : "No runs yet."
        }\nStart one with em_swarm {action:"start", swarm, goal}.`;
      }
      return formatRunStatus(runSnapshot(db, run));
    }

    case "finish": {
      const run = current();
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
      return [
        `Run ${run.id} (${run.swarm}) finished: ${r.run.status}. Tasks: ${before.counts.tasks.done} done of ${before.tasks.length}${
          open ? `; ${open} were still open` : ""
        }${before.counts.workers.running ? `; ${before.counts.workers.running} worker(s) still running` : ""}.`,
        r.memory
          ? `Memory written: ${r.memory} (em_memory {action:"read", name:"${r.memory}"}). Record durable decisions separately with em_remember.`
          : r.memoryError
            ? `The run is closed, but its memory was not written: ${r.memoryError}. Record the outcome with em_remember.`
            : args.remember
              ? "No memory written."
              : "No memory written (pass remember:true to keep the outcome).",
      ].join("\n");
    }
  }
  throw new SwarmError(`unknown action "${String(args.action)}"`);
}
