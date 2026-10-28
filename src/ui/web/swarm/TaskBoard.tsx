import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type SwarmTask, type SwarmTaskFull, type SwarmWorkerUi } from "../api.js";
import { cls } from "../util.js";
import { Head, pure, RoleChip, State, useNow } from "./bits.js";
import { GLYPH, rel, shortAgent } from "./style.js";

/** Columns, and whether a column lists the most recently changed tasks first. */
const COLUMNS: Array<[string, Array<SwarmTask["status"]>, boolean]> = [
  ["pending", ["pending"], false],
  ["active", ["active"], false],
  ["done", ["done"], true],
  ["failed / blocked", ["failed", "blocked"], true],
];
/** Cards per column before "show more"; a 2000-task run stays a few hundred nodes. */
const COL_CAP = 30;
/** Ages on the cards are coarse; the board is redrawn at most this often for them. */
const AGE_TICK_MS = 15_000;

function holder(t: SwarmTask, workers: Map<string, SwarmWorkerUi>): string {
  if (!t.agent_id) return t.status === "pending" ? "unassigned" : "n/a";
  const w = workers.get(t.agent_id);
  if (w) return `${w.role}·${shortAgent(w.agent_id)}`;
  // The coordinator (or a non-swarm caller) holds it under its label.
  return t.agent_id.startsWith("agent-") ? shortAgent(t.agent_id) : t.agent_id;
}

/** The whole task when the snapshot cut its text, fetched while the card is open. */
function useFullTask(
  t: SwarmTask,
  open: boolean,
): { task: SwarmTask; loading: boolean; error?: string } {
  const [full, setFull] = useState<SwarmTask>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || !t.clipped) return;
    let alive = true;
    setError(undefined);
    api<SwarmTaskFull>("/api/swarm/task", { id: t.id, run: t.run_id }).then(
      (r) => alive && setFull(r.task),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [open, t.clipped, t.id, t.updated_at]);
  if (!t.clipped) return { task: t, loading: false };
  if (full && full.updated_at >= t.updated_at) return { task: full, loading: false };
  return error ? { task: t, loading: false, error } : { task: t, loading: true };
}

function Card({
  t,
  roles,
  workers,
  byId,
  now,
}: {
  t: SwarmTask;
  roles: string[];
  workers: Map<string, SwarmWorkerUi>;
  byId: Map<number, SwarmTask>;
  now: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const full = useFullTask(t, open);
  const shown = full.task;
  const waiting = t.deps.filter((d) => byId.get(d)?.status !== "done");
  const firstResult = t.result?.trim().split("\n")[0];
  const held = t.status === "active" && t.agent_id ? workers.get(t.agent_id) : undefined;
  const holderGone = held && held.status !== "running" ? held.status : null;
  return (
    <div class={cls("sw-task", `st-${t.status}`, open && "open")}>
      <button
        type="button"
        class="sw-btn sw-task-sum"
        aria-expanded={open}
        title={firstResult ? `result: ${firstResult.slice(0, 300)}` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <div class="h">
          <span class="id">#{t.id}</span>
          <span class="title">{t.title}</span>
        </div>
        <div class="m">
          <State s={t.status} />
          <RoleChip role={t.role} roles={roles} />
          <span class="who" title={t.agent_id ?? undefined}>
            {holder(t, workers)}
          </span>
          {t.files.length ? (
            <span class="files" title={t.files.join("\n")}>
              {t.files.length} file{t.files.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {holderGone ? (
            <span
              class="sw-badge warn"
              title="the worker holding this task went quiet or stopped; the coordinator can reopen it (status pending)"
            >
              {GLYPH.stale} holder {holderGone}
            </span>
          ) : null}
          {t.auto_closed ? (
            <span
              class="sw-badge warn"
              title="closed from the worker's final message because it never reported; check the result and reopen if wrong"
            >
              auto-closed
            </span>
          ) : null}
          {t.deps.length ? (
            <span class={cls("deps", waiting.length > 0 && "waiting")}>
              after {t.deps.map((d) => `#${d}`).join(", ")}
            </span>
          ) : null}
          <span class="age">{rel(t.updated_at, now)}</span>
        </div>
      </button>
      {open ? (
        <div class="x">
          {shown.detail ? <pre class="sw-pre">{shown.detail}</pre> : null}
          {shown.result ? (
            <>
              <div class="lbl">result{t.auto_closed ? " (auto-closed)" : ""}</div>
              <pre class="sw-pre">{shown.result}</pre>
            </>
          ) : (
            <div class="lbl">no result yet</div>
          )}
          {full.loading ? <div class="lbl">… loading the full text</div> : null}
          {full.error ? (
            <div class="lbl bad">
              text cut at 300 characters; loading the rest failed: {full.error}
            </div>
          ) : null}
          {t.files.length ? (
            <div class="flist">
              {t.files.map((f) => (
                <a href={`#/explore?file=${encodeURIComponent(f)}`}>
                  <code>{f}</code>
                </a>
              ))}
            </div>
          ) : null}
          <div class="lbl">
            created by {t.created_by ?? "n/a"} · {new Date(t.created_at).toLocaleString()}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Column({
  label,
  tasks,
  roles,
  workers,
  byId,
  now,
}: {
  label: string;
  tasks: SwarmTask[];
  roles: string[];
  workers: Map<string, SwarmWorkerUi>;
  byId: Map<number, SwarmTask>;
  now: number;
}): JSX.Element {
  const [cap, setCap] = useState(COL_CAP);
  const rest = tasks.length - cap;
  return (
    <div class="sw-col">
      <div class="ch">
        <span>{label}</span>
        <span class="n">{tasks.length}</span>
      </div>
      {tasks.slice(0, cap).map((t) => (
        <Card key={t.id} t={t} roles={roles} workers={workers} byId={byId} now={now} />
      ))}
      {rest > 0 ? (
        <button
          type="button"
          class="ghost sm sw-col-more"
          onClick={() => setCap((c) => c + COL_CAP)}
          title={`${rest} more ${label} task${rest === 1 ? "" : "s"} not shown`}
        >
          show {Math.min(COL_CAP, rest)} more · {rest} hidden
        </button>
      ) : null}
    </div>
  );
}

function TaskBoardView({
  tasks,
  workers,
  roles,
  live,
  skew,
}: {
  tasks: SwarmTask[];
  workers: SwarmWorkerUi[];
  roles: string[];
  live: boolean;
  /** Server clock minus client clock. */
  skew: number;
}): JSX.Element {
  const now = useNow(AGE_TICK_MS, live, skew);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const wmap = new Map(workers.map((w) => [w.agent_id, w]));
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div class="card sw-board-card">
      <Head title="Tasks" meta={tasks.length ? `${done}/${tasks.length} done` : "none planned"} />
      {tasks.length ? (
        <div class="sw-board">
          {COLUMNS.map(([label, statuses, recentFirst]) => {
            const col = tasks.filter((t) => statuses.includes(t.status));
            if (recentFirst) col.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
            return (
              <Column
                key={label}
                label={label}
                tasks={col}
                roles={roles}
                workers={wmap}
                byId={byId}
                now={now}
              />
            );
          })}
        </div>
      ) : (
        <div class="empty small">
          No tasks yet. The coordinator plans them with <code>em_swarm {'{action:"plan"}'}</code>.
        </div>
      )}
    </div>
  );
}

/** Re-rendered when the tasks, workers or roles change, not on every feed poll. */
export const TaskBoard = pure(TaskBoardView);
