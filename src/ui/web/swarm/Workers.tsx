import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmDecision, SwarmTask, SwarmWorkerUi } from "../api.js";
import { Badge, Card, EmptyState } from "../ds.js";
import { cls, fmt } from "../util.js";
import { pure, RoleChip, State, useNow } from "./bits.js";
import { DecisionChip, workerDecisions } from "./decision.js";
import { heartbeat, sortWorkers } from "./run-helpers.js";
import { dur, GLYPH, roleColor, shortAgent } from "./style.js";
import { ReleaseButton } from "./Timeline.js";

/** Finished workers shown before "show all" folds the rest. */
const DONE_SHOWN = 4;

function WorkerCard({
  w,
  roles,
  task,
  now,
  staleMs,
  live,
  maxCalls,
  picked,
  onPick,
  onRelease,
  decision,
}: {
  decision: SwarmDecision | undefined;
  w: SwarmWorkerUi;
  roles: string[];
  task: SwarmTask | undefined;
  now: number;
  staleMs: number;
  live: boolean;
  maxCalls: number;
  picked: boolean;
  onPick: (id: string) => void;
  onRelease: (agent: string) => Promise<void>;
}): JSX.Element {
  const hb = heartbeat(w, now, staleMs);
  const color = roleColor(w.role, roles);
  const ended = w.ended_at ?? null;
  return (
    <Card
      class={cls("sw-wk", `st-${w.status}`, live && w.status === "running" && "is-live")}
      selected={picked}
      onClick={() => onPick(w.agent_id)}
    >
      <div class="sw-wk-stripe" style={{ background: color }} aria-hidden="true" />
      <div class="sw-wk-head">
        <RoleChip role={w.role} roles={roles} />
        <code class="sw-wk-id" title={w.agent_id}>
          {shortAgent(w.agent_id)}
        </code>
        <DecisionChip d={decision} />
        <span class="spacer" />
        <State s={w.status} />
      </div>
      <div class={cls("sw-wk-task", !task && "none")} title={task?.title}>
        {task ? (
          <>
            <span class="id">#{task.id}</span> {task.title}
          </>
        ) : w.task_id ? (
          <span class="id">#{w.task_id}</span>
        ) : w.status === "running" ? (
          "no task claimed yet"
        ) : (
          "no task held"
        )}
      </div>
      <div class="sw-wk-bar" title={`${w.tool_calls} tool calls`} aria-hidden="true">
        <i
          style={{
            width: `${maxCalls ? Math.max(2, (100 * w.tool_calls) / maxCalls) : 0}%`,
            background: color,
          }}
        />
      </div>
      <div class="sw-wk-meta">
        <span title="tool calls">› {fmt(w.tool_calls)} calls</span>
        {w.errors ? (
          <span class="bad" title="failed tool calls">
            {GLYPH.failed} {fmt(w.errors)}
          </span>
        ) : null}
        {w.last_tool ? (
          <span class="sw-wk-tool" title="last tool">
            {w.last_tool}
          </span>
        ) : null}
        <span class="spacer" />
        <span
          class={cls("sw-wk-beat", hb.quiet && "warn")}
          title={`last event ${new Date(w.last_ts).toLocaleTimeString()}`}
        >
          {w.status === "done" && ended
            ? `ran ${dur(ended - w.spawned_at)}`
            : `♥ ${dur(hb.age)} ago`}
        </span>
      </div>
      {live && hb.quiet ? (
        <div class="sw-wk-quiet" onClick={(e) => e.stopPropagation()}>
          <Badge tone="warn" title={`no event for ${dur(hb.age)} (stale after ${dur(staleMs)})`}>
            {GLYPH.stale} quiet {dur(hb.age)}
          </Badge>
          {w.status === "stale" ? <ReleaseButton agent={w.agent_id} onRelease={onRelease} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function WorkersView({
  workers,
  tasks,
  roles,
  live,
  skew,
  staleMs,
  picked,
  onPick,
  onRelease,
  decisions,
}: {
  decisions: Record<number, SwarmDecision> | undefined;
  workers: SwarmWorkerUi[];
  tasks: SwarmTask[];
  roles: string[];
  live: boolean;
  skew: number;
  staleMs: number;
  picked: string | null;
  /** Open a worker (the drawer) and filter the feed to it. */
  onPick: (agentId: string) => void;
  onRelease: (agent: string) => Promise<void>;
}): JSX.Element {
  // Heartbeat ages move slowly: a 5 s tick is enough and keeps the panel cheap.
  const now = useNow(5_000, live, skew);
  const [all, setAll] = useState(false);
  const sorted = sortWorkers(workers);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const done = sorted.filter((w) => w.status === "done");
  const hidden = all ? 0 : Math.max(0, done.length - DONE_SHOWN);
  // Folded: every running and stale worker, and only the newest finished ones.
  const shown = hidden
    ? [...sorted.filter((w) => w.status !== "done"), ...done.slice(-DONE_SHOWN)]
    : sorted;
  const maxCalls = Math.max(0, ...workers.map((w) => w.tool_calls));
  const n = (s: SwarmWorkerUi["status"]) => workers.filter((w) => w.status === s).length;
  return (
    <Card
      class="sw-workers"
      title="Workers"
      sub={workers.length ? `${workers.length} spawned` : undefined}
      right={
        workers.length ? (
          <span class="sw-wk-counts">
            <State s="running" word={`${n("running")} running`} />
            {n("stale") ? <State s="stale" word={`${n("stale")} stale`} /> : null}
            <State s="done" word={`${n("done")} done`} />
          </span>
        ) : null
      }
    >
      {workers.length ? (
        <>
          <div class="sw-wk-grid">
            {shown.map((w) => (
              <WorkerCard
                key={w.agent_id}
                w={w}
                roles={roles}
                task={w.task_id ? byTask.get(w.task_id) : undefined}
                now={now}
                staleMs={staleMs}
                live={live}
                maxCalls={maxCalls}
                picked={picked === w.agent_id}
                onPick={onPick}
                onRelease={onRelease}
                decision={workerDecisions(decisions, w.agent_id, w.task_id)[0]}
              />
            ))}
          </div>
          {hidden || (all && done.length > DONE_SHOWN) ? (
            <div class="sw-more">
              <button type="button" class="ghost sm" onClick={() => setAll((x) => !x)}>
                {all
                  ? "Show fewer finished workers"
                  : `Show ${hidden} more finished worker${hidden === 1 ? "" : "s"}`}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState compact icon={GLYPH.idle} title={live ? "No workers yet" : "No workers ran"}>
          {live
            ? "The coordinator spawns workers with the Agent tool (subagent_type swarm-<swarm>-<role>); each appears here as it starts."
            : "This run closed before any worker was spawned."}
        </EmptyState>
      )}
    </Card>
  );
}

/** Re-rendered on a new snapshot or pick, and every 5 s while live (heartbeat ages). */
export const Workers = pure(WorkersView);
