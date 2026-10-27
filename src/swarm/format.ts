import type { SyncAction, SyncResult } from "./agents.js";
import { clip, type RunSnapshot, type WorkerView } from "./runtime.js";
import type {
  ConfigIssue,
  NoteRow,
  RunRow,
  RunStatus,
  SwarmConfig,
  SwarmEventRow,
  TaskRow,
  TaskStatus,
  WorkerStatus,
} from "./types.js";

/**
 * Compact text renderers for swarm state, shared by the `em_swarm` tool and the
 * `eminiar swarm` CLI. Tool output enters the model's context window, so every renderer
 * caps its lists and the whole text stays under OUTPUT_MAX. Unknown values print "n/a",
 * never 0.
 */

export const OUTPUT_MAX = 6000;

export const TASK_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  active: "●",
  blocked: "◆",
  done: "✓",
  failed: "✗",
};

export const WORKER_GLYPH: Record<WorkerStatus, string> = {
  running: "●",
  done: "✓",
  stale: "◌",
};

const RUN_GLYPH: Record<RunStatus, string> = {
  active: "●",
  done: "✓",
  failed: "✗",
  cancelled: "◌",
};

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** "42s ago", "12m ago", "3h ago", "2d ago"; "n/a" when the time is unknown. */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "n/a";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Trim text to `max` characters on a line boundary, saying how much was left out. */
export function capOutput(s: string, max = OUTPUT_MAX, hint?: string): string {
  if (s.length <= max) return s;
  const room = max - 120;
  const cut = s.lastIndexOf("\n", room);
  const head = s.slice(0, cut > room / 2 ? cut : room);
  return `${head}\n… ${s.length - head.length} more characters left out${hint ? `; ${hint}` : ""}`;
}

/** The short id the feed uses for a Claude Code agent: `agent-a1b2c3d4e5` → `a1b2c3d4`. */
export function shortAgent(agentId: string): string {
  return agentId.replace(/^agent-/, "").slice(0, 8);
}

/** `coder@a1b2c3d4` for a worker, the label itself for the coordinator. */
function holderName(agentId: string | null, workers: Map<string, WorkerView>): string {
  if (!agentId) return "n/a";
  const w = workers.get(agentId);
  if (w) return `${w.role}@${shortAgent(agentId)}`;
  // Not a registered worker: the coordinator (or another caller) holds it under its label.
  return agentId;
}

function eventWho(e: SwarmEventRow): string {
  if (e.agent_id) return `${e.role ?? "worker"}@${shortAgent(e.agent_id)}`;
  return e.role ?? "n/a";
}

// --- configuration ---------------------------------------------------------------------

export function formatIssues(rel: string, issues: ConfigIssue[]): string {
  return issues
    .map((i) => `${rel}${i.line ? `:${i.line}` : ""}${i.path ? ` ${i.path}` : ""}: ${i.message}`)
    .join("\n");
}

export function formatInvalid(rel: string, issues: ConfigIssue[]): string {
  return capOutput(
    `${rel} has ${issues.length} problem(s); swarms stay off until it validates (\`eminiar swarm validate\`):\n${formatIssues(rel, issues)}`,
  );
}

export function formatNotOptedIn(rel: string): string {
  return [
    `Agent swarms are opt-in and this project has not opted in (no ${rel}).`,
    "To enable them, ask the user to run `eminiar swarm init` (writes a starter file and generates the worker agents), use “Create starter swarm.yaml” on the Swarms tab of the dashboard (`eminiar ui`), or write the file by hand (https://github.com/rydn/eminiar/blob/main/docs/swarms.md).",
    "Until then, do not improvise a swarm: use ordinary subagents or do the work directly.",
  ].join("\n");
}

export function formatDisabled(rel: string): string {
  return `Agent swarms are disabled in this project (enabled: false in ${rel}). Set enabled: true to use them; \`eminiar swarm sync\` removes the generated agent files while they are off.`;
}

const SYNC_STATE: Record<SyncAction["action"], string> = {
  unchanged: "synced",
  create: "not generated",
  update: "out of date",
  delete: "left over",
  conflict: "conflict",
};

export interface RunListItem {
  run: RunRow;
  done: number;
  total: number;
  running: number;
}

export function runListItem(run: RunRow, tasks: TaskRow[], workers: WorkerView[]): RunListItem {
  return {
    run,
    done: tasks.filter((t) => t.status === "done").length,
    total: tasks.length,
    running: workers.filter((w) => w.status === "running").length,
  };
}

function runLine(r: RunListItem, now: number): string {
  const { run } = r;
  return `${RUN_GLYPH[run.status]} ${run.id} ${run.swarm} ${run.status} · tasks ${r.done}/${r.total} done · ${r.running} running · started ${ago(run.created_at, now)}${
    run.status === "active"
      ? ` · updated ${ago(run.updated_at, now)}`
      : ` · ended ${ago(run.ended_at, now)}`
  } — ${clip(firstLine(run.goal), 100)}`;
}

/** Swarms, their roles and agent files, plus the active runs. */
export function formatSwarmList(
  config: SwarmConfig,
  plan: SyncAction[],
  active: RunListItem[],
  opts: { swarm?: string | undefined; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const byAgent = new Map(plan.map((a) => [a.agentType, a]));
  const counts = new Map<string, number>();
  for (const a of plan) counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
  const fileSummary = [...counts]
    .map(([action, n]) => `${n} ${SYNC_STATE[action as SyncAction["action"]]}`)
    .join(", ");
  const swarms = opts.swarm ? config.swarms.filter((s) => s.name === opts.swarm) : config.swarms;
  const lines = [
    `eminiar swarms · ${config.rel} · sync ${config.sync} · agent files: ${fileSummary || "none"}`,
  ];
  if (opts.swarm && !swarms.length)
    lines.push(
      `No swarm "${opts.swarm}"; ${config.rel} defines: ${config.swarms.map((s) => s.name).join(", ")}`,
    );
  for (const s of swarms) {
    lines.push(
      "",
      `${s.name} · ${s.topology} · up to ${s.maxAgents} worker(s) at once — ${clip(s.description, 160)}`,
    );
    if (s.topology === "pipeline" && s.stages.length)
      lines.push(`  stages: ${s.stages.join(" → ")}`);
    for (const r of s.roles) {
      const state = byAgent.get(r.agentType);
      lines.push(
        `  ${r.role} → ${r.agentType} · ${r.model ?? "inherit"} · ×${r.count}${r.isolation ? " · worktree" : ""} · ${
          state ? SYNC_STATE[state.action] : "n/a"
        }${state?.action === "conflict" ? ` (${state.reason ?? state.path})` : ""}`,
      );
    }
  }
  const leftover = plan.filter((a) => a.action === "delete");
  if (leftover.length)
    lines.push(
      "",
      `Left-over agent files: ${leftover.map((a) => a.path).join(", ")} (${leftover[0]?.reason ?? "not in the swarm file"})`,
    );
  if (plan.some((a) => a.action === "create" || a.action === "update" || a.action === "delete"))
    lines.push(
      'Agent files differ from the YAML: em_swarm {action:"sync"} (or `eminiar swarm sync`).',
    );
  if (plan.some((a) => a.action === "conflict"))
    lines.push(
      "Sync leaves conflicts alone: rename the role or the hand-written file; for a generated file edited by hand, move the edit into the YAML or overwrite it with sync --force.",
    );
  lines.push("");
  if (active.length) {
    lines.push("Active runs:");
    for (const r of active.slice(0, 10)) lines.push(`  ${runLine(r, now)}`);
  } else lines.push("No active run.");
  lines.push(
    'Start one: em_swarm {action:"start", swarm, goal}; the em-swarm skill has the coordinator playbook.',
  );
  return capOutput(lines.join("\n"));
}

/** One line per run, newest first. */
export function formatRunList(items: RunListItem[], now = Date.now()): string {
  if (!items.length) return "No swarm runs yet.";
  return capOutput(items.map((r) => runLine(r, now)).join("\n"));
}

const SYNC_VERB: Record<SyncAction["action"], { done: string; dry: string; mark: string }> = {
  create: { done: "created", dry: "to create", mark: "+" },
  update: { done: "updated", dry: "to update", mark: "~" },
  delete: { done: "deleted", dry: "to delete", mark: "-" },
  unchanged: { done: "unchanged", dry: "unchanged", mark: "=" },
  conflict: { done: "conflict", dry: "conflict", mark: "!" },
};

export function formatSync(
  result: SyncResult,
  opts: { dryRun?: boolean | undefined; reason?: string | undefined } = {},
): string {
  const word = (a: SyncAction["action"]) => SYNC_VERB[a][opts.dryRun ? "dry" : "done"];
  const tally = new Map<SyncAction["action"], number>();
  for (const a of result.actions) tally.set(a.action, (tally.get(a.action) ?? 0) + 1);
  const head = `${opts.dryRun ? "dry run · " : ""}agent files (.claude/agents): ${
    result.actions.length
      ? [...tally].map(([a, n]) => `${n} ${word(a)}`).join(", ")
      : "nothing to do"
  }${opts.reason ? ` (${opts.reason})` : ""}`;
  const lines = [head];
  for (const a of result.actions) {
    if (a.action === "unchanged") continue;
    lines.push(
      `  ${SYNC_VERB[a.action].mark} ${word(a.action)} ${a.path}${a.reason ? `: ${a.reason}` : ""}`,
    );
  }
  if (!opts.dryRun && result.actions.some((a) => a.action === "create"))
    lines.push(
      "Claude Code reads agent files when a session starts: if a new worker type is not available yet, open /agents or restart the session.",
    );
  return capOutput(lines.join("\n"));
}

// --- runs -------------------------------------------------------------------------------

const GROUP_ORDER: TaskStatus[] = ["active", "blocked", "failed", "pending", "done"];
const PER_GROUP = 12;

function taskLine(
  t: TaskRow,
  byId: Map<number, TaskRow>,
  workers: Map<string, WorkerView>,
): string {
  const parts = [`#${t.id} ${clip(t.title, 120)}${t.role ? ` (${t.role})` : ""}`];
  if (t.agent_id && t.status !== "pending") parts.push(holderName(t.agent_id, workers));
  if (t.status === "pending") {
    const waiting = t.deps.filter((d) => byId.get(d)?.status !== "done");
    if (waiting.length) parts.push(`waits on ${waiting.map((d) => `#${d}`).join(", ")}`);
  }
  if (t.files.length && (t.status === "pending" || t.status === "active"))
    parts.push(
      `files ${t.files.slice(0, 3).join(", ")}${t.files.length > 3 ? ` +${t.files.length - 3}` : ""}`,
    );
  let line = parts.join(" · ");
  if (t.auto_closed) line += " · ⚠ auto-closed: the worker never reported; check the result";
  if (t.result && t.status !== "active" && t.status !== "pending")
    line += ` — ${clip(firstLine(t.result), 140)}`;
  return line;
}

function workerLine(w: WorkerView, now: number): string {
  const when =
    w.status === "done" ? `ended ${ago(w.ended_at, now)}` : `last seen ${ago(w.last_ts, now)}`;
  return [
    `${WORKER_GLYPH[w.status]} ${w.status} ${w.role}@${shortAgent(w.agent_id)}`,
    w.task_id !== null ? `task #${w.task_id}` : undefined,
    `${w.tool_calls} tool call(s)${w.errors ? `, ${w.errors} failed` : ""}`,
    `last ${w.last_tool ?? "n/a"}`,
    when,
  ]
    .filter(Boolean)
    .join(" · ")
    .concat(w.status === "done" && w.summary ? ` — ${clip(firstLine(w.summary), 120)}` : "");
}

function eventLine(e: SwarmEventRow, now: number): string {
  return `  ${ago(e.ts, now)} ${eventWho(e)} ${e.kind}${e.task_id !== null ? ` #${e.task_id}` : ""}${
    e.text ? ` ${clip(firstLine(e.text), 140)}` : ""
  }`;
}

/** What to do next, from the coordinator's point of view. */
function nextStep(snap: RunSnapshot): string | undefined {
  if (snap.run.status !== "active") return undefined;
  const t = snap.counts.tasks;
  const open = t.pending + t.active + t.blocked;
  const running = snap.counts.workers.running;
  const hints: string[] = [];
  if (snap.counts.autoClosed)
    hints.push(
      `${snap.counts.autoClosed} task(s) were auto-closed; check them and reopen with em_swarm {action:"update", task, status:"pending"} if the work is not done.`,
    );
  if (!snap.tasks.length)
    hints.push('No tasks yet: em_swarm {action:"plan", tasks:[{title, role, files, deps}]}.');
  else if (!open)
    hints.push(
      'Every task is closed: review the results, then em_swarm {action:"finish", status:"done", summary, remember:true}.',
    );
  else if (!running && !t.active && t.pending)
    hints.push(
      "No worker is running: spawn workers for the claimable tasks (prompt naming task #N).",
    );
  if (t.blocked)
    hints.push(`${t.blocked} task(s) blocked: read their results and unblock or re-plan.`);
  return hints.length ? `Next: ${hints.join(" ")}` : undefined;
}

/** A run's state: tasks by status, workers, blackboard keys and the latest events. */
export function formatRunStatus(
  snap: RunSnapshot,
  opts: { now?: number; events?: number; perGroup?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const perGroup = opts.perGroup ?? PER_GROUP;
  const { run } = snap;
  const workers = new Map(snap.workers.map((w) => [w.agent_id, w]));
  const byId = new Map(snap.tasks.map((t) => [t.id, t]));
  const c = snap.counts;
  const lines = [
    `Run ${run.id} · swarm "${run.swarm}" (${run.topology}) · ${RUN_GLYPH[run.status]} ${run.status} · started ${ago(run.created_at, now)} · ${
      run.status === "active"
        ? `updated ${ago(run.updated_at, now)}`
        : `ended ${ago(run.ended_at, now)}`
    }`,
    `Goal: ${clip(run.goal, 400)}`,
  ];
  if (run.summary) lines.push(`Summary: ${clip(run.summary, 600)}`);

  const taskTally = GROUP_ORDER.filter((s) => c.tasks[s]).map((s) => `${c.tasks[s]} ${s}`);
  lines.push("", `Tasks (${snap.tasks.length}): ${taskTally.join(" · ") || "none planned"}`);
  for (const status of GROUP_ORDER) {
    const group = snap.tasks
      .filter((t) => t.status === status)
      // auto-closed tasks need a look, so they lead their group
      .sort((a, b) => Number(b.auto_closed) - Number(a.auto_closed) || a.id - b.id);
    if (!group.length) continue;
    lines.push(`${TASK_GLYPH[status]} ${status}`);
    for (const t of group.slice(0, perGroup)) lines.push(`  ${taskLine(t, byId, workers)}`);
    if (group.length > perGroup) lines.push(`  … ${group.length - perGroup} more ${status}`);
  }

  const wt = (["running", "stale", "done"] as const)
    .filter((s) => c.workers[s])
    .map((s) => `${c.workers[s]} ${s}`);
  lines.push(
    "",
    `Workers (${snap.workers.length}): ${wt.join(" · ") || "none spawned"}${
      snap.workers.length ? ` · ${c.toolCalls} tool call(s), ${c.errors} failed` : ""
    }`,
  );
  const rank: Record<WorkerStatus, number> = { running: 0, stale: 1, done: 2 };
  const shown = [...snap.workers].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.last_ts - a.last_ts,
  );
  for (const w of shown.slice(0, 12)) lines.push(`  ${workerLine(w, now)}`);
  if (shown.length > 12) lines.push(`  … ${shown.length - 12} more worker(s)`);

  if (snap.notes.length)
    lines.push(
      "",
      `Blackboard (em_swarm {action:"read", key}): ${snap.notes
        .slice(0, 16)
        .map((n) => `${n.key} (${n.author ?? "n/a"}, v${n.version}, ${ago(n.ts, now)})`)
        .join(" · ")}${snap.notes.length > 16 ? ` · … ${snap.notes.length - 16} more` : ""}`,
    );

  const events = snap.events.slice(-(opts.events ?? 12));
  if (events.length) {
    lines.push("", "Recent events (oldest first):");
    for (const e of events) lines.push(eventLine(e, now));
  }
  const next = nextStep(snap);
  if (next) lines.push("", next);
  return capOutput(lines.join("\n"), OUTPUT_MAX, `eminiar swarm status ${run.id} shows the rest`);
}

// --- blackboard ---------------------------------------------------------------------------

export function formatNote(n: NoteRow, now = Date.now()): string {
  return `${n.key} (v${n.version}, by ${n.author ?? "n/a"}, ${ago(n.ts, now)}):\n${n.value}`;
}

/** Every note of a run, each value clipped so the whole board stays readable. */
export function formatNotes(runId: string, notes: NoteRow[], now = Date.now(), each = 600): string {
  if (!notes.length)
    return `The blackboard of run ${runId} is empty; share a finding with em_swarm {action:"post", key, value}.`;
  const body = notes
    .map((n) => {
      const v = n.value.trim();
      return `## ${n.key} (v${n.version}, by ${n.author ?? "n/a"}, ${ago(n.ts, now)})\n${
        v.length > each
          ? `${v.slice(0, each)}… (${v.length - each} more characters: em_swarm {action:"read", key:"${n.key}"})`
          : v
      }`;
    })
    .join("\n\n");
  return capOutput(
    `Blackboard of run ${runId} (${notes.length} note(s), newest first):\n\n${body}`,
    OUTPUT_MAX,
    'read one key at a time with em_swarm {action:"read", key}',
  );
}

// --- watch (NDJSON for Claude Code's Monitor tool) -----------------------------------------

export type WatchType = "swarm.snapshot" | "swarm.changed" | "swarm.idle" | "swarm.finished";

export interface WatchLine {
  type: WatchType;
  run: string;
  swarm: string;
  status: RunStatus;
  tasks: Record<TaskStatus, number>;
  workers: Record<WorkerStatus, number>;
  auto_closed: number;
  last_event: {
    id: number;
    kind: string;
    who: string;
    task: number | null;
    text: string | null;
  } | null;
}

/**
 * One watch tick. `prevKey` is the key the previous tick returned (undefined on the first
 * tick). A line comes back only when something changed: the first tick (`swarm.snapshot`),
 * a change while work is in flight (`swarm.changed`), a change that leaves no worker
 * running and no task active (`swarm.idle`, the coordinator's turn), and the end of the
 * run (`swarm.finished`).
 */
export function watchStep(
  prevKey: string | undefined,
  snap: RunSnapshot,
): { key: string; line?: WatchLine } {
  const last = snap.events[snap.events.length - 1];
  const body: Omit<WatchLine, "type"> = {
    run: snap.run.id,
    swarm: snap.run.swarm,
    status: snap.run.status,
    tasks: { ...snap.counts.tasks },
    workers: { ...snap.counts.workers },
    auto_closed: snap.counts.autoClosed,
    last_event: last
      ? {
          id: last.id,
          kind: last.kind,
          who: eventWho(last),
          task: last.task_id,
          text: last.text ? clip(firstLine(last.text), 160) : null,
        }
      : null,
  };
  const key = JSON.stringify(body);
  if (snap.run.status !== "active") return { key, line: { type: "swarm.finished", ...body } };
  if (prevKey === undefined) return { key, line: { type: "swarm.snapshot", ...body } };
  if (key === prevKey) return { key };
  const idle = body.workers.running === 0 && body.tasks.active === 0;
  return { key, line: { type: idle ? "swarm.idle" : "swarm.changed", ...body } };
}
