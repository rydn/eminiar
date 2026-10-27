import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmTask, SwarmWorkerUi } from "../api.js";
import { cls } from "../util.js";
import { Head, RoleChip, State } from "./bits.js";
import { GLYPH, rel, shortAgent } from "./style.js";

const COLUMNS: Array<[string, Array<SwarmTask["status"]>]> = [
  ["pending", ["pending"]],
  ["active", ["active"]],
  ["done", ["done"]],
  ["failed / blocked", ["failed", "blocked"]],
];

function holder(t: SwarmTask, workers: Map<string, SwarmWorkerUi>): string {
  if (!t.agent_id) return t.status === "pending" ? "unassigned" : "n/a";
  const w = workers.get(t.agent_id);
  if (w) return `${w.role}·${shortAgent(w.agent_id)}`;
  // The coordinator (or a non-swarm caller) holds it under its label.
  return t.agent_id.startsWith("agent-") ? shortAgent(t.agent_id) : t.agent_id;
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
  const waiting = t.deps.filter((d) => byId.get(d)?.status !== "done");
  const firstResult = t.result?.trim().split("\n")[0];
  const held = t.status === "active" && t.agent_id ? workers.get(t.agent_id) : undefined;
  const holderGone = held && held.status !== "running" ? held.status : null;
  return (
    <div
      class={cls("sw-task", `st-${t.status}`, open && "open")}
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
      {open ? (
        <div class="x" onClick={(e) => e.stopPropagation()}>
          {t.detail ? <pre class="sw-pre">{t.detail}</pre> : null}
          {t.result ? (
            <>
              <div class="lbl">result{t.auto_closed ? " (auto-closed)" : ""}</div>
              <pre class="sw-pre">{t.result}</pre>
            </>
          ) : (
            <div class="lbl">no result yet</div>
          )}
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

export function TaskBoard({
  tasks,
  workers,
  roles,
  now,
}: {
  tasks: SwarmTask[];
  workers: SwarmWorkerUi[];
  roles: string[];
  now: number;
}): JSX.Element {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const wmap = new Map(workers.map((w) => [w.agent_id, w]));
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div class="card sw-board-card">
      <Head title="Tasks" meta={tasks.length ? `${done}/${tasks.length} done` : "none planned"} />
      {tasks.length ? (
        <div class="sw-board">
          {COLUMNS.map(([label, statuses]) => {
            const col = tasks.filter((t) => statuses.includes(t.status));
            return (
              <div class="sw-col">
                <div class="ch">
                  <span>{label}</span>
                  <span class="n">{col.length}</span>
                </div>
                {col.map((t) => (
                  <Card t={t} roles={roles} workers={wmap} byId={byId} now={now} />
                ))}
              </div>
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
