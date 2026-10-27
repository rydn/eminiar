import type { ProjectContext } from "../context.js";
import { readBriefSummary, readFileRisk } from "../history/model.js";
import { renderProjectBrief } from "../session/brief.js";
import { memoriesForFile, recallForText } from "../session/recall.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { MemoryRow } from "../storage/types.js";
import { inScope } from "./glob.js";
import { clip, eligibility, type RunSnapshot, runSnapshot } from "./runtime.js";
import type { ContextSpec, RoleSpec, RunRow, SwarmConfig, SwarmSpec, TaskRow } from "./types.js";

/**
 * Knowledge briefs for swarm members. Everything comes from what eminiar already keeps
 * (memories, the persisted history summary and file risk table, graph metrics), so a
 * brief costs milliseconds and never runs git or reads source files.
 */

const ago = (ts: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** Join sections in priority order and stop before the budget runs out. */
function budgeted(sections: Array<string | undefined>, max: number): string {
  const out: string[] = [];
  let used = 0;
  for (const s of sections) {
    if (!s?.trim()) continue;
    const need = s.length + 2;
    if (used + need > max) {
      const room = max - used - 2;
      if (room > 200) out.push(clip(s, room));
      break;
    }
    out.push(s);
    used += need;
  }
  return out.join("\n\n");
}

function taskLine(t: TaskRow): string {
  return `#${t.id} ${t.title}${t.role ? ` (${t.role})` : ""}`;
}

function parseTags(m: MemoryRow): string[] {
  if (!m.tags) return [];
  try {
    const v = JSON.parse(m.tags) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Memories a role always sees: matched by tag, kind or topic (`topic/name`). */
function taggedMemories(
  db: StorageAdapter,
  tags: string[],
  limit: number,
  skip: Set<string>,
): string[] {
  if (!tags.length || limit <= 0) return [];
  const want = new Set(tags.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const m of db.memoryList({ limit: 500 })) {
    if (!m.name || skip.has(m.name)) continue;
    if (m.status === "superseded" || m.status === "deprecated" || m.status === "rejected") continue;
    const topic = m.name.includes("/") ? m.name.split("/")[0]! : "";
    const hit =
      want.has(m.kind.toLowerCase()) ||
      (topic && want.has(topic.toLowerCase())) ||
      parseTags(m).some((t) => want.has(t.toLowerCase()));
    if (!hit) continue;
    out.push(`- memory ${m.name} [${m.kind}]: ${clip(firstLine(m.content), 140)}`);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Memories and doc pages for a brief. Recall runs on each short text separately (goal,
 * task, role): one long concatenation has so many terms that nothing clears recall's bar.
 * Memories linked to the task's files and the role's tagged memories are added.
 */
async function memorySection(
  db: StorageAdapter,
  texts: Array<string | undefined>,
  spec: ContextSpec,
  tags: string[],
  files: string[] = [],
): Promise<string | undefined> {
  const lines: string[] = [];
  const shown = new Set<string>();
  const keys = new Set<string>();
  const add = (text: string, rkeys: string[]) => {
    const fresh = rkeys.filter((k) => !keys.has(k));
    if (rkeys.length && !fresh.length) return;
    for (const k of rkeys) {
      keys.add(k);
      if (k.startsWith("memory:")) shown.add(k.slice(7));
    }
    for (const l of text.split("\n").filter((l) => l.startsWith("- ")))
      if (!lines.includes(l)) lines.push(l);
  };
  const budget = { memories: spec.memories, docs: spec.docs };
  for (const text of texts) {
    if (!text?.trim() || (budget.memories <= 0 && budget.docs <= 0)) continue;
    try {
      const r = await recallForText(db, text, {
        maxMemories: budget.memories,
        maxDocs: budget.docs,
        path: "agent",
      });
      add(r.text, r.keys);
      budget.memories -= r.keys.filter((k) => k.startsWith("memory:")).length;
      budget.docs -= r.keys.filter((k) => k.startsWith("doc:")).length;
    } catch {
      // recall is optional
    }
  }
  for (const f of files.slice(0, 4)) {
    if (budget.memories <= 0) break;
    try {
      const r = memoriesForFile(db, f, { max: Math.min(2, budget.memories) });
      if (r.text) {
        add(r.text, r.keys);
        budget.memories -= r.keys.length;
      }
    } catch {
      // optional
    }
  }
  lines.push(...taggedMemories(db, tags, Math.max(1, spec.memories), shown));
  if (!lines.length) return undefined;
  return `Memories and docs (em_memory {action:"read", name} for the full text):\n${lines.slice(0, spec.memories + spec.docs + 3).join("\n")}`;
}

/** Bug-prone files among `paths` (or in `scope`), from the persisted history risk table. */
function historySection(
  db: StorageAdapter,
  paths: string[],
  scope: string[],
  limit = 5,
): string | undefined {
  const risk = readFileRisk(db);
  const rows = Object.entries(risk)
    .filter(([p]) => (paths.length ? paths.includes(p) : inScope(p, scope)))
    .sort((a, b) => b[1].risk - a[1].risk)
    .slice(0, limit)
    .map(
      ([p, r]) =>
        `- ${p}: ${r.fixes} fix(es) in ${r.commits} commits${r.lastFix ? `, last fix ${r.lastFix}` : ""}${
          r.reasons.length ? ` (${r.reasons.join("; ")})` : ""
        }`,
    );
  const lesson = readBriefSummary(db)?.lesson;
  if (!rows.length && !lesson) return undefined;
  return [
    `History (em_history {action:"file", path} before editing):`,
    ...rows,
    ...(lesson ? [`- lesson: ${lesson}`] : []),
  ].join("\n");
}

/** Source files only: the graph also ranks docs, memories and manifests. */
function isCode(path: string): boolean {
  return !path.startsWith(".eminiar/") && !/\.(md|mdx|json|ya?ml|toml|lock|txt)$/i.test(path);
}

function hotSection(db: StorageAdapter, scope: string[], limit = 6): string | undefined {
  let rows: Array<{ path: string | null; score: number }>;
  try {
    rows = db.metricsTop({ kind: "file", limit: 60 });
  } catch {
    return undefined;
  }
  const hot = rows
    .filter(
      (r): r is { path: string; score: number } =>
        !!r.path && r.score > 0 && isCode(r.path) && inScope(r.path, scope),
    )
    .slice(0, limit)
    .map((r) => r.path);
  if (!hot.length) return undefined;
  return `Hot files${scope.length ? " in your scope" : ""} (fan-in × churn; em_graph_impact before changing them): ${hot.join(", ")}`;
}

function structureSection(
  ctx: ProjectContext,
  db: StorageAdapter,
  budget: number,
): string | undefined {
  try {
    // Hot files and history have their own sections in a swarm brief.
    const b = renderProjectBrief(ctx, db, budget)
      .split("\n")
      .filter((l) => !l.startsWith("Hot files") && !l.startsWith("History (em_history)"))
      .join("\n")
      .trim();
    return b ? `Project (eminiar):\n${b}` : undefined;
  } catch {
    return undefined;
  }
}

function boardSection(snap: RunSnapshot, now: number): string {
  const lines: string[] = [];
  const byRole = new Map<string, { running: number; done: number }>();
  for (const w of snap.workers) {
    const e = byRole.get(w.role) ?? { running: 0, done: 0 };
    if (w.status === "running") e.running++;
    else e.done++;
    byRole.set(w.role, e);
  }
  if (byRole.size)
    lines.push(
      `Workers: ${[...byRole]
        .map(([r, c]) => `${r} ${c.running} running${c.done ? `, ${c.done} finished` : ""}`)
        .join(" · ")}`,
    );
  if (snap.notes.length)
    lines.push(
      `Blackboard (em_swarm {action:"read", key}): ${snap.notes
        .slice(0, 12)
        .map((n) => `${n.key} (${n.author ?? "?"}, v${n.version}, ${ago(n.ts, now)})`)
        .join(" · ")}`,
    );
  const c = snap.counts.tasks;
  lines.push(
    `Tasks: ${c.pending} pending · ${c.active} active · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ""}${c.blocked ? ` · ${c.blocked} blocked` : ""}`,
  );
  return lines.join("\n");
}

// --- worker ------------------------------------------------------------------------------

export interface WorkerBriefInput {
  run: RunRow;
  swarm: SwarmSpec;
  role: RoleSpec;
  task?: TaskRow | undefined;
  handoffNote?: string | undefined;
  prompt?: string | undefined;
}

/** What a worker is told when it starts (SubagentStart additionalContext). */
export async function workerBrief(
  ctx: ProjectContext,
  db: StorageAdapter,
  w: WorkerBriefInput,
): Promise<string> {
  const now = Date.now();
  const spec = w.role.context;
  const snap = runSnapshot(db, w.run, 0);
  // The task and how to report it lead, so a small max_chars never cuts them off.
  const head: string[] = [];
  if (w.task) {
    head.push(
      `eminiar swarm brief · you hold task ${taskLine(w.task)}. Report it with em_swarm {action:"update", task:${w.task.id}, status:"done"|"failed"|"blocked", result}.`,
    );
  } else {
    const open = snap.tasks.filter((t) => eligibility(t, snap.tasks, w.swarm, w.role.role).ok);
    head.push(
      `eminiar swarm brief · if your prompt names "task #N", claim it first with em_swarm {action:"claim", task:N}; otherwise claim the next open one with em_swarm {action:"claim"}.${
        open.length
          ? ` Claimable now: ${open.slice(0, 6).map(taskLine).join("; ")}.`
          : ' Nothing is claimable yet; check em_swarm {action:"status"}.'
      }`,
    );
  }
  head.push(
    `You are the "${w.role.role}" worker (${w.role.agentType}) of swarm "${w.swarm.name}", run ${w.run.id}, topology ${w.swarm.topology}.`,
    `Goal: ${clip(w.run.goal, 300)}`,
  );
  if (w.task?.detail) head.push(clip(w.task.detail, 1200));
  if (w.task?.files.length) head.push(`Files: ${w.task.files.join(", ")}`);
  const files = w.task?.files ?? [];
  const sections = [
    head.join("\n"),
    boardSection(snap, now),
    await memorySection(
      db,
      [
        w.task ? `${w.task.title} ${w.task.detail ?? ""}` : undefined,
        w.run.goal,
        `${w.role.description} ${w.role.prompt}`,
      ],
      spec,
      w.role.memoryTags,
      files,
    ),
    spec.history ? historySection(db, files, w.role.scope) : undefined,
    spec.insights ? hotSection(db, files.length ? files : w.role.scope) : undefined,
    spec.structure
      ? structureSection(ctx, db, Math.min(1200, Math.floor(spec.maxChars / 3)))
      : undefined,
    'Before acting: em_recall {query} for decisions, em_history {action:"file", path} before editing a file, em_graph_impact {node} before changing a symbol, em_symbols / em_search {source:"code"} instead of grepping.',
  ];
  return budgeted(sections, spec.maxChars);
}

/** What `claim` returns with the task: its detail plus the knowledge around its files. */
export async function taskBrief(
  db: StorageAdapter,
  run: RunRow,
  role: RoleSpec | undefined,
  task: TaskRow,
): Promise<string> {
  const spec = role?.context ?? {
    memories: 3,
    docs: 2,
    history: true,
    structure: false,
    insights: true,
    maxChars: 3000,
  };
  const sections = [
    `Task ${taskLine(task)} of run ${run.id} (goal: ${clip(run.goal, 200)})${task.detail ? `\n${clip(task.detail, 1500)}` : ""}${
      task.files.length ? `\nFiles: ${task.files.join(", ")}` : ""
    }${task.deps.length ? `\nAfter: ${task.deps.map((d) => `#${d}`).join(", ")}` : ""}`,
    await memorySection(
      db,
      [`${task.title} ${task.detail ?? ""}`, run.goal],
      spec,
      role?.memoryTags ?? [],
      task.files,
    ),
    spec.history
      ? historySection(db, task.files, task.files.length ? [] : (role?.scope ?? []))
      : undefined,
    spec.insights && task.files.length ? hotSection(db, task.files) : undefined,
  ];
  return budgeted(sections, spec.maxChars);
}

// --- coordinator -------------------------------------------------------------------------

const PLAYBOOK: Record<SwarmSpec["topology"], string> = {
  hierarchical:
    "You lead: plan every task, assign each to a role, spawn the workers, review what comes back.",
  mesh: "Workers are peers on one board: seed the tasks, spawn workers, and let them claim any open task and add follow-ups.",
  pipeline:
    "Tasks run in stages by role; a later stage becomes claimable only when every task of the earlier stages is done.",
};

/** What `em_swarm start` returns: the playbook, the roles and the project knowledge. */
export async function coordinatorBrief(
  ctx: ProjectContext,
  db: StorageAdapter,
  config: SwarmConfig,
  swarm: SwarmSpec,
  run: RunRow,
): Promise<string> {
  const roles = swarm.roles.map(
    (r) =>
      `- ${r.role} → subagent_type "${r.agentType}" (${r.model ?? "inherit"}, up to ${r.count} at once${
        r.scope.length ? `, scope ${r.scope.join(" ")}` : ""
      }): ${r.description}`,
  );
  const head = [
    `Swarm "${swarm.name}" run ${run.id} started (${swarm.topology}, at most ${swarm.maxAgents} workers at once). You are the coordinator.`,
    `Goal: ${run.goal}`,
    PLAYBOOK[swarm.topology] +
      (swarm.topology === "pipeline" && swarm.stages.length
        ? ` Stages: ${swarm.stages.join(" → ")}.`
        : ""),
    `Workers (Agent tool, subagent_type as listed):\n${roles.join("\n")}`,
    [
      "Steps:",
      '1. Plan: em_swarm {action:"plan", tasks:[{key, title, detail, role, deps, files}]}: small tasks one worker can finish, each naming its files; deps take task ids or earlier keys.',
      '2. Spawn a worker per claimable task with the Agent tool: subagent_type from the list, a prompt that names "task #N" (the worker claims it), run_in_background: true for parallel work. eminiar refuses spawns over capacity and briefs each worker with the project knowledge.',
      '3. Watch: em_swarm {action:"status"} (or `eminiar swarm watch` under the Monitor tool). Workers post shared facts to the blackboard.',
      '4. Review each result. Reopen with em_swarm {action:"update", task, status:"pending"} or plan follow-ups; tasks marked auto-closed were never reported by their worker, so check them.',
      '5. Finish: em_swarm {action:"finish", status:"done", summary, remember:true}, and record durable decisions with em_remember.',
    ].join("\n"),
    ...(swarm.instructions ? [`Instructions from ${config.rel}:\n${swarm.instructions}`] : []),
  ];
  const scope = [...new Set(swarm.roles.flatMap((r) => r.scope))];
  const spec: ContextSpec = {
    ...(swarm.roles[0]?.context ?? {
      memories: 4,
      docs: 2,
      history: true,
      structure: true,
      insights: true,
      maxChars: 4000,
    }),
  };
  const tags = [...new Set(swarm.roles.flatMap((r) => r.memoryTags))];
  const knowledge = budgeted(
    [
      await memorySection(db, [run.goal, swarm.description], spec, tags),
      spec.history ? historySection(db, [], scope) : undefined,
      spec.insights ? hotSection(db, scope) : undefined,
      spec.structure ? structureSection(ctx, db, 1200) : undefined,
    ],
    Math.max(1500, spec.maxChars),
  );
  return [head.join("\n\n"), knowledge].filter(Boolean).join("\n\n");
}
